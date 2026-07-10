/**
 * Dead-worker recovery (MOTOR-CONTRACT.md C18).
 *
 * When a daemon dies with work rounds in flight (crash, reboot, SIGKILL,
 * or an agent stopping the daemon that schedules it), the interrupted
 * steps sit at status='running' under a dead claim_pid. The reconciler's
 * dead-worker sweep (recoverStepsWithDeadWorkers) requeues them promptly
 * instead of waiting out the 1.5×timeout age-based sweep.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { recoverStepsWithDeadWorkers } from "../dist/installer/step-ops.js";
import { getDb } from "../dist/db.js";

let tempHome: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dead-worker-"));
  const stateDir = path.join(tempHome, ".tamandua");
  fs.mkdirSync(stateDir, { recursive: true });
  saved = {
    HOME: process.env.HOME,
    TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
    TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
    TAMANDUA_CONTROL_PORT: process.env.TAMANDUA_CONTROL_PORT,
  };
  process.env.HOME = tempHome;
  process.env.TAMANDUA_STATE_DIR = stateDir;
  process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
  process.env.TAMANDUA_CONTROL_PORT = "1"; // dead control plane — nudges no-op
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
});

/** A pid that is guaranteed dead: spawn a no-op process and let it exit. */
function deadPid(): number {
  const r = spawnSync("true");
  return r.pid ?? 999999;
}

function seedRunWithRunningStep(opts: {
  claimPid: number | null;
  claimPgid?: number | null;
  claimJobId?: string | null;
  runStatus?: string;
  maxRetries?: number;
  retryCount?: number;
}): { runId: string; stepId: string } {
  const db = getDb();
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', ?, '{}', 0, ?, ?)",
  ).run(runId, opts.runStatus ?? "running", now, now);
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
       retry_count, max_retries, claim_pid, claim_pgid, claim_job_id, created_at, updated_at)
     VALUES (?, ?, 'work', 'wf-dead_dev', 0, 'work', '', 'running', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    stepId, runId,
    opts.retryCount ?? 0, opts.maxRetries ?? 3,
    opts.claimPid, opts.claimPgid ?? null, opts.claimJobId ?? "tamandua-wf-dead-job",
    now, now,
  );
  return { runId, stepId };
}

function stepStatus(stepId: string): { status: string; retry_count: number } {
  return getDb().prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(stepId) as {
    status: string;
    retry_count: number;
  };
}

describe("recoverStepsWithDeadWorkers (C18)", () => {
  it("requeues a running step whose worker pid is dead", () => {
    const { runId, stepId } = seedRunWithRunningStep({ claimPid: deadPid() });

    const result = recoverStepsWithDeadWorkers();

    assert.equal(result.recovered, 1);
    assert.deepEqual(result.runIds, [runId]);
    const step = stepStatus(stepId);
    assert.equal(step.status, "pending", "step should be requeued for retry");
    assert.equal(step.retry_count, 1, "a retry slot is consumed, mirroring orphan recovery");
  });

  it("leaves steps with a live worker alone", () => {
    const { stepId } = seedRunWithRunningStep({ claimPid: process.pid });

    const result = recoverStepsWithDeadWorkers();

    assert.equal(result.recovered, 0);
    assert.equal(stepStatus(stepId).status, "running");
  });

  it("leaves steps without claim ownership to the age-based sweep", () => {
    const { stepId } = seedRunWithRunningStep({ claimPid: null });

    const result = recoverStepsWithDeadWorkers();

    assert.equal(result.recovered, 0);
    assert.equal(stepStatus(stepId).status, "running", "no claim_pid → liveness unknown → untouched");
  });

  it("ignores steps of non-running runs", () => {
    const { stepId } = seedRunWithRunningStep({ claimPid: deadPid(), runStatus: "paused" });

    const result = recoverStepsWithDeadWorkers();

    assert.equal(result.recovered, 0);
    assert.equal(stepStatus(stepId).status, "running");
  });

  it("exhausts retries and fails the run when the dead worker burned the last retry", () => {
    const { runId, stepId } = seedRunWithRunningStep({
      claimPid: deadPid(),
      retryCount: 3,
      maxRetries: 3,
    });

    const result = recoverStepsWithDeadWorkers();

    assert.equal(result.failed, 1);
    assert.equal(stepStatus(stepId).status, "failed");
    const run = getDb().prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed");
  });

  it("recovers multiple dead-worker steps across runs in one sweep", () => {
    const a = seedRunWithRunningStep({ claimPid: deadPid() });
    const b = seedRunWithRunningStep({ claimPid: deadPid() });
    const alive = seedRunWithRunningStep({ claimPid: process.pid });

    const result = recoverStepsWithDeadWorkers();

    assert.equal(result.recovered, 2);
    assert.equal(new Set(result.runIds).size, 2);
    assert.equal(stepStatus(a.stepId).status, "pending");
    assert.equal(stepStatus(b.stepId).status, "pending");
    assert.equal(stepStatus(alive.stepId).status, "running");
  });

  it("leaves the step alone when the harness process GROUP survived the daemon (survivor guard)", async () => {
    // Ungraceful daemon death does not kill detached harness children: the
    // agent may still be working. Spawn a detached process (its own group
    // leader) to stand in for the surviving harness group.
    const { spawn } = await import("node:child_process");
    const survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
      detached: true,
      stdio: "ignore",
    });
    try {
      const { stepId } = seedRunWithRunningStep({
        claimPid: deadPid(),
        claimPgid: survivor.pid!,
      });

      const result = recoverStepsWithDeadWorkers();

      assert.equal(result.recovered, 0, "must not requeue while the harness group is alive");
      assert.equal(result.skipped, 1, "the survivor case is reported as skipped");
      assert.equal(stepStatus(stepId).status, "running", "two agents in one workdir is worse than waiting");
    } finally {
      try { process.kill(-survivor.pid!, "SIGKILL"); } catch { /* gone */ }
    }
  });

  it("requeues when both the daemon and the harness group are dead", async () => {
    const { spawnSync } = await import("node:child_process");
    // A pgid guaranteed dead: a short-lived detached leader that already exited.
    const r = spawnSync("true");
    const deadGroup = r.pid ?? 999998;

    const { stepId } = seedRunWithRunningStep({
      claimPid: deadPid(),
      claimPgid: deadGroup,
    });

    const result = recoverStepsWithDeadWorkers();

    assert.equal(result.recovered, 1);
    assert.equal(stepStatus(stepId).status, "pending");
  });

  it("getOwnProcessGroupId returns this process's group (matches ps)", async () => {
    const { getOwnProcessGroupId } = await import("../dist/installer/step-ops.js");
    const { spawnSync } = await import("node:child_process");
    const own = getOwnProcessGroupId();
    assert.ok(own && own > 0, "should self-detect a positive pgid on Linux");
    const psOut = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf-8" });
    assert.equal(own, Number(psOut.stdout.trim()), "must agree with ps");
  });
});

