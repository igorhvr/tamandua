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
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { recoverStepsWithDeadWorkers } from "../dist/installer/step-ops.js";
import { getDb } from "../dist/db.js";
import { getRunEvents } from "../dist/installer/events.js";
import { createTempHome } from "./helpers/test-env.ts";

describe("dead-worker-recovery", () => {
  const th = createTempHome("tamandua-dead-worker-");
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      HOME: process.env.HOME,
      TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
      TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
      TAMANDUA_CONTROL_PORT: process.env.TAMANDUA_CONTROL_PORT,
    };
    process.env.HOME = th.homeDir;
    process.env.TAMANDUA_STATE_DIR = th.tamanduaDir;
    process.env.TAMANDUA_DB_PATH = path.join(th.tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_CONTROL_PORT = "1"; // dead control plane — nudges no-op
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
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
      backdateSeconds: 30,
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
      backdateSeconds: 30,
    });

    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");

    // First recovery
    let result = recoverOrphanedStepsForAgent("wf-dead_fixer", runId, 0);
    assert.equal(result.recovered, 1);

    // Reset step back to running for next recovery
    const db = getDb();
    // Backdate again after first recovery
    const ago = new Date(Date.now() - 30 * 1000).toISOString();
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
      backdateSeconds: 30,
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
      backdateSeconds: 30,
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
    // Backdate by 8 hours to exceed ABANDONED_THRESHOLD_MS (maxRoleTimeout + 5min grace)
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-dead_dev",
      abandonedCount: 0,
      retryCount: 2,
      backdateSeconds: 28800,
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
      backdateSeconds: 28800,
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
      backdateSeconds: 28800,
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
      backdateSeconds: 30,
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
      backdateSeconds: 30,
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
      backdateSeconds: 30,
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
      backdateSeconds: 30,
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
      backdateSeconds: 30,
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
// WDGM: PGID Liveness Watchdog Defense-in-Depth
// ══════════════════════════════════════════════════════════════════════

