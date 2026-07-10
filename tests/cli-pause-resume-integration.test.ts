/**
 * Integration tests for CLI pause/resume one run (US-009).
 *
 * Validates end-to-end lifecycle:
 * 1. CLI pause transitions run from running to paused
 * 2. CLI resume transitions run from paused to running
 * 3. Paused run stops claiming new steps (scheduler timers removed)
 * 4. Resumed run starts claiming steps again (scheduler timers re-created)
 * 5. Terminal run pause is rejected with clear error
 * 6. Non-paused run resume is rejected
 * 7. Step state is preserved across pause/resume
 *
 * Uses temp HOME/TAMANDUA_STATE_DIR for isolation.
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
  path: string,
  method = "GET",
  body?: unknown,
  secret?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (secret) headers["x-tamandua-secret"] = secret;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${controlPort}${path}`, {
    method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let resBody: unknown;
  try {
    resBody = await res.json();
  } catch {
    resBody = null;
  }
  return { status: res.status, body: resBody };
}

interface SeedStep {
  stepId: string;
  agentId: string;
}

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
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const stepStatus = i === 0 ? "pending" : "waiting";
    insertStep.run(
      crypto.randomUUID(), runId, s.stepId, s.agentId, i,
      "test input", "STATUS: done", stepStatus, "single", now, now,
    );
  }

  db.close();
}

async function assertSchedulerJobsForRun(
  controlPort: number,
  runId: string,
  expectedPresence: boolean,
  secret: string,
): Promise<void> {
  const { body } = await controlFetch(controlPort, "/control/jobs", "GET", undefined, secret);
  const jobs = (body as { jobs?: Array<{ id: string; runId: string; agentId: string }> }).jobs ?? [];

  const matching = jobs.filter((j) => j.runId === runId);
  if (expectedPresence) {
    assert.ok(
      matching.length > 0,
      `Expected scheduler jobs for run ${runId.slice(0, 8)}, but found none. Jobs: ${JSON.stringify(jobs)}`,
    );
  } else {
    assert.equal(
      matching.length,
      0,
      `Expected no scheduler jobs for run ${runId.slice(0, 8)}, but found ${matching.length}: ${JSON.stringify(matching)}`,
    );
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe("CLI pause/resume one run (integration)", { concurrency: 1 }, () => {
  // ── AC 3 + AC 4: Scheduler timer lifecycle across pause/resume ──
  it("pause removes scheduler timers, resume re-creates them", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const dashboardPort = await getAvailablePort();
    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-integration-test-");

    // Copy workflow directory so daemon can load the workflow spec
    const srcWorkflowDir = path.resolve(__dirname, "..", "workflows", "feature-dev-merge");
    const dstWorkflowDir = path.join(th.tamanduaDir, "workflows", "feature-dev-merge");
    fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
    fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const runId = crypto.randomUUID();
    // Create a run with all 6 agent steps from the feature-dev-merge workflow
    const steps: SeedStep[] = [
      { stepId: "plan", agentId: "feature-dev-merge_planner" },
      { stepId: "setup", agentId: "feature-dev-merge_setup" },
      { stepId: "implement", agentId: "feature-dev-merge_developer" },
      { stepId: "verify", agentId: "feature-dev-merge_verifier" },
      { stepId: "test", agentId: "feature-dev-merge_tester" },
      { stepId: "finalize_merge", agentId: "feature-dev-merge_merger" },
    ];
    seedRunAndSteps(dbPath, runId, "feature-dev-merge", "running", "pending_register", steps);

    let daemon: ChildProcess | undefined;

    try {
      // Start daemon
      daemon = spawn("node", [DAEMON_SCRIPT, String(dashboardPort)], {
        env: cleanChildEnv({ HOME: th.homeDir,
          TAMANDUA_CONTROL_PORT: String(controlPort), }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      daemon.stdout?.resume();
      daemon.stderr?.resume();

      await waitForControlUp(controlPort);

      // Register the run with the daemon to create scheduler timers
      const secret = readDaemonSecret(th.homeDir);
      const regResp = await controlFetch(controlPort, "/control/register-run", "POST", { runId }, secret);
      assert.ok(
        regResp.status === 200 || regResp.status === 202,
        `Expected register-run success (200/202), got ${regResp.status}: ${JSON.stringify(regResp.body)}`,
      );

      // AC 3: Verify scheduler timers exist for the run
      await assertSchedulerJobsForRun(controlPort, runId, true, secret);

      // Pause the run via CLI
      const pauseResult = await runCli(
        ["workflow", "pause", runId],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(
        pauseResult.exitCode, 0,
        `Pause should succeed, got exit ${pauseResult.exitCode}, stderr: ${cleanStderr(pauseResult.stderr)}`,
      );
      assert.ok(
        pauseResult.stdout.includes("Paused run"),
        `Expected "Paused run" in stdout, got: ${pauseResult.stdout}`,
      );

      // AC 3: Verify scheduler timers are removed after pause
      await assertSchedulerJobsForRun(controlPort, runId, false, secret);

      // AC 1: Verify status shows paused
      const statusAfterPause = await runCli(
        ["workflow", "status", runId.slice(0, 8)],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );
      assert.ok(
        /Status:\s+paused/i.test(statusAfterPause.stdout),
        `Expected status "paused", got: ${statusAfterPause.stdout}`,
      );

      // Resume the run via CLI
      const resumeResult = await runCli(
        ["workflow", "resume", runId],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(
        resumeResult.exitCode, 0,
        `Resume should succeed, got exit ${resumeResult.exitCode}, stderr: ${cleanStderr(resumeResult.stderr)}`,
      );
      assert.ok(
        resumeResult.stdout.includes("Resumed run"),
        `Expected "Resumed run" in stdout, got: ${resumeResult.stdout}`,
      );

      // AC 4: Verify scheduler timers are re-created after resume
      await assertSchedulerJobsForRun(controlPort, runId, true, secret);

      // AC 2: Verify status shows running after resume
      const statusAfterResume = await runCli(
        ["workflow", "status", runId.slice(0, 8)],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );
      assert.ok(
        /Status:\s+running/i.test(statusAfterResume.stdout),
        `Expected status "running", got: ${statusAfterResume.stdout}`,
      );
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });

  // ── AC 5: Terminal run pause is rejected ──
  it("pause completed run via CLI is rejected with clear error", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const th = createTempHome("tamandua-integration-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");
    const completedRunId = crypto.randomUUID();

    const steps: SeedStep[] = [
      { stepId: "plan", agentId: "feature-dev-merge_planner" },
    ];
    seedRunAndSteps(dbPath, completedRunId, "feature-dev-merge", "completed", null, steps);

    const { stderr, exitCode } = await runCli(
      ["workflow", "pause", completedRunId.slice(0, 8)],
      { HOME: th.homeDir },
    );

    assert.notEqual(exitCode, 0, "Should exit with non-zero code for completed run");
    assert.ok(
      stderr.includes("Cannot pause run") || stderr.includes("only running runs"),
      `Expected terminal-run rejection error, got: ${stderr}`,
    );
    assert.ok(
      stderr.includes("completed"),
      `Expected "completed" status in error, got: ${stderr}`,
    );
  });

  it("pause failed run via CLI is rejected", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const th = createTempHome("tamandua-integration-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");
    const failedRunId = crypto.randomUUID();

    const steps: SeedStep[] = [
      { stepId: "plan", agentId: "feature-dev-merge_planner" },
    ];
    seedRunAndSteps(dbPath, failedRunId, "feature-dev-merge", "failed", null, steps);

    const { stderr, exitCode } = await runCli(
      ["workflow", "pause", failedRunId.slice(0, 8)],
      { HOME: th.homeDir },
    );

    assert.notEqual(exitCode, 0, "Should exit with non-zero code for failed run");
    assert.ok(
      stderr.includes("Cannot pause run") || stderr.includes("only running runs"),
      `Expected terminal-run rejection error, got: ${stderr}`,
    );
    assert.ok(
      stderr.includes("failed"),
      `Expected "failed" status in error, got: ${stderr}`,
    );
  });

  // ── AC 6: Non-paused run resume is rejected ──
  it("resume running (non-paused) run is rejected", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const th = createTempHome("tamandua-integration-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");
    const runningRunId = crypto.randomUUID();

    const steps: SeedStep[] = [
      { stepId: "plan", agentId: "feature-dev-merge_planner" },
    ];
    seedRunAndSteps(dbPath, runningRunId, "feature-dev-merge", "running", null, steps);

    const { stderr, exitCode } = await runCli(
      ["workflow", "resume", runningRunId],
      { HOME: th.homeDir },
    );

    assert.notEqual(exitCode, 0, "Should exit with non-zero code for running run");
    assert.ok(
      stderr.includes("Cannot resume run") || stderr.includes("only paused or failed"),
      `Expected non-paused resume rejection, got: ${stderr}`,
    );
  });

  it("resume completed (terminal) run is rejected", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const th = createTempHome("tamandua-integration-test-");

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");
    const completedRunId = crypto.randomUUID();

    const steps: SeedStep[] = [
      { stepId: "plan", agentId: "feature-dev-merge_planner" },
    ];
    seedRunAndSteps(dbPath, completedRunId, "feature-dev-merge", "completed", null, steps);

    const { stderr, exitCode } = await runCli(
      ["workflow", "resume", completedRunId],
      { HOME: th.homeDir },
    );

    assert.notEqual(exitCode, 0, "Should exit with non-zero code for completed run");
    assert.ok(
      stderr.includes("Cannot resume run") || stderr.includes("cannot be resumed"),
      `Expected terminal-run resume rejection, got: ${stderr}`,
    );
    assert.ok(
      stderr.includes("completed"),
      `Expected "completed" in error, got: ${stderr}`,
    );
  });

  // ── AC 7: Step state preserved across pause/resume ──
  it("step state is preserved across pause/resume (steps not modified)", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const dashboardPort = await getAvailablePort();
    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-integration-test-");

    // Copy workflow directory
    const srcWorkflowDir = path.resolve(__dirname, "..", "workflows", "feature-dev-merge");
    const dstWorkflowDir = path.join(th.tamanduaDir, "workflows", "feature-dev-merge");
    fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
    fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const runId = crypto.randomUUID();
    const steps: SeedStep[] = [
      { stepId: "plan", agentId: "feature-dev-merge_planner" },
      { stepId: "setup", agentId: "feature-dev-merge_setup" },
      { stepId: "implement", agentId: "feature-dev-merge_developer" },
    ];
    seedRunAndSteps(dbPath, runId, "feature-dev-merge", "running", "pending_register", steps);

    let daemon: ChildProcess | undefined;

    try {
      // Start daemon
      daemon = spawn("node", [DAEMON_SCRIPT, String(dashboardPort)], {
        env: cleanChildEnv({ HOME: th.homeDir,
          TAMANDUA_CONTROL_PORT: String(controlPort), }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      daemon.stdout?.resume();
      daemon.stderr?.resume();

      await waitForControlUp(controlPort);

      // Register the run to create scheduler timers
      const secret = readDaemonSecret(th.homeDir);
      const regResp = await controlFetch(controlPort, "/control/register-run", "POST", { runId }, secret);
      assert.ok(
        regResp.status === 200 || regResp.status === 202,
        `Expected register-run success, got ${regResp.status}`,
      );

      // Snapshot steps before pause
      const stepsBeforeRaw = getStepsFromDb(dbPath, runId);
      const stepsBefore = new Map(stepsBeforeRaw.map((s) => [s.step_id, s]));

      // Pause
      const pauseResult = await runCli(
        ["workflow", "pause", runId],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );
      assert.equal(pauseResult.exitCode, 0, `Pause should succeed, got exit ${pauseResult.exitCode}`);

      // Snapshot steps after pause
      const stepsAfterPauseRaw = getStepsFromDb(dbPath, runId);
      const stepsAfterPause = new Map(stepsAfterPauseRaw.map((s) => [s.step_id, s]));

      // Verify steps are unchanged (except possibly updated_at)
      for (const [stepId, before] of stepsBefore) {
        const after = stepsAfterPause.get(stepId);
        assert.ok(after, `Step ${stepId} should still exist after pause`);
        assert.equal(after.status, before.status, `Step ${stepId} status should be preserved: expected ${before.status}, got ${after.status}`);
        assert.equal(after.step_id, before.step_id, `Step ${stepId} id should be preserved`);
        assert.equal(after.agent_id, before.agent_id, `Step ${stepId} agent should be preserved`);
      }

      // Resume
      const resumeResult = await runCli(
        ["workflow", "resume", runId],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );
      assert.equal(resumeResult.exitCode, 0, `Resume should succeed, got exit ${resumeResult.exitCode}`);

      // Snapshot steps after resume
      const stepsAfterResumeRaw = getStepsFromDb(dbPath, runId);
      const stepsAfterResume = new Map(stepsAfterResumeRaw.map((s) => [s.step_id, s]));

      // Verify steps are unchanged after resume too
      for (const [stepId, before] of stepsBefore) {
        const after = stepsAfterResume.get(stepId);
        assert.ok(after, `Step ${stepId} should still exist after resume`);
        assert.equal(after.status, before.status, `Step ${stepId} status should be preserved: expected ${before.status}, got ${after.status}`);
      }
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });
});

  // ── US-001: Regression test for stranded running step on pause→resume ──
  it("recovers stranded running step to pending on pause→resume (US-001)", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const dashboardPort = await getAvailablePort();
    const controlPort = await getAvailablePort();

    const th = createTempHome("tamandua-integration-orphan-");

    // Copy workflow directory so daemon can load the workflow spec
    const srcWorkflowDir = path.resolve(__dirname, "..", "workflows", "feature-dev-merge");
    const dstWorkflowDir = path.join(th.tamanduaDir, "workflows", "feature-dev-merge");
    fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
    fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const runId = crypto.randomUUID();
    // Seed a run with one step set to status='running' to simulate
    // an in-flight agent that was killed by pause-without-drain.
    const steps: SeedStep[] = [
      { stepId: "plan", agentId: "feature-dev-merge_planner" },
    ];
    seedRunAndSteps(dbPath, runId, "feature-dev-merge", "running", "pending_register", steps);

    // Override the first step's status to 'running' (simulating orphaned in-flight step)
    {
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE steps SET status = 'running', retry_count = 0 WHERE run_id = ? AND step_index = 0")
        .run(runId);
      db.close();
    }

    let daemon: ChildProcess | undefined;

    try {
      // Start daemon
      daemon = spawn("node", [DAEMON_SCRIPT, String(dashboardPort)], {
        env: cleanChildEnv({ HOME: th.homeDir,
          TAMANDUA_CONTROL_PORT: String(controlPort), }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      daemon.stdout?.resume();
      daemon.stderr?.resume();

      await waitForControlUp(controlPort);

      // Register the run with the daemon to create scheduler timers
      const secret = readDaemonSecret(th.homeDir);
      const regResp = await controlFetch(controlPort, "/control/register-run", "POST", { runId }, secret);
      assert.ok(
        regResp.status === 200 || regResp.status === 202,
        `Expected register-run success (200/202), got ${regResp.status}: ${JSON.stringify(regResp.body)}`,
      );

      // Verify the step is still 'running' before pause
      const beforeStep = getStepFromDb(dbPath, runId, 0);
      assert.equal(beforeStep?.status, "running", "Step should be running (simulating orphaned agent)");
      assert.equal(beforeStep?.retry_count, 0, "Step retry_count should be 0 before recovery");

      // Pause the run via CLI
      const pauseResult = await runCli(
        ["workflow", "pause", runId],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );
      assert.equal(
        pauseResult.exitCode, 0,
        `Pause should succeed, got exit ${pauseResult.exitCode}, stderr: ${cleanStderr(pauseResult.stderr)}`,
      );
      assert.ok(
        pauseResult.stdout.includes("Paused run"),
        `Expected "Paused run" in stdout, got: ${pauseResult.stdout}`,
      );

      // Resume the run via CLI
      const resumeResult = await runCli(
        ["workflow", "resume", runId],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );
      assert.equal(
        resumeResult.exitCode, 0,
        `Resume should succeed, got exit ${resumeResult.exitCode}, stderr: ${cleanStderr(resumeResult.stderr)}`,
      );
      assert.ok(
        resumeResult.stdout.includes("Resumed run"),
        `Expected "Resumed run" in stdout, got: ${resumeResult.stdout}`,
      );

      // AC 1: Verify the step was recovered from 'running' to 'pending'
      const afterStep = getStepFromDb(dbPath, runId, 0);
      assert.equal(
        afterStep?.status, "pending",
        `Expected step status 'pending' after pause→resume, got '${afterStep?.status}'`,
      );

      // AC 2: Verify scheduler timers were re-created after resume
      await assertSchedulerJobsForRun(controlPort, runId, true, secret);

      // AC 3: Verify retry_count is bumped after recovery
      assert.equal(
        afterStep?.retry_count, 1,
        `Expected retry_count 1 after recovery, got ${afterStep?.retry_count}`,
      );

      // AC 4: Drain path is unaffected — pause with drain leaves steps untouched
      // (verified by existing drain test coverage in dashboard-mcp-pause-resume-integration)
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  });

  // ── Helpers ────────────────────────────────────────────────────────

interface DbStep {
  id: string;
  step_id: string;
  agent_id: string;
  step_index: number;
  status: string;
  run_id: string;
  retry_count: number;
}

function getStepsFromDb(dbPath: string, runId: string): DbStep[] {
  const db = new DatabaseSync(dbPath);
  const rows = db
    .prepare("SELECT id, step_id, agent_id, step_index, status, run_id FROM steps WHERE run_id = ? ORDER BY step_index ASC")
    .all(runId) as DbStep[];
  db.close();
  return rows;
}

function getStepFromDb(dbPath: string, runId: string, stepIndex: number): { status: string; retry_count: number } | null {
  const db = new DatabaseSync(dbPath);
  const row = db
    .prepare("SELECT status, retry_count FROM steps WHERE run_id = ? AND step_index = ?")
    .get(runId, stepIndex) as { status: string; retry_count: number } | undefined;
  db.close();
  return row ?? null;
}