// ══════════════════════════════════════════════════════════════════════
// US-004 WLST Recovery — story-level abandoned_count vs retry_count
// ══════════════════════════════════════════════════════════════════════

/**
 * Seed a run + story + loop step for abandonment recovery testing.
 * The story starts at status='running' with the given abandoned_count and
 * retry_count. The loop step has current_story_id set and status='running'.
 * Returns { runId, storyId, storyRowId, stepRowId }.
 */
function seedStoryRun(opts: {
  agentId?: string;
  abandonedCount?: number;
  retryCount?: number;
  maxRetries?: number;
  backdateSeconds?: number;
  inputTemplate?: string;
} = {}): { runId: string; storyId: string; storyRowId: string; stepRowId: string } {
  const db = getDb();
  const runId = crypto.randomUUID();
  const storyRowId = crypto.randomUUID();
  const stepRowId = crypto.randomUUID();
  const ago = new Date(Date.now() - (opts.backdateSeconds ?? 0) * 1000).toISOString();
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, ?, ?)",
  ).run(runId, ago, ago);

  db.prepare(
    `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria,
       status, retry_count, max_retries, abandoned_count, created_at, updated_at)
     VALUES (?, ?, 0, 'S1', 'Test', 'desc', '[]', 'running', ?, ?, ?, ?, ?)`,
  ).run(storyRowId, runId, opts.retryCount ?? 0, opts.maxRetries ?? 4, opts.abandonedCount ?? 0, ago, ago);

  const inputTemplate = opts.inputTemplate ?? 'Implement';
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
       status, retry_count, max_retries, type, current_story_id, loop_config, created_at, updated_at)
     VALUES (?, ?, 'implement', ?, 0, ?, '', 'running', 0, 4, 'loop', ?, ?, ?, ?)`,
  ).run(stepRowId, runId, opts.agentId ?? "wf-dead_dev", inputTemplate, storyRowId, JSON.stringify({ over: "stories" }), ago, ago);

  return { runId, storyId: "S1", storyRowId, stepRowId };
}

function storyState(storyRowId: string): {
  status: string; retry_count: number; abandoned_count: number;
} {
  return getDb().prepare(
    "SELECT status, retry_count, abandoned_count FROM stories WHERE id = ?"
  ).get(storyRowId) as { status: string; retry_count: number; abandoned_count: number };
}

describe("recoverOrphanedStepsForAgent — story-level WLST", () => {
  it("increments story.abandoned_count, not story.retry_count", async () => {
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-dead_fixer",
      abandonedCount: 0,
      retryCount: 2,
      backdateSeconds: 5,
    });

    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const result = recoverOrphanedStepsForAgent("wf-dead_fixer", runId, 0);

    assert.equal(result.recovered, 1, "story should be recovered");
    assert.equal(result.failed, 0, "story should not be failed");

    const story = storyState(storyRowId);
    assert.equal(story.status, "pending", "story should be reset to pending");
    assert.equal(story.abandoned_count, 1, "abandoned_count should increment from 0 to 1");
    assert.equal(story.retry_count, 2, "retry_count should be UNCHANGED (not mixed with infra failures)");
  });

  it("increments abandoned_count cumulatively on repeated recoveries", async () => {
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-dead_fixer",
      abandonedCount: 3,
      retryCount: 1,
      backdateSeconds: 5,
    });

    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");

    // First recovery
    let result = recoverOrphanedStepsForAgent("wf-dead_fixer", runId, 0);
    assert.equal(result.recovered, 1);

    // Reset step back to running for next recovery
    const db = getDb();
    // Backdate again after first recovery
    const ago = new Date(Date.now() - 5 * 1000).toISOString();
    db.prepare("UPDATE steps SET status = 'running', current_story_id = ?, updated_at = ? WHERE run_id = ?").run(storyRowId, ago, runId);
    db.prepare("UPDATE stories SET status = 'running', updated_at = ? WHERE id = ?").run(ago, storyRowId);

    // Second recovery
    result = recoverOrphanedStepsForAgent("wf-dead_fixer", runId, 0);
    assert.equal(result.recovered, 1, "second recovery should also succeed");

    const story = storyState(storyRowId);
    assert.equal(story.abandoned_count, 5, "abandoned_count should be 3 + 1 + 1 = 5");
    assert.equal(story.retry_count, 1, "retry_count should still be 1 (unchanged)");
  });

  it("exhausts ABANDON_STORY_MAX=8 and fails the story/run", async () => {
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-dead_fixer",
      abandonedCount: 8,
      retryCount: 0,
      backdateSeconds: 5,
    });

    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const result = recoverOrphanedStepsForAgent("wf-dead_fixer", runId, 0);

    assert.equal(result.failed, 1, "story should be failed on abandon exhaustion");
    assert.equal(result.recovered, 0, "story should not be recovered");

    const story = storyState(storyRowId);
    assert.equal(story.status, "failed", "story should be failed");
    assert.equal(story.abandoned_count, 9, "abandoned_count should be 9 (exhausted)");

    const run = getDb().prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed");
  });

  it("preserves retry_count for honest rejections (does not touch retry_count)", async () => {
    // A story with honest retries already consumed (retry_count=3, max_retries=4)
    // suffers a worker loss. abandoned_count increments, retry_count stays.
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-dead_fixer",
      abandonedCount: 0,
      retryCount: 3,
      maxRetries: 4,
      backdateSeconds: 5,
    });

    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const result = recoverOrphanedStepsForAgent("wf-dead_fixer", runId, 0);

    assert.equal(result.recovered, 1);
    const story = storyState(storyRowId);
    assert.equal(story.abandoned_count, 1, "abandoned_count should be 1");
    assert.equal(story.retry_count, 3, "retry_count should stay at 3 (honest rejection budget preserved)");
    assert.equal(story.status, "pending");
  });
});

describe("cleanupAbandonedSteps — story-level WLST", () => {
  it("increments story.abandoned_count, not story.retry_count, on age-based cleanup", async () => {
    // Backdate by 2 hours to exceed ABANDONED_THRESHOLD_MS (maxRoleTimeout + 5min grace)
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-dead_dev",
      abandonedCount: 0,
      retryCount: 2,
      backdateSeconds: 7200,
    });

    const { cleanupAbandonedSteps } = await import("../dist/installer/step-ops.js");
    cleanupAbandonedSteps();

    const story = storyState(storyRowId);
    assert.equal(story.status, "pending", "story should be reset to pending");
    assert.equal(story.abandoned_count, 1, "abandoned_count should increment from 0 to 1");
    assert.equal(story.retry_count, 2, "retry_count should be UNCHANGED");
  });

  it("exhausts ABANDON_STORY_MAX=8 and fails the story/run", async () => {
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-dead_dev",
      abandonedCount: 8,
      retryCount: 0,
      backdateSeconds: 7200,
    });

    const { cleanupAbandonedSteps } = await import("../dist/installer/step-ops.js");
    cleanupAbandonedSteps();

    const story = storyState(storyRowId);
    assert.equal(story.status, "failed", "story should be failed");
    assert.equal(story.abandoned_count, 9, "abandoned_count should be 9 (exhausted)");

    const run = getDb().prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed");
  });

  it("recovers story with abundant abandon budget even when retries are exhausted", async () => {
    // Story has exhausted its honest retry budget (retry_count=4, max_retries=4)
    // but has abandon budget remaining (abandoned_count=0). Age-based cleanup
    // should still recover it using the abandon counter.
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-dead_dev",
      abandonedCount: 0,
      retryCount: 4,
      maxRetries: 4,
      backdateSeconds: 7200,
    });

    const { cleanupAbandonedSteps } = await import("../dist/installer/step-ops.js");
    cleanupAbandonedSteps();

    const story = storyState(storyRowId);
    assert.equal(story.status, "pending", "story should be recovered (abandon budget available)");
    assert.equal(story.abandoned_count, 1);
    assert.equal(story.retry_count, 4, "retry_count unchanged");
  });

  it("does NOT reset done stories (cleanupAbandonedSteps skips done)", async () => {
    // Set up a done story. cleanupAbandonedSteps explicitly skips 'done' stories.
    const db = getDb();
    const runId = crypto.randomUUID();
    const storyRowId = crypto.randomUUID();
    const ago = new Date(Date.now() - 3600 * 1000).toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, ?, ?)",
    ).run(runId, ago, ago);

    db.prepare(
      `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria,
         status, retry_count, max_retries, abandoned_count, created_at, updated_at)
       VALUES (?, ?, 0, 'S-done', 'Test', 'desc', '[]', 'done', 0, 4, 0, ?, ?)`,
    ).run(storyRowId, runId, ago, ago);

    const { cleanupAbandonedSteps } = await import("../dist/installer/step-ops.js");
    cleanupAbandonedSteps();

    // Story should still be 'done' (NOT touched by cleanupAbandonedSteps story path)
    const story = storyState(storyRowId);
    assert.equal(story.status, "done", "done stories must NOT be reset by cleanupAbandonedSteps");
    assert.equal(story.abandoned_count, 0, "abandoned_count should be unchanged");
  });
});

// ══════════════════════════════════════════════════════════════════════
// US-005 WLST Feedback — timeout_retry flows to story-level claim context
// ══════════════════════════════════════════════════════════════════════

describe("recoverOrphanedStepsForAgent — timeout_retry feedback (story-level)", () => {
  it("sets timeout_retry in run context when timeoutRetryReason is provided for story-level recovery", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-dead_fixer",
      abandonedCount: 0,
      retryCount: 2,
      backdateSeconds: 5,
    });

    const timeoutReason = "previous attempt was killed by the 30-minute harness timeout — plan the work to fit, or split it.";
    const result = recoverOrphanedStepsForAgent("wf-dead_fixer", runId, 0, timeoutReason);

    assert.equal(result.recovered, 1, "story should be recovered");
    assert.equal(result.failed, 0, "story should not be failed");

    // Story-level recovery should keep abandoned_count separate from retry_count
    const story = storyState(storyRowId);
    assert.equal(story.status, "pending", "story should be reset to pending");
    assert.equal(story.abandoned_count, 1, "abandoned_count should increment");
    assert.equal(story.retry_count, 2, "retry_count unchanged");

    // Run context should contain timeout_retry
    const runAfter = getDb().prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
    const ctx = JSON.parse(runAfter.context);
    assert.equal(ctx.timeout_retry, timeoutReason,
      "run context must carry timeout_retry after story-level timeout recovery");
  });

  it("claimStep sees timeout_retry in resolvedInput for the loop step", async () => {
    const { recoverOrphanedStepsForAgent, claimStep } = await import("../dist/installer/step-ops.js");
    const { runId } = seedStoryRun({
      agentId: "wf-dead_fixer",
      abandonedCount: 0,
      retryCount: 2,
      backdateSeconds: 5,
      // The input_template must include {{timeout_retry}} so the resolver
      // injects the timeout message — just like real workflow YAML templates.
      inputTemplate: "Story: {{current_story}}\nID: {{current_story_id}}\nTitle: {{current_story_title}}\nTIMEOUT RETRY: {{timeout_retry}}\nRETRY FEEDBACK: {{retry_feedback}}",
    });

    const timeoutReason = "previous attempt was killed by the 30-minute harness timeout — plan the work to fit, or split it.";
    const recoveryResult = recoverOrphanedStepsForAgent("wf-dead_fixer", runId, 0, timeoutReason);
    assert.equal(recoveryResult.recovered, 1, "story should be recovered");

    // After recovery, the loop step is reset to pending (current_story_id=NULL).
    // claimStep for the agent should pick it up and resolve timeout_retry.
    const claim = claimStep("wf-dead_fixer", runId);
    assert.ok(claim.found, "step should be claimable after story-level recovery");
    // The resolvedInput should contain the timeout message (via the TIMEOUT RETRY section)
    assert.ok(claim.resolvedInput!.includes("TIMEOUT RETRY"),
      `resolvedInput should include TIMEOUT RETRY section, got: ${claim.resolvedInput?.slice(0, 500)}`);
    assert.ok(claim.resolvedInput!.includes(timeoutReason),
      `resolvedInput should include the timeout reason, got: ${claim.resolvedInput?.slice(0, 500)}`);
  });

  it("clears timeout_retry from run context after claim prevents leakage", async () => {
    const { recoverOrphanedStepsForAgent, claimStep } = await import("../dist/installer/step-ops.js");
    const { runId } = seedStoryRun({
      agentId: "wf-dead_fixer",
      abandonedCount: 0,
      retryCount: 2,
      backdateSeconds: 5,
      inputTemplate: "Story: {{current_story}}\nTIMEOUT RETRY: {{timeout_retry}}",
    });

    const timeoutReason = "previous attempt was killed by the 30-minute harness timeout — plan the work to fit, or split it.";
    recoverOrphanedStepsForAgent("wf-dead_fixer", runId, 0, timeoutReason);

    // Verify timeout_retry is present before claim
    const ctxBefore = JSON.parse((getDb().prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string }).context);
    assert.equal(ctxBefore.timeout_retry, timeoutReason, "timeout_retry should be present before claim");

    // Claim the step — this should clear timeout_retry
    const claim = claimStep("wf-dead_fixer", runId);
    assert.ok(claim.found, "step should be claimable");

    // After claim, timeout_retry should be cleared from run context.
    // The loop-step path deletes the key entirely (not sets to "").
    const ctxAfter = JSON.parse((getDb().prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string }).context);
    assert.ok(!ctxAfter.timeout_retry,
      `timeout_retry should be cleared from run context after claim, got: ${JSON.stringify(ctxAfter.timeout_retry)}`);
  });

  it("does NOT set timeout_retry when timeoutRetryReason is omitted for story-level recovery", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-dead_fixer",
      abandonedCount: 0,
      retryCount: 0,
      backdateSeconds: 5,
    });

    // Recovery WITHOUT timeout reason (non-timeout worker loss, e.g. crash)
    const result = recoverOrphanedStepsForAgent("wf-dead_fixer", runId, 0);
    assert.equal(result.recovered, 1, "story should be recovered");

    // Verify abandoned_count is used (not retry_count)
    const story = storyState(storyRowId);
    assert.equal(story.abandoned_count, 1, "abandoned_count should increment");
    assert.equal(story.retry_count, 0, "retry_count unchanged");

    const runAfter = getDb().prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
    const ctx = JSON.parse(runAfter.context);
    // timeout_retry should not be set when no timeout reason was provided
    assert.ok(!ctx.timeout_retry,
      `timeout_retry should not be present when no timeout reason was provided, got: ${JSON.stringify(ctx.timeout_retry)}`);
  });

  it("feedback message includes harness timeout minutes (not raw ms error)", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const { runId } = seedStoryRun({
      agentId: "wf-dead_fixer",
      abandonedCount: 0,
      retryCount: 0,
      backdateSeconds: 5,
    });

    // Simulate the formatted feedback that agent-scheduler would produce
    // ("previous attempt was killed by the N-minute harness timeout...")
    const formattedReason = "previous attempt was killed by the 20-minute harness timeout — plan the work to fit, or split it.";
    const result = recoverOrphanedStepsForAgent("wf-dead_fixer", runId, 0, formattedReason);
    assert.equal(result.recovered, 1);

    const runAfter = getDb().prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
    const ctx = JSON.parse(runAfter.context);
    // The message should NOT be a raw ms error like "pi timed out after 1200000ms"
    assert.ok(!ctx.timeout_retry.includes("timed out after") || ctx.timeout_retry.includes("minute"),
      `feedback should use minute-based format, not raw ms: ${ctx.timeout_retry}`);
    assert.ok(ctx.timeout_retry.includes("plan the work to fit"),
      `feedback should include actionable guidance: ${ctx.timeout_retry}`);
  });
});

// ══════════════════════════════════════════════════════════════════════
// US-001 PGID Liveness Watchdog — checkRunningWorkersLiveness
// ══════════════════════════════════════════════════════════════════════

/**
 * Seed a step with claim_pgid and claim_updated_at for liveness testing.
 */
function seedRunWithPgidStep(opts: {
  claimPgid: number | null;
  claimJobId?: string | null;
  runStatus?: string;
  maxRetries?: number;
  retryCount?: number;
  backdateClaimMs?: number; // milliseconds to subtract from claim_updated_at
}): { runId: string; stepId: string; agentId: string } {
  const db = getDb();
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const agentId = "wf-dead_dev";
  const now = new Date().toISOString();
  const claimUpdatedAt = opts.backdateClaimMs != null
    ? new Date(Date.now() - opts.backdateClaimMs).toISOString()
    : now;
  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', ?, '{}', 0, ?, ?)",
  ).run(runId, opts.runStatus ?? "running", now, now);
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
       retry_count, max_retries, claim_pid, claim_pgid, claim_job_id, claim_updated_at, created_at, updated_at)
     VALUES (?, ?, 'work', ?, 0, 'work', '', 'running', ?, ?, 999999, ?, ?, ?, ?, ?)`,
  ).run(
    stepId, runId, agentId,
    opts.retryCount ?? 0, opts.maxRetries ?? 3,
    opts.claimPgid, opts.claimJobId ?? "tamandua-wf-dead-job",
    claimUpdatedAt, now, now,
  );
  return { runId, stepId, agentId };
}