/** Seed a running step with a backdated claim for watchdog testing. */
function seedWatchdogStep(opts: {
  claimPgid: number;
  claimJobId: string | null;
  backdateSeconds?: number;
}): { runId: string; stepId: string } {
  const db = getDb();
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const ago = new Date(Date.now() - (opts.backdateSeconds ?? 60) * 1000).toISOString();

  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, ?, ?)",
  ).run(runId, ago, ago);

  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
       retry_count, max_retries, claim_pid, claim_pgid, claim_job_id, claim_updated_at, created_at, updated_at)
     VALUES (?, ?, 'work', 'wf-dead_dev', 0, 'work', '', 'running', 0, 3, 99999, ?, ?, ?, ?, ?)`,
  ).run(stepId, runId, opts.claimPgid, opts.claimJobId, ago, ago, ago);

  return { runId, stepId };
}

describe("checkRunningWorkersLiveness — WDGM defense-in-depth", () => {
  // Unique dead pgid per test to avoid collisions across tests sharing a DB.
  let deadPgidSeq = 90000;
  function nextDeadPgid(): number { return deadPgidSeq++; }

  it("skips recovery when claim_pgid is dead but a live inFlightChild exists for claim_job_id (WDGM)", async () => {
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");

    // Seed: running step past the 30s grace period, with a dead claim_pgid
    // and a claim_job_id that matches a live inFlightChild.
    const { stepId } = seedWatchdogStep({
      claimPgid: nextDeadPgid(),
      claimJobId: "job-wdgm-alive",
      backdateSeconds: 60, // past 30s grace
    });

    // Create an inFlightChildren map with a live entry for this job.
    // Process.pid is always alive (this test process).
    const inFlightChildren = new Map<string, { pid: number; pgid: number; killed: boolean }>();
    inFlightChildren.set("job-wdgm-alive", { pid: process.pid, pgid: process.pid, killed: false });

    const result = checkRunningWorkersLiveness(inFlightChildren);

    // Step-scoped check: our specific step must NOT be recovered.
    const step = getDb().prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "running", "our step must NOT be recovered — inFlightChild proves worker is alive");
    // Global count may include sibling test steps in concurrent runs; use step-scoped assertions only.
    assert.ok(result.skipped >= 1, `should skip this step (defense-in-depth) — got ${result.skipped}`);
  });

  it("recovers when claim_pgid is dead AND no inFlightChild exists (existing behavior preserved)", async () => {
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");

    // Seed: running step past the 30s grace period, with a dead claim_pgid
    // and NO matching inFlightChild entry. Use a unique pgid to avoid
    // collisions with previous test fixtures that share the same temp DB.
    const myPgid = nextDeadPgid();
    const { stepId } = seedWatchdogStep({
      claimPgid: myPgid,
      claimJobId: "job-wdgm-unknown",
      backdateSeconds: 60, // past 30s grace
    });

    // Empty inFlightChildren — no job entry for this claim_job_id.
    const inFlightChildren = new Map<string, { pid: number; pgid: number; killed: boolean }>();

    const result = checkRunningWorkersLiveness(inFlightChildren);

    // Previous tests may have left running steps with dead pgids in the DB.
    // Assert that at least our step was recovered (recovered count >= 1).
    assert.ok(result.recovered >= 1, `must recover at least our step — got ${result.recovered}`);
    const step = getDb().prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "pending", "our step should be requeued");
  });

  it("recovers when claim_pgid is dead and inFlightChild exists but is dead", async () => {
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");

    // Seed: running step past the 30s grace period, with a dead claim_pgid.
    const { stepId } = seedWatchdogStep({
      claimPgid: nextDeadPgid(),
      claimJobId: "job-wdgm-dead-child",
      backdateSeconds: 60,
    });

    // inFlightChildren has the job entry but the child is dead — use a pid
    // that's guaranteed dead (similar to deadPid()).
    const inFlightChildren = new Map<string, { pid: number; pgid: number; killed: boolean }>();
    inFlightChildren.set("job-wdgm-dead-child", { pid: deadPid(), pgid: deadPid(), killed: false });

    const result = checkRunningWorkersLiveness(inFlightChildren);

    // At least our step must be recovered; may include sibling test steps in concurrent runs.
    assert.ok(result.recovered >= 1, `must recover at least our step — got ${result.recovered}`);
    const step = getDb().prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "pending", "step should be requeued");
  });

  it("recovers when claim_pgid is dead and inFlightChild exists but killed=true", async () => {
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");

    // Seed: running step past the 30s grace period, with a dead claim_pgid.
    const { stepId } = seedWatchdogStep({
      claimPgid: nextDeadPgid(),
      claimJobId: "job-wdgm-killed",
      backdateSeconds: 60,
    });

    // inFlightChildren has the job entry but killed=true — defense skips.
    const inFlightChildren = new Map<string, { pid: number; pgid: number; killed: boolean }>();
    inFlightChildren.set("job-wdgm-killed", { pid: process.pid, pgid: process.pid, killed: true });

    const result = checkRunningWorkersLiveness(inFlightChildren);

    // At least our step must be recovered; may include sibling test steps in concurrent runs.
    assert.ok(result.recovered >= 1, `must recover at least our step — got ${result.recovered}`);
    const step = getDb().prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "pending", "step should be requeued");
  });

  it("skips steps within the 30s grace period even when claim_pgid is dead", async () => {
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");

    // Seed: running step claimed JUST NOW (within grace period), dead claim_pgid.
    const { stepId } = seedWatchdogStep({
      claimPgid: nextDeadPgid(),
      claimJobId: "job-wdgm-fresh",
      backdateSeconds: 5, // well within 30s grace
    });

    const result = checkRunningWorkersLiveness();

    // Step-scoped check: our specific step must NOT be recovered (within grace period).
    const step = getDb().prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "running", "our step must NOT be recovered — within grace period");
    // Global count may include sibling test steps in concurrent runs; use step-scoped assertions only.
    assert.ok(result.skipped >= 1, `should skip due to grace period — got ${result.skipped}`);
  });

  it("works correctly without inFlightChildren (backward-compatible — daemon restart)", async () => {
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");

    // Seed: running step past the grace period, dead claim_pgid.
    const { stepId } = seedWatchdogStep({
      claimPgid: nextDeadPgid(),
      claimJobId: "job-wdgm-restart",
      backdateSeconds: 60,
    });

    // No inFlightChildren passed — simulates daemon restart where the map
    // was discarded. Should still recover based on claim_pgid alone.
    const result = checkRunningWorkersLiveness();

    // At least our step must be recovered; may include sibling test steps in concurrent runs.
    assert.ok(result.recovered >= 1, `must recover at least our step — got ${result.recovered}`);
    const step = getDb().prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "pending");
  });

  it("skips when claim_pgid is alive (worker process group still exists)", async () => {
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");
    const { spawn } = await import("node:child_process");

    // Spawn a detached process that becomes its own group leader.
    // Its pid IS its pgid, and kill(-pgid, 0) will find it alive.
    const survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
      detached: true,
      stdio: "ignore",
    });

    try {
      const { stepId } = seedWatchdogStep({
        claimPgid: survivor.pid!, // alive group leader
        claimJobId: "job-wdgm-self",
        backdateSeconds: 60,
      });

      const result = checkRunningWorkersLiveness();

      // Previous tests may have left dead-pgid steps that will be recovered.
      // Assert that OUR specific step (with alive pgid) was NOT recovered.
      const step = getDb().prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
      assert.equal(step.status, "running", "our step must remain running — claim_pgid is alive");
    } finally {
      try { process.kill(-survivor.pid!, "SIGKILL"); } catch { /* gone */ }
    }
  });
});

describe("recoverOrphanedStepsForAgent — US-004 exit diagnostics in step.worker_lost", () => {
  it("step.worker_lost includes exitCode, signal, stderrTail when provided (single step)", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const db = getDb();

    const runId = crypto.randomUUID();
    const stepRowId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, ?, ?)",
    ).run(runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
        retry_count, max_retries, claim_job_id, created_at, updated_at)
       VALUES (?, ?, 'work', 'wf-dead_dev', 0, 'work', '', 'running', 0, 3, 'job-us004', ?, ?)`,
    ).run(stepRowId, runId, now, now);

    const result = recoverOrphanedStepsForAgent(
      "wf-dead_dev",
      runId,
      0,
      undefined,
      undefined,
      "job-us004",
      undefined, // abandonReason
      undefined,
      1,           // exitCode
      "SIGTERM",   // signal
      "stderr: out of memory",  // stderrTail
    );

    assert.equal(result.recovered, 1);

    const events = getRunEvents(runId);
    const workerLost = events.filter((e) => e.event === "step.worker_lost");
    assert.equal(workerLost.length, 1, "should emit one step.worker_lost event");

    const evt = workerLost[0];
    assert.equal(evt.exitCode, 1, "exitCode should be 1");
    assert.equal(evt.signal, "SIGTERM", "signal should be SIGTERM");
    assert.equal(evt.stderrTail, "stderr: out of memory", "stderrTail should be preserved");
  });

  it("step.worker_lost includes exit diagnostics when exitCode is 0 and stderrTail is undefined", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const db = getDb();

    const runId = crypto.randomUUID();
    const stepRowId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, ?, ?)",
    ).run(runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
        retry_count, max_retries, claim_job_id, created_at, updated_at)
       VALUES (?, ?, 'work', 'wf-dead_dev', 0, 'work', '', 'running', 0, 3, 'job-us004b', ?, ?)`,
    ).run(stepRowId, runId, now, now);

    const result = recoverOrphanedStepsForAgent(
      "wf-dead_dev",
      runId,
      0,
      undefined,
      undefined,
      "job-us004b",
      undefined, // abandonReason
      undefined,
      0,           // exitCode = 0
      null,        // no signal
      undefined,   // no stderr
    );

    assert.equal(result.recovered, 1);

    const events = getRunEvents(runId);
    const workerLost = events.filter((e) => e.event === "step.worker_lost");
    assert.equal(workerLost.length, 1);

    const evt = workerLost[0];
    assert.equal(evt.exitCode, 0, "exitCode should be 0");
    assert.equal(evt.signal, undefined, "signal should be undefined");
    assert.equal(evt.stderrTail, undefined, "stderrTail should be undefined");
  });

  it("step.timeout events do NOT include exit diagnostics (only worker_lost)", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const db = getDb();

    const runId = crypto.randomUUID();
    const stepRowId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, ?, ?)",
    ).run(runId, now, now);
    // No claim_job_id → recovery event is step.timeout, not step.worker_lost
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
        retry_count, max_retries, created_at, updated_at)
       VALUES (?, ?, 'work', 'wf-dead_dev', 0, 'work', '', 'running', 0, 3, ?, ?)`,
    ).run(stepRowId, runId, now, now);

    const result = recoverOrphanedStepsForAgent(
      "wf-dead_dev",
      runId,
      0,
      undefined,
      undefined,
      undefined,  // no workerJobId → step.timeout event
      undefined, // abandonReason
      undefined,
      1,
      "SIGKILL",
      "some stderr",
    );

    assert.equal(result.recovered, 1);

    const events = getRunEvents(runId);
    const timeouts = events.filter((e) => e.event === "step.timeout");
    assert.equal(timeouts.length, 1, "should emit step.timeout, not step.worker_lost");

    const evt = timeouts[0];
    assert.equal(evt.exitCode, undefined, "step.timeout should not have exitCode");
    assert.equal(evt.signal, undefined, "step.timeout should not have signal");
    assert.equal(evt.stderrTail, undefined, "step.timeout should not have stderrTail");
  });

  it("step.worker_lost for story-level recovery includes exit diagnostics", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const db = getDb();

    const runId = crypto.randomUUID();
    const storyRowId = crypto.randomUUID();
    const stepRowId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, ?, ?)",
    ).run(runId, now, now);
    db.prepare(
      "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, abandoned_count, created_at, updated_at) VALUES (?, ?, 0, 'US-001', 'test', 'desc', '[]', 'running', 0, 4, 0, ?, ?)",
    ).run(storyRowId, runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
        type, current_story_id, retry_count, max_retries, claim_job_id, created_at, updated_at)
       VALUES (?, ?, 'loop', 'wf-dead_dev', 0, 'loop', '', 'running', 'loop', ?, 0, 3, 'job-us004-story', ?, ?)`,
    ).run(stepRowId, runId, storyRowId, now, now);

    const result = recoverOrphanedStepsForAgent(
      "wf-dead_dev",
      runId,
      0,
      undefined,
      undefined,
      "job-us004-story",
      undefined, // abandonReason
      undefined,
      137,        // exitCode
      "SIGKILL",  // signal
      "Killed: 9", // stderrTail
    );

    assert.equal(result.recovered, 1);

    const events = getRunEvents(runId);
    const workerLost = events.filter((e) => e.event === "step.worker_lost");
    assert.equal(workerLost.length, 1, "should emit step.worker_lost for story-level");

    const evt = workerLost[0];
    assert.equal(evt.exitCode, 137);
    assert.equal(evt.signal, "SIGKILL");
    assert.equal(evt.stderrTail, "Killed: 9");
  });
});

describe("recoverOrphanedStepsForAgent — US-005 worker_lost_count aggregation", () => {
  it("increments worker_lost_count when step.worker_lost is emitted (single step)", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const db = getDb();

    const runId = crypto.randomUUID();
    const stepRowId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, worker_lost_count, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, 0, ?, ?)",
    ).run(runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
        retry_count, max_retries, claim_job_id, created_at, updated_at)
       VALUES (?, ?, 'work', 'wf-dead_dev', 0, 'work', '', 'running', 0, 3, 'job-us005-r1', ?, ?)`,
    ).run(stepRowId, runId, now, now);

    // Initial count should be 0
    const before = db.prepare("SELECT worker_lost_count FROM runs WHERE id = ?").get(runId) as { worker_lost_count: number };
    assert.equal(before.worker_lost_count, 0);

    // Trigger a worker_lost event
    const result = recoverOrphanedStepsForAgent(
      "wf-dead_dev", runId, 0, undefined, undefined,
      "job-us005-r1", undefined, // abandonReason
      undefined, 1, "SIGTERM", "stderr: oom",
    );
    assert.equal(result.recovered, 1);

    // Count should now be 1
    const after = db.prepare("SELECT worker_lost_count FROM runs WHERE id = ?").get(runId) as { worker_lost_count: number };
    assert.equal(after.worker_lost_count, 1, "worker_lost_count should increment to 1");

    // Event should NOT contain workerLostCount (only terminal events have it)
    const events = getRunEvents(runId);
    const workerLost = events.filter((e) => e.event === "step.worker_lost");
    assert.equal(workerLost.length, 1);
    assert.equal(workerLost[0].workerLostCount, undefined, "step.worker_lost events should not carry workerLostCount");
  });

  it("increments worker_lost_count when step.worker_lost is emitted (story-level)", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const db = getDb();

    const runId = crypto.randomUUID();
    const stepRowId = crypto.randomUUID();
    const storyId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, worker_lost_count, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, 0, ?, ?)",
    ).run(runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
        retry_count, max_retries, type, current_story_id, claim_job_id, created_at, updated_at)
       VALUES (?, ?, 'work', 'wf-dead_dev', 0, 'work', '', 'running', 0, 3, 'loop', ?, 'job-us005-r2', ?, ?)`,
    ).run(stepRowId, runId, storyId, now, now);
    db.prepare(
      `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria,
        status, retry_count, max_retries, abandoned_count, created_at, updated_at)
       VALUES (?, ?, 0, 'US-001', 'Test story', '', '[]', 'pending', 0, 3, 0, ?, ?)`,
    ).run(storyId, runId, now, now);

    // Trigger a worker_lost event for story-level recovery
    const result = recoverOrphanedStepsForAgent(
      "wf-dead_dev", runId, 0, undefined, undefined,
      "job-us005-r2", undefined, // abandonReason
      undefined, 137, "SIGKILL", undefined,
    );
    assert.equal(result.recovered, 1);

    // Count should be 1
    const row = db.prepare("SELECT worker_lost_count FROM runs WHERE id = ?").get(runId) as { worker_lost_count: number };
    assert.equal(row.worker_lost_count, 1, "worker_lost_count should increment to 1 for story-level");
  });

  it("does NOT increment worker_lost_count for step.timeout events", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const db = getDb();

    const runId = crypto.randomUUID();
    const stepRowId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, worker_lost_count, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, 0, ?, ?)",
    ).run(runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
        retry_count, max_retries, created_at, updated_at)
       VALUES (?, ?, 'work', 'wf-dead_dev', 0, 'work', '', 'running', 0, 3, ?, ?)`,
    ).run(stepRowId, runId, now, now);
    // No claim_job_id → recovery event is step.timeout, not step.worker_lost

    const result = recoverOrphanedStepsForAgent(
      "wf-dead_dev", runId, 0, undefined, undefined,
      undefined, // no workerJobId = timeout
      undefined, // abandonReason
      undefined, undefined, undefined, undefined,
    );
    assert.equal(result.recovered, 1);

    // Count should still be 0
    const row = db.prepare("SELECT worker_lost_count FROM runs WHERE id = ?").get(runId) as { worker_lost_count: number };
    assert.equal(row.worker_lost_count, 0, "worker_lost_count should not increment for timeout");
  });

  it("worker_lost_count has default 0 on new runs", () => {
    const db = getDb();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Insert without explicit worker_lost_count
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, ?, ?)",
    ).run(runId, now, now);

    const row = db.prepare("SELECT worker_lost_count FROM runs WHERE id = ?").get(runId) as { worker_lost_count: number };
    assert.equal(row.worker_lost_count, 0, "should default to 0");
  });

  it("multiple worker_lost events accumulate", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const db = getDb();

    const runId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, worker_lost_count, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, 0, ?, ?)",
    ).run(runId, now, now);

    // Create and lose 3 steps
    for (let i = 0; i < 3; i++) {
      const stepRowId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
          retry_count, max_retries, claim_job_id, created_at, updated_at)
         VALUES (?, ?, 'work', 'wf-dead_dev', ?, 'work', '', 'running', ?, 3, 'job-acc', ?, ?)`,
      ).run(stepRowId, runId, i, i, now, now);

      const result = recoverOrphanedStepsForAgent(
        "wf-dead_dev", runId, 0, undefined, undefined,
        "job-acc", undefined, // abandonReason
        undefined, 1, undefined, undefined,
      );
      assert.equal(result.recovered, 1);
    }

    const row = db.prepare("SELECT worker_lost_count FROM runs WHERE id = ?").get(runId) as { worker_lost_count: number };
    assert.equal(row.worker_lost_count, 3, "should accumulate to 3");
  });
});

// ══════════════════════════════════════════════════════════════════════
// ABND: Reason threading through story_abandonments
// ══════════════════════════════════════════════════════════════════════

describe("ABND story_abandonments — reason threading", () => {
  it("cleanupAbandonedSteps records reason=worker_timeout in story_abandonments", async () => {
    const { cleanupAbandonedSteps } = await import("../dist/installer/step-ops.js");
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-abnd_dev",
      abandonedCount: 0,
      retryCount: 0,
      backdateSeconds: 28800, // 8 hours, exceeds ABANDONED_THRESHOLD_MS
    });

    cleanupAbandonedSteps();

    // Verify story_abandonments table has the record
    const rows = getDb().prepare(
      "SELECT * FROM story_abandonments WHERE story_id = ? AND run_id = ? ORDER BY created_at DESC"
    ).all(storyRowId, runId) as Array<{ reason: string; abandoned_count: number }>;

    assert.equal(rows.length, 1, "should have one abandonment record");
    assert.equal(rows[0].reason, "worker_timeout", "reason should be worker_timeout");
    assert.equal(rows[0].abandoned_count, 1, "abandoned_count should be 1");
  });

  it("recoverOrphanedStepsForAgent records reason=worker_lost when abandonReason omitted", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-abnd_fixer",
      abandonedCount: 0,
      retryCount: 0,
      backdateSeconds: 30,
    });

    // Call WITHOUT explicit abandonReason — should default to "worker_lost"
    const result = recoverOrphanedStepsForAgent("wf-abnd_fixer", runId, 0);
    assert.equal(result.recovered, 1);

    const rows = getDb().prepare(
      "SELECT reason, abandoned_count FROM story_abandonments WHERE story_id = ? AND run_id = ?"
    ).all(storyRowId, runId) as Array<{ reason: string; abandoned_count: number }>;

    assert.equal(rows.length, 1, "should have one abandonment record");
    assert.equal(rows[0].reason, "worker_lost", "default reason should be worker_lost");
    assert.equal(rows[0].abandoned_count, 1, "abandoned_count should be 1");
  });

  it("recoverOrphanedStepsForAgent records explicit abandonReason", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const storyRowId = crypto.randomUUID();
    const stepRowId = crypto.randomUUID();
    const ago = new Date(Date.now() - 30000).toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, ?, ?)",
    ).run(runId, ago, ago);
    db.prepare(
      "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, abandoned_count, created_at, updated_at) VALUES (?, ?, 0, 'S1', 'Test', 'desc', '[]', 'running', 0, 4, 2, ?, ?)",
    ).run(storyRowId, runId, ago, ago);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, current_story_id, loop_config, created_at, updated_at) VALUES (?, ?, 'implement', 'wf-abnd_fixer', 0, 'Implement', '', 'running', 0, 4, 'loop', ?, ?, ?, ?)",
    ).run(stepRowId, runId, storyRowId, JSON.stringify({ over: "stories" }), ago, ago);

    // Call WITH explicit abandonReason = "no_work_release"
    const result = recoverOrphanedStepsForAgent(
      "wf-abnd_fixer", runId, 0,
      undefined, undefined, undefined,
      "no_work_release",
      undefined, undefined, undefined, undefined,
    );
    assert.equal(result.recovered, 1);

    const rows = db.prepare(
      "SELECT reason, abandoned_count FROM story_abandonments WHERE story_id = ? AND run_id = ?"
    ).all(storyRowId, runId) as Array<{ reason: string; abandoned_count: number }>;

    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, "no_work_release", "reason should be no_work_release");
    assert.equal(rows[0].abandoned_count, 3, "abandoned_count should be 2 + 1 = 3");
  });

  it("recoverOrphanedStepsForAgent records different reasons for different call sites", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");

    // Seed two separate runs
    const run1 = seedStoryRun({
      agentId: "wf-abnd_fixer",
      abandonedCount: 0,
      retryCount: 0,
      backdateSeconds: 30,
    });
    const run2 = seedStoryRun({
      agentId: "wf-abnd_fixer",
      abandonedCount: 0,
      retryCount: 0,
      backdateSeconds: 30,
    });

    // Recover run1 with liveness_detected
    recoverOrphanedStepsForAgent("wf-abnd_fixer", run1.runId, 0,
      undefined, undefined, undefined,
      "liveness_detected",
      "liveness-detected", undefined, undefined, undefined,
    );

    // Recover run2 with worker_died
    recoverOrphanedStepsForAgent("wf-abnd_fixer", run2.runId, 0,
      undefined, undefined, undefined,
      "worker_died",
      undefined, undefined, undefined, undefined,
    );

    const rows1 = getDb().prepare(
      "SELECT reason FROM story_abandonments WHERE story_id = ? AND run_id = ?"
    ).all(run1.storyRowId, run1.runId) as Array<{ reason: string }>;
    const rows2 = getDb().prepare(
      "SELECT reason FROM story_abandonments WHERE story_id = ? AND run_id = ?"
    ).all(run2.storyRowId, run2.runId) as Array<{ reason: string }>;

    assert.equal(rows1[0].reason, "liveness_detected");
    assert.equal(rows2[0].reason, "worker_died");
  });

  it("story.abandoned event emitted with reason and abandonedCount", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const { runId } = seedStoryRun({
      agentId: "wf-abnd_fixer",
      abandonedCount: 0,
      retryCount: 0,
      backdateSeconds: 30,
    });

    recoverOrphanedStepsForAgent("wf-abnd_fixer", runId, 0,
      undefined, undefined, undefined,
      "worker_timeout",
      undefined, undefined, undefined, undefined,
    );

    const events = getRunEvents(runId);
    const abandonedEvents = events.filter((e) => e.event === "story.abandoned");

    assert.equal(abandonedEvents.length, 1, "should emit exactly one story.abandoned event");
    assert.equal(abandonedEvents[0].reason, "worker_timeout", "reason should be worker_timeout");
    assert.equal(abandonedEvents[0].abandonedCount, 1, "abandonedCount should be 1");
    assert.equal(abandonedEvents[0].storyId, "S1", "storyId should be S1");
    assert.ok(abandonedEvents[0].detail!.includes("worker_timeout"), "detail should include reason");
  });

  it("story.abandoned event emitted by cleanupAbandonedSteps with reason=worker_timeout", async () => {
    const { cleanupAbandonedSteps } = await import("../dist/installer/step-ops.js");
    const { runId } = seedStoryRun({
      agentId: "wf-abnd_dev",
      abandonedCount: 0,
      retryCount: 0,
      backdateSeconds: 28800,
    });

    cleanupAbandonedSteps();

    const events = getRunEvents(runId);
    const abandonedEvents = events.filter((e) => e.event === "story.abandoned");

    assert.equal(abandonedEvents.length, 1, "should emit exactly one story.abandoned event");
    assert.equal(abandonedEvents[0].reason, "worker_timeout", "reason should be worker_timeout");
    assert.equal(abandonedEvents[0].abandonedCount, 1, "abandonedCount should be 1");
  });

  it("story_abandonments accumulates multiple abandonments for the same story", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const db = getDb();
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-abnd_fixer",
      abandonedCount: 0,
      retryCount: 0,
      backdateSeconds: 30,
    });

    // First abandonment
    recoverOrphanedStepsForAgent("wf-abnd_fixer", runId, 0,
      undefined, undefined, undefined,
      "worker_lost",
      undefined, undefined, undefined, undefined,
    );

    // Reset story for second abandonment
    const ago = new Date(Date.now() - 30000).toISOString();
    db.prepare("UPDATE steps SET status = 'running', current_story_id = ?, updated_at = ? WHERE run_id = ?").run(storyRowId, ago, runId);
    db.prepare("UPDATE stories SET status = 'running', updated_at = ? WHERE id = ?").run(ago, storyRowId);

    // Second abandonment
    recoverOrphanedStepsForAgent("wf-abnd_fixer", runId, 0,
      undefined, undefined, undefined,
      "worker_timeout",
      undefined, undefined, undefined, undefined,
    );

    const rows = getDb().prepare(
      "SELECT reason, abandoned_count FROM story_abandonments WHERE story_id = ? AND run_id = ? ORDER BY created_at ASC"
    ).all(storyRowId, runId) as Array<{ reason: string; abandoned_count: number }>;

    assert.equal(rows.length, 2, "should have two abandonments");
    assert.equal(rows[0].reason, "worker_lost");
    assert.equal(rows[0].abandoned_count, 1);
    assert.equal(rows[1].reason, "worker_timeout");
    assert.equal(rows[1].abandoned_count, 2);
  });

  it("story_abandonments records abandonment on budget exhaustion (failed path)", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-abnd_fixer",
      abandonedCount: 8,
      retryCount: 0,
      backdateSeconds: 30,
    });

    const result = recoverOrphanedStepsForAgent("wf-abnd_fixer", runId, 0,
      undefined, undefined, undefined,
      "worker_lost",
      undefined, undefined, undefined, undefined,
    );
    assert.equal(result.failed, 1, "story should be failed on abandon exhaustion");

    // The story_abandonments should still record the abandonment (even though it exhausted)
    const rows = getDb().prepare(
      "SELECT reason, abandoned_count FROM story_abandonments WHERE story_id = ? AND run_id = ?"
    ).all(storyRowId, runId) as Array<{ reason: string; abandoned_count: number }>;

    assert.equal(rows.length, 1, "should record abandonment even on exhaustion");
    assert.equal(rows[0].reason, "worker_lost");
    assert.equal(rows[0].abandoned_count, 9, "abandoned_count should be 8 + 1 = 9");
  });

  it("existing abandoned_count assertions still pass with reason threading", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-abnd_fixer",
      abandonedCount: 3,
      retryCount: 1,
      backdateSeconds: 30,
    });

    // First recovery
    let result = recoverOrphanedStepsForAgent("wf-abnd_fixer", runId, 0,
      undefined, undefined, undefined,
      "worker_lost",
      undefined, undefined, undefined, undefined,
    );
    assert.equal(result.recovered, 1);

    // Reset for second recovery
    const db = getDb();
    const ago = new Date(Date.now() - 30000).toISOString();
    db.prepare("UPDATE steps SET status = 'running', current_story_id = ?, updated_at = ? WHERE run_id = ?").run(storyRowId, ago, runId);
    db.prepare("UPDATE stories SET status = 'running', updated_at = ? WHERE id = ?").run(ago, storyRowId);

    // Second recovery
    result = recoverOrphanedStepsForAgent("wf-abnd_fixer", runId, 0,
      undefined, undefined, undefined,
      "worker_timeout",
      undefined, undefined, undefined, undefined,
    );
    assert.equal(result.recovered, 1);

    const story = storyState(storyRowId);
    assert.equal(story.abandoned_count, 5, "abandoned_count should be 3 + 1 + 1 = 5");
    assert.equal(story.retry_count, 1, "retry_count should be unchanged");
    assert.equal(story.status, "pending");
  });
});

// ══════════════════════════════════════════════════════════════════════
// ABND: Aggregate abandon reasons in event detail
// ══════════════════════════════════════════════════════════════════════

describe("ABND — abandon reason aggregate", () => {
  it("buildAbandonReasonAggregate returns correct aggregate for multiple reasons", async () => {
    const { buildAbandonReasonAggregate } = await import("../dist/installer/step-ops.js");
    const db = getDb();
    const runId = crypto.randomUUID();

    // Insert multiple abandonments with different reasons
    const rows = [
      { story_id: crypto.randomUUID(), reason: "worker_lost", cnt: 5 },
      { story_id: crypto.randomUUID(), reason: "no_work_release", cnt: 3 },
      { story_id: crypto.randomUUID(), reason: "worker_timeout", cnt: 1 },
    ];
    for (const r of rows) {
      for (let i = 0; i < r.cnt; i++) {
        db.prepare(
          "INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
        ).run(crypto.randomUUID(), r.story_id, runId, r.reason, 1);
      }
    }

    const aggregate = buildAbandonReasonAggregate(runId);
    assert.ok(aggregate.startsWith("abandon budget exhausted (9/8)"), `should have correct total, got: ${aggregate}`);
    assert.ok(aggregate.includes("5x worker_lost"), `should include worker_lost count, got: ${aggregate}`);
    assert.ok(aggregate.includes("3x no_work_release"), `should include no_work_release count, got: ${aggregate}`);
    assert.ok(aggregate.includes("1x worker_timeout"), `should include worker_timeout count, got: ${aggregate}`);
    // Reasons should be ordered by count DESC
    const reasonsIdx = aggregate.indexOf("reasons: ");
    const reasonsPart = aggregate.slice(reasonsIdx);
    const lostIdx = reasonsPart.indexOf("worker_lost");
    const noWorkIdx = reasonsPart.indexOf("no_work_release");
    const timeoutIdx = reasonsPart.indexOf("worker_timeout");
    assert.ok(lostIdx < noWorkIdx, "worker_lost should come before no_work_release");
    assert.ok(noWorkIdx < timeoutIdx, "no_work_release should come before worker_timeout");
  });

  it("buildAbandonReasonAggregate handles single reason", async () => {
    const { buildAbandonReasonAggregate } = await import("../dist/installer/step-ops.js");
    const db = getDb();
    const runId = crypto.randomUUID();

    db.prepare(
      "INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run(crypto.randomUUID(), crypto.randomUUID(), runId, "worker_lost", 1);

    const aggregate = buildAbandonReasonAggregate(runId);
    assert.ok(aggregate.startsWith("abandon budget exhausted (1/8)"), `got: ${aggregate}`);
    assert.ok(aggregate.includes("1x worker_lost"), `got: ${aggregate}`);
  });

  it("buildAbandonReasonAggregate produces sensible fallback for empty table", async () => {
    const { buildAbandonReasonAggregate } = await import("../dist/installer/step-ops.js");
    const runId = crypto.randomUUID();
    // No inserts into story_abandonments — table is empty for this run

    const aggregate = buildAbandonReasonAggregate(runId);
    assert.ok(aggregate.includes("no per-story abandonment records found"), `got: ${aggregate}`);
    assert.ok(aggregate.includes("abandon budget exhausted"), `got: ${aggregate}`);
  });

  it("cleanupAbandonedSteps includes aggregate in budget-exhaustion events", async () => {
    const { cleanupAbandonedSteps } = await import("../dist/installer/step-ops.js");
    const db = getDb();

    // Seed a run with a story that already has ABANDON_STORY_MAX abandonments
    const { runId } = seedStoryRun({
      agentId: "wf-abnd_dev",
      abandonedCount: 8, // exactly at max, so +1 triggers exhaustion
      retryCount: 0,
      backdateSeconds: 28800, // 8 hours back to trigger timeout sweeper
    });

    // Insert a prior abandonment to get an aggregate with actual data
    // Note: cleanupAbandonedSteps itself also inserts a worker_timeout record
    // (before it checks the budget threshold), so total will be 2.
    const storyRows = db.prepare(
      "SELECT id, story_id FROM stories WHERE run_id = ?"
    ).all(runId) as { id: string; story_id: string }[];
    const storyId = storyRows[0];
    db.prepare(
      "INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run(crypto.randomUUID(), storyId.id, runId, "worker_timeout", 1);

    cleanupAbandonedSteps();

    const events = getRunEvents(runId);

    // Check story.failed event
    const storyFailed = events.filter((e) => e.event === "story.failed");
    assert.equal(storyFailed.length, 1, "should have one story.failed event");
    assert.ok(
      storyFailed[0].detail!.includes("abandon budget exhausted"),
      `story.failed detail should contain aggregate, got: ${storyFailed[0].detail}`
    );
    assert.ok(
      storyFailed[0].detail!.includes("2x worker_timeout"),
      `story.failed detail should include reason breakdown (cleanupAbandonedSteps inserts + our pre-seed), got: ${storyFailed[0].detail}`
    );

    // Check step.failed event
    const stepFailed = events.filter((e) => e.event === "step.failed");
    assert.equal(stepFailed.length, 1, "should have one step.failed event");
    assert.ok(
      stepFailed[0].detail!.includes("abandon budget exhausted"),
      `step.failed detail should contain aggregate, got: ${stepFailed[0].detail}`
    );
    assert.ok(
      stepFailed[0].detail!.includes("2x worker_timeout"),
      `step.failed detail should include reason breakdown, got: ${stepFailed[0].detail}`
    );

    // Check run.failed event
    const runFailed = events.filter((e) => e.event === "run.failed");
    assert.equal(runFailed.length, 1, "should have one run.failed event");
    assert.ok(
      runFailed[0].detail!.includes("abandon budget exhausted"),
      `run.failed detail should contain aggregate, got: ${runFailed[0].detail}`
    );
    assert.ok(
      runFailed[0].detail!.includes("2x worker_timeout"),
      `run.failed detail should include reason breakdown, got: ${runFailed[0].detail}`
    );
  });

  it("recoverOrphanedStepsForAgent includes aggregate in budget-exhaustion events", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const db = getDb();

    // Seed a run with a story at abandon limit
    const { runId } = seedStoryRun({
      agentId: "wf-abnd_fixer",
      abandonedCount: 8,
      retryCount: 0,
      backdateSeconds: 30,
    });

    // Insert prior abandonments with different reasons
    db.prepare(
      "INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run(crypto.randomUUID(), crypto.randomUUID(), runId, "worker_lost", 1);
    db.prepare(
      "INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run(crypto.randomUUID(), crypto.randomUUID(), runId, "no_work_release", 1);

    const result = recoverOrphanedStepsForAgent("wf-abnd_fixer", runId, 0,
      undefined, undefined, undefined,
      "worker_timeout",
      undefined, undefined, undefined, undefined,
    );
    assert.equal(result.failed, 1, "story should be failed on abandon exhaustion");

    const events = getRunEvents(runId);

    // Check story.failed event
    const storyFailed = events.filter((e) => e.event === "story.failed");
    assert.equal(storyFailed.length, 1, "should have one story.failed event");
    assert.ok(
      storyFailed[0].detail!.includes("abandon budget exhausted"),
      `story.failed detail should contain aggregate, got: ${storyFailed[0].detail}`
    );
    assert.ok(
      storyFailed[0].detail!.includes("worker_lost") ||
      storyFailed[0].detail!.includes("worker_timeout"),
      `story.failed detail should include reasons, got: ${storyFailed[0].detail}`
    );

    // Check step.failed event
    const stepFailed = events.filter((e) => e.event === "step.failed");
    assert.equal(stepFailed.length, 1, "should have one step.failed event");
    assert.ok(
      stepFailed[0].detail!.includes("abandon budget exhausted"),
      `step.failed detail should contain aggregate, got: ${stepFailed[0].detail}`
    );

    // Check run.failed event
    const runFailed = events.filter((e) => e.event === "run.failed");
    assert.equal(runFailed.length, 1, "should have one run.failed event");
    assert.ok(
      runFailed[0].detail!.includes("abandon budget exhausted"),
      `run.failed detail should contain aggregate, got: ${runFailed[0].detail}`
    );
  });

  it("aggregate includes total abandonments and budget cap", async () => {
    const { buildAbandonReasonAggregate } = await import("../dist/installer/step-ops.js");
    const db = getDb();
    const runId = crypto.randomUUID();

    // Insert 2 abandonments
    for (let i = 0; i < 2; i++) {
      db.prepare(
        "INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
      ).run(crypto.randomUUID(), crypto.randomUUID(), runId, "worker_lost", 1);
    }

    const aggregate = buildAbandonReasonAggregate(runId);
    assert.ok(aggregate.startsWith("abandon budget exhausted (2/8)"), `got: ${aggregate}`);
    assert.ok(aggregate.includes("2x worker_lost"), `got: ${aggregate}`);
  });

  it("buildAbandonReasonAggregate handles many distinct reasons ordered by count DESC", async () => {
    const { buildAbandonReasonAggregate } = await import("../dist/installer/step-ops.js");
    const db = getDb();
    const runId = crypto.randomUUID();

    // Insert 6+ different reasons with varying counts
    const specs: Array<{ reason: string; cnt: number }> = [
      { reason: "worker_timeout", cnt: 7 },
      { reason: "worker_lost", cnt: 4 },
      { reason: "no_work_release", cnt: 2 },
      { reason: "liveness_detected", cnt: 2 },
      { reason: "worker_died", cnt: 1 },
      { reason: "run_paused", cnt: 1 },
      { reason: "daemon_restart", cnt: 1 },
    ];
    for (const s of specs) {
      for (let i = 0; i < s.cnt; i++) {
        db.prepare(
          "INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
        ).run(crypto.randomUUID(), crypto.randomUUID(), runId, s.reason, 1);
      }
    }

    const aggregate = buildAbandonReasonAggregate(runId);

    // Total: 7+4+2+2+1+1+1 = 18
    assert.ok(aggregate.startsWith("abandon budget exhausted (18/8)"), `got: ${aggregate}`);

    // Reasons must appear in count-descending order
    const reasonsIdx = aggregate.indexOf("reasons: ");
    const reasonsPart = aggregate.slice(reasonsIdx);
    const idx: Record<string, number> = {};
    for (const s of specs) {
      idx[s.reason] = reasonsPart.indexOf(s.reason);
      assert.ok(idx[s.reason] > -1, `should contain ${s.reason}`);
    }
    // worker_timeout (7) must come before worker_lost (4)
    assert.ok(idx.worker_timeout < idx.worker_lost, "worker_timeout should precede worker_lost");
    // worker_lost (4) must come before no_work_release/liveness_detected (2)
    assert.ok(idx.worker_lost < idx.no_work_release, "worker_lost should precede no_work_release");
    assert.ok(idx.worker_lost < idx.liveness_detected, "worker_lost should precede liveness_detected");
    // worker_died and run_paused (1) should come last (after 2-count items)
    assert.ok(idx.no_work_release < idx.worker_died || idx.liveness_detected < idx.worker_died,
      "1-count reasons should come after 2-count reasons");
  });

  it("buildAbandonReasonAggregate handles high per-reason counts", async () => {
    const { buildAbandonReasonAggregate } = await import("../dist/installer/step-ops.js");
    const db = getDb();
    const runId = crypto.randomUUID();

    // 25 abandonments of the same reason
    for (let i = 0; i < 25; i++) {
      db.prepare(
        "INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
      ).run(crypto.randomUUID(), crypto.randomUUID(), runId, "worker_lost", 1);
    }

    const aggregate = buildAbandonReasonAggregate(runId);
    assert.ok(aggregate.startsWith("abandon budget exhausted (25/8)"), `got: ${aggregate}`);
    assert.ok(aggregate.includes("25x worker_lost"), `got: ${aggregate}`);
  });

  it("buildAbandonReasonAggregate for run with multi-story abandonments", async () => {
    const { buildAbandonReasonAggregate } = await import("../dist/installer/step-ops.js");
    const db = getDb();
    const runId = crypto.randomUUID();

    // Simulate 3 different stories being abandoned, some multiple times
    const storyA = crypto.randomUUID();
    const storyB = crypto.randomUUID();
    const storyC = crypto.randomUUID();
    // Story A: abandoned 3x (worker_lost)
    for (let i = 0; i < 3; i++) {
      db.prepare(
        "INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
      ).run(crypto.randomUUID(), storyA, runId, "worker_lost", i + 1);
    }
    // Story B: abandoned 2x (worker_timeout)
    for (let i = 0; i < 2; i++) {
      db.prepare(
        "INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
      ).run(crypto.randomUUID(), storyB, runId, "worker_timeout", i + 1);
    }
    // Story C: abandoned 1x (no_work_release)
    db.prepare(
      "INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run(crypto.randomUUID(), storyC, runId, "no_work_release", 1);

    const aggregate = buildAbandonReasonAggregate(runId);
    // Total abandonments = 3 + 2 + 1 = 6
    assert.ok(aggregate.startsWith("abandon budget exhausted (6/8)"), `got: ${aggregate}`);
    assert.ok(aggregate.includes("3x worker_lost"), `got: ${aggregate}`);
    assert.ok(aggregate.includes("2x worker_timeout"), `got: ${aggregate}`);
    assert.ok(aggregate.includes("1x no_work_release"), `got: ${aggregate}`);
  });

  it("cleanupAbandonedSteps step-level (non-loop) does NOT write story_abandonments", async () => {
    const { cleanupAbandonedSteps } = await import("../dist/installer/step-ops.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepRowId = crypto.randomUUID();
    const ago = new Date(Date.now() - 28800 * 1000).toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, ?, ?)"
    ).run(runId, ago, ago);
    // Single step (type = 'single', NOT loop, no current_story_id)
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
         status, retry_count, max_retries, abandoned_count, type, created_at, updated_at)
       VALUES (?, ?, 'work', 'wf-dead_dev', 0, 'work', '', 'running', 0, 3, 0, 'single', ?, ?)`
    ).run(stepRowId, runId, ago, ago);

    cleanupAbandonedSteps();

    // story_abandonments should be empty — step-level abandonment is NOT story-level
    const abandonRows = db.prepare(
      "SELECT COUNT(*) as cnt FROM story_abandonments WHERE run_id = ?"
    ).get(runId) as { cnt: number };
    assert.equal(abandonRows.cnt, 0, "story_abandonments should not have step-level records");

    // Step should be reset to pending with abandoned_count incremented
    const step = db.prepare("SELECT status, abandoned_count FROM steps WHERE id = ?").get(stepRowId) as {
      status: string;
      abandoned_count: number;
    };
    assert.equal(step.status, "pending", "step should be reset to pending");
    assert.equal(step.abandoned_count, 1, "step abandoned_count should increment");
  });

  it("cleanupAbandonedSteps step-level exhausts MAX_ABANDON_RESETS without touching story_abandonments", async () => {
    const { cleanupAbandonedSteps } = await import("../dist/installer/step-ops.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepRowId = crypto.randomUUID();
    const ago = new Date(Date.now() - 28800 * 1000).toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, ?, ?)"
    ).run(runId, ago, ago);
    // Single step at MAX_ABANDON_RESETS - 1 (4), so one more triggers exhaustion at 5
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
         status, retry_count, max_retries, abandoned_count, type, created_at, updated_at)
       VALUES (?, ?, 'work', 'wf-dead_dev', 0, 'work', '', 'running', 0, 3, 4, 'single', ?, ?)`
    ).run(stepRowId, runId, ago, ago);

    cleanupAbandonedSteps();

    // story_abandonments should be empty
    const abandonRows = db.prepare(
      "SELECT COUNT(*) as cnt FROM story_abandonments WHERE run_id = ?"
    ).get(runId) as { cnt: number };
    assert.equal(abandonRows.cnt, 0, "story_abandonments must not have step-level records");

    // Step should be failed (exhausted), run failed
    const step = db.prepare("SELECT status, abandoned_count FROM steps WHERE id = ?").get(stepRowId) as {
      status: string;
      abandoned_count: number;
    };
    assert.equal(step.status, "failed", "step should be failed on abandon exhaustion");
    assert.equal(step.abandoned_count, 5, "abandoned_count should be 5");

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed on step abandon exhaustion");
  });

  it("recoverOrphanedStepsForAgent step-level (non-loop) does NOT write story_abandonments", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepRowId = crypto.randomUUID();
    const ago = new Date(Date.now() - 30000).toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, ?, ?)"
    ).run(runId, ago, ago);
    // Single step (type = 'single', NOT loop, no current_story_id)
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
         status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'work', 'wf-dead_dev', 0, 'work', '', 'running', 0, 3, 'single', ?, ?)`
    ).run(stepRowId, runId, ago, ago);

    const result = recoverOrphanedStepsForAgent("wf-dead_dev", runId, 0,
      undefined, undefined, undefined,
      "worker_lost",
      undefined, undefined, undefined, undefined,
    );
    assert.equal(result.recovered, 1, "step should be recovered");

    // story_abandonments should be empty
    const abandonRows = db.prepare(
      "SELECT COUNT(*) as cnt FROM story_abandonments WHERE run_id = ?"
    ).get(runId) as { cnt: number };
    assert.equal(abandonRows.cnt, 0, "story_abandonments must not have step-level records");
  });

  it("story.abandoned event detail includes ABANDON_STORY_MAX budget cap", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const { runId } = seedStoryRun({
      agentId: "wf-abnd_fixer",
      abandonedCount: 0,
      retryCount: 0,
      backdateSeconds: 30,
    });

    recoverOrphanedStepsForAgent("wf-abnd_fixer", runId, 0,
      undefined, undefined, undefined,
      "no_work_release",
      undefined, undefined, undefined, undefined,
    );

    const events = getRunEvents(runId);
    const abandonedEvents = events.filter((e) => e.event === "story.abandoned");
    assert.equal(abandonedEvents.length, 1);
    assert.ok(
      abandonedEvents[0].detail!.includes("(1/8)"),
      `detail should include abandon budget display, got: ${abandonedEvents[0].detail}`
    );
    assert.ok(
      abandonedEvents[0].detail!.includes("reason: no_work_release"),
      `detail should include reason, got: ${abandonedEvents[0].detail}`
    );
  });

  it("run.failed detail includes full aggregate with reasons on budget exhaustion", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const db = getDb();

    const { runId } = seedStoryRun({
      agentId: "wf-abnd_fixer",
      abandonedCount: 8,
      retryCount: 0,
      backdateSeconds: 30,
    });

    // Pre-seed 3 reasons for richer aggregate
    const storyIds = db.prepare(
      "SELECT id FROM stories WHERE run_id = ?"
    ).all(runId) as { id: string }[];
    db.prepare(
      "INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run(crypto.randomUUID(), storyIds[0].id, runId, "worker_lost", 1);
    db.prepare(
      "INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run(crypto.randomUUID(), storyIds[0].id, runId, "worker_lost", 1);
    db.prepare(
      "INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run(crypto.randomUUID(), storyIds[0].id, runId, "worker_timeout", 1);

    const result = recoverOrphanedStepsForAgent("wf-abnd_fixer", runId, 0,
      undefined, undefined, undefined,
      "no_work_release",
      undefined, undefined, undefined, undefined,
    );
    assert.equal(result.failed, 1, "story should be failed on abandon exhaustion");

    const events = getRunEvents(runId);
    const runFailed = events.filter((e) => e.event === "run.failed");
    assert.equal(runFailed.length, 1, "should have one run.failed event");
    const detail = runFailed[0].detail!;
    assert.ok(detail.includes("abandon budget exhausted"), `run.failed detail: ${detail}`);
    // After the 9th abandonment (no_work_release), aggregate should include all 4 records
    assert.ok(detail.includes("2x worker_lost"), `should include worker_lost: ${detail}`);
    assert.ok(detail.includes("worker_timeout"), `should include worker_timeout: ${detail}`);
    assert.ok(detail.includes("no_work_release"), `should include no_work_release: ${detail}`);
    // Total: 2 worker_lost + 1 worker_timeout + 1 no_work_release = 4
    assert.ok(detail.includes("(4/8)"), `should show 4/8, got: ${detail}`);
  });
});

