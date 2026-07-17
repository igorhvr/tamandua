/**
 * PAUS: Pause-kill-resume regression test (US-006).
 *
 * Reproduces the production silent-pause livelock end-to-end against a
 * real isolated daemon with a scripted agent (zero model tokens).
 *
 * Sequence:
 *   1. Start daemon, seed a run, register → step is claimed (running)
 *   2. Non-drain pause → worker killed, run paused, step recoverable
 *   3. Resume → step recovered to pending, timers re-created
 *   4. Scripted agent picks up and completes → run completes
 *
 * Asserts:
 *   - Attribution context keys (paused_by, paused_at, pause_drain, resumed_by, resumed_at)
 *   - Events (run.pause_requested before run.paused, run.resume_requested before run.resumed)
 *   - Zero real model tokens (scripted agent via TAMANDUA_PI_BINARY)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { createScriptedAgent, type ScriptedBehavior } from "../e2e-tests/helpers/scripted-agent.ts";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_SCRIPT = path.resolve(__dirname, "..", "dist", "cli", "cli.js");
const DAEMON_SCRIPT = path.resolve(__dirname, "..", "dist", "server", "daemon.js");

// ── Helpers ──────────────────────────────────────────────────────────

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

async function waitForControlUp(port: number, timeoutMs = 10000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/control/health`);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Control plane did not come up on port ${port}`);
}

function readDaemonSecret(homeDir: string): string {
  const secretPath = path.join(homeDir, ".tamandua", "daemon-secret");
  return fs.readFileSync(secretPath, "utf-8").trim();
}

async function controlFetch(
  controlPort: number,
  pathName: string,
  method = "GET",
  body?: unknown,
  secret?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (secret) headers["x-tamandua-secret"] = secret;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${controlPort}${pathName}`, {
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

interface DbStep {
  status: string;
  retry_count: number;
}

interface DbRun {
  status: string;
  scheduling_status: string | null;
  context: string;
}

function getStepFromDb(dbPath: string, runId: string, stepIndex = 0): DbStep | null {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("SELECT status, retry_count FROM steps WHERE run_id = ? AND step_index = ?")
      .get(runId, stepIndex) as DbStep | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

function getRunFromDb(dbPath: string, runId: string): DbRun | null {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("SELECT status, scheduling_status, context FROM runs WHERE id = ?")
      .get(runId) as DbRun | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

function seedRunAndStep(dbPath: string, runId: string, workflowId: string, harnessDir: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    const now = new Date().toISOString();
    const context = JSON.stringify({
      task: "PAUS regression test",
      repo: harnessDir,
      working_directory_for_harness: harnessDir,
    });

    // Create tables with full schema including scheduling/ownership columns
    // so the daemon's migrate() ALTER TABLE statements are no-ops.
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        context TEXT NOT NULL DEFAULT '{}',
        tokens_spent INTEGER NOT NULL DEFAULT 0,
        notify_url TEXT,
        scheduling_status TEXT,
        scheduling_requested_at TEXT,
        scheduling_error TEXT,
        worker_lost_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
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
        claim_job_id TEXT,
        claim_pid INTEGER,
        claim_pgid INTEGER,
        claim_updated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tamandua_stats (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        system_tokens_spent INTEGER NOT NULL DEFAULT 0
      );
    `);

    db.exec("INSERT OR IGNORE INTO tamandua_stats (id, system_tokens_spent) VALUES (1, 0)");

    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`,
    ).run(runId, workflowId, "PAUS regression test", context, now, now);

    const stepRowId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, created_at, updated_at)
       VALUES (?, ?, 'implement', ?, 0, 'Implement PAUS test', 'STATUS: done', 'pending', 'single', ?, ?)`,
    ).run(stepRowId, runId, `${workflowId}_developer`, now, now);
  } finally {
    db.close();
  }
}

async function waitForStepStatus(
  dbPath: string,
  runId: string,
  desiredStatus: string,
  timeoutMs = 30000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const step = getStepFromDb(dbPath, runId);
    if (step?.status === desiredStatus) return;
    await sleep(500);
  }
  const current = getStepFromDb(dbPath, runId);
  throw new Error(
    `Step did not reach status "${desiredStatus}" within ${timeoutMs}ms (current: ${current?.status ?? "null"})`,
  );
}

async function waitForRunCompleted(
  dbPath: string,
  runId: string,
  timeoutMs = 30000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const run = getRunFromDb(dbPath, runId);
    if (run?.status === "completed") return;
    await sleep(500);
  }
  const current = getRunFromDb(dbPath, runId);
  throw new Error(
    `Run did not reach "completed" within ${timeoutMs}ms (current: ${current?.status ?? "null"})`,
  );
}

// ── Tests ────────────────────────────────────────────────────────────

describe("pause-kill-resume regression (PAUS)", { concurrency: 1 }, () => {
  let th: ReturnType<typeof createTempHome>;
  let controlPort: number;
  let daemon: ChildProcess | undefined;
  let runId: string;
  let secret: string;
  let dbPath: string;

  before(async () => {
    th = createTempHome("tamandua-pause-kill-resume-");
    controlPort = await getAvailablePort();
    dbPath = path.join(th.tamanduaDir, "tamandua.db");
    runId = crypto.randomUUID();

    // Copy workflow directory so daemon can load the workflow spec
    const srcWorkflowDir = path.resolve(__dirname, "..", "workflows", "feature-dev-merge");
    const dstWorkflowDir = path.join(th.tamanduaDir, "workflows", "feature-dev-merge");
    fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
    fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });

    // Seed the run with a pending step (no scheduling_status set — let the daemon register it)
    seedRunAndStep(dbPath, runId, "feature-dev-merge", th.homeDir);

    // Create scripted agent: first dispatch hangs after claim, second completes normally
    const agentBehaviors: Record<string, ScriptedBehavior | ScriptedBehavior[]> = {
      "developer": [
        { mode: "hang-after-claim" },
        {
          mode: "work",
          output: "STATUS: done\nCHANGES: implemented PAUS attribution\nTESTS: all regression tests pass",
        },
      ],
    };

    const scriptedAgent = createScriptedAgent(th.root, { agents: agentBehaviors, defaultTokens: 0 });

    // Start daemon with scripted agent as the pi binary
    daemon = spawn("node", [DAEMON_SCRIPT], {
      env: cleanChildEnv({
        HOME: th.homeDir,
        TAMANDUA_CONTROL_PORT: String(controlPort),
        ...scriptedAgent.env,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.stdout?.resume();
    daemon.stderr?.resume();

    await waitForControlUp(controlPort);
    secret = readDaemonSecret(th.homeDir);

    // Register the run with the daemon (creates scheduler timers)
    const regResp = await controlFetch(
      controlPort,
      "/control/register-run",
      "POST",
      { runId },
      secret,
    );
    assert.ok(
      regResp.status === 200 || regResp.status === 202,
      `register-run should succeed, got ${regResp.status}: ${JSON.stringify(regResp.body)}`,
    );

    // Nudge to trigger immediate dispatch instead of waiting 15s for the interval
    await controlFetch(controlPort, "/control/nudge", "POST", undefined, secret);

    // Wait for the step to be claimed by the scripted agent (hang-after-claim)
    await waitForStepStatus(dbPath, runId, "running", 15000);
  });

  after(() => {
    if (daemon && daemon.exitCode === null && daemon.pid) {
      try {
        process.kill(daemon.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  });

  it("reproduces production pause-kill-resume sequence end-to-end", async () => {
    // ── Phase 1: Non-drain pause ───────────────────────────────────
    const pauseResp = await controlFetch(
      controlPort,
      "/control/pause-run",
      "POST",
      { runId, drain: false, requestedBy: "tester@test:12345 (cli)" },
      secret,
    );
    assert.equal(pauseResp.status, 200, `Pause should succeed, got ${pauseResp.status}`);
    assert.equal((pauseResp.body as Record<string, unknown>).state, "paused");

    // Verify run is paused
    const runAfterPause = getRunFromDb(dbPath, runId);
    assert.ok(runAfterPause, "run should exist after pause");
    assert.equal(runAfterPause.status, "paused", "run status should be paused");

    // Verify step is still running (non-drain pause kills worker, step stays running)
    const stepAfterPause = getStepFromDb(dbPath, runId);
    assert.ok(stepAfterPause, "step should exist after pause");
    assert.equal(stepAfterPause.status, "running", "step should be running after non-drain pause");

    // ── Phase 2: Assert attribution context keys ───────────────────
    const ctx = JSON.parse(runAfterPause.context);
    assert.ok(ctx.paused_by, "paused_by context key should be set");
    assert.equal(ctx.paused_by, "tester@test:12345 (cli)", "paused_by should match requester");
    assert.ok(ctx.paused_at, "paused_at context key should be set");
    assert.ok(
      Math.abs(Date.now() - new Date(ctx.paused_at).getTime()) < 60000,
      "paused_at should be a recent ISO timestamp",
    );
    assert.equal(ctx.pause_drain, "false", "pause_drain should be 'false' for non-drain pause");

    // ── Phase 3: Assert events ─────────────────────────────────────
    const eventsPath = path.join(th.tamanduaDir, "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(eventsPath), "events file should exist");

    const events = fs
      .readFileSync(eventsPath, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const pauseRequestedIdx = events.findIndex((e) => e.event === "run.pause_requested");
    const pausedIdx = events.findIndex((e) => e.event === "run.paused");
    assert.ok(pauseRequestedIdx >= 0, "run.pause_requested event should exist");
    assert.ok(pausedIdx >= 0, "run.paused event should exist");
    assert.ok(
      pauseRequestedIdx < pausedIdx,
      `run.pause_requested (idx=${pauseRequestedIdx}) should come before run.paused (idx=${pausedIdx})`,
    );

    // Verify pause_requested detail contains requester and drain
    const pauseReqEvent = events[pauseRequestedIdx];
    const pauseReqDetail = JSON.parse(pauseReqEvent.detail as string);
    assert.equal(pauseReqDetail.requestedBy, "tester@test:12345 (cli)");
    assert.equal(pauseReqDetail.drain, false);

    // Verify scheduler timers are removed
    const jobsBeforeResume = await controlFetch(
      controlPort,
      "/control/jobs",
      "GET",
      undefined,
      secret,
    );
    const jobsBefore = (jobsBeforeResume.body as { jobs?: Array<{ runId: string }> }).jobs ?? [];
    const runJobsBefore = jobsBefore.filter((j) => j.runId === runId);
    assert.equal(runJobsBefore.length, 0, "scheduler timers should be removed after pause");

    // ── Phase 4: Resume ────────────────────────────────────────────
    const resumeResp = await controlFetch(
      controlPort,
      "/control/resume-run",
      "POST",
      { runId, requestedBy: "resumer@test:99999 (cli)" },
      secret,
    );
    assert.ok(
      resumeResp.status === 200 || resumeResp.status === 202,
      `Resume should succeed, got ${resumeResp.status}: ${JSON.stringify(resumeResp.body)}`,
    );

    // Wait for step recovery (resume calls recoverOrphanedStepsForAgent)
    await waitForStepStatus(dbPath, runId, "pending", 5000);

    // Verify step recovered to pending
    const stepAfterResume = getStepFromDb(dbPath, runId);
    assert.equal(stepAfterResume?.status, "pending", "step should be recovered to pending after resume");

    // Verify retry_count bumped for orphan recovery
    assert.equal(stepAfterResume?.retry_count, 1, "retry_count should be bumped by orphan recovery");

    // ── Phase 5: Assert resume attribution ─────────────────────────
    const runAfterResume = getRunFromDb(dbPath, runId);
    assert.ok(runAfterResume, "run should exist after resume");
    assert.equal(runAfterResume.status, "running", "run should be running after resume");

    const ctx2 = JSON.parse(runAfterResume.context);
    assert.ok(ctx2.resumed_by, "resumed_by context key should be set");
    assert.equal(ctx2.resumed_by, "resumer@test:99999 (cli)", "resumed_by should match requester");
    assert.ok(ctx2.resumed_at, "resumed_at context key should be set");
    assert.ok(
      Math.abs(Date.now() - new Date(ctx2.resumed_at as string).getTime()) < 60000,
      "resumed_at should be a recent ISO timestamp",
    );

    // Paused keys should still be present (context is additive, not replaced)
    assert.equal(ctx2.paused_by, "tester@test:12345 (cli)", "paused_by should persist across resume");

    // ── Phase 6: Assert resume events ──────────────────────────────
    const events2 = fs
      .readFileSync(eventsPath, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const resumeRequestedIdx = events2.findIndex((e) => e.event === "run.resume_requested");
    const resumedIdx = events2.findIndex((e) => e.event === "run.resumed");
    assert.ok(resumeRequestedIdx >= 0, "run.resume_requested event should exist");
    assert.ok(resumedIdx >= 0, "run.resumed event should exist");
    assert.ok(
      resumeRequestedIdx < resumedIdx,
      `run.resume_requested (idx=${resumeRequestedIdx}) should come before run.resumed (idx=${resumedIdx})`,
    );

    // Verify resume_requested detail contains requester
    const resumeReqEvent = events2[resumeRequestedIdx];
    const resumeReqDetail = JSON.parse(resumeReqEvent.detail as string);
    assert.equal(resumeReqDetail.requestedBy, "resumer@test:99999 (cli)");

    // ── Phase 7: Verify scheduler timers re-created ────────────────
    const jobsAfterResume = await controlFetch(
      controlPort,
      "/control/jobs",
      "GET",
      undefined,
      secret,
    );
    const jobsAfter = (jobsAfterResume.body as { jobs?: Array<{ runId: string }> }).jobs ?? [];
    const runJobsAfter = jobsAfter.filter((j) => j.runId === runId);
    assert.ok(runJobsAfter.length > 0, "scheduler timers should be re-created after resume");

    // ── Phase 8: Nudge to trigger immediate dispatch ───────────────
    // The nudge will cause the dispatch round to fire; the scripted agent
    // (second behavior: mode="work") will claim and complete the step.
    await controlFetch(controlPort, "/control/nudge", "POST", undefined, secret);

    // Wait for step to complete and run to finish
    await waitForRunCompleted(dbPath, runId, 30000);

    // ── Phase 9: Verify run completed ──────────────────────────────
    const runFinal = getRunFromDb(dbPath, runId);
    assert.ok(runFinal, "run should exist after completion");
    assert.equal(runFinal.status, "completed", "run should be completed");

    const stepFinal = getStepFromDb(dbPath, runId);
    assert.ok(stepFinal, "step should exist after run completion");
    assert.equal(stepFinal.status, "done", "step should be done");

    // ── Phase 10: Verify zero real tokens spent ────────────────────
    // Scripted agent always emits 0 tokens
    const db = new DatabaseSync(dbPath);
    try {
      const runRow = db
        .prepare("SELECT tokens_spent FROM runs WHERE id = ?")
        .get(runId) as { tokens_spent: number } | undefined;
      // The scripted agent's defaultTokens is 0
      assert.equal(
        runRow?.tokens_spent ?? 0,
        0,
        "should spend zero real tokens (scripted agent, defaultTokens=0)",
      );
    } finally {
      db.close();
    }

    // ── Phase 11: Verify run.completed event exists ────────────────
    const events3 = fs
      .readFileSync(eventsPath, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const completedEvent = events3.find((e) => e.event === "run.completed");
    assert.ok(completedEvent, "run.completed event should exist after completion");
  });
});
