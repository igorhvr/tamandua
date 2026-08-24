/**
 * Tests for tamandua workflow resume CLI command (US-004).
 *
 * Validates:
 * 1. tamandua workflow resume <paused-run-id> resumes the run and prints confirmation
 * 2. Resumed run status transitions from paused to running
 * 3. tamandua workflow resume <terminal-run-id> prints clear error
 * 4. Existing failed-run resume path still works
 * 5. Resume with no daemon prints daemon-unreachable error
 * 6. Resume with missing run-id prints usage error
 */

import { describe, it } from "node:test";
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
  context?: Record<string, unknown>;
  tokensSpent?: number;
  schedulingStatus?: string;
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
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      input_template TEXT NOT NULL DEFAULT '',
      expects TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'waiting',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      abandoned_count INTEGER DEFAULT 0,
      reroute_count INTEGER DEFAULT 0,
      current_story_id TEXT,
      claim_pid INTEGER,
      claim_updated_at TEXT,
      type TEXT NOT NULL DEFAULT 'single',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  for (const r of runs) {
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent${r.schedulingStatus !== undefined ? ", scheduling_status" : ""})
       VALUES (?, ?, ?, ?, ?, ?${r.schedulingStatus !== undefined ? ", ?" : ""})`,
    ).run(
      r.id, r.workflowId, r.task, r.status, JSON.stringify(r.context ?? {}), r.tokensSpent ?? 0,
      ...(r.schedulingStatus !== undefined ? [r.schedulingStatus] : []),
    );
  }

  db.close();
}

async function getAvailablePort(): Promise<number> {
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

describe("tamandua workflow resume CLI", { concurrency: 1 }, () => {
  // AC 1 + 2: Resume a paused run with daemon running works and status transitions to running
  it("resume paused run with daemon resumes the run and status shows running", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-resume-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const pausedRunId = crypto.randomUUID();
    seedRunDb(dbPath, [
      {
        id: pausedRunId,
        workflowId: "feature-dev-merge",
        task: "Test paused run for resume",
        status: "paused",
        context: { working_directory_for_harness: th.root },
      },
    ]);

    // Copy the workflow directory so the daemon can register the run on resume
    const srcWorkflowDir = path.resolve(__dirname, "..", "workflows", "feature-dev-merge");
    const dstWorkflowDir = path.join(th.tamanduaDir, "workflows", "feature-dev-merge");
    fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
    fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });

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

      // Resume the run via CLI
      const { stdout, stderr, exitCode } = await runCli(
        ["workflow", "resume", pausedRunId],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(exitCode, 0, `Should exit with code 0, got ${exitCode}, stderr: ${cleanStderr(stderr)}`);
      assert.ok(
        stdout.includes("Resumed run"),
        `Expected "Resumed run" in stdout, got: ${stdout}`,
      );
      assert.ok(
        stdout.includes(pausedRunId.slice(0, 8)),
        `Expected run id prefix in stdout, got: ${stdout}`,
      );

      // AC 2: Verify status now shows running
      const { stdout: statusOut } = await runCli(
        ["workflow", "status", pausedRunId.slice(0, 8)],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.ok(
        /Status:\s+running/i.test(statusOut),
        `Expected status to show "running", got: ${statusOut}`,
      );
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
        await sleep(200);
      }
    }
  });

  // AC 4: Resume completed run prints clear error (terminal)
  it("resume completed run prints terminal error", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const th = createTempHome("tamandua-resume-test-");

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
      ["workflow", "resume", completedRunId.slice(0, 8)],
      { HOME: th.homeDir },
    );

    assert.notEqual(exitCode, 0, "Should exit with non-zero code for terminal run");
    assert.ok(
      stderr.includes("Cannot resume run") || stderr.includes("cannot be resumed"),
      `Expected terminal error in stderr, got: ${stderr}`,
    );
    assert.ok(
      stderr.includes("completed"),
      `Expected "completed" status in error, got: ${stderr}`,
    );
  });

  // AC 4: Resume canceled run prints clear error (terminal)
  it("resume canceled run prints terminal error", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const th = createTempHome("tamandua-resume-test-");

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
      ["workflow", "resume", canceledRunId.slice(0, 8)],
      { HOME: th.homeDir },
    );

    assert.notEqual(exitCode, 0, "Should exit with non-zero code for terminal run");
    assert.ok(
      stderr.includes("Cannot resume run") || stderr.includes("cannot be resumed"),
      `Expected terminal error, got: ${stderr}`,
    );
    assert.ok(
      stderr.includes("canceled"),
      `Expected "canceled" status in error, got: ${stderr}`,
    );
  });

  // AC 5: Existing failed-run resume path still works
  it("resume failed run uses existing resumeWorkflow path", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-resume-test-");

    // Copy the workflow directory so the daemon can register the run on resume
    const srcWorkflowDir = path.resolve(__dirname, "..", "workflows", "feature-dev-merge");
    const dstWorkflowDir = path.join(th.tamanduaDir, "workflows", "feature-dev-merge");
    fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
    fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const failedRunId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    seedRunDb(dbPath, [
      {
        id: failedRunId,
        workflowId: "feature-dev-merge",
        task: "Test failed run for resume",
        status: "failed",
        context: { working_directory_for_harness: th.root },
      },
    ]);

    // Also insert a failed step so resumeWorkflow has a step to restart from
    const db = new DatabaseSync(dbPath);
    const nowStr = new Date().toISOString();
    db.prepare(
      `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(), stepId, failedRunId, 'feature-dev-merge_developer', 0,
      'test input', 'STEPS_STATUS: done', 'failed', 'single', nowStr, nowStr,
    );
    db.close();

    let daemon: ChildProcess | undefined;

    try {
      // Start daemon so resumeWorkflow can register with it
      daemon = spawn("node", [DAEMON_SCRIPT], {
        env: cleanChildEnv({ HOME: th.homeDir,
          TAMANDUA_CONTROL_PORT: String(controlPort), }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      daemon.stdout?.resume();
      daemon.stderr?.resume();

      await waitForControlUp(controlPort);

      const { stdout, stderr, exitCode } = await runCli(
        ["workflow", "resume", failedRunId.slice(0, 8)],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(exitCode, 0, `Should exit with code 0 for failed run resume, got ${exitCode}, stderr: ${cleanStderr(stderr)}`);
      assert.ok(
        stdout.includes("Resumed run"),
        `Expected "Resumed run" in stdout, got: ${stdout}`,
      );
      assert.ok(
        stdout.includes("restarting from step"),
        `Expected "restarting from step" in stdout, got: ${stdout}`,
      );
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
        await sleep(200);
      }
    }
  });

  // FFRC (W3.21): force-fail a run, then immediately resume. The force-fail
  // shape leaves the run 'failed' with ALL non-done steps 'canceled' (no
  // 'failed' step exists). Resume must repair the canceled pipeline and
  // re-register — never emit a spurious run.completed or hit the
  // "Run is terminal: completed" contradiction that permanently blocked
  // resume in the torture-test evidence.
  it("resume immediately after force-fail re-registers without spurious run.completed", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-resume-ffrc-");

    // Copy the workflow directory so the daemon can register the run on resume
    const srcWorkflowDir = path.resolve(__dirname, "..", "workflows", "feature-dev-merge");
    const dstWorkflowDir = path.join(th.tamanduaDir, "workflows", "feature-dev-merge");
    fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
    fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const runId = crypto.randomUUID();
    seedRunDb(dbPath, [
      {
        id: runId,
        workflowId: "feature-dev-merge",
        task: "W3.21 force-fail resume replay",
        status: "running",
        context: { working_directory_for_harness: th.root },
      },
    ]);

    // Steps: one done, one in flight, one waiting — the force-fail shape.
    const db = new DatabaseSync(dbPath);
    const nowStr = new Date().toISOString();
    const stepRows: Array<[string, string, string, number]> = [
      ["implement", "feature-dev-merge_developer", "done", 0],
      ["verify", "feature-dev-merge_verifier", "running", 1],
      ["merge", "feature-dev-merge_integrator", "waiting", 2],
    ];
    for (const [stepId, agentId, status, index] of stepRows) {
      db.prepare(
        `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(), stepId, runId, agentId, index,
        "test input", "STEPS_STATUS: done", status, "single", nowStr, nowStr,
      );
    }
    db.close();

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

      // 1. Force-fail (no live worker: claim_pid is NULL, so no --force needed).
      const failCli = await runCli(
        ["workflow", "fail", runId, "--reason", "W3.21 replay"],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );
      assert.equal(failCli.exitCode, 0, `force-fail should exit 0, got ${failCli.exitCode}: ${cleanStderr(failCli.stderr)}`);
      assert.ok(failCli.stdout.includes("Force-failed run"), `unexpected force-fail stdout: ${failCli.stdout}`);

      // 2. Immediately resume — the exact W3.21 race window.
      const resumeCli = await runCli(
        ["workflow", "resume", runId],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      // Must NOT surface the historical contradiction.
      const stderr = cleanStderr(resumeCli.stderr);
      assert.ok(
        !stderr.includes("Run is terminal: completed"),
        `resume must never hit the terminal:completed contradiction, stderr: ${stderr}`,
      );
      // Must not fail with an uncaught throw either.
      assert.ok(!/Error:/.test(stderr), `resume must not surface an uncaught error, stderr: ${stderr}`);

      // The W3.21 shape has no 'failed' step, so the resume either succeeds
      // (repair + re-register) or fails with the retriable teardown error.
      if (resumeCli.exitCode === 0) {
        assert.ok(
          resumeCli.stdout.includes("Resumed run"),
          `expected "Resumed run" in stdout, got: ${resumeCli.stdout}`,
        );
        assert.ok(
          resumeCli.stdout.includes("restarting from step: verify"),
          `expected restart from the repaired step, got: ${resumeCli.stdout}`,
        );
      } else {
        assert.ok(
          stderr.includes("teardown in progress") || stderr.includes("Failed to resume run"),
          `expected retriable teardown error, got stderr: ${stderr}`,
        );
      }

      // 3. DB/daemon-observed status agree — never 'completed'.
      const db2 = new DatabaseSync(dbPath);
      const run = db2.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | undefined;
      const steps = db2.prepare("SELECT step_id, status FROM steps WHERE run_id = ? ORDER BY step_index ASC").all(runId) as Array<{ step_id: string; status: string }>;
      db2.close();
      assert.ok(run, "run must exist");
      assert.notEqual(run.status, "completed", `run must never be marked completed, got: ${run.status}`);

      if (resumeCli.exitCode === 0) {
        assert.equal(run.status, "running", `resumed run should be running, got: ${run.status}`);
        const byId = Object.fromEntries(steps.map((s) => [s.step_id, s.status]));
        assert.equal(byId["implement"], "done", "done step stays done");
        // The repaired step may already have been claimed by the daemon's
        // dispatch motor by the time we read the DB — pending OR running
        // both prove the repair worked.
        assert.ok(
          byId["verify"] === "pending" || byId["verify"] === "running",
          `canceled in-flight step must be repaired to pending (or claimed), got: ${byId["verify"]}`,
        );
        assert.equal(byId["merge"], "waiting", "canceled waiting step repaired to waiting");
      } else {
        // Retriable path: run returned to 'failed' so a retry can succeed.
        assert.equal(run.status, "failed", `retriable failure should leave run failed, got: ${run.status}`);
      }

      // 4. Event stream: no spurious run.completed; force-failed stream ends
      // on run.force_failed (or, at worst, a resume-registration run.failed).
      const eventsPath = path.join(th.tamanduaDir, "events", `${runId}.jsonl`);
      if (fs.existsSync(eventsPath)) {
        const eventNames = fs.readFileSync(eventsPath, "utf-8")
          .split(/\r?\n/).filter(Boolean)
          .map((line) => (JSON.parse(line) as { event: string }).event);
        assert.ok(
          !eventNames.includes("run.completed"),
          `spurious run.completed in event stream: ${eventNames.join(", ")}`,
        );
      }
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
        await sleep(200);
      }
    }
  });

  // Resume a running run should fail (only paused or failed)
  it("resume running run prints error", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const th = createTempHome("tamandua-resume-test-");

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
      ["workflow", "resume", runningRunId],
      { HOME: th.homeDir },
    );

    assert.notEqual(exitCode, 0, "Should exit with non-zero code for running run");
    assert.ok(
      stderr.includes("Cannot resume run") || stderr.includes("only paused or failed"),
      `Expected "only paused or failed" error, got: ${stderr}`,
    );
  });

  // Resume paused run without daemon prints unreachable error
  it("resume paused run without daemon prints unreachable error", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const unusedPort = await getAvailablePort();

    const th = createTempHome("tamandua-resume-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const pausedRunId = crypto.randomUUID();
    seedRunDb(dbPath, [
      {
        id: pausedRunId,
        workflowId: "feature-dev-merge",
        task: "Test paused run no daemon",
        status: "paused",
      },
    ]);

    const { stderr, exitCode } = await runCli(
      ["workflow", "resume", pausedRunId],
      { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(unusedPort) },
    );

    assert.notEqual(exitCode, 0, "Should exit with non-zero code");
    assert.ok(
      stderr.includes("Daemon is unreachable") || stderr.includes("unreachable"),
      `Expected daemon-unreachable error, got: ${stderr}`,
    );
  });

  // Resume nonexistent run prints not-found error
  it("resume nonexistent run prints not-found error", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const th = createTempHome("tamandua-resume-missing-");
    const { stdout, stderr, exitCode } = await runCli(
      ["workflow", "resume", "nonexistent-run-id"],
      { HOME: th.homeDir },
    );

    assert.notEqual(exitCode, 0, "Should exit with non-zero code");
    assert.ok(
      stderr.includes("No run found matching") || stderr.includes("not found"),
      `Expected not-found error in stderr, got: ${stderr}`,
    );
  });

  // US-004: CLI auto-populates requester identity on resume
  it("resume via CLI auto-populates requester identity in context", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();
    const th = createTempHome("tamandua-resume-id-");

    // Copy the workflow directory so the daemon can register the run on resume
    const srcWorkflowDir = path.resolve(__dirname, "..", "workflows", "feature-dev-merge");
    const dstWorkflowDir = path.join(th.tamanduaDir, "workflows", "feature-dev-merge");
    fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
    fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const pausedRunId = crypto.randomUUID();
    seedRunDb(dbPath, [
      {
        id: pausedRunId,
        workflowId: "feature-dev-merge",
        task: "Test requester identity on resume",
        status: "paused",
        context: { working_directory_for_harness: th.root },
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
        ["workflow", "resume", pausedRunId],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(exitCode, 0, `Should exit with code 0, got ${exitCode}, stderr: ${cleanStderr(stderr)}`);
      assert.ok(stdout.includes("Resumed run"), `Expected "Resumed run" in stdout, got: ${stdout}`);

      // Verify context keys contain the CLI identity
      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(pausedRunId) as { context: string } | undefined;
      db.close();
      assert.ok(row, "Run should exist in DB");
      const ctx = JSON.parse(row.context) as Record<string, unknown>;
      assert.equal(typeof ctx.resumed_by, "string", "resumed_by should be a string");
      assert.ok(
        (ctx.resumed_by as string).endsWith(" (cli)"),
        `resumed_by should end with " (cli)", got: ${ctx.resumed_by}`,
      );
      assert.ok(
        (ctx.resumed_by as string).includes("@"),
        `resumed_by should contain "@", got: ${ctx.resumed_by}`,
      );
      assert.equal(typeof ctx.resumed_at, "string", "resumed_at should be a string");
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
        await sleep(200);
      }
    }
  });

  // Resume with missing run-id prints usage error
  it("resume missing run-id prints usage error", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const th = createTempHome("tamandua-resume-usage-");
    const { stdout, stderr, exitCode } = await runCli(["workflow", "resume"], { HOME: th.homeDir });

    assert.notEqual(exitCode, 0, "Should exit with non-zero code when no run-id provided");
    assert.ok(
      stderr.includes("Missing run-id"),
      `Expected "Missing run-id" error, got stderr: "${cleanStderr(stderr)}"`,
    );
  });
});