describe("checkRunningWorkersLiveness (US-001)", () => {
  it("recovers a step whose claim_pgid is dead", async () => {
    const { spawnSync } = await import("node:child_process");
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");
    const deadPgid = spawnSync("true").pid ?? 999997;
    const { runId, stepId } = seedRunWithPgidStep({
      claimPgid: deadPgid,
      backdateClaimMs: 60_000, // 60s old, well past grace period
    });

    const result = checkRunningWorkersLiveness();

    assert.equal(result.recovered, 1, "dead-pgid step should be recovered");
    assert.deepEqual(result.runIds, [runId]);
    const step = stepStatus(stepId);
    assert.equal(step.status, "pending", "step should be requeued for retry");
    assert.equal(step.retry_count, 1, "a retry slot is consumed");
  });

  it("leaves steps with a live process group alone", async () => {
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");
    const { getOwnProcessGroupId } = await import("../dist/installer/step-ops.js");
    // Use our own process GROUP id — it's definitely alive.
    const ownPgid = getOwnProcessGroupId();
    assert.ok(ownPgid && ownPgid > 0, "must self-detect a positive pgid");
    const { stepId } = seedRunWithPgidStep({
      claimPgid: ownPgid,
      backdateClaimMs: 60_000,
    });

    const result = checkRunningWorkersLiveness();

    assert.equal(result.recovered, 0, "live pgid must NOT be recovered");
    assert.equal(result.skipped, 0);
    assert.equal(stepStatus(stepId).status, "running");
  });

  it("skips steps without claim_pgid (ownerless/legacy)", async () => {
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");
    // claim_pgid = null, claim_updated_at = null — legacy claim
    const { stepId } = seedRunWithPgidStep({
      claimPgid: null,
      backdateClaimMs: 60_000,
    });

    const result = checkRunningWorkersLiveness();

    assert.equal(result.recovered, 0, "ownerless claims must be skipped");
    assert.equal(result.skipped, 0);
    assert.equal(stepStatus(stepId).status, "running", "left for timeout sweeper");
  });

  it("respects grace period: skips claims younger than 30s", async () => {
    const { spawnSync } = await import("node:child_process");
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");
    const deadPgid = spawnSync("true").pid ?? 999996;
    // Only 10s old — within grace period
    const { stepId } = seedRunWithPgidStep({
      claimPgid: deadPgid,
      backdateClaimMs: 10_000,
    });

    const result = checkRunningWorkersLiveness();

    assert.equal(result.skipped, 1, "claim within grace period must be skipped");
    assert.equal(result.recovered, 0);
    assert.equal(stepStatus(stepId).status, "running", "step left alone during grace period");
  });

  it("does not skip claims just past the grace period (31s old)", async () => {
    const { spawnSync } = await import("node:child_process");
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");
    const deadPgid = spawnSync("true").pid ?? 999995;
    // 31s old — just past the 30s grace period boundary
    const { runId, stepId } = seedRunWithPgidStep({
      claimPgid: deadPgid,
      backdateClaimMs: 31_000,
    });

    const result = checkRunningWorkersLiveness();

    assert.equal(result.recovered, 1, "step just past grace period should be recovered");
    assert.deepEqual(result.runIds, [runId]);
    assert.equal(stepStatus(stepId).status, "pending");
  });

  it("skips steps with NULL claim_updated_at (conservative fallback)", async () => {
    const { spawnSync } = await import("node:child_process");
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");
    const deadPgid = spawnSync("true").pid ?? 999994;
    // claim_updated_at not backdated — it's set in the seed function to now
    // So we NULL it out after seeding
    const { stepId } = seedRunWithPgidStep({
      claimPgid: deadPgid,
      backdateClaimMs: 60_000,
    });
    // Manually set claim_updated_at to NULL
    getDb().prepare("UPDATE steps SET claim_updated_at = NULL WHERE id = ?").run(stepId);

    const result = checkRunningWorkersLiveness();

    assert.equal(result.skipped, 1, "NULL claim_updated_at — can't determine age, skip");
    assert.equal(result.recovered, 0);
    assert.equal(stepStatus(stepId).status, "running", "left for timeout sweeper");
  });

  it("emits step.worker_lost event with [liveness-detected] detail prefix", async () => {
    const { spawnSync } = await import("node:child_process");
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");
    const deadPgid = spawnSync("true").pid ?? 999993;
    const { stepId } = seedRunWithPgidStep({
      claimPgid: deadPgid,
      backdateClaimMs: 60_000,
    });

    // Verify the step was recovered before checking events
    const result = checkRunningWorkersLiveness();
    assert.equal(result.recovered, 1, "step must be recovered for event to exist");

    // Read the events file and check the detail
    const eventsPath = path.join(process.env.TAMANDUA_STATE_DIR!, "events", "all.jsonl");
    let foundLivenessEvent = false;
    try {
      const events = fs.readFileSync(eventsPath, "utf-8");
      for (const line of events.split("\n")) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.event === "step.worker_lost" && evt.detail && evt.detail.includes("[liveness-detected]")) {
            foundLivenessEvent = true;
            assert.ok(evt.detail.includes("exited"), "detail should describe worker exit");
            break;
          }
        } catch {
          // skip malformed JSON lines
        }
      }
    } catch {
      // events file may not exist — that's also a test failure
    }
    assert.ok(foundLivenessEvent,
      "must emit step.worker_lost with [liveness-detected] in detail");
  });

  it("does NOT emit liveness-detected events when no dead workers exist", async () => {
    const { checkRunningWorkersLiveness, getOwnProcessGroupId } = await import("../dist/installer/step-ops.js");
    const ownPgid = getOwnProcessGroupId();
    assert.ok(ownPgid && ownPgid > 0, "must self-detect a positive pgid");
    // Live pgid only
    seedRunWithPgidStep({
      claimPgid: ownPgid,
      backdateClaimMs: 60_000,
    });

    checkRunningWorkersLiveness();

    const eventsPath = path.join(process.env.TAMANDUA_STATE_DIR!, "events", "all.jsonl");
    let foundLivenessEvent = false;
    try {
      const events = fs.readFileSync(eventsPath, "utf-8");
      for (const line of events.split("\n")) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.event === "step.worker_lost" && evt.detail && evt.detail.includes("[liveness-detected]")) {
            foundLivenessEvent = true;
          }
        } catch {
          // skip
        }
      }
    } catch {
      // no events file means no events — good
    }
    assert.equal(foundLivenessEvent, false,
      "must NOT emit liveness-detected events when all workers are alive");
  });

  it("recovers multiple dead-pgid steps across runs in one sweep", async () => {
    const { spawnSync } = await import("node:child_process");
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");
    const deadPgidA = spawnSync("true").pid ?? 999992;
    const deadPgidB = spawnSync("true").pid ?? 999991;
    const { runId: runA, stepId: stepA } = seedRunWithPgidStep({
      claimPgid: deadPgidA,
      backdateClaimMs: 60_000,
    });
    const { runId: runB, stepId: stepB } = seedRunWithPgidStep({
      claimPgid: deadPgidB,
      backdateClaimMs: 60_000,
    });

    const result = checkRunningWorkersLiveness();

    assert.equal(result.recovered, 2, "both dead-pgid steps should be recovered");
    assert.equal(new Set(result.runIds).size, 2);
    assert.equal(stepStatus(stepA).status, "pending");
    assert.equal(stepStatus(stepB).status, "pending");
  });

  it("exhausts retries and fails the run when the dead worker burned the last retry", async () => {
    const { spawnSync } = await import("node:child_process");
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");
    const deadPgid = spawnSync("true").pid ?? 999990;
    const { runId, stepId } = seedRunWithPgidStep({
      claimPgid: deadPgid,
      backdateClaimMs: 60_000,
      retryCount: 3,
      maxRetries: 3,
    });

    const result = checkRunningWorkersLiveness();

    assert.equal(result.failed, 1, "step should fail when retries exhausted");
    assert.equal(stepStatus(stepId).status, "failed");
    const run = getDb().prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed");
  });

  it("ignores steps with claim_pgid = 0 (not a valid pgid)", async () => {
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");
    const { stepId } = seedRunWithPgidStep({
      claimPgid: 0,
      backdateClaimMs: 60_000,
    });

    const result = checkRunningWorkersLiveness();

    assert.equal(result.recovered, 0, "claim_pgid=0 must be skipped (query uses > 0)");
    assert.equal(stepStatus(stepId).status, "running");
  });

  // ═══════════════════════════════════════════════════════════════════
  // US-003: Story-level abandon accounting via liveness watchdog
  // ═══════════════════════════════════════════════════════════════════

  it("increments story.abandoned_count (not retry_count) for dead-pgid story-level recovery", async () => {
    const { spawnSync } = await import("node:child_process");
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");
    const deadPgid = spawnSync("true").pid ?? 999989;

    // Seed a story+loop step, then assign a dead PGID with backdated claim
    const { runId, storyRowId, stepRowId } = seedStoryRun({
      agentId: "wf-dead_dev",
      abandonedCount: 0,
      retryCount: 2,
      backdateSeconds: 60,
    });

    const db = getDb();
    const backdatedClaim = new Date(Date.now() - 60_000).toISOString();
    db.prepare(
      "UPDATE steps SET claim_pgid = ?, claim_pid = 999999, claim_job_id = 'job-liveness-story', claim_updated_at = ? WHERE id = ?"
    ).run(deadPgid, backdatedClaim, stepRowId);

    const result = checkRunningWorkersLiveness();

    assert.equal(result.recovered, 1, "dead-pgid story step should be recovered");
    assert.deepEqual(result.runIds, [runId]);

    const story = storyState(storyRowId);
    assert.equal(story.status, "pending", "story should be reset to pending");
    assert.equal(story.abandoned_count, 1, "abandoned_count should increment from 0 to 1");
    assert.equal(story.retry_count, 2, "retry_count should be UNCHANGED (not mixed with infra failures)");

    // Step should be reset to pending with current_story_id cleared
    const step = getDb().prepare(
      "SELECT status, current_story_id FROM steps WHERE id = ?"
    ).get(stepRowId) as { status: string; current_story_id: string | null };
    assert.equal(step.status, "pending", "step should be reset to pending");
    assert.equal(step.current_story_id, null, "current_story_id should be cleared");
  });

  it("emits step.worker_lost with [liveness-detected] and story info for story-level recovery", async () => {
    const { spawnSync } = await import("node:child_process");
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");
    const deadPgid = spawnSync("true").pid ?? 999988;

    const { storyRowId, stepRowId } = seedStoryRun({
      agentId: "wf-dead_dev",
      abandonedCount: 0,
      retryCount: 0,
      backdateSeconds: 60,
    });

    const db = getDb();
    const backdatedClaim = new Date(Date.now() - 60_000).toISOString();
    db.prepare(
      "UPDATE steps SET claim_pgid = ?, claim_pid = 999999, claim_job_id = 'job-liveness-story2', claim_updated_at = ? WHERE id = ?"
    ).run(deadPgid, backdatedClaim, stepRowId);

    const result = checkRunningWorkersLiveness();
    assert.equal(result.recovered, 1, "step must be recovered for event to exist");

    // Read the events file and verify the detail
    const eventsPath = path.join(process.env.TAMANDUA_STATE_DIR!, "events", "all.jsonl");
    let foundLivenessStoryEvent = false;
    try {
      const events = fs.readFileSync(eventsPath, "utf-8");
      for (const line of events.split("\n")) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.event === "step.worker_lost" && evt.detail) {
            if (evt.detail.includes("[liveness-detected]") && evt.detail.includes("story")) {
              foundLivenessStoryEvent = true;
              assert.ok(
                evt.detail.includes("exited without completing story"),
                `detail should mention incomplete story: ${evt.detail}`
              );
              assert.ok(
                evt.detail.includes("reset to pending"),
                `detail should mention reset to pending: ${evt.detail}`
              );
              assert.ok(
                evt.detail.includes("story abandon 1/8"),
                `detail should include abandon count (1/8): ${evt.detail}`
              );
              break;
            }
          }
        } catch {
          // skip malformed JSON lines
        }
      }
    } catch {
      // events file may not exist
    }
    assert.ok(foundLivenessStoryEvent,
      "must emit step.worker_lost with [liveness-detected] and story abandon info");
  });

  it("exhausts story abandon budget via liveness watchdog and fails story/run", async () => {
    const { spawnSync } = await import("node:child_process");
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");
    const deadPgid = spawnSync("true").pid ?? 999987;

    // Seed a story already at ABANDON_STORY_MAX (8) abandon count
    const { runId, storyRowId, stepRowId } = seedStoryRun({
      agentId: "wf-dead_dev",
      abandonedCount: 8,
      retryCount: 0,
      backdateSeconds: 60,
    });

    const db = getDb();
    const backdatedClaim = new Date(Date.now() - 60_000).toISOString();
    db.prepare(
      "UPDATE steps SET claim_pgid = ?, claim_pid = 999999, claim_job_id = 'job-liveness-story3', claim_updated_at = ? WHERE id = ?"
    ).run(deadPgid, backdatedClaim, stepRowId);

    const result = checkRunningWorkersLiveness();

    assert.equal(result.failed, 1, "story should be failed on abandon exhaustion");
    assert.equal(result.recovered, 0, "story should not be recovered when exhausted");

    const story = storyState(storyRowId);
    assert.equal(story.status, "failed", "story should be failed");
    assert.equal(story.abandoned_count, 9, "abandoned_count should be 9 (exhausted)");

    const run = getDb().prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed");
  });
});

