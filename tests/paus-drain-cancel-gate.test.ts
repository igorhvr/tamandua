/**
 * PAUS US-007 proof gate — drain-cancel-on-resume regression (live daemon).
 *
 * Proves the 2026-08-24 drain rule end-to-end through the REAL product stack
 * (spawned dist/server/daemon.js + the CLI subprocess):
 *
 *  - A run with a pending drain (pause --drain in progress: status 'running',
 *    scheduling_status 'draining_pause', pause_drain context marker, and an
 *    in-flight step so the drain is genuinely pending) that receives a plain
 *    `tamandua workflow resume` has the drain CANCELLED: the CLI exits 0 and
 *    prints the operator warning, the run leaves draining_pause, the daemon
 *    admits it (scheduling_status 'active'), and the run's event stream
 *    records run.drain_cancelled_by_resume with NO drain-induced run.paused
 *    following the resume.
 *  - Control case in the same file: a plain paused run (scheduling 'paused',
 *    no drain) resumes unchanged — no drain-cancel event, no warning.
 *
 * Harness shape (modeled on tests/cli-resume-command.test.ts and
 * tests/cli-pause-resume-integration.test.ts):
 *  - temp HOME / state dir; runs and steps tables seeded directly with
 *    scheduling_status columns; the feature-dev-merge workflow directory is
 *    copied into the state dir so the daemon can load the spec on admission.
 *  - dist/server/daemon.js is spawned on a random TAMANDUA_CONTROL_PORT; the
 *    CLI resume subprocess drives the exact product resume path against it.
 *  - Polling is bounded; only the spawned daemon pid is killed (finally).
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

interface SeedStep {
  stepId: string;
  agentId: string;
  /** Explicit per-step status; the seed helper never fabricates one. */
  status: string;
}

/**
 * Create the runs + steps tables (with scheduling columns) and seed a single
 * run whose scheduling state mirrors a mid-pause/mid-drain run. The context
 * carries pause_drain when the drain scenario needs the historical marker.
 */