// ══════════════════════════════════════════════════════════════════════
// ABN2: Recovery resilience — telemetry failures must not block recovery
// ══════════════════════════════════════════════════════════════════════

describe("ABN2 recovery resilience — telemetry failures do not block recovery", () => {
  it("story recovery completes when story_abandonments INSERT fails (table dropped)", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const db = getDb();
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-resil_fixer",
      abandonedCount: 0,
      retryCount: 0,
      backdateSeconds: 5,
    });

    // Corrupt the story_abandonments table to make INSERT fail
    db.prepare("DROP TABLE IF EXISTS story_abandonments").run();

    // Recovery must still complete — story/step should be reset even without telemetry
    const result = recoverOrphanedStepsForAgent("wf-resil_fixer", runId, 0);
    assert.equal(result.recovered, 1, "story should be recovered despite telemetry INSERT failure");
    assert.equal(result.failed, 0, "story should not be failed");

    // Step is reset to pending, current_story_id is cleared
    const step = db.prepare(
      "SELECT status, current_story_id FROM steps WHERE run_id = ?"
    ).get(runId) as { status: string; current_story_id: string | null };
    assert.equal(step.status, "pending", "step should be reset to pending");
    assert.equal(step.current_story_id, null, "current_story_id should be cleared");

    // Story is reset to pending with abandoned_count incremented
    const story = storyState(storyRowId);
    assert.equal(story.status, "pending", "story should be reset to pending");
    assert.equal(story.abandoned_count, 1, "abandoned_count should be incremented despite telemetry failure");
  });

  it("story recovery completes with higher abandoned_count when table is missing", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const db = getDb();
    const { runId, storyRowId, stepRowId } = seedStoryRun({
      agentId: "wf-resil2_fixer",
      abandonedCount: 2,
      retryCount: 0,
      backdateSeconds: 5,
    });

    db.prepare("DROP TABLE IF EXISTS story_abandonments").run();

    const result = recoverOrphanedStepsForAgent("wf-resil2_fixer", runId, 0);
    assert.equal(result.recovered, 1, "step should be recovered");

    const step = db.prepare(
      "SELECT status FROM steps WHERE id = ?"
    ).get(stepRowId) as { status: string };
    assert.equal(step.status, "pending", "step should be reset");

    const story = storyState(storyRowId);
    assert.equal(story.status, "pending", "story should be pending");
    assert.equal(story.abandoned_count, 3, "abandoned_count should be 2 + 1 = 3");
  });

  it("step retry_count path also works when telemetry table is broken (non-loop step)", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const db = getDb();

    // Seed a non-loop (single) running step
    const { runId } = seedRunWithRunningStep({
      claimPid: null,
      retryCount: 0,
      maxRetries: 4,
    });

    db.prepare("DROP TABLE IF EXISTS story_abandonments").run();

    // A non-loop step (no current_story_id) takes the retry-count path, not the story-abandonment path.
    // This exercises that the function handles steps without stories (no INSERT needed).
    const result = recoverOrphanedStepsForAgent("wf-dead_dev", runId, 0);
    assert.equal(result.recovered, 1, "non-loop step should be recovered");

    const step = db.prepare(
      "SELECT status, retry_count FROM steps WHERE run_id = ?"
    ).get(runId) as { status: string; retry_count: number };
    assert.equal(step.status, "pending", "step should be reset to pending");
    assert.equal(step.retry_count, 1, "retry_count should increment");
  });

  it("recovery reports correct counts despite telemetry failure", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const db = getDb();
    const { runId } = seedStoryRun({
      agentId: "wf-resil4_fixer",
      abandonedCount: 0,
      retryCount: 0,
      backdateSeconds: 5,
    });

    db.prepare("DROP TABLE IF EXISTS story_abandonments").run();

    const result = recoverOrphanedStepsForAgent("wf-resil4_fixer", runId, 0);
    assert.equal(result.recovered, 1);
    assert.equal(result.failed, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// ABN2: cleanupAbandonedSteps resilience — telemetry failures must not block recovery
// ══════════════════════════════════════════════════════════════════════

describe("ABN2 cleanupAbandonedSteps resilience — telemetry failures do not block recovery", () => {
  it("cleanupAbandonedSteps story recovery completes when story_abandonments INSERT fails (table dropped)", async () => {
    const { cleanupAbandonedSteps } = await import("../dist/installer/step-ops.js");
    const db = getDb();
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-cleanup-resil_dev",
      abandonedCount: 0,
      retryCount: 0,
      backdateSeconds: 28800,
    });

    // Corrupt the story_abandonments table to make INSERT fail
    db.prepare("DROP TABLE IF EXISTS story_abandonments").run();

    // cleanupAbandonedSteps must still complete — story/step should be recovered without aborting
    cleanupAbandonedSteps();

    // Step is reset to pending, current_story_id is cleared
    const step = db.prepare(
      "SELECT status, current_story_id FROM steps WHERE run_id = ?"
    ).get(runId) as { status: string; current_story_id: string | null };
    assert.equal(step.status, "pending", "step should be reset to pending despite telemetry INSERT failure");
    assert.equal(step.current_story_id, null, "current_story_id should be cleared");

    // Story is reset to pending with abandoned_count incremented
    const story = storyState(storyRowId);
    assert.equal(story.status, "pending", "story should be reset to pending");
    assert.equal(story.abandoned_count, 1, "abandoned_count should be incremented despite telemetry failure");
  });

  it("cleanupAbandonedSteps increments abandoned_count correctly when telemetry INSERT fails", async () => {
    const { cleanupAbandonedSteps } = await import("../dist/installer/step-ops.js");
    const db = getDb();
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-cleanup-resil2_dev",
      abandonedCount: 3,
      retryCount: 0,
      backdateSeconds: 28800,
    });

    db.prepare("DROP TABLE IF EXISTS story_abandonments").run();

    cleanupAbandonedSteps();

    const step = db.prepare(
      "SELECT status FROM steps WHERE run_id = ?"
    ).get(runId) as { status: string };
    assert.equal(step.status, "pending", "step should be reset to pending");

    const story = storyState(storyRowId);
    assert.equal(story.status, "pending", "story should be pending");
    assert.equal(story.abandoned_count, 4, "abandoned_count should be 3 + 1 = 4");
  });

  it("cleanupAbandonedSteps non-loop step recovery works when telemetry table is broken", async () => {
    const { cleanupAbandonedSteps } = await import("../dist/installer/step-ops.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const ago = new Date(Date.now() - 28800 * 1000).toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, ?, ?)",
    ).run(runId, ago, ago);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
         retry_count, max_retries, abandoned_count, claim_pid, created_at, updated_at)
       VALUES (?, ?, 'work', 'wf-dead_dev', 0, 'work', '', 'running', 0, 4, 0, NULL, ?, ?)`,
    ).run(stepId, runId, ago, ago);

    db.prepare("DROP TABLE IF EXISTS story_abandonments").run();

    cleanupAbandonedSteps();

    const step = db.prepare(
      "SELECT status, abandoned_count FROM steps WHERE id = ?"
    ).get(stepId) as { status: string; abandoned_count: number };
    assert.equal(step.status, "pending", "non-loop step should be reset to pending");
    assert.equal(step.abandoned_count, 1, "abandoned_count should be incremented");
  });
});

// ══════════════════════════════════════════════════════════════════════
// ABN2: sweep-level per-step try/catch — one step exception must not abort the sweep
// ══════════════════════════════════════════════════════════════════════

describe("ABN2 sweep-level resilience — per-step try/catch", () => {
  it("recoverStepsWithDeadWorkers: one step's exception does not prevent other steps from being processed", async () => {
    const { recoverStepsWithDeadWorkers: r2 } = await import("../dist/installer/step-ops.js");
    const db = getDb();

    // Seed two steps with dead workers
    const a = seedRunWithRunningStep({ claimPid: deadPid() });
    const b = seedRunWithRunningStep({ claimPid: deadPid() });

    // Rename a column that recoverOrphanedStepsForAgent selects but
    // recoverStepsWithDeadWorkers's initial query does not, so the
    // sweep finds steps but per-step recovery throws.
    db.prepare("ALTER TABLE steps RENAME COLUMN retry_count TO retry_count_old").run();
    try {
      const result = r2();

      // Both of our steps threw inside recoverOrphanedStepsForAgent.
      // At least 2 must be counted as failed (may include leftover
      // dead-worker steps from earlier tests sharing this DB).
      assert.ok(result.failed >= 2, `must count at least 2 as failed — got ${result.failed}`);
      assert.equal(result.recovered, 0, "no steps recovered since recoverOrphanedStepsForAgent threw");
    } finally {
      db.prepare("ALTER TABLE steps RENAME COLUMN retry_count_old TO retry_count").run();
    }

    // Our specific steps remain running because recovery could not complete
    assert.equal(stepStatus(a.stepId).status, "running", "step A unchanged - recovery threw");
    assert.equal(stepStatus(b.stepId).status, "running", "step B unchanged - recovery threw");
  });

  it("recoverStepsWithDeadWorkers: sweep completes (totals accumulated) even when all steps throw", async () => {
    const { recoverStepsWithDeadWorkers: r2 } = await import("../dist/installer/step-ops.js");
    const db = getDb();

    seedRunWithRunningStep({ claimPid: deadPid() });
    seedRunWithRunningStep({ claimPid: deadPid() });
    seedRunWithRunningStep({ claimPid: deadPid() });

    db.prepare("ALTER TABLE steps RENAME COLUMN retry_count TO retry_count_old").run();
    try {
      const result = r2();

      // At least our 3 steps are counted as failed. Previous tests may have
      // left running steps in this DB that also fail, so use >= 3.
      assert.ok(result.failed >= 3, `must count at least 3 as failed — got ${result.failed}`);
      assert.equal(result.recovered, 0);
    } finally {
      db.prepare("ALTER TABLE steps RENAME COLUMN retry_count_old TO retry_count").run();
    }
  });

  it("checkRunningWorkersLiveness: one step's exception does not prevent other steps from being processed", async () => {
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");
    const db = getDb();

    // Use unique dead pgids to avoid collisions
    let pgidSeq = 95000;
    const nextPgid = () => pgidSeq++;

    seedWatchdogStep({ claimPgid: nextPgid(), claimJobId: "job-sweep-a", backdateSeconds: 60 });
    seedWatchdogStep({ claimPgid: nextPgid(), claimJobId: "job-sweep-b", backdateSeconds: 60 });

    db.prepare("ALTER TABLE steps RENAME COLUMN retry_count TO retry_count_old").run();
    try {
      const result = checkRunningWorkersLiveness();

      // At least 2 must be counted as failed (may include leftover
      // watchdog steps from earlier tests sharing this DB).
      assert.ok(result.failed >= 2, `must count at least 2 as failed — got ${result.failed}`);
      assert.equal(result.recovered, 0, "no steps recovered since recoverOrphanedStepsForAgent threw");
    } finally {
      db.prepare("ALTER TABLE steps RENAME COLUMN retry_count_old TO retry_count").run();
    }
  });

  it("checkRunningWorkersLiveness: sweep completes even when all watchdog steps throw", async () => {
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");
    const db = getDb();

    let pgidSeq = 95100;
    const nextPgid = () => pgidSeq++;

    seedWatchdogStep({ claimPgid: nextPgid(), claimJobId: "job-sweep-c", backdateSeconds: 60 });
    seedWatchdogStep({ claimPgid: nextPgid(), claimJobId: "job-sweep-d", backdateSeconds: 60 });
    seedWatchdogStep({ claimPgid: nextPgid(), claimJobId: "job-sweep-e", backdateSeconds: 60 });

    db.prepare("ALTER TABLE steps RENAME COLUMN retry_count TO retry_count_old").run();
    try {
      const result = checkRunningWorkersLiveness();

      // All 3 steps threw → counted as failed. Note: skipped may be > 0 due to
      // watchdog steps from previous tests sharing this DB, so only assert >= 3.
      assert.ok(result.failed >= 3, `must count at least 3 as failed — got ${result.failed}`);
      assert.equal(result.recovered, 0);
    } finally {
      db.prepare("ALTER TABLE steps RENAME COLUMN retry_count_old TO retry_count").run();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// ABN2 US-006: Incident shape reproduction — dead PGID + story recovery
// via the liveness watchdog (checkRunningWorkersLiveness).
// ══════════════════════════════════════════════════════════════════════

/**
 * Seed a run + story + loop step with a claim_pgid for watchdog testing.
 * Combines seedStoryRun (story-level loop step) with seedWatchdogStep
 * (claim_pgid, claim_updated_at). The step has current_story_id set,
 * type='loop', a dead claim_pgid, and claim_updated_at backdated past
 * the 30s LIVENESS_GRACE_PERIOD_MS.
 */
function seedWatchdogStoryRun(opts: {
  claimPgid: number;
  claimJobId?: string | null;
  abandonedCount?: number;
  retryCount?: number;
  maxRetries?: number;
  agentId?: string;
  backdateSeconds?: number;
}): { runId: string; storyRowId: string; stepRowId: string } {
  const db = getDb();
  const runId = crypto.randomUUID();
  const storyRowId = crypto.randomUUID();
  const stepRowId = crypto.randomUUID();
  const backdate = opts.backdateSeconds ?? 60;
  const ago = new Date(Date.now() - backdate * 1000).toISOString();

  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, ?, ?)",
  ).run(runId, ago, ago);

  db.prepare(
    `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria,
       status, retry_count, max_retries, abandoned_count, created_at, updated_at)
     VALUES (?, ?, 0, 'S1', 'Test', 'desc', '[]', 'running', ?, ?, ?, ?, ?)`,
  ).run(storyRowId, runId, opts.retryCount ?? 0, opts.maxRetries ?? 4, opts.abandonedCount ?? 0, ago, ago);

  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
       status, retry_count, max_retries, type, current_story_id, loop_config,
       claim_pid, claim_pgid, claim_job_id, claim_updated_at, created_at, updated_at)
     VALUES (?, ?, 'implement', ?, 0, 'Implement', '', 'running', 0, 4, 'loop', ?, ?,
             99999, ?, ?, ?, ?, ?)`,
  ).run(
    stepRowId, runId, opts.agentId ?? "wf-dead_dev",
    storyRowId, JSON.stringify({ over: "stories" }),
    opts.claimPgid, opts.claimJobId ?? "job-wdgm-story", ago, ago, ago,
  );

  return { runId, storyRowId, stepRowId };
}

