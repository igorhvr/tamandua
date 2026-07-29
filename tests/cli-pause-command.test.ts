/**
 * Tests for tamandua workflow pause CLI command (US-003).
 *
 * Validates:
 * 1. tamandua workflow pause <valid-run-id> pauses the run and prints confirmation
 * 2. tamandua workflow pause <completed-run-id> prints clear error (cannot pause terminal run)
 * 3. tamandua workflow pause <nonexistent-id> prints not-found error
 * 4. After pause, tamandua workflow status shows status=paused
 * 5. Pause with no daemon prints daemon-unreachable error
 */

import { describe, it, before, after } from "node:test";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_SCRIPT = path.resolve(__dirname, "..", "dist", "cli", "cli.js");
const DAEMON_SCRIPT = path.resolve(__dirname, "..", "dist", "server", "daemon.js");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("node", ["--no-warnings", CLI_SCRIPT, ...args], {
      env: cleanChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.once("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function cleanStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => {
      if (line.includes("ExperimentalWarning") && line.includes("SQLite")) return false;
      if (line.includes("node --trace-warnings")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function seedRunDb(dbPath: string, runs: Array<{
  id: string;
  workflowId: string;
  task: string;
  status: string;
  tokensSpent?: number;
}>) {
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      context TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      run_number INTEGER,
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      notify_url TEXT,
      scheduling_status TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS steps (
      step_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'waiting',
      type TEXT NOT NULL DEFAULT 'single',
      retry_count INTEGER NOT NULL DEFAULT 0,
      abandoned_count INTEGER NOT NULL DEFAULT 0,
      reroute_count INTEGER NOT NULL DEFAULT 0,
      current_story_id TEXT,
      claim_pid INTEGER,
      claim_updated_at TEXT,
      output TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      worker_job_id TEXT,
      worker_pid INTEGER,
      worker_pgid INTEGER,
      PRIMARY KEY (step_id, run_id)
    )
  `);

  for (const r of runs) {
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, tokens_spent)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(r.id, r.workflowId, r.task, r.status, r.tokensSpent ?? 0);
  }

  db.close();
}

async function canBind(port: number): Promise<boolean> {
  const server = http.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", () => resolve());
      server.listen(port, "127.0.0.1");
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
}

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert.ok(addr && typeof addr === "object");
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForControlUp(port: number, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/control/health`);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`control plane did not come up on port ${port}`);
}

// ── Tests ──────────────────────────────────────────────────────────

describe("tamandua workflow pause CLI", { concurrency: 1 }, () => {
  // AC 3: tamandua workflow pause <nonexistent-id> prints not-found error
  it("pause nonexistent run prints not-found error", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    // Isolated empty state: "not found" must come from a temp DB, never
    // from querying the developer's real ~/.tamandua.
    const th = createTempHome("tamandua-pause-test-");

    const { stdout, stderr, exitCode } = await runCli(
      ["workflow", "pause", "nonexistent-run-id"],
      { HOME: th.homeDir },
    );

    assert.notEqual(exitCode, 0, "Should exit with non-zero code");
    assert.ok(
      stderr.includes("No run found matching") || stderr.includes("not found"),
      `Expected not-found error in stderr, got: ${stderr}`,
    );
    assert.equal(cleanStderr(stderr), stderr.trim() ? cleanStderr(stderr) : "");
  });

  // AC 2: tamandua workflow pause <completed-run-id> prints clear error
  it("pause terminal (completed) run prints clear error", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const th = createTempHome("tamandua-pause-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const completedRunId = crypto.randomUUID();
    seedRunDb(dbPath, [
      {
        id: completedRunId,
        workflowId: "feature-dev-merge",
        task: "Test completed run",
        status: "completed",
      },
    ]);

    const { stdout, stderr, exitCode } = await runCli(
      ["workflow", "pause", completedRunId.slice(0, 8)],
      { HOME: th.homeDir },
    );

    assert.notEqual(exitCode, 0, "Should exit with non-zero code");
    assert.ok(
      stderr.includes("Cannot pause run") || stderr.includes("only running runs"),
      `Expected terminal error in stderr, got: ${stderr}`,
    );
    assert.ok(
      stderr.includes("completed"),
      `Expected "completed" status in error, got: ${stderr}`,
    );
  });

  // AC 2 (edge): failed run is also terminal
  it("pause terminal (failed) run prints clear error", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const th = createTempHome("tamandua-pause-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const failedRunId = crypto.randomUUID();
    seedRunDb(dbPath, [
      {
        id: failedRunId,
        workflowId: "feature-dev-merge",
        task: "Test failed run",
        status: "failed",
      },
    ]);

    const { stderr, exitCode } = await runCli(
      ["workflow", "pause", failedRunId.slice(0, 8)],
      { HOME: th.homeDir },
    );

    assert.notEqual(exitCode, 0, "Should exit with non-zero code");
    assert.ok(
      stderr.includes("Cannot pause run") || stderr.includes("only running runs"),
      `Expected terminal error, got: ${stderr}`,
    );
    assert.ok(
      stderr.includes("failed"),
      `Expected "failed" status in error, got: ${stderr}`,
    );
  });

  // AC 2 (edge): canceled run is also terminal
  it("pause terminal (canceled) run prints clear error", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const th = createTempHome("tamandua-pause-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const canceledRunId = crypto.randomUUID();
    seedRunDb(dbPath, [
      {
        id: canceledRunId,
        workflowId: "feature-dev-merge",
        task: "Test canceled run",
        status: "canceled",
      },
    ]);

    const { stderr, exitCode } = await runCli(
      ["workflow", "pause", canceledRunId.slice(0, 8)],
      { HOME: th.homeDir },
    );

    assert.notEqual(exitCode, 0, "Should exit with non-zero code");
    assert.ok(
      stderr.includes("Cannot pause run") || stderr.includes("only running runs"),
      `Expected terminal error, got: ${stderr}`,
    );
    assert.ok(
      stderr.includes("canceled"),
      `Expected "canceled" status in error, got: ${stderr}`,
    );
  });

  // AC 5 (daemon unreachable): pause running run with no daemon prints clear error
  it("pause running run without daemon prints unreachable error", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    // Use a port that is guaranteed not to have a daemon listening
    const unusedPort = await getAvailablePort();

    const th = createTempHome("tamandua-pause-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const runningRunId = crypto.randomUUID();
    seedRunDb(dbPath, [
      {
        id: runningRunId,
        workflowId: "feature-dev-merge",
        task: "Test running run",
        status: "running",
      },
    ]);

    const { stderr, exitCode } = await runCli(
      ["workflow", "pause", runningRunId],
      { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(unusedPort) },
    );

    assert.notEqual(exitCode, 0, "Should exit with non-zero code");
    assert.ok(
      stderr.includes("Daemon is unreachable") || stderr.includes("unreachable"),
      `Expected daemon-unreachable error, got: ${stderr}`,
    );
  });

  // AC 1 + AC 4: pause a running run with daemon running works and status shows paused
  it("pause running run with daemon pauses the run and status shows paused", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-pause-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const runningRunId = crypto.randomUUID();
    seedRunDb(dbPath, [
      {
        id: runningRunId,
        workflowId: "feature-dev-merge",
        task: "Test running run for pause",
        status: "running",
      },
    ]);

    let daemon: ChildProcess | undefined;

    try {
      // Start daemon
      daemon = spawn("node", [DAEMON_SCRIPT], {
        env: cleanChildEnv({ HOME: th.homeDir,
          TAMANDUA_CONTROL_PORT: String(controlPort), }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      daemon.stdout?.resume();
      daemon.stderr?.resume();

      await waitForControlUp(controlPort);

      // Pause the run via CLI
      const { stdout, stderr, exitCode } = await runCli(
        ["workflow", "pause", runningRunId],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(exitCode, 0, `Should exit with code 0, got ${exitCode}, stderr: ${cleanStderr(stderr)}`);
      assert.ok(
        stdout.includes("Paused run"),
        `Expected "Paused run" in stdout, got: ${stdout}`,
      );
      assert.ok(
        stdout.includes(runningRunId.slice(0, 8)),
        `Expected run id prefix in stdout, got: ${stdout}`,
      );

      // AC 4: Verify status now shows paused
      const { stdout: statusOut } = await runCli(
        ["workflow", "status", runningRunId.slice(0, 8)],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.ok(
        statusOut.includes("paused") || statusOut.includes("Paused"),
        `Expected status to show "paused", got: ${statusOut}`,
      );
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });

  // US-004: CLI auto-populates requester identity on pause
  it("pause via CLI auto-populates requester identity in context", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();
    const th = createTempHome("tamandua-pause-id-");
    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const runningRunId = crypto.randomUUID();
    seedRunDb(dbPath, [
      {
        id: runningRunId,
        workflowId: "feature-dev-merge",
        task: "Test requester identity on pause",
        status: "running",
      },
    ]);

    let daemon: ChildProcess | undefined;

    try {
      daemon = spawn("node", [DAEMON_SCRIPT], {
        env: cleanChildEnv({ HOME: th.homeDir,
          TAMANDUA_CONTROL_PORT: String(controlPort), }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      daemon.stdout?.resume();
      daemon.stderr?.resume();

      await waitForControlUp(controlPort);

      const { stdout, stderr, exitCode } = await runCli(
        ["workflow", "pause", runningRunId],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(exitCode, 0, `Should exit with code 0, got ${exitCode}, stderr: ${cleanStderr(stderr)}`);
      assert.ok(stdout.includes("Paused run"), `Expected "Paused run" in stdout, got: ${stdout}`);

      // Verify context keys contain the CLI identity
      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(runningRunId) as { context: string } | undefined;
      db.close();
      assert.ok(row, "Run should exist in DB");
      const ctx = JSON.parse(row.context) as Record<string, unknown>;
      assert.equal(typeof ctx.paused_by, "string", "paused_by should be a string");
      assert.ok(
        (ctx.paused_by as string).endsWith(" (cli)"),
        `paused_by should end with " (cli)", got: ${ctx.paused_by}`,
      );
      assert.ok(
        (ctx.paused_by as string).includes("@"),
        `paused_by should contain "@", got: ${ctx.paused_by}`,
      );
      assert.equal(typeof ctx.paused_at, "string", "paused_at should be a string");
      assert.equal(ctx.pause_drain, "false", "pause_drain should be false");
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });

  // AC: pause with missing run-id prints usage/error
  it("pause missing run-id prints usage error", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const th = createTempHome("tamandua-pause-usage-");
    const { stdout, stderr, exitCode } = await runCli(["workflow", "pause"], { HOME: th.homeDir });

    assert.notEqual(exitCode, 0, "Should exit with non-zero code when no run-id provided");
    assert.ok(
      stderr.includes("Missing run-id"),
      `Expected "Missing run-id" error, got stderr: "${cleanStderr(stderr)}"`,
    );
  });
});