function seedRunAndSteps(
  dbPath: string,
  runId: string,
  workflowId: string,
  runStatus: string,
  schedulingStatus: string | null,
  context: Record<string, unknown>,
  steps: SeedStep[],
): void {
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
      scheduling_status TEXT,
      scheduling_requested_at TEXT,
      scheduling_error TEXT
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
      max_retries INTEGER DEFAULT 4,
      type TEXT NOT NULL DEFAULT 'single',
      loop_config TEXT,
      current_story_id TEXT,
      abandoned_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const now = new Date().toISOString();
  const harnessDir = path.dirname(dbPath);
  const runContext = JSON.stringify({
    task: "PAUS US-007 gate",
    repo: harnessDir,
    working_directory_for_harness: harnessDir,
    ...context,
  });

  db.prepare(
    `INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, run_number, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
  ).run(runId, workflowId, "PAUS US-007 gate run", runStatus, runContext, schedulingStatus, now, now);

  const insertStep = db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    insertStep.run(
      crypto.randomUUID(), runId, s.stepId, s.agentId, i,
      "test input", "STATUS: done", s.status, "single", now, now,
    );
  }

  db.close();
}

interface RunRow {
  status: string;
  scheduling_status: string | null;
  context: string;
}

function readRun(dbPath: string, runId: string): RunRow | undefined {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare(
    "SELECT status, scheduling_status, context FROM runs WHERE id = ?",
  ).get(runId) as RunRow | undefined;
  db.close();
  return row;
}

async function pollSchedulingStatus(
  dbPath: string,
  runId: string,
  expected: string,
  timeoutMs = 10_000,
): Promise<RunRow> {
  const startedAt = Date.now();
  let row: RunRow | undefined;
  do {
    row = readRun(dbPath, runId);
    if (row && row.scheduling_status === expected) return row;
    await sleep(150);
  } while (Date.now() - startedAt < timeoutMs);
  throw new Error(
    `run ${runId} scheduling_status never became "${expected}"; last: ${JSON.stringify(row ?? null)}`,
  );
}

/** Read the run-scoped JSONL event stream, [] when the file is absent. */
function readRunEvents(stateDir: string, runId: string): Array<Record<string, unknown>> {
  const eventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function copyWorkflow(stateDir: string, workflowId: string): void {
  const srcWorkflowDir = path.resolve(__dirname, "..", "workflows", workflowId);
  const dstWorkflowDir = path.join(stateDir, "workflows", workflowId);
  fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
  fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });
}

// ── Tests ──────────────────────────────────────────────────────────

describe("PAUS US-007 proof gate — drain-cancel on plain resume (live daemon)", { concurrency: 1 }, () => {
  // ── Drain-pending run: resume must cancel the drain, warn, and proceed ──
  it("plain resume of a drain-pending run cancels the drain, warns, and the daemon admits the run (no drain-induced run.paused)", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT) || !fs.existsSync(DAEMON_SCRIPT)) {
      t.skip("CLI/daemon not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();
    const th = createTempHome("tamandua-paus-drain-gate-");
    copyWorkflow(th.tamanduaDir, "feature-dev-merge");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");
    const runId = crypto.randomUUID();

    // A genuinely pending drain: pause --drain was issued while a step was
    // in-flight, so the run stays status 'running' with scheduling
    // 'draining_pause', the pause_drain marker is set, and the in-flight
    // 'running' step keeps the drain from finalizing.
    seedRunAndSteps(dbPath, runId, "feature-dev-merge", "running", "draining_pause", {
      pause_drain: "true",
    }, [
      { stepId: "plan", agentId: "feature-dev-merge_planner", status: "done" },
      { stepId: "implement", agentId: "feature-dev-merge_developer", status: "running" },
      { stepId: "verify", agentId: "feature-dev-merge_verifier", status: "waiting" },
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

      // The seeded drain state must still be draining_pause before the resume
      // (a live daemon must NOT have auto-finalized it).
      const before = readRun(dbPath, runId);
      assert.equal(before?.status, "running");
      assert.equal(before?.scheduling_status, "draining_pause");
      assert.ok(JSON.parse(before?.context ?? "{}").pause_drain === "true");

      // ── AC1: CLI resume exits 0 and prints the drain-cancel warning ──
      const resume = await runCli(
        ["workflow", "resume", runId],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );
      assert.equal(
        resume.exitCode, 0,
        `resume should exit 0, got ${resume.exitCode}, stderr: ${cleanStderr(resume.stderr)}`,
      );
      assert.ok(
        cleanStderr(resume.stderr).includes("had a pending drain in progress; plain resume cancels the drain"),
        `expected the drain-cancel warning on stderr, got: ${cleanStderr(resume.stderr)}`,
      );
      assert.ok(
        resume.stdout.includes("Resumed run"),
        `expected "Resumed run" in stdout, got: ${resume.stdout}`,
      );

      // ── AC2: scheduling leaves draining_pause and the daemon admits ──
      const admitted = await pollSchedulingStatus(dbPath, runId, "active");
      assert.equal(admitted.status, "running", "run should stay running after drain-cancel resume");
      assert.notEqual(
        admitted.scheduling_status, "draining_pause",
        "scheduling_status must leave draining_pause",
      );
      assert.equal(admitted.scheduling_status, "active", "daemon should admit the run as active");

      // The pause_drain marker is cleared by the atomic drain-cancel.
      const ctx = JSON.parse(admitted.context) as Record<string, unknown>;
      assert.ok(!("pause_drain" in ctx), "pause_drain marker should be cleared by resume");

      // ── AC3: event stream records the cancel; no drain-induced run.paused ──
      const events = readRunEvents(th.tamanduaDir, runId);
      const cancelIdx = events.findIndex((e) => e.event === "run.drain_cancelled_by_resume");
      assert.ok(cancelIdx >= 0, "expected a run.drain_cancelled_by_resume event");
      assert.equal(events[cancelIdx].runId, runId, "drain-cancel event must carry the run id");
      const resumedIdx = events.findIndex((e) => e.event === "run.resumed");
      assert.ok(resumedIdx >= 0, "expected a run.resumed event");
      assert.ok(
        cancelIdx < resumedIdx,
        "run.drain_cancelled_by_resume must precede run.resumed",
      );
      const pausedAfterResume = events
        .slice(resumedIdx)
        .filter((e) => e.event === "run.paused");
      assert.equal(
        pausedAfterResume.length, 0,
        `no drain-induced run.paused may follow the resume: ${JSON.stringify(events)}`,
      );
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });

  // ── Control: plain paused run resumes without drain semantics ──
  it("plain resume of a paused run (no pending drain) emits no drain-cancel event and no warning", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT) || !fs.existsSync(DAEMON_SCRIPT)) {
      t.skip("CLI/daemon not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();
    const th = createTempHome("tamandua-paus-drain-control-");
    copyWorkflow(th.tamanduaDir, "feature-dev-merge");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");
    const runId = crypto.randomUUID();

    seedRunAndSteps(dbPath, runId, "feature-dev-merge", "paused", "paused", {}, [
      { stepId: "plan", agentId: "feature-dev-merge_planner", status: "pending" },
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

      const resume = await runCli(
        ["workflow", "resume", runId],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );
      assert.equal(
        resume.exitCode, 0,
        `paused-run resume should exit 0, got ${resume.exitCode}, stderr: ${cleanStderr(resume.stderr)}`,
      );
      assert.ok(
        resume.stdout.includes("Resumed run"),
        `expected "Resumed run" in stdout, got: ${resume.stdout}`,
      );
      assert.ok(
        !cleanStderr(resume.stderr).includes("pending drain"),
        `paused-run resume must not print the drain warning, got: ${cleanStderr(resume.stderr)}`,
      );

      // The paused run resumes to running and the daemon admits it — exactly
      // as before the drain rule (no behavioral change for non-drain resumes).
      const admitted = await pollSchedulingStatus(dbPath, runId, "active");
      assert.equal(admitted.status, "running", "paused run should be running after resume");

      // No drain-cancel event may be written for a non-drain resume.
      const events = readRunEvents(th.tamanduaDir, runId);
      assert.ok(
        events.length > 0,
        "resume should emit run-level events (run.resumed at minimum)",
      );
      assert.equal(
        events.filter((e) => e.event === "run.drain_cancelled_by_resume").length,
        0,
        "paused-run resume must not emit run.drain_cancelled_by_resume",
      );
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });
});