// ══════════════════════════════════════════════════════════════════════
// US-002 Liveness Watchdog Integration — executeDispatchRound wiring
// ══════════════════════════════════════════════════════════════════════

describe("liveness watchdog in executeDispatchRound (US-002)", () => {
  it("recovers dead-pgid steps during dispatch round tick", async () => {
    const deadPgid = spawnSync("true").pid ?? 999980;
    const deadWorkerRunId = crypto.randomUUID();
    const deadWorkerStepId = crypto.randomUUID();
    const dispatchRunId = crypto.randomUUID();
    const claimUpdatedAt = new Date(Date.now() - 60_000).toISOString();
    const now = new Date().toISOString();
    const db = getDb();

    // Seed a step with a dead PGID (simulating worker that died)
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-live-int', 'task', 'running', '{}', 0, ?, ?)",
    ).run(deadWorkerRunId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
         retry_count, max_retries, claim_pid, claim_pgid, claim_job_id, claim_updated_at, created_at, updated_at)
       VALUES (?, ?, 'work', 'wf-live-int_dev', 0, 'work', '', 'running', 0, 5, 999999, ?, 'job-dead', ?, ?, ?)`,
    ).run(deadWorkerStepId, deadWorkerRunId, deadPgid, claimUpdatedAt, now, now);

    // Seed an EMPTY dispatch run (different agent with no steps — peek returns NO_WORK)
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-live-int', 'task', 'running', '{}', 0, ?, ?)",
    ).run(dispatchRunId, now, now);

    const { executeDispatchRound } = await import("../dist/installer/agent-scheduler.js");
    const { nudgeScheduledRuns } = await import("../dist/installer/agent-scheduler.js");

    // Track nudge calls to verify the integration
    const nudgedRunIds: string[][] = [];
    const origNudge = nudgeScheduledRuns;
    // We can't easily mock dynamic imports, so instead we verify the outcome
    // by calling executeDispatchRound and checking the step was recovered.
    const job: import("../dist/installer/agent-scheduler.js").CronJobInfo = {
      id: "job-live-int",
      workflowId: "wf-live-int",
      agentId: "wf-live-int_other",
      runId: dispatchRunId,
      timeoutSeconds: 30,
      workingDirectoryForHarness: process.cwd(),
      harnessType: "pi",
      createdAt: now,
    };

    const agent: import("../dist/installer/types.js").WorkflowAgent = {
      id: "other",
      role: "coding",
      workspace: { baseDir: process.cwd(), files: {} },
    };

    try {
      await executeDispatchRound(job, agent);
    } catch {
      // executeDispatchRound may throw if workspace / persona resolution fails
      // in the test env — that's fine, the liveness check already ran
    }

    // The dead-PGID step should have been recovered by the liveness watchdog
    const step = stepStatus(deadWorkerStepId);
    assert.equal(
      step.status,
      "pending",
      `dead-pgid step should be recovered to pending during dispatch round, got ${step.status}`,
    );

    // Verify a retry slot was consumed
    assert.equal(step.retry_count, 1, "recovery should consume a retry slot");
  });

  it("leaves live-pgid steps untouched during dispatch round", async () => {
    const { getOwnProcessGroupId } = await import("../dist/installer/step-ops.js");
    const ownPgid = getOwnProcessGroupId();
    assert.ok(ownPgid && ownPgid > 0, "must self-detect a positive pgid");

    const liveRunId = crypto.randomUUID();
    const liveStepId = crypto.randomUUID();
    const dispatchRunId = crypto.randomUUID();
    const now = new Date().toISOString();
    const db = getDb();

    // Seed a step with our own (live) PGID
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-live-int', 'task', 'running', '{}', 0, ?, ?)",
    ).run(liveRunId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
         retry_count, max_retries, claim_pid, claim_pgid, claim_job_id, claim_updated_at, created_at, updated_at)
       VALUES (?, ?, 'work', 'wf-live-int_dev', 0, 'work', '', 'running', 0, 3, 999999, ?, 'job-live', ?, ?, ?)`,
    ).run(liveStepId, liveRunId, ownPgid, now, now, now);

    // Empty dispatch run
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-live-int', 'task', 'running', '{}', 0, ?, ?)",
    ).run(dispatchRunId, now, now);

    const { executeDispatchRound } = await import("../dist/installer/agent-scheduler.js");

    const job: import("../dist/installer/agent-scheduler.js").CronJobInfo = {
      id: "job-live-int2",
      workflowId: "wf-live-int",
      agentId: "wf-live-int_other",
      runId: dispatchRunId,
      timeoutSeconds: 30,
      workingDirectoryForHarness: process.cwd(),
      harnessType: "pi",
      createdAt: now,
    };

    const agent: import("../dist/installer/types.js").WorkflowAgent = {
      id: "other",
      role: "coding",
      workspace: { baseDir: process.cwd(), files: {} },
    };

    try {
      await executeDispatchRound(job, agent);
    } catch {
      // ignore workspace resolution errors — liveness check already ran
    }

    // The live-PGID step should NOT have been touched
    const step = stepStatus(liveStepId);
    assert.equal(
      step.status,
      "running",
      `live-pgid step must remain running, got ${step.status}`,
    );
  });

  it("does not produce log noise when no dead workers exist (idle round)", async () => {
    // This test verifies that idle rounds don't emit liveness-detected events.
    // Seed an empty dispatch run — no steps with claim_pgid at all.
    const dispatchRunId = crypto.randomUUID();
    const now = new Date().toISOString();
    const db = getDb();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-live-int', 'task', 'running', '{}', 0, ?, ?)",
    ).run(dispatchRunId, now, now);

    const { executeDispatchRound } = await import("../dist/installer/agent-scheduler.js");

    const job: import("../dist/installer/agent-scheduler.js").CronJobInfo = {
      id: "job-live-int3",
      workflowId: "wf-live-int",
      agentId: "wf-live-int_other",
      runId: dispatchRunId,
      timeoutSeconds: 30,
      workingDirectoryForHarness: process.cwd(),
      harnessType: "pi",
      createdAt: now,
    };

    const agent: import("../dist/installer/types.js").WorkflowAgent = {
      id: "other",
      role: "coding",
      workspace: { baseDir: process.cwd(), files: {} },
    };

    try {
      await executeDispatchRound(job, agent);
    } catch {
      // ignore workspace resolution errors
    }

    // Verify no liveness-detected events were emitted
    const eventsPath = path.join(process.env.TAMANDUA_STATE_DIR!, "events", "all.jsonl");
    let foundLivenessEvent = false;
    try {
      const events = fs.readFileSync(eventsPath, "utf-8");
      for (const line of events.split("\n")) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.event === "step.worker_lost" && evt.detail && evt.detail.includes("[liveness-detected]")) {
            foundLivenessEvent = true;
            break;
          }
        } catch {
          // skip malformed JSON lines
        }
      }
    } catch {
      // no events file — also fine
    }
    assert.equal(foundLivenessEvent, false,
      "idle rounds must not produce liveness-detected events");
  });
});