describe("ABN2 US-006 — Incident shape: dead PGID, story recovers via liveness watchdog", () => {
  // Unique dead pgid per test to avoid collisions across tests sharing a DB.
  let deadPgidSeq2 = 98000;
  function nextDeadPgid2(): number { return deadPgidSeq2++; }

  // Ensure story_abandonments table exists (a previous ABN2 resilience
  // test may have dropped it via "DROP TABLE IF EXISTS").
  beforeEach(() => {
    getDb().prepare(`
      CREATE TABLE IF NOT EXISTS story_abandonments (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        abandoned_count INTEGER NOT NULL,
        step_id TEXT,
        created_at TEXT NOT NULL
      )
    `).run();
  });

  it("recovers a loop-step story via liveness watchdog — step reset, story reset, abandonment recorded with step_id", async () => {
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");

    // Seed: loop step with a running story, dead claim_pgid, backdated > 30s.
    // No inFlightChildren provided → watchdog falls through to recovery.
    const { runId, storyRowId, stepRowId } = seedWatchdogStoryRun({
      claimPgid: nextDeadPgid2(),
      claimJobId: "job-us006-story",
      abandonedCount: 0,
      backdateSeconds: 60,
    });

    const result = checkRunningWorkersLiveness();

    // Sweep must complete with at least our step recovered
    assert.ok(result.recovered >= 1, `must recover at least our step — got ${result.recovered}`);
    assert.equal(result.failed, 0, "no steps should fail");

    // Step must be reset to pending, current_story_id cleared
    const step = getDb().prepare(
      "SELECT status, current_story_id FROM steps WHERE id = ?"
    ).get(stepRowId) as { status: string; current_story_id: string | null };
    assert.equal(step.status, "pending", "loop step must be reset to pending");
    assert.equal(step.current_story_id, null, "current_story_id must be cleared after recovery");

    // Story must be reset to pending with abandoned_count incremented
    const story = storyState(storyRowId);
    assert.equal(story.status, "pending", "story must be reset to pending");
    assert.equal(story.abandoned_count, 1, "abandoned_count must increment from 0 to 1");
    assert.equal(story.retry_count, 0, "retry_count must be unchanged (not mixed with infra failures)");

    // Abandonment row must be recorded in story_abandonments
    const abandonRows = getDb().prepare(
      "SELECT * FROM story_abandonments WHERE story_id = ? AND run_id = ?"
    ).all(storyRowId, runId) as Array<{
      reason: string;
      abandoned_count: number;
      step_id: string | null;
    }>;
    assert.equal(abandonRows.length, 1, "must have exactly one abandonment record");
    assert.equal(abandonRows[0].reason, "liveness_detected", "reason must be liveness_detected");
    assert.equal(abandonRows[0].abandoned_count, 1, "abandoned_count in record must be 1");

    // step_id in abandonment row must match the parent step UUID
    assert.ok(abandonRows[0].step_id !== null && abandonRows[0].step_id !== undefined,
      "step_id must not be null — must be populated with parent step UUID");
    assert.equal(abandonRows[0].step_id, stepRowId,
      `step_id ${abandonRows[0].step_id} must equal parent step UUID ${stepRowId}`);
  });

  it("recovers story with non-zero abandoned_count — abandoned_count increments correctly via watchdog", async () => {
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");

    const { runId, storyRowId, stepRowId } = seedWatchdogStoryRun({
      claimPgid: nextDeadPgid2(),
      claimJobId: "job-us006-b",
      abandonedCount: 3,
      backdateSeconds: 60,
    });

    const result = checkRunningWorkersLiveness();

    assert.ok(result.recovered >= 1, `must recover at least our step — got ${result.recovered}`);

    const step = getDb().prepare(
      "SELECT status FROM steps WHERE id = ?"
    ).get(stepRowId) as { status: string };
    assert.equal(step.status, "pending", "loop step must be reset to pending");

    const story = storyState(storyRowId);
    assert.equal(story.abandoned_count, 4, "abandoned_count must be 3 + 1 = 4");

    const abandonRows = getDb().prepare(
      "SELECT reason, abandoned_count, step_id FROM story_abandonments WHERE story_id = ? AND run_id = ?"
    ).all(storyRowId, runId) as Array<{
      reason: string;
      abandoned_count: number;
      step_id: string | null;
    }>;
    assert.equal(abandonRows.length, 1, "must have exactly one abandonment record");
    assert.equal(abandonRows[0].reason, "liveness_detected");
    assert.equal(abandonRows[0].abandoned_count, 4, "abandoned_count in record must be 4");
    assert.equal(abandonRows[0].step_id, stepRowId, "step_id must match parent step UUID");
  });

  it("emits story.abandoned event with liveness_detected reason", async () => {
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");

    const { runId } = seedWatchdogStoryRun({
      claimPgid: nextDeadPgid2(),
      claimJobId: "job-us006-c",
      abandonedCount: 0,
      backdateSeconds: 60,
    });

    checkRunningWorkersLiveness();

    const events = getRunEvents(runId);
    const abandonedEvents = events.filter((e) => e.event === "story.abandoned");
    assert.equal(abandonedEvents.length, 1, "must emit one story.abandoned event");
    assert.equal(abandonedEvents[0].reason, "liveness_detected", "event reason must be liveness_detected");
    assert.equal(abandonedEvents[0].abandonedCount, 1, "event abandonedCount must be 1");
  });
});

