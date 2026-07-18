/**
 * Tests for tamandua workflow pause-all and resume-all CLI commands (US-005).
 *
 * Validates:
 * 1. tamandua workflow pause-all pauses all running runs and prints count
 * 2. tamandua workflow resume-all resumes all paused runs and prints count
 * 3. pause-all --drain uses drain semantics for each run
 * 4. If no eligible runs exist, prints "No runs to pause/resume"
 * 5. Terminal runs are not modified
 * 6. Tests for pause-all and resume-all pass
 * 7. Typecheck passes
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
    const harnessDir = path.join(path.dirname(dbPath), "harness", r.id);
    fs.mkdirSync(harnessDir, { recursive: true });
    const context = JSON.stringify({
      task: r.task,
      repo: harnessDir,
      working_directory_for_harness: harnessDir,
    });
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.workflowId, r.task, r.status, context, r.tokensSpent ?? 0);
  }

  db.close();
}

function seedRunWithStepsDb(dbPath: string, runs: Array<{
  id: string;
  workflowId: string;
  task: string;
  status: string;
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
      step_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'waiting',
      type TEXT NOT NULL DEFAULT 'single',
      retry_count INTEGER NOT NULL DEFAULT 0,
      abandoned_count INTEGER NOT NULL DEFAULT 0,
      reroute_count INTEGER NOT NULL DEFAULT 0,
      claim_pid INTEGER,
      claim_updated_at TEXT,
      output TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      worker_job_id TEXT,
      worker_pid INTEGER,
      worker_pgid INTEGER
    )
  `);

  for (const r of runs) {
    const harnessDir = path.join(path.dirname(dbPath), "harness", r.id);
    fs.mkdirSync(harnessDir, { recursive: true });
    const context = JSON.stringify({
      task: r.task,
      repo: harnessDir,
      working_directory_for_harness: harnessDir,
    });
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(r.id, r.workflowId, r.task, r.status, context);
  }

  db.close();
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

async function readDbStatus(dbPath: string, runId: string): Promise<{ status: string; scheduling_status: string | null }> {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string | null } | undefined;
  db.close();
  return row ? { status: row.status, scheduling_status: row.scheduling_status } : { status: "not_found", scheduling_status: null };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("tamandua workflow pause-all CLI", { concurrency: 1 }, () => {
  // AC 4: If no eligible runs exist, prints "No runs to pause"
  it("pause-all with no running runs prints 'No runs to pause'", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const th = createTempHome("tamandua-pause-all-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    // Only terminal runs, no running runs
    const completedId = crypto.randomUUID();
    const failedId = crypto.randomUUID();
    const pausedId = crypto.randomUUID();
    seedRunDb(dbPath, [
      { id: completedId, workflowId: "feature-dev-merge", task: "Completed run", status: "completed" },
      { id: failedId, workflowId: "feature-dev-merge", task: "Failed run", status: "failed" },
      { id: pausedId, workflowId: "feature-dev-merge", task: "Paused run", status: "paused" },
    ]);

    const { stdout, stderr, exitCode } = await runCli(
      ["workflow", "pause-all"],
      { HOME: th.homeDir },
    );

    assert.equal(exitCode, 0, "Should exit with code 0");
    assert.ok(
      stdout.includes("No runs to pause"),
      `Expected "No runs to pause" in stdout, got: ${stdout}`,
    );
  });

  // AC 1 + AC 5: pause-all pauses all running runs, skips terminal runs
  it("pause-all pauses all running runs and prints count", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-pause-all-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const running1 = crypto.randomUUID();
    const running2 = crypto.randomUUID();
    const running3 = crypto.randomUUID();
    const completedRun = crypto.randomUUID();

    seedRunDb(dbPath, [
      { id: running1, workflowId: "feature-dev-merge", task: "Running 1", status: "running" },
      { id: running2, workflowId: "feature-dev-merge", task: "Running 2", status: "running" },
      { id: running3, workflowId: "feature-dev-merge", task: "Running 3", status: "running" },
      { id: completedRun, workflowId: "feature-dev-merge", task: "Already done", status: "completed" },
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
        ["workflow", "pause-all"],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(exitCode, 0, `Should exit with code 0, got ${exitCode}`);
      assert.ok(
        stdout.includes("Paused 3 run(s)"),
        `Expected "Paused 3 run(s)" in stdout, got: ${stdout}`,
      );

      // Verify all running runs are now paused
      for (const id of [running1, running2, running3]) {
        const s = await readDbStatus(dbPath, id);
        assert.equal(s.status, "paused", `Run ${id.slice(0, 8)} should be paused, got ${s.status}`);
      }

      // AC 5: Terminal run is not modified
      const completedStatus = await readDbStatus(dbPath, completedRun);
      assert.equal(completedStatus.status, "completed", "Completed run should remain completed");
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });

  // AC 3: pause-all --drain uses drain semantics
  it("pause-all --drain sets scheduling_status to draining_pause", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-pause-all-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const running1 = crypto.randomUUID();
    const running2 = crypto.randomUUID();

    seedRunDb(dbPath, [
      { id: running1, workflowId: "feature-dev-merge", task: "Drainable 1", status: "running" },
      { id: running2, workflowId: "feature-dev-merge", task: "Drainable 2", status: "running" },
    ]);
    {
      const db = new DatabaseSync(dbPath);
      const now = new Date().toISOString();
      const insertRunningStep = db.prepare(
        `INSERT INTO steps (step_id, run_id, agent_id, step_index, status, type, retry_count, created_at, updated_at)
         VALUES ('impl', ?, 'feature-dev-merge_developer', 0, 'running', 'single', 0, ?, ?)`,
      );
      insertRunningStep.run(running1, now, now);
      insertRunningStep.run(running2, now, now);
      db.close();
    }

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
        ["workflow", "pause-all", "--drain"],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(exitCode, 0, `Should exit with code 0, got ${exitCode}`);
      assert.ok(
        stdout.includes("Paused 2 run(s)"),
        `Expected "Paused 2 run(s)" in stdout, got: ${stdout}`,
      );

      // Verify drain semantics: scheduling_status should be draining_pause, status still running
      for (const id of [running1, running2]) {
        const s = await readDbStatus(dbPath, id);
        assert.equal(s.status, "running", `Run ${id.slice(0, 8)} status should still be running during drain`);
        assert.equal(s.scheduling_status, "draining_pause", `Run ${id.slice(0, 8)} scheduling_status should be draining_pause`);
      }
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });
});

describe("tamandua workflow resume-all CLI", { concurrency: 1 }, () => {
  // AC 4: If no eligible runs exist, prints "No runs to resume"
  it("resume-all with no paused runs prints 'No runs to resume'", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const th = createTempHome("tamandua-resume-all-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const runningId = crypto.randomUUID();
    const completedId = crypto.randomUUID();
    seedRunDb(dbPath, [
      { id: runningId, workflowId: "feature-dev-merge", task: "Running run", status: "running" },
      { id: completedId, workflowId: "feature-dev-merge", task: "Completed run", status: "completed" },
    ]);

    const { stdout, stderr, exitCode } = await runCli(
      ["workflow", "resume-all"],
      { HOME: th.homeDir },
    );

    assert.equal(exitCode, 0, "Should exit with code 0");
    assert.ok(
      stdout.includes("No runs to resume"),
      `Expected "No runs to resume" in stdout, got: ${stdout}`,
    );
  });

  // AC 2 + AC 5: resume-all resumes all paused runs, skips terminal runs
  it("resume-all resumes all paused runs and prints count", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-resume-all-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const paused1 = crypto.randomUUID();
    const paused2 = crypto.randomUUID();
    const completedRun = crypto.randomUUID();

    // Need steps table too for resume (admitOrQueueRun checks steps)
    seedRunWithStepsDb(dbPath, [
      { id: paused1, workflowId: "feature-dev-merge", task: "Paused 1", status: "paused" },
      { id: paused2, workflowId: "feature-dev-merge", task: "Paused 2", status: "paused" },
      { id: completedRun, workflowId: "feature-dev-merge", task: "Already done", status: "completed" },
    ]);

    // Copy the workflow directory so the daemon can register the run on resume
    const srcWorkflowDir = path.resolve(__dirname, "..", "workflows", "feature-dev-merge");
    const dstWorkflowDir = path.join(th.tamanduaDir, "workflows", "feature-dev-merge");
    fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
    fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });

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
        ["workflow", "resume-all"],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(exitCode, 0, `Should exit with code 0, got ${exitCode}`);
      assert.ok(
        stdout.includes("Resumed 2 run(s)"),
        `Expected "Resumed 2 run(s)" in stdout, got: ${stdout}`,
      );

      // Verify all paused runs are now running
      for (const id of [paused1, paused2]) {
        const s = await readDbStatus(dbPath, id);
        assert.equal(s.status, "running", `Run ${id.slice(0, 8)} should be running, got ${s.status}`);
      }

      // AC 5: Terminal run is not modified
      const completedStatus = await readDbStatus(dbPath, completedRun);
      assert.equal(completedStatus.status, "completed", "Completed run should remain completed");
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });

  // AC: resume-all with no daemon handles gracefully
  it("resume-all without daemon handles gracefully", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const unusedPort = await getAvailablePort();
    const th = createTempHome("tamandua-resume-all-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const paused1 = crypto.randomUUID();
    const paused2 = crypto.randomUUID();
    seedRunDb(dbPath, [
      { id: paused1, workflowId: "feature-dev-merge", task: "Paused no daemon", status: "paused" },
      { id: paused2, workflowId: "feature-dev-merge", task: "Another paused", status: "paused" },
    ]);

    const { stdout, stderr, exitCode } = await runCli(
      ["workflow", "resume-all"],
      { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(unusedPort) },
    );

    assert.equal(exitCode, 0, "Should exit with code 0");
    assert.ok(
      stdout.includes("Resumed"),
      `Expected "Resumed" in stdout, got: ${stdout}`,
    );
    assert.ok(
      stdout.includes("0 run(s)"),
      `Expected "0 run(s)" in stdout, got: ${stdout}`,
    );
  });
});

describe("tamandua workflow pause-all / resume-all terminal protection", { concurrency: 1 }, () => {
  // AC 5: Terminal runs are not modified by pause-all
  it("pause-all does not modify terminal (completed/failed/canceled) runs", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-term-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const running = crypto.randomUUID();
    const completed = crypto.randomUUID();
    const failed = crypto.randomUUID();
    const canceled = crypto.randomUUID();

    seedRunDb(dbPath, [
      { id: running, workflowId: "feature-dev-merge", task: "Running", status: "running" },
      { id: completed, workflowId: "feature-dev-merge", task: "Completed", status: "completed" },
      { id: failed, workflowId: "feature-dev-merge", task: "Failed", status: "failed" },
      { id: canceled, workflowId: "feature-dev-merge", task: "Canceled", status: "canceled" },
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

      const { stdout, exitCode } = await runCli(
        ["workflow", "pause-all"],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(exitCode, 0, "Should exit with code 0");
      assert.ok(
        stdout.includes("Paused 1 run(s)"),
        `Expected "Paused 1 run(s)" in stdout, got: ${stdout}`,
      );

      // Running should be paused
      const runningStatus = await readDbStatus(dbPath, running);
      assert.equal(runningStatus.status, "paused", "Running run should be paused");

      // Terminal runs should be unchanged
      assert.equal((await readDbStatus(dbPath, completed)).status, "completed");
      assert.equal((await readDbStatus(dbPath, failed)).status, "failed");
      assert.equal((await readDbStatus(dbPath, canceled)).status, "canceled");
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });

  // AC 5: Terminal runs are not modified by resume-all
  it("resume-all does not modify terminal (completed/failed/canceled) runs", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-term-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const paused = crypto.randomUUID();
    const completed = crypto.randomUUID();
    const failed = crypto.randomUUID();
    const canceled = crypto.randomUUID();

    // Need steps table for resume
    seedRunWithStepsDb(dbPath, [
      { id: paused, workflowId: "feature-dev-merge", task: "Paused", status: "paused" },
      { id: completed, workflowId: "feature-dev-merge", task: "Completed", status: "completed" },
      { id: failed, workflowId: "feature-dev-merge", task: "Failed", status: "failed" },
      { id: canceled, workflowId: "feature-dev-merge", task: "Canceled", status: "canceled" },
    ]);

    // Copy the workflow directory so the daemon can register the run on resume
    const srcWorkflowDir = path.resolve(__dirname, "..", "workflows", "feature-dev-merge");
    const dstWorkflowDir = path.join(th.tamanduaDir, "workflows", "feature-dev-merge");
    fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
    fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });

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

      const { stdout, exitCode } = await runCli(
        ["workflow", "resume-all"],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(exitCode, 0, "Should exit with code 0");
      assert.ok(
        stdout.includes("Resumed 1 run(s)"),
        `Expected "Resumed 1 run(s)" in stdout, got: ${stdout}`,
      );

      // Paused should be running now
      const pausedStatus = await readDbStatus(dbPath, paused);
      assert.equal(pausedStatus.status, "running", "Paused run should be resumed");

      // Terminal runs should be unchanged
      assert.equal((await readDbStatus(dbPath, completed)).status, "completed");
      assert.equal((await readDbStatus(dbPath, failed)).status, "failed");
      assert.equal((await readDbStatus(dbPath, canceled)).status, "canceled");
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });
});
