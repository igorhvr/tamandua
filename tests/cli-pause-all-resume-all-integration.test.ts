/**
 * Integration tests for pause-all, resume-all, and drain semantics (US-010).
 *
 * Validates:
 * 1. pause-all pauses all running runs (AC 1)
 * 2. resume-all resumes all paused runs (AC 2)
 * 3. drain=true allows in-flight work to complete before pause (AC 3)
 * 4. Terminal runs are not affected by pause-all or resume-all (AC 4)
 * 5. Events are emitted for run.paused and run.resumed (AC 5)
 * 6. Tests for pause-all and drain pass (AC 6)
 * 7. Typecheck passes (checked separately)
 *
 * These are integration-level tests: they spawn a daemon, register runs
 * via the control plane, then exercise CLI pause-all / resume-all and
 * verify scheduler timers, DB state, and event emission.
 */

import { describe, it } from "node:test";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import crypto from "node:crypto";
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

function readDaemonSecret(homeDir: string): string {
  const secretPath = path.join(homeDir, ".tamandua", "daemon-secret");
  return fs.readFileSync(secretPath, "utf-8").trim();
}

async function controlFetch(
  controlPort: number,
  endpoint: string,
  method = "GET",
  body?: unknown,
  secret?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (secret) headers["x-tamandua-secret"] = secret;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${controlPort}${endpoint}`, {
    method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let resBody: unknown;
  try {
    resBody = await res.json();
  } catch {
    resBody = null;
  }
  return { status: res.status, body: resBody };
}

/**
 * Fetch the set of runIds that currently have scheduler jobs from the control plane.
 */
async function getSchedulerRunIds(controlPort: number, secret: string): Promise<Set<string>> {
  const { body } = await controlFetch(controlPort, "/control/jobs", "GET", undefined, secret);
  const jobs = (body as { jobs?: Array<{ runId: string }> }).jobs ?? [];
  return new Set(jobs.map((j) => j.runId));
}

interface SeedStep {
  stepId: string;
  agentId: string;
  stepStatus?: string;
}

/**
 * Seed a run and its steps into the test DB. The first step defaults to
 * "pending" and the rest to "waiting" unless stepStatus overrides.
 */
function seedRunAndSteps(
  dbPath: string,
  runId: string,
  workflowId: string,
  runStatus: string,
  schedulingStatus: string | null,
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
  const harnessDir = path.join(path.dirname(dbPath), "harness", runId);
  fs.mkdirSync(harnessDir, { recursive: true });
  const context = JSON.stringify({
    task: "Integration test",
    repo: harnessDir,
    working_directory_for_harness: harnessDir,
  });

  db.prepare(
    `INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, run_number, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
  ).run(runId, workflowId, "Test integration run", runStatus, context, schedulingStatus, now, now);

  const insertStep = db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, max_retries, type, loop_config, current_story_id, abandoned_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)`,
  );

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const stepStatus = s.stepStatus ?? (i === 0 ? "pending" : "waiting");
    insertStep.run(
      crypto.randomUUID(), runId, s.stepId, s.agentId, i,
      "test input", "STATUS: done", stepStatus, 0, "single", now, now,
    );
  }

  db.close();
}

/**
 * Read events for a specific run from the per-run events file.
 */
function readRunEvents(homeDir: string, runId: string): Array<Record<string, unknown>> {
  const eventsPath = path.join(homeDir, ".tamandua", "events", `${runId}.jsonl`);
  if (!fs.existsSync(eventsPath)) return [];
  const content = fs.readFileSync(eventsPath, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line));
}

/**
 * Create workflow directory in the test HOME so the daemon can register runs.
 */
function copyWorkflowDir(homeDir: string): void {
  const srcWorkflowDir = path.resolve(__dirname, "..", "workflows", "feature-dev-merge");
  const dstWorkflowDir = path.join(homeDir, ".tamandua", "workflows", "feature-dev-merge");
  fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
  fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });
}

// ── Tests ──────────────────────────────────────────────────────────

describe("pause-all / resume-all integration", { concurrency: 1 }, () => {
  // ── AC 1: pause-all pauses all running runs; scheduler timers removed ──
  it("pause-all removes scheduler timers for all running runs", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-pa-int-test-");

    copyWorkflowDir(th.homeDir);

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const run1 = crypto.randomUUID();
    const run2 = crypto.randomUUID();
    const run3 = crypto.randomUUID();

    const steps: SeedStep[] = [
      { stepId: "plan", agentId: "feature-dev-merge_planner" },
      { stepId: "setup", agentId: "feature-dev-merge_setup" },
    ];

    seedRunAndSteps(dbPath, run1, "feature-dev-merge", "running", "pending_register", steps);
    seedRunAndSteps(dbPath, run2, "feature-dev-merge", "running", "pending_register", steps);
    seedRunAndSteps(dbPath, run3, "feature-dev-merge", "running", "pending_register", steps);

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

      // Register all runs
      const secret = readDaemonSecret(th.homeDir);
      for (const rid of [run1, run2, run3]) {
        const regResp = await controlFetch(controlPort, "/control/register-run", "POST", { runId: rid }, secret);
        assert.ok(
          regResp.status === 200 || regResp.status === 202,
          `Expected register-run success for ${rid.slice(0, 8)}, got ${regResp.status}`,
        );
      }

      // Verify scheduler timers exist for all runs
      const jobsBefore = await getSchedulerRunIds(controlPort, secret);
      assert.ok(jobsBefore.has(run1), `Expected scheduler job for run1`);
      assert.ok(jobsBefore.has(run2), `Expected scheduler job for run2`);
      assert.ok(jobsBefore.has(run3), `Expected scheduler job for run3`);

      // pause-all via CLI
      const result = await runCli(
        ["workflow", "pause-all"],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(result.exitCode, 0, `pause-all should succeed, got exit ${result.exitCode}, stderr: ${cleanStderr(result.stderr)}`);
      assert.ok(
        result.stdout.includes("Paused 3 run(s)"),
        `Expected "Paused 3 run(s)", got: ${result.stdout}`,
      );

      // Verify scheduler timers are removed for all three runs
      const jobsAfter = await getSchedulerRunIds(controlPort, secret);
      assert.ok(!jobsAfter.has(run1), `Expected no scheduler job for run1 after pause-all`);
      assert.ok(!jobsAfter.has(run2), `Expected no scheduler job for run2 after pause-all`);
      assert.ok(!jobsAfter.has(run3), `Expected no scheduler job for run3 after pause-all`);

      // Verify all runs are paused in DB
      const db = new DatabaseSync(dbPath);
      for (const rid of [run1, run2, run3]) {
        const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(rid) as { status: string } | undefined;
        assert.ok(row, `Run ${rid.slice(0, 8)} should exist`);
        assert.equal(row.status, "paused", `Run ${rid.slice(0, 8)} should be paused`);
      }
      db.close();
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });

  // ── AC 2: resume-all resumes all paused runs; scheduler timers re-created ──
  it("resume-all re-creates scheduler timers for all paused runs", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-ra-int-test-");

    copyWorkflowDir(th.homeDir);

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const run1 = crypto.randomUUID();
    const run2 = crypto.randomUUID();
    const run3 = crypto.randomUUID();

    const steps: SeedStep[] = [
      { stepId: "plan", agentId: "feature-dev-merge_planner" },
    ];

    // Seed runs as paused
    seedRunAndSteps(dbPath, run1, "feature-dev-merge", "paused", "paused", steps);
    seedRunAndSteps(dbPath, run2, "feature-dev-merge", "paused", "paused", steps);
    seedRunAndSteps(dbPath, run3, "feature-dev-merge", "paused", "paused", steps);

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

      const secret = readDaemonSecret(th.homeDir);

      // Verify no scheduler timers before resume-all
      const jobsBefore = await getSchedulerRunIds(controlPort, secret);
      assert.ok(!jobsBefore.has(run1), "No scheduler job expected for paused run1");
      assert.ok(!jobsBefore.has(run2), "No scheduler job expected for paused run2");
      assert.ok(!jobsBefore.has(run3), "No scheduler job expected for paused run3");

      // resume-all via CLI
      const result = await runCli(
        ["workflow", "resume-all"],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(result.exitCode, 0, `resume-all should succeed, got exit ${result.exitCode}, stderr: ${cleanStderr(result.stderr)}`);
      assert.ok(
        result.stdout.includes("Resumed 3 run(s)"),
        `Expected "Resumed 3 run(s)", got: ${result.stdout}`,
      );

      // Verify scheduler timers are re-created for all three runs
      const jobsAfter = await getSchedulerRunIds(controlPort, secret);
      assert.ok(jobsAfter.has(run1), `Expected scheduler job for run1 after resume-all`);
      assert.ok(jobsAfter.has(run2), `Expected scheduler job for run2 after resume-all`);
      assert.ok(jobsAfter.has(run3), `Expected scheduler job for run3 after resume-all`);

      // Verify all runs are running in DB
      const db = new DatabaseSync(dbPath);
      for (const rid of [run1, run2, run3]) {
        const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(rid) as { status: string } | undefined;
        assert.ok(row, `Run ${rid.slice(0, 8)} should exist`);
        assert.equal(row.status, "running", `Run ${rid.slice(0, 8)} should be running`);
      }
      db.close();
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });

  // ── AC 3: drain=true allows in-flight work to complete before pause ──
  it("pause-all --drain keeps scheduler timers until steps complete", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-drain-int-test-");

    copyWorkflowDir(th.homeDir);

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const run1 = crypto.randomUUID();
    const run2 = crypto.randomUUID();

    const steps: SeedStep[] = [
      { stepId: "plan", agentId: "feature-dev-merge_planner" },
    ];

    seedRunAndSteps(dbPath, run1, "feature-dev-merge", "running", "pending_register", steps);
    seedRunAndSteps(dbPath, run2, "feature-dev-merge", "running", "pending_register", steps);

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

      // Register both runs
      const secret = readDaemonSecret(th.homeDir);
      for (const rid of [run1, run2]) {
        const regResp = await controlFetch(controlPort, "/control/register-run", "POST", { runId: rid }, secret);
        assert.ok(
          regResp.status === 200 || regResp.status === 202,
          `Expected register-run success for ${rid.slice(0, 8)}, got ${regResp.status}`,
        );
      }

      // Verify scheduler timers exist for both runs
      const jobsBefore = await getSchedulerRunIds(controlPort, secret);
      assert.ok(jobsBefore.has(run1), "Expected scheduler job for run1 before drain");
      assert.ok(jobsBefore.has(run2), "Expected scheduler job for run2 before drain");

      {
        const db = new DatabaseSync(dbPath);
        db.prepare("UPDATE steps SET status = 'running' WHERE run_id IN (?, ?)").run(run1, run2);
        db.close();
      }

      // pause-all --drain via CLI
      const result = await runCli(
        ["workflow", "pause-all", "--drain"],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(result.exitCode, 0, `pause-all --drain should succeed, got exit ${result.exitCode}, stderr: ${cleanStderr(result.stderr)}`);
      assert.ok(
        result.stdout.includes("Paused 2 run(s)"),
        `Expected "Paused 2 run(s)", got: ${result.stdout}`,
      );

      // AC 3: Verify drain did NOT immediately pause — status is still running,
      // scheduling_status should be draining_pause, and scheduler timers persist.
      const db = new DatabaseSync(dbPath);
      for (const rid of [run1, run2]) {
        const row = db.prepare(
          "SELECT status, scheduling_status FROM runs WHERE id = ?",
        ).get(rid) as { status: string; scheduling_status: string } | undefined;
        assert.ok(row, `Run ${rid.slice(0, 8)} should exist`);
        assert.equal(row.status, "running", `Run ${rid.slice(0, 8)} status should still be running during drain`);
        assert.equal(row.scheduling_status, "draining_pause", `Run ${rid.slice(0, 8)} scheduling_status should be draining_pause`);
      }
      db.close();

      // AC 3: Scheduler timers still exist while draining (in-flight work can complete)
      const jobsDuring = await getSchedulerRunIds(controlPort, secret);
      assert.ok(jobsDuring.has(run1), "Expected scheduler job for run1 during drain");
      assert.ok(jobsDuring.has(run2), "Expected scheduler job for run2 during drain");
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });

  // ── AC 3 continued: after drain, completing in-flight steps triggers final pause ──
  it("completing in-flight steps while draining_pause triggers transition to paused", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-drain-final-test-");

    copyWorkflowDir(th.homeDir);

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const runId = crypto.randomUUID();
    const stepId1 = crypto.randomUUID();
    const stepId2 = crypto.randomUUID();
    const stepId3 = crypto.randomUUID();

    // Create a run with THREE steps:
    // Step 0: done (already completed)
    // Step 1: running (in-flight, about to complete)
    // Step 2: waiting (still pending — NOT the last step, so advancing won't complete the run)
    {
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
          worker_lost_count INTEGER NOT NULL DEFAULT 0
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
      const context = JSON.stringify({
        task: "Drain finalize test",
        repo: harnessDir,
        working_directory_for_harness: harnessDir,
      });

      db.prepare(
        `INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, run_number, worker_lost_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 'draining_pause', NULL, 0, ?, ?)`,
      ).run(runId, "feature-dev-merge", "Drain finalize test", "running", context, now, now);

      // Step 0: done (already completed)
      db.prepare(
        `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, max_retries, type, loop_config, current_story_id, abandoned_count, created_at, updated_at)
         VALUES (?, ?, 'plan', 'feature-dev-merge_planner', 0, 'test', 'STATUS: done', 'done', 4, 'single', NULL, NULL, 0, ?, ?)`,
      ).run(stepId1, runId, now, now);

      // Step 1: running (in-flight)
      db.prepare(
        `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, max_retries, type, loop_config, current_story_id, abandoned_count, created_at, updated_at)
         VALUES (?, ?, 'setup', 'feature-dev-merge_setup', 1, 'test', 'STATUS: done', 'running', 4, 'single', NULL, NULL, 0, ?, ?)`,
      ).run(stepId2, runId, now, now);

      // Step 2: waiting (NOT the last step — completing step 1 should advance but NOT complete the run)
      db.prepare(
        `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, max_retries, type, loop_config, current_story_id, abandoned_count, created_at, updated_at)
         VALUES (?, ?, 'implement', 'feature-dev-merge_developer', 2, 'test', 'STATUS: done', 'waiting', 4, 'single', NULL, NULL, 0, ?, ?)`,
      ).run(stepId3, runId, now, now);

      db.close();
    }

    let daemon: ChildProcess | undefined;

    try {
      // Must set TAMANDUA_STATE_DIR so emitEvent() and getDb() use the same root
      daemon = spawn("node", [DAEMON_SCRIPT], {
        env: cleanChildEnv({ HOME: th.homeDir,
          TAMANDUA_CONTROL_PORT: String(controlPort),
          TAMANDUA_STATE_DIR: th.tamanduaDir, }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      daemon.stdout?.resume();
      daemon.stderr?.resume();

      await waitForControlUp(controlPort);

      // Now complete the in-flight step (stepId2) using step complete --file
      // This triggers finalizeDrainingPause internally in completeStep
      const reportFile = path.join(th.homeDir, "drain-report.txt");
      fs.writeFileSync(reportFile, "STATUS: done");
      const completeResult = await runCli(
        ["step", "complete", stepId2, "--file", reportFile],
        { HOME: th.homeDir, TAMANDUA_STATE_DIR: th.tamanduaDir },
      );

      // step complete writes to stdout, but might emit warnings
      const cleanErr = cleanStderr(completeResult.stderr);
      if (cleanErr && completeResult.exitCode !== 0) {
        // Log the error for debugging
      }

      // Verify the run is now paused (finalizeDrainingPause should have fired)
      const db = new DatabaseSync(dbPath);
      const row = db.prepare(
        "SELECT status, scheduling_status FROM runs WHERE id = ?",
      ).get(runId) as { status: string; scheduling_status: string } | undefined;
      assert.ok(row, `Run should exist`);
      assert.equal(
        row.status,
        "paused",
        `Run should transition to paused after all steps complete during drain. status=${row.status}, scheduling_status=${row.scheduling_status}`,
      );
      db.close();
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });

  // ── AC 4: Terminal runs are not affected by pause-all or resume-all ──
  it("pause-all skips terminal runs (completed, failed, canceled)", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-term-int-test-");

    copyWorkflowDir(th.homeDir);

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const runningId = crypto.randomUUID();
    const completedId = crypto.randomUUID();
    const failedId = crypto.randomUUID();
    const canceledId = crypto.randomUUID();

    const steps: SeedStep[] = [
      { stepId: "plan", agentId: "feature-dev-merge_planner" },
    ];

    seedRunAndSteps(dbPath, runningId, "feature-dev-merge", "running", "pending_register", steps);
    seedRunAndSteps(dbPath, completedId, "feature-dev-merge", "completed", null, steps);
    seedRunAndSteps(dbPath, failedId, "feature-dev-merge", "failed", null, steps);
    seedRunAndSteps(dbPath, canceledId, "feature-dev-merge", "canceled", null, steps);

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

      const secret = readDaemonSecret(th.homeDir);

      // Register the running run
      const regResp = await controlFetch(controlPort, "/control/register-run", "POST", { runId: runningId }, secret);
      assert.ok(
        regResp.status === 200 || regResp.status === 202,
        `Expected register-run success, got ${regResp.status}`,
      );

      // pause-all
      const result = await runCli(
        ["workflow", "pause-all"],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(result.exitCode, 0, `pause-all should succeed`);
      // Only 1 running run should be paused
      assert.ok(
        result.stdout.includes("Paused 1 run(s)"),
        `Expected "Paused 1 run(s)", got: ${result.stdout}`,
      );

      // Verify: running → paused, terminal runs unchanged
      const db = new DatabaseSync(dbPath);
      assert.equal(
        (db.prepare("SELECT status FROM runs WHERE id = ?").get(runningId) as { status: string }).status,
        "paused",
      );
      assert.equal(
        (db.prepare("SELECT status FROM runs WHERE id = ?").get(completedId) as { status: string }).status,
        "completed",
      );
      assert.equal(
        (db.prepare("SELECT status FROM runs WHERE id = ?").get(failedId) as { status: string }).status,
        "failed",
      );
      assert.equal(
        (db.prepare("SELECT status FROM runs WHERE id = ?").get(canceledId) as { status: string }).status,
        "canceled",
      );
      db.close();
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });

  // ── resume-all only resumes paused runs (skips running and terminal) ──
  it("resume-all only resumes paused runs (skips running and terminal)", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-ra-term-test-");

    copyWorkflowDir(th.homeDir);

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const pausedId = crypto.randomUUID();
    const runningId = crypto.randomUUID();
    const completedId = crypto.randomUUID();
    const failedId = crypto.randomUUID();

    const steps: SeedStep[] = [
      { stepId: "plan", agentId: "feature-dev-merge_planner" },
    ];

    seedRunAndSteps(dbPath, pausedId, "feature-dev-merge", "paused", "paused", steps);
    seedRunAndSteps(dbPath, runningId, "feature-dev-merge", "running", null, steps);
    seedRunAndSteps(dbPath, completedId, "feature-dev-merge", "completed", null, steps);
    seedRunAndSteps(dbPath, failedId, "feature-dev-merge", "failed", null, steps);

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

      // resume-all
      const result = await runCli(
        ["workflow", "resume-all"],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(result.exitCode, 0, `resume-all should succeed`);
      // Only the paused run should be resumed
      assert.ok(
        result.stdout.includes("Resumed 1 run(s)"),
        `Expected "Resumed 1 run(s)", got: ${result.stdout}`,
      );

      // Verify: paused → running, others unchanged
      const db = new DatabaseSync(dbPath);
      assert.equal(
        (db.prepare("SELECT status FROM runs WHERE id = ?").get(pausedId) as { status: string }).status,
        "running",
        "Paused run should be resumed",
      );
      assert.equal(
        (db.prepare("SELECT status FROM runs WHERE id = ?").get(runningId) as { status: string }).status,
        "running",
        "Running run should stay running",
      );
      assert.equal(
        (db.prepare("SELECT status FROM runs WHERE id = ?").get(completedId) as { status: string }).status,
        "completed",
        "Completed run should stay completed",
      );
      assert.equal(
        (db.prepare("SELECT status FROM runs WHERE id = ?").get(failedId) as { status: string }).status,
        "failed",
        "Failed run should stay failed",
      );
      db.close();
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });

  // ── AC 5: Events are emitted for run.paused and run.resumed ──
  it("pause-all emits run.paused events for each paused run", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-ev-pause-test-");

    copyWorkflowDir(th.homeDir);

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const run1 = crypto.randomUUID();
    const run2 = crypto.randomUUID();

    const steps: SeedStep[] = [
      { stepId: "plan", agentId: "feature-dev-merge_planner" },
    ];

    seedRunAndSteps(dbPath, run1, "feature-dev-merge", "running", "pending_register", steps);
    seedRunAndSteps(dbPath, run2, "feature-dev-merge", "running", "pending_register", steps);

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

      // Register both runs
      const secret = readDaemonSecret(th.homeDir);
      for (const rid of [run1, run2]) {
        await controlFetch(controlPort, "/control/register-run", "POST", { runId: rid }, secret);
      }

      // pause-all
      const result = await runCli(
        ["workflow", "pause-all"],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );
      assert.equal(result.exitCode, 0, `pause-all should succeed`);

      // Check per-run events
      for (const rid of [run1, run2]) {
        const events = readRunEvents(th.homeDir, rid);
        const pauseEvent = events.find((e) => e.event === "run.paused");
        assert.ok(pauseEvent, `Expected run.paused event for ${rid.slice(0, 8)}`);
        assert.equal(pauseEvent.runId, rid, "Event should have correct runId");
        assert.equal(pauseEvent.workflowId, "feature-dev-merge", "Event should have correct workflowId");
        assert.ok(pauseEvent.ts, "Event should have a timestamp");
      }

      // Check global events file
      const globalEventsPath = path.join(th.tamanduaDir, "events", "all.jsonl");
      assert.ok(fs.existsSync(globalEventsPath), "Global events file should exist");
      const globalContent = fs.readFileSync(globalEventsPath, "utf-8").trim();
      const globalLines = globalContent.split("\n");
      const pauseLines = globalLines.filter((l) => {
        try { return JSON.parse(l).event === "run.paused"; } catch { return false; }
      });
      assert.ok(pauseLines.length >= 2, `Expected at least 2 run.paused events in global file, got ${pauseLines.length}`);
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });

  it("resume-all emits run.resumed events for each resumed run", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-ev-resume-test-");

    copyWorkflowDir(th.homeDir);

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const run1 = crypto.randomUUID();
    const run2 = crypto.randomUUID();

    const steps: SeedStep[] = [
      { stepId: "plan", agentId: "feature-dev-merge_planner" },
    ];

    seedRunAndSteps(dbPath, run1, "feature-dev-merge", "paused", "paused", steps);
    seedRunAndSteps(dbPath, run2, "feature-dev-merge", "paused", "paused", steps);

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

      // resume-all
      const result = await runCli(
        ["workflow", "resume-all"],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );
      assert.equal(result.exitCode, 0, `resume-all should succeed`);

      // Check per-run events for run.resumed
      for (const rid of [run1, run2]) {
        const events = readRunEvents(th.homeDir, rid);
        const resumeEvent = events.find((e) => e.event === "run.resumed");
        assert.ok(resumeEvent, `Expected run.resumed event for ${rid.slice(0, 8)}`);
        assert.equal(resumeEvent.runId, rid, "Event should have correct runId");
        assert.equal(resumeEvent.workflowId, "feature-dev-merge", "Event should have correct workflowId");
        assert.ok(resumeEvent.ts, "Event should have a timestamp");
      }

      // Check global events file
      const globalEventsPath = path.join(th.tamanduaDir, "events", "all.jsonl");
      assert.ok(fs.existsSync(globalEventsPath), "Global events file should exist");
      const globalContent = fs.readFileSync(globalEventsPath, "utf-8").trim();
      const globalLines = globalContent.split("\n");
      const resumeLines = globalLines.filter((l) => {
        try { return JSON.parse(l).event === "run.resumed"; } catch { return false; }
      });
      assert.ok(resumeLines.length >= 2, `Expected at least 2 run.resumed events in global file, got ${resumeLines.length}`);
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });

  // ── drain: no new work is spawned while draining ──
  it("pause-all --drain prevents new scheduler jobs while draining", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-drain-nospawn-test-");

    copyWorkflowDir(th.homeDir);

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    // Create one run that has an in-flight (running) step AND a waiting step
    const runId = crypto.randomUUID();
    const stepIdRunning = crypto.randomUUID();

    {
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
          worker_lost_count INTEGER NOT NULL DEFAULT 0
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
          max_retries INTEGER DEFAULT 0,
          type TEXT NOT NULL DEFAULT 'single',
          loop_config TEXT,
          current_story_id TEXT,
          abandoned_count INTEGER DEFAULT 0,
          reroute_count INTEGER DEFAULT 0,
          claim_pid INTEGER,
          claim_updated_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT null DEFAULT (datetime('now'))
        )
      `);

      const now = new Date().toISOString();
      const harnessDir = path.dirname(dbPath);
      const context = JSON.stringify({
        task: "Drain no-spawn test",
        repo: harnessDir,
        working_directory_for_harness: harnessDir,
      });

      db.prepare(
        `INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, run_number, worker_lost_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, 0, ?, ?)`,
      ).run(runId, "feature-dev-merge", "Drain no-spawn test", "running", context, now, now);

      // Step 0: running (in-flight)
      db.prepare(
        `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, max_retries, type, abandoned_count, reroute_count, created_at, updated_at)
         VALUES (?, ?, 'plan', 'feature-dev-merge_planner', 0, 'test', 'STATUS: done', 'running', 0, 'single', 0, 0, ?, ?)`,
      ).run(stepIdRunning, runId, now, now);

      // Step 1: waiting (should NOT be claimed while draining)
      db.prepare(
        `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, max_retries, type, abandoned_count, reroute_count, created_at, updated_at)
         VALUES (?, ?, 'setup', 'feature-dev-merge_setup', 1, 'test', 'STATUS: done', 'waiting', 0, 'single', 0, 0, ?, ?)`,
      ).run(crypto.randomUUID(), runId, now, now);

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

      // Register the run (creates scheduler timers)
      const secret = readDaemonSecret(th.homeDir);
      const regResp = await controlFetch(controlPort, "/control/register-run", "POST", { runId }, secret);
      assert.ok(
        regResp.status === 200 || regResp.status === 202,
        `Expected register-run success, got ${regResp.status}`,
      );

      // Verify scheduler timers exist
      const jobsBefore = await getSchedulerRunIds(controlPort, secret);
      assert.ok(jobsBefore.has(runId), "Expected scheduler job for run");

      // Pause with drain via CLI
      const result = await runCli(
        ["workflow", "pause", runId.slice(0, 8), "--drain"],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );
      assert.equal(
        result.exitCode,
        0,
        `pause --drain should succeed (exit ${result.exitCode}): ${cleanStderr(result.stderr)}`,
      );

      // Verify draining_pause state (not fully paused)
      const db = new DatabaseSync(dbPath);
      const row = db.prepare(
        "SELECT status, scheduling_status FROM runs WHERE id = ?",
      ).get(runId) as { status: string; scheduling_status: string } | undefined;
      assert.ok(row, "Run should exist");
      assert.equal(row.status, "running", "Status should still be running during drain");
      assert.equal(row.scheduling_status, "draining_pause", "Scheduling status should be draining_pause");
      db.close();

      // The waiting step should NOT be claimed to "running" while draining.
      // Verify the waiting step is still waiting (not claimed).
      const db2 = new DatabaseSync(dbPath);
      const waitingStep = db2.prepare(
        "SELECT status FROM steps WHERE run_id = ? AND step_index = 1",
      ).get(runId) as { status: string } | undefined;
      assert.ok(waitingStep, "Waiting step should exist");
      assert.equal(
        waitingStep.status,
        "waiting",
        `Waiting step should remain waiting during drain (not be claimed). Got: ${waitingStep.status}`,
      );
      db2.close();
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });
});
