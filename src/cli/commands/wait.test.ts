/**
 * Tests for the workflow wait command.
 *
 * These tests exercise: exit code computation, heartbeat formatting, JSON output
 * shape, human output lines, timeout detection, and integration-style tests
 * that spawn the wait command with temp DB.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import { cleanChildEnv } from "../../../tests/helpers/test-env.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the tamandua shell wrapper
const tamanduaBin = path.resolve(__dirname, "..", "..", "..", "bin", "tamandua");

// ── Helpers ──────────────────────────────────────────────────────────

function setupTempDb(): {
  tempRoot: string;
  db: DatabaseSync;
  dbPath: string;
} {
  const tempRoot = tamanduaTempDir("tamandua-wait-");
  const dbPath = path.join(tempRoot, ".tamandua", "tamandua.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL DEFAULT 'test',
      task TEXT NOT NULL DEFAULT 'test',
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      notify_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      input_template TEXT NOT NULL DEFAULT '',
      expects TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'waiting',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      type TEXT NOT NULL DEFAULT 'single',
      loop_config TEXT,
      current_story_id TEXT,
      abandoned_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tamandua_stats (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      system_tokens_spent INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO tamandua_stats (id, system_tokens_spent) VALUES (1, 0);
  `);
  return { tempRoot, db, dbPath };
}

function insertRun(
  db: DatabaseSync,
  id: string,
  runNumber: number,
  workflowId: string,
  status: string,
  tokensSpent = 0,
  createdAt?: string,
): void {
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, tokens_spent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    runNumber,
    workflowId,
    "Task for " + id,
    status,
    tokensSpent,
    createdAt ?? new Date().toISOString(),
    new Date().toISOString(),
  );
}

function insertStep(
  db: DatabaseSync,
  id: string,
  runId: string,
  stepId: string,
  agentId: string,
  status: string,
  stepIndex = 0,
): void {
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', '', ?, datetime('now'), datetime('now'))`,
  ).run(id, runId, stepId, agentId, stepIndex, status);
}

/**
 * Run tamandua workflow wait as a spawned shell script (the real CLI).
 */