// ══════════════════════════════════════════════════════════════════════
// ABN2 US-007: Telemetry-write failure does not prevent recovery
// ══════════════════════════════════════════════════════════════════════

describe("ABN2 US-007 — Telemetry-write failure does not prevent recovery", () => {
  let deadPgidSeq3 = 99000;
  function nextDeadPgid3(): number { return deadPgidSeq3++; }

  // Ensure story_abandonments table is recreated for subsequent tests
  // (the US-006 describe block also has a beforeEach, but inter-describe
  // ordering is not guaranteed — be self-sufficient).
  beforeEach(() => {
    getDb().prepare(`
      CREATE TABLE IF NOT EXISTS story_abandonments (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        abandoned_count INTEGER NOT NULL,
        step_id TEXT,
        created_at TEXT NOT NULL
      )
    `).run();
  });

  it("checkRunningWorkersLiveness sweep completes story recovery despite telemetry INSERT failure (table dropped)", async () => {
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");

    // Seed a loop step with story, dead claim_pgid, backdated > 30s
    const { runId, storyRowId, stepRowId } = seedWatchdogStoryRun({
      claimPgid: nextDeadPgid3(),
      claimJobId: "job-us007-watchdog",
      abandonedCount: 0,
      backdateSeconds: 60,
    });

    // Corrupt the story_abandonments table to make telemetry INSERT fail
    getDb().prepare("DROP TABLE IF EXISTS story_abandonments").run();

    // Sweep must complete without throwing — no run-wedging
    const result = checkRunningWorkersLiveness();

    // Recovery completes despite telemetry failure
    assert.ok(result.recovered >= 1, `must recover at least our step — got ${result.recovered}`);
    assert.equal(result.failed, 0, "no steps should fail despite telemetry failure");

    // Step must be reset to pending, current_story_id cleared
    const step = getDb().prepare(
      "SELECT status, current_story_id FROM steps WHERE id = ?"
    ).get(stepRowId) as { status: string; current_story_id: string | null };
    assert.equal(step.status, "pending", "step must be reset to pending despite telemetry failure");
    assert.equal(step.current_story_id, null, "current_story_id must be cleared");

    // Story must be reset to pending with abandoned_count incremented
    const story = storyState(storyRowId);
    assert.equal(story.status, "pending", "story must be reset to pending despite telemetry failure");
    assert.equal(story.abandoned_count, 1, "abandoned_count must increment from 0 to 1");
    assert.equal(story.retry_count, 0, "retry_count must be unchanged");
  });

  it("recoverStepsWithDeadWorkers sweep completes story recovery despite telemetry INSERT failure (table dropped)", async () => {
    const { recoverStepsWithDeadWorkers: r2 } = await import("../dist/installer/step-ops.js");
    const db = getDb();

    // Seed a loop step with story and dead claim_pid.
    // recoverStepsWithDeadWorkers checks claim_pid liveness.
    const runId = crypto.randomUUID();
    const storyRowId = crypto.randomUUID();
    const stepRowId = crypto.randomUUID();
    const ago = new Date(Date.now() - 5000).toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, ?, ?)",
    ).run(runId, ago, ago);

    db.prepare(
      "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, abandoned_count, created_at, updated_at) VALUES (?, ?, 0, 'US-007', 'test', 'desc', '[]', 'running', 0, 4, 0, ?, ?)",
    ).run(storyRowId, runId, ago, ago);

    // Loop step with dead claim_pid — recoverStepsWithDeadWorkers will pick it up
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
         status, retry_count, max_retries, type, current_story_id, loop_config,
         claim_pid, claim_job_id, created_at, updated_at)
       VALUES (?, ?, 'implement', 'wf-dead_dev', 0, 'Implement', '', 'running', 0, 4,
               'loop', ?, '{}', ?, 'job-us007-r2', ?, ?)`,
    ).run(stepRowId, runId, storyRowId, deadPid(), ago, ago);

    // Corrupt the story_abandonments table
    db.prepare("DROP TABLE IF EXISTS story_abandonments").run();

    // Sweep must complete without throwing
    const result = r2();

    // Recovery completes despite telemetry failure
    assert.ok(result.recovered >= 1,
      `must recover at least our step — got recovered=${result.recovered} failed=${result.failed}`);

    // Step must be reset to pending
    const step = db.prepare(
      "SELECT status, current_story_id FROM steps WHERE id = ?"
    ).get(stepRowId) as { status: string; current_story_id: string | null };
    assert.equal(step.status, "pending", "step must be reset to pending despite telemetry failure");
    assert.equal(step.current_story_id, null, "current_story_id must be cleared");

    // Story must be reset to pending with abandoned_count incremented
    const story = storyState(storyRowId);
    assert.equal(story.status, "pending", "story must be reset to pending despite telemetry failure");
    assert.equal(story.abandoned_count, 1, "abandoned_count must increment from 0 to 1");
  });

  it("recoverStepsWithDeadWorkers sweep handles mixed recovery — non-loop step succeeds when telemetry table is broken", async () => {
    const { recoverStepsWithDeadWorkers: r2 } = await import("../dist/installer/step-ops.js");
    const db = getDb();

    // Seed a non-loop running step with dead claim_pid.
    // Non-loop steps don't use story_abandonments — they use retry_count.
    const { stepId } = seedRunWithRunningStep({ claimPid: deadPid() });

    db.prepare("DROP TABLE IF EXISTS story_abandonments").run();

    const result = r2();

    // Non-loop step recovery should complete normally — no telemetry table needed
    assert.equal(result.recovered, 1, "non-loop step should be recovered");

    const step = stepStatus(stepId);
    assert.equal(step.status, "pending", "step should be reset to pending");
    assert.equal(step.retry_count, 1, "retry_count should increment");
  });

  it("recoverOrphanedStepsForAgent directly — abandoned_count increments correctly when telemetry table is missing", async () => {
    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");

    const { runId, storyRowId, stepRowId } = seedStoryRun({
      agentId: "wf-us007_fixer",
      abandonedCount: 2,
      retryCount: 0,
      backdateSeconds: 5,
    });

    // Drop the table to simulate telemetry failure
    getDb().prepare("DROP TABLE IF EXISTS story_abandonments").run();

    const result = recoverOrphanedStepsForAgent("wf-us007_fixer", runId, 0,
      undefined, undefined, undefined,
      "no_work_release",
      undefined, undefined, undefined, undefined,
    );

    // Recovery must complete despite telemetry failure
    assert.equal(result.recovered, 1, "story should be recovered despite telemetry failure");
    assert.equal(result.failed, 0);

    // Step is reset
    const step = getDb().prepare(
      "SELECT status, current_story_id FROM steps WHERE id = ?"
    ).get(stepRowId) as { status: string; current_story_id: string | null };
    assert.equal(step.status, "pending", "step must be reset to pending");
    assert.equal(step.current_story_id, null);

    // abandoned_count must still increment (the UPDATE runs regardless of telemetry failure)
    const story = storyState(storyRowId);
    assert.equal(story.status, "pending", "story must be reset to pending");
    assert.equal(story.abandoned_count, 3, "abandoned_count must be 2 + 1 = 3");
  });

  it("checkRunningWorkersLiveness sweep does not abort early — multiple steps, telemetry broken", async () => {
    const { checkRunningWorkersLiveness } = await import("../dist/installer/step-ops.js");

    // Seed two watchdog story runs with distinct dead pgids
    const a = seedWatchdogStoryRun({
      claimPgid: nextDeadPgid3(),
      claimJobId: "job-us007-multi-a",
      abandonedCount: 0,
      backdateSeconds: 60,
    });
    const b = seedWatchdogStoryRun({
      claimPgid: nextDeadPgid3(),
      claimJobId: "job-us007-multi-b",
      abandonedCount: 0,
      backdateSeconds: 60,
    });

    // Corrupt telemetry table — BOTH steps will hit telemetry failure
    getDb().prepare("DROP TABLE IF EXISTS story_abandonments").run();

    // Sweep must complete without throwing — must recover both steps
    const result = checkRunningWorkersLiveness();

    assert.ok(result.recovered >= 2,
      `must recover at least 2 steps — got recovered=${result.recovered} failed=${result.failed}`);
    assert.equal(result.failed, 0, "no steps should fail");

    // Both steps must be reset to pending
    for (const { stepRowId, storyRowId } of [a, b]) {
      const step = getDb().prepare(
        "SELECT status FROM steps WHERE id = ?"
      ).get(stepRowId) as { status: string };
      assert.equal(step.status, "pending", "each step must be reset to pending");

      const story = storyState(storyRowId);
      assert.equal(story.status, "pending", "each story must be reset to pending");
      assert.equal(story.abandoned_count, 1, "each story abandoned_count must be 1");
    }
  });
});

});
