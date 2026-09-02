/**
 * US-005: workflow fail CLI command.
 */

import { describe, it, after } from "node:test";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_SCRIPT = path.resolve(__dirname, "..", "dist", "cli", "cli.js");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCli(args: string[], homeDir: string, stateDir: string): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("node", ["--no-warnings", CLI_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanChildEnv({
        HOME: homeDir,
        TAMANDUA_STATE_DIR: stateDir,
      }),
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

function readRunEvents(stateDir: string, runId: string): any[] {
  const eventsDir = path.join(stateDir, "events");
  const filePath = path.join(eventsDir, `${runId}.jsonl`);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function setupDbWithRun(
  stateDir: string,
  opts?: { status?: string; runNumber?: number },
): { runId: string; homeDir: string; tamanduaDir: string; root: string } {
  const th = createTempHome("tamandua-wf-fail-");
  const statePath = stateDir || th.tamanduaDir;
  const dbPath = path.join(statePath, "tamandua.db");

  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL DEFAULT 'test-workflow',
      task TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'running',
      notify_url TEXT,
      scheduling_status TEXT,
      scheduling_requested_at TEXT,
      scheduling_error TEXT,
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      worker_lost_count INTEGER NOT NULL DEFAULT 0,
      author_role TEXT NOT NULL DEFAULT 'write',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      input_template TEXT NOT NULL,
      expects TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'waiting',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      type TEXT NOT NULL DEFAULT 'single',
      loop_config TEXT,
      current_story_id TEXT,
      abandoned_count INTEGER DEFAULT 0,
      claim_job_id TEXT,
      claim_pid INTEGER,
      claim_pgid INTEGER,
      claim_updated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  const status = opts?.status ?? "running";
  const runNumber = opts?.runNumber ?? 42;

  db.prepare(
    "INSERT INTO runs (id, run_number, workflow_id, task, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, runNumber, "test-workflow", "test task", "{}", status, now, now);

  db.close();

  return { runId, homeDir: th.homeDir, tamanduaDir: th.tamanduaDir, root: th.root };
}

function insertStep(
  stateDir: string,
  stepId: string,
  runId: string,
  agentId: string,
  stepIndex: number,
  status: string,
  opts?: { claimPid?: number; claimPgid?: number },
): void {
  const dbPath = path.join(stateDir, "tamandua.db");
  const db = new DatabaseSync(dbPath);

  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, status,
       claim_pid, claim_pgid, claim_updated_at, retry_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    stepId,
    runId,
    `dev-${stepIndex}`,
    agentId,
    stepIndex,
    "test input",
    status,
    opts?.claimPid ?? null,
    opts?.claimPgid ?? null,
    opts ? now : null,
    0,
    now,
    now,
  );

  db.close();
}

// ── Sticky isolation env ─────────────────────────────────────────────
// forceFailRun launches fire-and-forget continuations — scheduleRunCronTeardown's
// teardownWorkflowCronsIfIdle (logs "Workflow idle" through lib/logger) plus
// the import()-hop terminateRunWithDaemon (controlRequest reads the daemon
// secret at HOME/.tamandua/daemon-secret when TAMANDUA_CONTROL_PORT is set) —
// that resolve DB / log / daemon-secret paths AFTER the triggering test's
// finally has run. Restoring the operator's real env there makes those late
// continuations trip the guard at the REAL ~/.tamandua (ledger entries with
// testFile null). Keep HOME / TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH pointed at
// a module-scoped temp dir for the whole file and drop TAMANDUA_CONTROL_PORT
// (an ambient port — e.g. 3339 when tests run inside a tamandua run — makes
// controlRequest skip its early guard return and reach a live daemon). The
// module after() restores the operator's env exactly as it was at load.
const stickyState = (() => {
  const th = createTempHome("tamandua-wf-fail-sticky-");
  const stateDir = path.join(th.root, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    root: th.root,
    homeDir: th.homeDir,
    stateDir,
    dbPath: path.join(stateDir, "tamandua.db"),
  };
})();
const originalHome = process.env.HOME;
const originalStateDir = process.env.TAMANDUA_STATE_DIR;
const originalDbPath = process.env.TAMANDUA_DB_PATH;
const originalControlPort = process.env.TAMANDUA_CONTROL_PORT;

function restoreOrDelete(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function applyStickyEnv(): void {
  process.env.HOME = stickyState.homeDir;
  process.env.TAMANDUA_STATE_DIR = stickyState.stateDir;
  process.env.TAMANDUA_DB_PATH = stickyState.dbPath;
  delete process.env.TAMANDUA_CONTROL_PORT;
}

after(() => {
  restoreOrDelete("HOME", originalHome);
  restoreOrDelete("TAMANDUA_STATE_DIR", originalStateDir);
  restoreOrDelete("TAMANDUA_DB_PATH", originalDbPath);
  restoreOrDelete("TAMANDUA_CONTROL_PORT", originalControlPort);
  try { fs.rmSync(stickyState.root, { recursive: true, force: true }); } catch { /* cleanup */ }
});

describe("US-005: workflow fail CLI command", () => {
  describe("forceFailRun backend", () => {
    it("force-fails a running run and emits run.force_failed event", async () => {
      const th = createTempHome("tamandua-ff-back-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      process.env.HOME = th.homeDir;
      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      // Drop the ambient control port: with HOME temp but TAMANDUA_CONTROL_PORT
      // still set, controlRequest would skip its early guard return and reach
      // a live daemon on that port.
      delete process.env.TAMANDUA_CONTROL_PORT;
      try {
        const { forceFailRun } = await import("../dist/installer/status.js");
        const result = await forceFailRun(runId, "Test force-fail reason");
        assert.ok(result.ok, "should succeed");
        assert.equal(result.status, "failed");
        assert.equal(result.reason, "Test force-fail reason");

        const db = new DatabaseSync(path.join(stateDir, "tamandua.db"));
        const run = db.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as any;
        db.close();

        assert.equal(run.status, "failed");
        assert.equal(run.scheduling_status, null);

        const events = readRunEvents(stateDir, runId);
        const ffEvents = events.filter((e) => e.event === "run.force_failed");
        assert.equal(ffEvents.length, 1);
        assert.equal(ffEvents[0].detail, "Test force-fail reason");
        assert.equal(ffEvents[0].runId, runId);
      } finally {
        // Restore to the module-scoped sticky temp env (NOT the operator's
        // real env): forceFailRun's fire-and-forget teardown continuations
        // resolve DB/log/daemon-secret paths after this hook.
        applyStickyEnv();
      }
    });

    it("cancels pending/waiting/running steps", async () => {
      const th = createTempHome("tamandua-ff-steps-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepPending = crypto.randomUUID();
      const stepRunning = crypto.randomUUID();
      const stepDone = crypto.randomUUID();
      insertStep(stateDir, stepPending, runId, "agentA", 0, "pending");
      insertStep(stateDir, stepRunning, runId, "agentB", 1, "running", { claimPid: 99999 });
      insertStep(stateDir, stepDone, runId, "agentC", 2, "done");

      process.env.HOME = th.homeDir;
      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      // Drop the ambient control port: with HOME temp but TAMANDUA_CONTROL_PORT
      // still set, controlRequest would skip its early guard return and reach
      // a live daemon on that port.
      delete process.env.TAMANDUA_CONTROL_PORT;
      try {
        const { forceFailRun } = await import("../dist/installer/status.js");
        await forceFailRun(runId, "Cancelling steps");

        const db = new DatabaseSync(path.join(stateDir, "tamandua.db"));
        const s1 = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepPending) as any;
        const s2 = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepRunning) as any;
        const s3 = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDone) as any;
        db.close();

        assert.equal(s1.status, "canceled");
        assert.equal(s2.status, "canceled");
        assert.equal(s3.status, "done", "already-done steps should not be changed");
      } finally {
        // Restore to the module-scoped sticky temp env (NOT the operator's
        // real env): forceFailRun's fire-and-forget teardown continuations
        // resolve DB/log/daemon-secret paths after this hook.
        applyStickyEnv();
      }
    });

    it("refuses to force-fail a completed run", async () => {
      const th = createTempHome("tamandua-ff-completed-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir, { status: "completed" });

      process.env.HOME = th.homeDir;
      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      // Drop the ambient control port: with HOME temp but TAMANDUA_CONTROL_PORT
      // still set, controlRequest would skip its early guard return and reach
      // a live daemon on that port.
      delete process.env.TAMANDUA_CONTROL_PORT;
      try {
        const { forceFailRun } = await import("../dist/installer/status.js");
        await assert.rejects(
          () => forceFailRun(runId, "Should fail"),
          /already completed/,
        );
      } finally {
        // Restore to the module-scoped sticky temp env (NOT the operator's
        // real env): forceFailRun's fire-and-forget teardown continuations
        // resolve DB/log/daemon-secret paths after this hook.
        applyStickyEnv();
      }
    });

    it("refuses to force-fail a canceled run", async () => {
      const th = createTempHome("tamandua-ff-canceled-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir, { status: "canceled" });

      process.env.HOME = th.homeDir;
      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      // Drop the ambient control port: with HOME temp but TAMANDUA_CONTROL_PORT
      // still set, controlRequest would skip its early guard return and reach
      // a live daemon on that port.
      delete process.env.TAMANDUA_CONTROL_PORT;
      try {
        const { forceFailRun } = await import("../dist/installer/status.js");
        await assert.rejects(
          () => forceFailRun(runId, "Should fail"),
          /already canceled/,
        );
      } finally {
        // Restore to the module-scoped sticky temp env (NOT the operator's
        // real env): forceFailRun's fire-and-forget teardown continuations
        // resolve DB/log/daemon-secret paths after this hook.
        applyStickyEnv();
      }
    });

    it("refuses with alive worker unless --force", async () => {
      const th = createTempHome("tamandua-ff-alive-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepId = crypto.randomUUID();
      insertStep(stateDir, stepId, runId, "agentX", 0, "running", {
        claimPid: process.pid,
      });

      process.env.HOME = th.homeDir;
      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      // Drop the ambient control port: with HOME temp but TAMANDUA_CONTROL_PORT
      // still set, controlRequest would skip its early guard return and reach
      // a live daemon on that port.
      delete process.env.TAMANDUA_CONTROL_PORT;
      try {
        const { forceFailRun } = await import("../dist/installer/status.js");

        // Without force — should refuse
        const result = await forceFailRun(runId, "Has alive worker");
        assert.ok(!result.ok, "should refuse");
        assert.ok(result.reason!.includes("alive worker"), `reason: ${result.reason}`);
        assert.ok(result.aliveWorkers!.length > 0);
        assert.equal(result.aliveWorkers![0].pid, process.pid);

        // With force — should succeed
        const result2 = await forceFailRun(runId, "Has alive worker", true);
        assert.ok(result2.ok, "should succeed with --force");
        assert.equal(result2.status, "failed");
      } finally {
        // Restore to the module-scoped sticky temp env (NOT the operator's
        // real env): forceFailRun's fire-and-forget teardown continuations
        // resolve DB/log/daemon-secret paths after this hook.
        applyStickyEnv();
      }
    });

    it("force-fails a paused run", async () => {
      const th = createTempHome("tamandua-ff-paused-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir, { status: "paused" });

      process.env.HOME = th.homeDir;
      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      // Drop the ambient control port: with HOME temp but TAMANDUA_CONTROL_PORT
      // still set, controlRequest would skip its early guard return and reach
      // a live daemon on that port.
      delete process.env.TAMANDUA_CONTROL_PORT;
      try {
        const { forceFailRun } = await import("../dist/installer/status.js");
        const result = await forceFailRun(runId, "Paused run force-fail");
        assert.ok(result.ok);
        assert.equal(result.status, "failed");
      } finally {
        // Restore to the module-scoped sticky temp env (NOT the operator's
        // real env): forceFailRun's fire-and-forget teardown continuations
        // resolve DB/log/daemon-secret paths after this hook.
        applyStickyEnv();
      }
    });
  });

  describe("CLI integration", () => {
    it("workflow fail --help prints help text", async () => {
      const th = createTempHome("tamandua-wff-help-");
      const result = await runCli(["workflow", "fail", "--help"], th.homeDir, th.tamanduaDir);
      assert.ok(result.stdout.includes("tamandua workflow fail"), `stdout: ${result.stdout}`);
      assert.ok(result.stdout.includes("--reason"), `stdout: ${result.stdout}`);
      assert.ok(result.stdout.includes("--force"), `stdout: ${result.stdout}`);
      assert.equal(result.exitCode, 0);
    });

    it("workflow fail with prefix run-id works", async () => {
      const th = createTempHome("tamandua-wff-prefix-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const result = await runCli(
        ["workflow", "fail", runId.slice(0, 8), "--reason", "Test prefix match"],
        th.homeDir,
        stateDir,
      );
      assert.equal(result.exitCode, 0, `exit: ${result.exitCode}, stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes("Force-failed"), `stdout: ${result.stdout}`);

      // Verify event was emitted
      const events = readRunEvents(stateDir, runId);
      const ffEvents = events.filter((e) => e.event === "run.force_failed");
      assert.equal(ffEvents.length, 1);
      assert.equal(ffEvents[0].detail, "Test prefix match");
    });

    it("workflow fail with #N run-id works", async () => {
      const th = createTempHome("tamandua-wff-hashn-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir, { runNumber: 99 });

      const result = await runCli(
        ["workflow", "fail", "#99", "--reason", "HashN test"],
        th.homeDir,
        stateDir,
      );
      assert.equal(result.exitCode, 0, `exit: ${result.exitCode}, stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes("Force-failed"), `stdout: ${result.stdout}`);
    });

    it("workflow fail with alive worker refuses via CLI", async () => {
      const th = createTempHome("tamandua-wff-alive-cli-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepId = crypto.randomUUID();
      insertStep(stateDir, stepId, runId, "agentZ", 0, "running", {
        claimPid: process.pid,
      });

      const result = await runCli(
        ["workflow", "fail", runId.slice(0, 8), "--reason", "Alive worker"],
        th.homeDir,
        stateDir,
      );
      assert.notEqual(result.exitCode, 0, "should exit non-zero");
      assert.ok(
        result.stderr.includes("alive worker") || result.stderr.includes(String(process.pid)),
        `stderr: ${result.stderr}`,
      );
    });

    it("workflow fail with alive worker + --force succeeds via CLI", async () => {
      const th = createTempHome("tamandua-wff-force-cli-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepId = crypto.randomUUID();
      insertStep(stateDir, stepId, runId, "agentF", 0, "running", {
        claimPid: process.pid,
      });

      const result = await runCli(
        ["workflow", "fail", runId.slice(0, 8), "--reason", "Force override", "--force"],
        th.homeDir,
        stateDir,
      );
      assert.equal(result.exitCode, 0, `exit: ${result.exitCode}, stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes("Force-failed"), `stdout: ${result.stdout}`);
    });

    it("workflow fail without --reason fails", async () => {
      const th = createTempHome("tamandua-wff-no-reason-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const result = await runCli(
        ["workflow", "fail", runId.slice(0, 8)],
        th.homeDir,
        stateDir,
      );
      assert.notEqual(result.exitCode, 0, "should exit non-zero");
      assert.ok(result.stderr.includes("--reason"), `stderr: ${result.stderr}`);
    });

    it("workflow fail on completed run fails", async () => {
      const th = createTempHome("tamandua-wff-completed-cli-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir, { status: "completed" });

      const result = await runCli(
        ["workflow", "fail", runId.slice(0, 8), "--reason", "Too late"],
        th.homeDir,
        stateDir,
      );
      assert.notEqual(result.exitCode, 0, "should exit non-zero");
      assert.ok(
        result.stderr.includes("already completed") || result.stderr.toLowerCase().includes("cannot force-fail"),
        `stderr: ${result.stderr}`,
      );
    });
  });
});

// ── Late fire-and-forget continuations land in sticky temp state ─────
// forceFailRun's scheduleRunCronTeardown fires teardownWorkflowCronsIfIdle as
// an unawaited continuation that resolves DB + logger paths AFTER the
// triggering test's finally has restored the env. Before the sticky env
// existed it logged "Workflow idle" at the REAL ~/.tamandua/tamandua.log
// (guard-dropped, ledger entry with testFile null). This regression test
// proves the write now lands in the sticky temp state.
describe("forceFailRun late teardown continuations land in sticky temp state", () => {
  it('teardown idle-check logs "Workflow idle" into the sticky tamandua.log', async () => {
    applyStickyEnv();
    const { runId } = setupDbWithRun(stickyState.stateDir);
    const { forceFailRun } = await import("../dist/installer/status.js");

    const result = await forceFailRun(runId, "Sticky teardown check");
    assert.ok(result.ok);

    // Give the fire-and-forget module-loader continuations a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 600));

    // The run.force_failed event landed in the sticky events dir.
    const evtFile = path.join(stickyState.stateDir, "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(evtFile), "force_failed event must land in the sticky events dir");
    const events = readRunEvents(stickyState.stateDir, runId);
    assert.ok(
      events.some((e) => e.event === "run.force_failed"),
      `expected run.force_failed in sticky events, got: ${events.map((e) => e.event).join(", ")}`,
    );

    // The late teardown idle-check logged into the sticky log (previously
    // guard-dropped at the real ~/.tamandua — the coverage the guard hid).
    const logFile = path.join(stickyState.stateDir, "tamandua.log");
    assert.ok(fs.existsSync(logFile), "teardown logger write must land in the sticky log");
    const logContent = fs.readFileSync(logFile, "utf-8");
    assert.ok(
      logContent.includes("Workflow idle"),
      `teardown idle-check must have run against the sticky state, log:\n${logContent}`,
    );
  });
});