function runWait(args: string[], env: Record<string, string>, timeout = 15_000) {
  return spawnSync("/bin/sh", [tamanduaBin, "workflow", "wait", ...args], {
    encoding: "utf8",
    env: cleanChildEnv(env),
    timeout,
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe("wait command", () => {
  let tempRoot: string;
  let db: DatabaseSync;
  let dbPath: string;
  let originalDbPath: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    originalHome = process.env.HOME;
    const setup = setupTempDb();
    tempRoot = setup.tempRoot;
    db = setup.db;
    dbPath = setup.dbPath;
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.HOME = tempRoot;
  });

  afterEach(() => {
    if (originalDbPath) process.env.TAMANDUA_DB_PATH = originalDbPath;
    else delete process.env.TAMANDUA_DB_PATH;
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── Unit: exit code computation ────────────────────────────────────

  it("computeExitCode returns 0 when all runs are done", async () => {
    const { computeExitCode } = await import("../../../dist/cli/commands/wait.js");
    const states = [
      { runId: "a", runNumber: 1, workflowId: "wf", status: "completed", tokensSpent: 0, createdAt: "", updatedAt: "", steps: { done: 2, failed: 0, pending: 0, running: 0, waiting: 0, canceled: 0 } },
      { runId: "b", runNumber: 2, workflowId: "wf", status: "done", tokensSpent: 0, createdAt: "", updatedAt: "", steps: { done: 3, failed: 0, pending: 0, running: 0, waiting: 0, canceled: 0 } },
    ];
    assert.equal(computeExitCode(states, false), 0);
  });

  it("computeExitCode returns 1 when at least one run failed", async () => {
    const { computeExitCode } = await import("../../../dist/cli/commands/wait.js");
    const states = [
      { runId: "a", runNumber: 1, workflowId: "wf", status: "completed", tokensSpent: 0, createdAt: "", updatedAt: "", steps: { done: 2, failed: 0, pending: 0, running: 0, waiting: 0, canceled: 0 } },
      { runId: "b", runNumber: 2, workflowId: "wf", status: "failed", tokensSpent: 0, createdAt: "", updatedAt: "", steps: { done: 1, failed: 1, pending: 0, running: 0, waiting: 0, canceled: 0 } },
    ];
    assert.equal(computeExitCode(states, false), 1);
  });

  it("computeExitCode returns 3 when canceled and no failed", async () => {
    const { computeExitCode } = await import("../../../dist/cli/commands/wait.js");
    const states = [
      { runId: "a", runNumber: 1, workflowId: "wf", status: "canceled", tokensSpent: 0, createdAt: "", updatedAt: "", steps: { done: 1, failed: 0, pending: 0, running: 0, waiting: 0, canceled: 1 } },
      { runId: "b", runNumber: 2, workflowId: "wf", status: "completed", tokensSpent: 0, createdAt: "", updatedAt: "", steps: { done: 3, failed: 0, pending: 0, running: 0, waiting: 0, canceled: 0 } },
    ];
    assert.equal(computeExitCode(states, false), 3);
  });

  it("computeExitCode returns 1 over 3 when both failed and canceled", async () => {
    const { computeExitCode } = await import("../../../dist/cli/commands/wait.js");
    const states = [
      { runId: "a", runNumber: 1, workflowId: "wf", status: "failed", tokensSpent: 0, createdAt: "", updatedAt: "", steps: { done: 0, failed: 1, pending: 0, running: 0, waiting: 0, canceled: 0 } },
      { runId: "b", runNumber: 2, workflowId: "wf", status: "canceled", tokensSpent: 0, createdAt: "", updatedAt: "", steps: { done: 1, failed: 0, pending: 0, running: 0, waiting: 0, canceled: 1 } },
    ];
    assert.equal(computeExitCode(states, false), 1);
  });

  it("getWaitHelp documents exit code 3 for canceled runs (contract vs computeExitCode)", async () => {
    const { getWaitHelp } = await import("../../../dist/cli/commands/wait.js");
    const help = getWaitHelp();

    // The help text is the documented contract for `workflow wait` exit codes.
    // Pin the canceled line so drift between help and computeExitCode is caught:
    // computeExitCode returns 3 only when a run is canceled and none failed,
    // and precedence puts failed (1) above canceled (3) — see the unit tests above.
    assert.ok(
      help.includes("3   At least one run canceled (and none failed)"),
      `getWaitHelp must document exit code 3 for canceled runs; got:\n${help}`,
    );
    assert.ok(
      help.includes("1   At least one run failed"),
      `getWaitHelp must document the failed-over-canceled precedence; got:\n${help}`,
    );
  });

  it("computeExitCode returns 2 when timedOut is true", async () => {
    const { computeExitCode } = await import("../../../dist/cli/commands/wait.js");
    const states = [
      { runId: "a", runNumber: 1, workflowId: "wf", status: "running", tokensSpent: 0, createdAt: "", updatedAt: "", steps: { done: 1, failed: 0, pending: 1, running: 0, waiting: 0, canceled: 0 } },
    ];
    assert.equal(computeExitCode(states, true), 2);
  });

  // ── Unit: JSON output shape ────────────────────────────────────────

  it("formatJsonOutput returns valid JSON with correct shape", async () => {
    const { formatJsonOutput } = await import("../../../dist/cli/commands/wait.js");
    const result = {
      runs: [{
        runId: "aaa-bbb-ccc",
        runNumber: 42,
        workflowId: "test-wf",
        status: "completed",
        tokensSpent: 12345,
        createdAt: new Date(Date.now() - 120_000).toISOString(),
        updatedAt: new Date().toISOString(),
        steps: { done: 5, failed: 0, pending: 0, running: 0, waiting: 0, canceled: 0 },
      }],
      timedOut: false,
    };

    const jsonStr = formatJsonOutput(result);
    const parsed = JSON.parse(jsonStr);
    assert.equal(parsed.timedOut, false);
    assert.equal(parsed.runs.length, 1);
    assert.equal(parsed.runs[0].runId, "run-aaa-bbb-ccc");
    assert.equal(parsed.runs[0].runNumber, 42);
    assert.equal(parsed.runs[0].workflowId, "test-wf");
    assert.equal(parsed.runs[0].status, "completed");
    assert.equal(parsed.runs[0].tokensSpent, 12345);
    assert.equal(typeof parsed.runs[0].durationMs, "number");
    assert.deepEqual(parsed.runs[0].steps, { done: 5, failed: 0, pending: 0, running: 0 });
  });

  it("formatJsonOutput with timedOut true", async () => {
    const { formatJsonOutput } = await import("../../../dist/cli/commands/wait.js");
    const result = {
      runs: [],
      timedOut: true,
    };

    const jsonStr = formatJsonOutput(result);
    const parsed = JSON.parse(jsonStr);
    assert.equal(parsed.timedOut, true);
    assert.equal(parsed.runs.length, 0);
  });

  // ── Unit: human output format ──────────────────────────────────────

  it("formatHumanOutput returns one line per run", async () => {
    const { formatHumanOutput } = await import("../../../dist/cli/commands/wait.js");
    const result = {
      runs: [
        {
          runId: "aaa-bbb-ccc",
          runNumber: 1,
          workflowId: "feature-dev",
          status: "completed",
          tokensSpent: 100,
          createdAt: new Date(Date.now() - 120_000).toISOString(),
          updatedAt: new Date().toISOString(),
          steps: { done: 3, failed: 0, pending: 0, running: 0, waiting: 0, canceled: 0 },
        },
        {
          runId: "ddd-eee-fff",
          runNumber: 2,
          workflowId: "bug-fix",
          status: "failed",
          tokensSpent: 200,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          updatedAt: new Date().toISOString(),
          steps: { done: 1, failed: 1, pending: 0, running: 0, waiting: 0, canceled: 0 },
        },
      ],
      timedOut: false,
    };

    const output = formatHumanOutput(result);
    const lines = output.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes("#1"));
    assert.ok(lines[0].includes("feature-dev"));
    assert.ok(lines[0].includes("completed"));
    assert.ok(lines[1].includes("#2"));
    assert.ok(lines[1].includes("bug-fix"));
    assert.ok(lines[1].includes("failed"));
  });

  // ── Unit: formatElapsed ────────────────────────────────────────────

  it("formatElapsed formats seconds only", async () => {
    const { formatElapsed } = await import("../../../dist/cli/commands/wait.js");
    assert.equal(formatElapsed(5_000), "0m05s");
    assert.equal(formatElapsed(59_000), "0m59s");
  });

  it("formatElapsed formats minutes and seconds", async () => {
    const { formatElapsed } = await import("../../../dist/cli/commands/wait.js");
    assert.equal(formatElapsed(65_000), "1m05s");
    assert.equal(formatElapsed(125_000), "2m05s");
    assert.equal(formatElapsed(3_660_000), "61m00s");
  });

  // ── Integration: wait completes immediately when run is already done ──

  it("exits 0 immediately when run is already completed", () => {
    insertRun(db, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "test-wf", "completed");

    const result = runWait(
      ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"],
      { HOME: tempRoot, TAMANDUA_DB_PATH: dbPath, TAMANDUA_TEST_GUARD: "0" },
    );

    assert.equal(result.status, 0);
  });

  // ── Integration: wait exits 1 when run has failed ──

  it("exits 1 when run status is failed", () => {
    insertRun(db, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "test-wf", "failed");

    const result = runWait(
      ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"],
      { HOME: tempRoot, TAMANDUA_DB_PATH: dbPath, TAMANDUA_TEST_GUARD: "0" },
    );

    assert.equal(result.status, 1);
  });

  // ── Integration: --json output ─────────────────────────────────────

  it("--json outputs valid JSON to stdout for completed run", () => {
    insertRun(db, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "test-wf", "completed", 500);

    const result = runWait(
      ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "--json"],
      { HOME: tempRoot, TAMANDUA_DB_PATH: dbPath, TAMANDUA_TEST_GUARD: "0" },
    );

    assert.equal(result.status, 0);

    // Parse stdout as JSON
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.timedOut, false);
    assert.equal(parsed.runs.length, 1);
    assert.equal(parsed.runs[0].runId, "run-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    assert.equal(parsed.runs[0].status, "completed");
    assert.equal(parsed.runs[0].tokensSpent, 500);
  });

  // ── Integration: --quiet suppresses output ─────────────────────────

  it("--quiet suppresses stdout for completed run", () => {
    insertRun(db, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "test-wf", "completed");

    const result = runWait(
      ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "--quiet"],
      { HOME: tempRoot, TAMANDUA_DB_PATH: dbPath, TAMANDUA_TEST_GUARD: "0" },
    );

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  });

  // ── Integration: --quiet with --json still outputs JSON ────────────

  it("--quiet --json still outputs JSON to stdout", () => {
    insertRun(db, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "test-wf", "completed");

    const result = runWait(
      ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "--quiet", "--json"],
      { HOME: tempRoot, TAMANDUA_DB_PATH: dbPath, TAMANDUA_TEST_GUARD: "0" },
    );

    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.runs.length, 1);
  });

  // ── Integration: timeout exits with code 2 ─────────────────────────

  it("exits with code 2 on timeout when run is still running", () => {
    // Insert a run that's still running
    insertRun(db, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "test-wf", "running");
    insertStep(db, "step-1", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "implement", "dev", "running", 0);

    const result = runWait(
      ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "--timeout", "2s"],
      { HOME: tempRoot, TAMANDUA_DB_PATH: dbPath, TAMANDUA_TEST_GUARD: "0" },
      10_000,
    );

    assert.equal(result.status, 2);
  });

  // ── Integration: timeout with --json includes timedOut ─────────────

  it("--timeout --json output has timedOut: true", () => {
    insertRun(db, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "test-wf", "running");
    insertStep(db, "step-1", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "implement", "dev", "running", 0);

    const result = runWait(
      ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "--timeout", "2s", "--json"],
      { HOME: tempRoot, TAMANDUA_DB_PATH: dbPath, TAMANDUA_TEST_GUARD: "0" },
      10_000,
    );

    assert.equal(result.status, 2);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.timedOut, true);
    assert.equal(parsed.runs[0].status, "running");
  });

  // ── Integration: selector not found exits 4 ────────────────────────

  it("exits with code 4 when selector not found", () => {
    const result = runWait(
      ["nonexistent-run"],
      { HOME: tempRoot, TAMANDUA_DB_PATH: dbPath, TAMANDUA_TEST_GUARD: "0" },
    );

    assert.equal(result.status, 4);
    assert.ok(result.stderr.includes("No run found matching"));
  });

  // ── Integration: --all waits for running runs when all become done ──

  it("--all waits for running runs when all become done", async () => {
    insertRun(db, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "test-wf", "running");
    insertRun(db, "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", 2, "test-wf", "running");

    const { spawn } = await import("node:child_process");
    const child = spawn(
      "/bin/sh",
      [tamanduaBin, "workflow", "wait", "--all", "--timeout", "5s"],
      {
        env: cleanChildEnv({ HOME: tempRoot, TAMANDUA_DB_PATH: dbPath, TAMANDUA_TEST_GUARD: "0" }),
        stdio: "pipe",
      },
    );

    // After a short delay, mark one run as done
    await new Promise((resolve) => setTimeout(resolve, 500));
    db.prepare("UPDATE runs SET status = 'completed', updated_at = datetime('now') WHERE id = ?")
      .run("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

    // Mark the second one as done too
    await new Promise((resolve) => setTimeout(resolve, 500));
    db.prepare("UPDATE runs SET status = 'completed', updated_at = datetime('now') WHERE id = ?")
      .run("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");

    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? -1));
    });

    // Should exit 0 because both runs completed
    assert.equal(exitCode, 0);

    if (!child.killed) child.kill();
  });

  // ── Integration: DB flip triggers early wakeup ─────────────────────

  it("DB status flip during wait triggers unblock and exits 0", async () => {
    insertRun(db, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "test-wf", "running");
    insertStep(db, "step-1", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "implement", "dev", "running", 0);

    const { spawn } = await import("node:child_process");
    const child = spawn(
      "/bin/sh",
      [tamanduaBin, "workflow", "wait", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "--timeout", "10s"],
      {
        env: cleanChildEnv({ HOME: tempRoot, TAMANDUA_DB_PATH: dbPath, TAMANDUA_TEST_GUARD: "0" }),
        stdio: "pipe",
      },
    );

    // After a short delay, flip the run to completed
    await new Promise((resolve) => setTimeout(resolve, 1500));
    db.prepare("UPDATE runs SET status = 'completed', updated_at = datetime('now') WHERE id = ?")
      .run("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    db.prepare("UPDATE steps SET status = 'done', updated_at = datetime('now') WHERE run_id = ?")
      .run("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? -1));
    });

    assert.equal(exitCode, 0);

    if (!child.killed) child.kill();
  });

  // ── Integration: #N selector ───────────────────────────────────────

  it("#N selector resolves run by number", () => {
    insertRun(db, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 42, "test-wf", "completed");

    const result = runWait(
      ["#42"],
      { HOME: tempRoot, TAMANDUA_DB_PATH: dbPath, TAMANDUA_TEST_GUARD: "0" },
    );

    assert.equal(result.status, 0);
  });

  // ── Unit: extractSelectors ─────────────────────────────────────────

  it("extractSelectors skips flag tokens", async () => {
    const { extractSelectors } = await import("../../../dist/cli/commands/wait.js");
    const result = extractSelectors([
      "run-abc",
      "--json",
      "--all",
      "--timeout",
      "30s",
      "run-def",
      "--quiet",
    ]);
    assert.deepEqual(result, ["run-abc", "run-def"]);
  });

  it("extractSelectors handles --timeout=value inline form", async () => {
    const { extractSelectors } = await import("../../../dist/cli/commands/wait.js");
    const result = extractSelectors([
      "run-abc",
      "--timeout=30s",
      "run-def",
    ]);
    assert.deepEqual(result, ["run-abc", "run-def"]);
  });

  // ── Integration: multiple selectors ────────────────────────────────

  it("waits for multiple selectors", () => {
    insertRun(db, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "test-wf", "completed");
    insertRun(db, "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", 2, "test-wf", "completed");

    const result = runWait(
      ["aaaaaaaa", "bbbbbbbb"],
      { HOME: tempRoot, TAMANDUA_DB_PATH: dbPath, TAMANDUA_TEST_GUARD: "0" },
    );

    assert.equal(result.status, 0);
  });

  // ── Integration: --help outputs help text ──────────────────────────

  it("--help prints help text", () => {
    const result = spawnSync(
      "/bin/sh",
      [tamanduaBin, "workflow", "wait", "--help"],
      {
        encoding: "utf8",
        env: cleanChildEnv({ HOME: tempRoot, TAMANDUA_DB_PATH: dbPath, TAMANDUA_TEST_GUARD: "0" }),
        timeout: 10_000,
      },
    );

    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("tamandua workflow wait"));
    assert.ok(result.stdout.includes("Exit codes"));
  });

  // ── Integration: workflow stop → wait exits 3 promptly (CNEV US-006) ──
  //
  // Contract: after `tamandua workflow stop` on a running run, `tamandua
  // workflow wait <run-id>` terminates promptly (within a few 2s poll
  // intervals) with the documented exit code 3. The stop itself emits the
  // terminal run.canceled event, so the run's event file ends on a terminal
  // record — not on a straggling run.tokens.updated.

  it("workflow stop then workflow wait exits 3 promptly with run.canceled as terminal event", () => {
    const runId = "cccccccc-dddd-4eee-8fff-000000000000";
    insertRun(db, runId, 7, "test-wf", "running");
    insertStep(db, "step-1", runId, "implement", "test-wf_developer", "running", 0);

    const env = { HOME: tempRoot, TAMANDUA_DB_PATH: dbPath, TAMANDUA_TEST_GUARD: "0" };

    // Cancel the running run through the real CLI stop path.
    const stopResult = spawnSync(
      "/bin/sh",
      [tamanduaBin, "workflow", "stop", runId],
      {
        encoding: "utf8",
        env: cleanChildEnv(env),
        timeout: 15_000,
      },
    );

    assert.equal(
      stopResult.status, 0,
      `workflow stop should succeed, got exit ${stopResult.status}, stderr: ${stopResult.stderr}`,
    );
    assert.ok(
      stopResult.stdout.includes("Cancelled run"),
      `Expected "Cancelled run" in stop stdout, got: ${stopResult.stdout}`,
    );

    // The run's event file must end on the terminal run.canceled record
    // (CNEV: DB and event stream agree; waiters see a terminal event).
    const eventsFile = path.join(tempRoot, ".tamandua", "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(eventsFile), `Expected per-run events file at ${eventsFile}`);
    const eventLines = fs
      .readFileSync(eventsFile, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    assert.ok(eventLines.length > 0, "Expected at least one event in the run's event file");
    const lastEvent = JSON.parse(eventLines[eventLines.length - 1]);
    assert.equal(lastEvent.event, "run.canceled");
    assert.equal(lastEvent.runId, runId);
    assert.equal(lastEvent.reason, "cli-stop");

    // Wait on the canceled run: must exit 3 promptly (a hang would hit the
    // spawnSync timeout and fail the status assertion).
    const startedAt = Date.now();
    const waitResult = spawnSync(
      "/bin/sh",
      [tamanduaBin, "workflow", "wait", runId],
      {
        encoding: "utf8",
        env: cleanChildEnv(env),
        timeout: 30_000,
      },
    );
    const elapsedMs = Date.now() - startedAt;

    assert.equal(
      waitResult.status, 3,
      `workflow wait on canceled run should exit 3, got exit ${waitResult.status}, stderr: ${waitResult.stderr}`,
    );
    assert.ok(
      elapsedMs < 8_000,
      `workflow wait took ${elapsedMs}ms — expected prompt exit within a few poll intervals (2s each)`,
    );
  });

  it("workflow wait on a canceled run exits 3 immediately without stop", () => {
    // Defense: even if the run was already canceled (e.g., by an earlier
    // session or the dashboard), wait must resolve it as terminal — exit 3,
    // no hang, no timeout.
    const runId = "dddddddd-eeee-4fff-8aaa-111111111111";
    insertRun(db, runId, 8, "test-wf", "canceled");
    insertStep(db, "step-1", runId, "implement", "test-wf_developer", "canceled", 0);

    const startedAt = Date.now();
    const result = runWait(
      [runId],
      { HOME: tempRoot, TAMANDUA_DB_PATH: dbPath, TAMANDUA_TEST_GUARD: "0" },
      30_000,
    );
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.status, 3);
    assert.ok(elapsedMs < 8_000, `wait took ${elapsedMs}ms — expected prompt exit`);
  });
});
