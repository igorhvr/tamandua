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

    assert.equal(result.recovered, 0, "must NOT recover — inFlightChild proves worker is alive");
    assert.equal(result.skipped, 1, "should skip this step (defense-in-depth)");
    const step = getDb().prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "running", "step must remain running");
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

    assert.equal(result.recovered, 1, "must recover — inFlightChild pid is dead");
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

    assert.equal(result.recovered, 1, "must recover — killed=true, defense-in-depth does not apply");
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

    assert.equal(result.recovered, 0, "must NOT recover — within grace period");
    assert.equal(result.skipped, 1, "should skip due to grace period");
    const step = getDb().prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "running", "step must remain running");
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

    assert.equal(result.recovered, 1, "must recover — no inFlightChildren available");
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
});
