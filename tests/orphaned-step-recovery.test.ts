/**
 * Regression tests for: Step stuck at status='running' after pi SIGKILL
 *
 * Validates:
 * 1. recoverOrphanedStepsForAgent resets a running step to pending,
 *    bumps retry_count, and emits step.timeout events
 * 2. When retry_count exceeds max_retries, the step is marked failed
 *    and step.failed/run.failed events are emitted
 * 3. Stale-claim sweeper (staleThresholdMs param) only recovers steps
 *    whose updated_at is older than the threshold
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { createTempHome } from "./helpers/test-env.ts";
import { recoverOrphanedStepsForAgent, claimStep, completeStep, resolveStepContext, type WorkerOwnership } from "../dist/installer/step-ops.js";
import { getDb } from "../dist/db.js";
import { getRunEvents } from "../dist/installer/events.js";
import { classifyWorkRoundOutcome } from "../dist/installer/agent-scheduler.js";
import { autoCompleteStepIfRunning, type PollingRoundMetadata } from "../dist/installer/agent-scheduler.js";

// ── Environment isolation ──────────────────────────────────────────────
// Production modules imported at file scope (getDb, recoverOrphanedStepsForAgent,
// claimStep) call emitEvent() and logger.info/warn which write to
// ~/.tamandua/ by default. Without isolation, test runs pollute the real
// events/all.jsonl and tamandua.log with realistic-looking events.
// createTempHome sets up an isolated temp home with automatic after() cleanup.

describe("orphaned-step-recovery", () => {
  const { tamanduaDir } = createTempHome("tamandua-orphaned-test-");
  process.env.TAMANDUA_STATE_DIR = tamanduaDir;
  process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");

const TEST_AGENT_1 = "test_sigkill-recovery-agent-1";
const TEST_AGENT_2 = "test_sigkill-recovery-agent-2";
const TEST_AGENT_3 = "test_sigkill-recovery-agent-3";

function ts(): string {
  return new Date().toISOString();
}

describe("recoverOrphanedStepsForAgent", () => {
  let testRunId: string;
  let singleStepId: string;
  let exhaustedStepId: string;
  let freshStepId: string;
  let testRun2Id: string;  // for exhausted test (separate run so failure doesn't affect others)

  before(() => {
    const db = getDb();
    testRunId = crypto.randomUUID();
    testRun2Id = crypto.randomUUID();
    singleStepId = crypto.randomUUID();
    exhaustedStepId = crypto.randomUUID();
    freshStepId = crypto.randomUUID();
    const now = ts();

    // ── Run for single-step recovery test ──
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'test task', 'running', '{}', ?, ?)"
    ).run(testRunId, now, now);

    // Single step: running, retry_count=0, max_retries=2 — should be recovered
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'test-step', ?, 0, '', '', 'running', 0, 2, 'single', ?, ?)`
    ).run(singleStepId, testRunId, TEST_AGENT_1, now, now);

    // Fresh step: running, but updated_at = now — should NOT be claimed by stale sweeper
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'fresh-step', ?, 0, '', '', 'running', 0, 2, 'single', ?, ?)`
    ).run(freshStepId, testRunId, TEST_AGENT_2, now, now);

    // ── Run for exhausted retries test ──
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'test exhausted', 'running', '{}', ?, ?)"
    ).run(testRun2Id, now, now);

    // Exhausted step: running, retry_count=2, max_retries=2 — should be marked failed
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'exhausted-step', ?, 0, '', '', 'running', 2, 2, 'single', ?, ?)`
    ).run(exhaustedStepId, testRun2Id, TEST_AGENT_3, now, now);
  });

  after(() => {
    const db = getDb();
    db.prepare("DELETE FROM steps WHERE id IN (?, ?, ?)").run(singleStepId, freshStepId, exhaustedStepId);
    db.prepare("DELETE FROM runs WHERE id IN (?, ?)").run(testRunId, testRun2Id);
  });

  // ── AC 1: SIGKILL recovery — reset to pending, bump retry_count ──
  it("resets a running step to pending and bumps retry_count after SIGKILL", () => {
    const result = recoverOrphanedStepsForAgent(TEST_AGENT_1, testRunId);

    assert.equal(result.recovered, 1, "should recover 1 step");
    assert.equal(result.failed, 0, "should not fail any steps");
    assert.equal(result.skipped, 0, "should not skip any steps");

    const db = getDb();
    const step = db.prepare(
      "SELECT status, retry_count FROM steps WHERE id = ?"
    ).get(singleStepId) as { status: string; retry_count: number };

    assert.equal(step.status, "pending", "step should be reset to pending");
    assert.equal(step.retry_count, 1, "retry_count should be bumped to 1");

    // Verify that run status is still 'running' (not prematurely failed)
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(testRunId) as { status: string };
    assert.equal(run.status, "running");
  });

  // ── AC 2: Exhausted retries → mark failed ────────────────────────
  it("marks step as failed when retry_count exceeds max_retries", () => {
    const result = recoverOrphanedStepsForAgent(TEST_AGENT_3, testRun2Id);

    assert.equal(result.failed, 1, "should fail 1 step");
    assert.equal(result.recovered, 0, "should not recover any steps");

    const db = getDb();

    // Step should be failed
    const step = db.prepare(
      "SELECT status, retry_count, output FROM steps WHERE id = ?"
    ).get(exhaustedStepId) as { status: string; retry_count: number; output: string };

    assert.equal(step.status, "failed", "step should be marked failed");
    assert.equal(step.retry_count, 3, "retry_count should be bumped to 3");
    assert.ok(step.output.includes("retries exhausted"), "output should mention retries exhausted");

    // Run should also be failed
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(testRun2Id) as { status: string };
    assert.equal(run.status, "failed", "run should be marked failed when retries exhausted");
  });

  // ── AC 3: Stale-claim sweeper — only recovers old-enough steps ────
  it("stale-threshold: recovers old running step, ignores fresh one", () => {
    // Reset the previously-recovered step back to running so the sweeper
    // test has a real target
    const db = getDb();
    const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
    db.prepare(
      "UPDATE steps SET status = 'running', retry_count = 1, updated_at = ? WHERE id = ?"
    ).run(oldTs, singleStepId);

    // Stale threshold: 5 minutes (300,000 ms). The old step (10 min ago) should
    // be recovered, but the fresh step (updated just now) should not.
    const result = recoverOrphanedStepsForAgent(TEST_AGENT_1, testRunId, 5 * 60 * 1000);

    assert.equal(result.recovered, 1, "should recover the stale step");

    // Verify the stale step was reset again
    const step = db.prepare(
      "SELECT status, retry_count FROM steps WHERE id = ?"
    ).get(singleStepId) as { status: string; retry_count: number };
    assert.equal(step.status, "pending");
    assert.equal(step.retry_count, 2, "retry_count should be bumped again");

    // Verify the fresh step was NOT touched
    const freshResult = recoverOrphanedStepsForAgent(TEST_AGENT_2, testRunId, 5 * 60 * 1000);
    assert.equal(freshResult.recovered, 0, "fresh step should NOT be recovered");
    assert.equal(freshResult.failed, 0);
    assert.equal(freshResult.skipped, 0);
  });

  // ── AC 4: No-op for agents with no running steps ─────────────────
  it("returns zero counts for agent with no running steps", () => {
    const result = recoverOrphanedStepsForAgent("nonexistent-agent-xyz", crypto.randomUUID());
    assert.equal(result.recovered, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 0);
  });

  // ── AC 5: Calling without staleThreshold recovers ALL running steps
  it("recovers all running steps when staleThreshold is omitted (post-exit path)", () => {
    const db = getDb();

    // NOTE: freshStepId (from before()) is also running for this agent.
    // The stale-threshold test (AC 3) proved that freshStepId is NOT touched
    // by a stale-threshold query. But without the threshold, it WILL be
    // recovered. Reset freshStepId back to running (retry_count was already
    // bumped to 1 in the stale-threshold test) so we can verify it gets
    // recovered again.
    db.prepare(
      "UPDATE steps SET status = 'running', updated_at = datetime('now') WHERE id = ?"
    ).run(freshStepId);

    // Also create a second fresh running step so the count is unambiguous
    const tmpStepId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'tmp-step', ?, 0, '', '', 'running', 0, 2, 'single', datetime('now'), datetime('now'))`
    ).run(tmpStepId, testRunId, TEST_AGENT_2);

    try {
      // Without staleThreshold, ALL running steps for this (agent, run) tuple
      // are recovered regardless of how recently they were updated.
      const result = recoverOrphanedStepsForAgent(TEST_AGENT_2, testRunId);
      assert.equal(result.recovered, 2, "should recover both running steps");
      assert.equal(result.failed, 0);
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(tmpStepId);
    }
  });

  // ── AC 6: SIGKILL timeout records timeout_retry in run context ─
  // When recoverOrphanedStepsForAgent is called with a timeoutRetryReason,
  // the run's context must carry `timeout_retry` so the retry prompt includes
  // a signal that the agent's previous attempt was interrupted.
  it("records timeout_retry in run context when timeoutRetryReason is provided", () => {
    const db = getDb();
    const agent = "test_timeout-context-recorder";

    // Create a fresh run + running step
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const now = ts();
    const contextBefore = JSON.stringify({ repo: "/tmp/test", branch: "fix/bug-123", build_cmd: "npm run build", test_cmd: "npm test" });

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'fix bug 123', 'running', ?, ?, ?)"
    ).run(runId, contextBefore, now, now);

    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'fix', ?, 0,
         'BROKEN: {{timeout_retry}}', '',
         'running', 0, 2, 'single', ?, ?)`
    ).run(stepUuid, runId, agent, now, now);

    try {
      // Execute recovery with a timeout reason
      const timeoutReason = "pi timed out after 1800000ms";
      const result = recoverOrphanedStepsForAgent(agent, runId, undefined, timeoutReason);

      assert.equal(result.recovered, 1, "should recover 1 step");
      assert.equal(result.failed, 0);

      // The run's context should now contain timeout_retry
      const runAfter = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
      const ctx = JSON.parse(runAfter.context);
      assert.equal(ctx.timeout_retry, timeoutReason,
        "run context must carry timeout_retry after timeout recovery");

      // The step should be back to pending with retry_count bumped
      const step = db.prepare(
        "SELECT status, retry_count FROM steps WHERE id = ?"
      ).get(stepUuid) as { status: string; retry_count: number };
      assert.equal(step.status, "pending");
      assert.equal(step.retry_count, 1);

      // ── Sub-test: claimStep sees timeout_retry in the resolved input ──
      const claim = claimStep(agent, runId);
      assert.ok(claim.found, "step should be claimable after recovery");
      assert.ok(claim.resolvedInput?.includes(timeoutReason),
        `resolved input should include timeout reason, got: ${claim.resolvedInput?.slice(0, 300)}`);

      // After claim, timeout_retry should be cleared from run context
      const runAfterClaim = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
      const ctxAfterClaim = JSON.parse(runAfterClaim.context);
      assert.equal(ctxAfterClaim.timeout_retry, "",
        "timeout_retry should be cleared from run context after claim");

      // Reset step back to running so after() can clean it up
      db.prepare("UPDATE steps SET status = 'running' WHERE id = ?").run(stepUuid);
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // ── AC 7: No stale timeout_retry leakage between different retries ──
  it("does NOT set timeout_retry when timeoutRetryReason is omitted (non-timeout exit)", () => {
    const db = getDb();
    const agent = "test_no-context-pollution";
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const now = ts();
    const contextBefore = JSON.stringify({ repo: "/tmp/test" });

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'task', 'running', ?, ?, ?)"
    ).run(runId, contextBefore, now, now);

    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'fix', ?, 0, '', '', 'running', 0, 2, 'single', ?, ?)`
    ).run(stepUuid, runId, agent, now, now);

    try {
      // Recovery WITHOUT a timeout reason (simulates non-timeout exit, e.g. SIGTERM)
      const result = recoverOrphanedStepsForAgent(agent, runId);
      assert.equal(result.recovered, 1, "should recover the step");

      // Context should NOT contain timeout_retry
      const runAfter = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
      const ctx = JSON.parse(runAfter.context);
      assert.ok(!("timeout_retry" in ctx),
        "run context must NOT contain timeout_retry when no reason was provided");

      db.prepare("UPDATE steps SET status = 'running' WHERE id = ?").run(stepUuid);
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// Regression: other_output (clean pi exit without STATUS line)
// ══════════════════════════════════════════════════════════════════════

describe("other_output recovery (clean pi exit without STATUS)", () => {
  // ── AC 1: other_output triggers recovery of running step ───────
  it("resets running step to pending when other_output occurs (recoverOrphanedStepsForAgent)", () => {
    const db = getDb();
    const agent = "test_other-output-recovery";
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'verify work', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'verify-step', ?, 0, '', '', 'running', 0, 3, 'single', ?, ?)`
    ).run(stepUuid, runId, agent, now, now);

    try {
      // Simulate the other_output handler: call recoverOrphanedStepsForAgent
      // without staleThreshold or timeoutRetryReason (clean exit, not a timeout)
      const result = recoverOrphanedStepsForAgent(agent, runId);

      assert.equal(result.recovered, 1, "should recover 1 running step");
      assert.equal(result.failed, 0, "should not fail any steps");

      const step = db.prepare(
        "SELECT status, retry_count FROM steps WHERE id = ?"
      ).get(stepUuid) as { status: string; retry_count: number };

      assert.equal(step.status, "pending", "step should be reset to pending");
      assert.equal(step.retry_count, 1, "retry_count should be bumped to 1");

      // Run should still be running (not prematurely failed)
      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "running");
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // ── AC 2: claim-race output is NOT classified as other_output ──
  it("classifyWorkRoundOutcome: NO_WORK_AVAILABLE is NOT other_output", () => {
    // A work round whose claim raced another worker replies
    // NO_WORK_AVAILABLE. That must stay a benign no-op ("no_work"), not
    // "other_output" — other_output triggers orphaned-step recovery.
    assert.equal(
      classifyWorkRoundOutcome("NO_WORK_AVAILABLE"),
      "no_work",
      "NO_WORK_AVAILABLE must be classified as no_work, not other_output",
    );

    // Also verify with whitespace
    assert.equal(
      classifyWorkRoundOutcome("  NO_WORK_AVAILABLE  "),
      "no_work",
      "whitespace-padded NO_WORK_AVAILABLE must still be no_work",
    );

    // STATUS: done is NOT other_output
    assert.equal(
      classifyWorkRoundOutcome("STATUS: done\nCHANGES: foo"),
      "work_done",
      "STATUS: done must be classified as work_done, not other_output",
    );

    // STATUS: fail is NOT other_output
    assert.equal(
      classifyWorkRoundOutcome("STATUS: fail\nREASON: timeout"),
      "work_failed",
      "STATUS: fail must be classified as work_failed, not other_output",
    );
  });

  // ── AC 3: Clean exit output without STATUS is other_output ─────
  it("classifyWorkRoundOutcome: clean exit output without STATUS is other_output", () => {
    // This is the exact scenario from the bug report: pi produced a lot
    // of text but never emitted STATUS: done/fail/retry.
    const verifierOutput = "Code checks are comprehensive. Now for visual verification since this has frontend changes. Let me spin up the dev server and inspect.";

    assert.equal(
      classifyWorkRoundOutcome(verifierOutput),
      "other_output",
      "output without STATUS line or HEARTBEAT_OK must be classified as other_output",
    );

    // Empty output is NOT other_output
    assert.equal(
      classifyWorkRoundOutcome(""),
      "empty_output",
      "empty output must be classified as empty_output, not other_output",
    );
  });

  // ── AC 4: other_output with no running step is a no-op ─────────
  it("recoverOrphanedStepsForAgent is a no-op when no running steps exist", () => {
    const result = recoverOrphanedStepsForAgent("agent_with_no_claims_xyz", crypto.randomUUID());

    assert.equal(result.recovered, 0, "should recover 0 steps");
    assert.equal(result.failed, 0, "should fail 0 steps");
    assert.equal(result.skipped, 0, "should skip 0 steps");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Regression: STORIES_JSON parse-wedge bug
// (autoCompleteStepIfRunning swallowed completeStep throws and left the
//  step in 'running' forever — wedging the run until the 45-min sweeper.)
// ══════════════════════════════════════════════════════════════════════

describe("autoCompleteStepIfRunning recovers wedged step on completeStep throw", () => {
// ══════════════════════════════════════════════════════════════════════
// US-003: Ownership-aware orphan recovery
// ══════════════════════════════════════════════════════════════════════

describe("US-003: Ownership-aware orphan recovery", () => {
  // AC 1: workerJobId skips steps claimed by a different worker
  it("skips steps claimed by a different worker (claim_job_id mismatch)", () => {
    const db = getDb();
    const agent = "test_ownership-skip-other-worker";
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'ownership skip', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // Step claimed by worker-B (claim_job_id = 'job-B')
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, claim_job_id, claim_pid, claim_updated_at, created_at, updated_at)
       VALUES (?, ?, 'ownership-step', ?, 0, '', '', 'running', 0, 2, 'single', 'job-B', 99999, ?, ?, ?)`
    ).run(stepUuid, runId, agent, now, now, now);

    try {
      // Worker-A (job-A) tries to recover — should SKIP because step is claimed by job-B
      const result = recoverOrphanedStepsForAgent(agent, runId, undefined, undefined, undefined, "job-A");

      assert.equal(result.recovered, 0, "should recover 0 steps (different worker)");
      assert.equal(result.failed, 0, "should not fail any steps");
      assert.equal(result.skipped, 0, "should not skip any steps");

      const step = db.prepare(
        "SELECT status FROM steps WHERE id = ?"
      ).get(stepUuid) as { status: string };
      assert.equal(step.status, "running", "step should still be running (untouched)");
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // AC 2: workerJobId recovers steps claimed by the SAME worker
  it("recovers steps claimed by the same worker (claim_job_id match)", () => {
    const db = getDb();
    const agent = "test_ownership-recover-same-worker";
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'ownership same worker', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // Step claimed by worker-A (claim_job_id = 'job-A')
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, claim_job_id, claim_pid, claim_updated_at, created_at, updated_at)
       VALUES (?, ?, 'same-worker-step', ?, 0, '', '', 'running', 0, 2, 'single', 'job-A', 12345, ?, ?, ?)`
    ).run(stepUuid, runId, agent, now, now, now);

    try {
      // Worker-A (job-A) exits — should RECOVER because step is claimed by same worker
      const result = recoverOrphanedStepsForAgent(agent, runId, undefined, undefined, undefined, "job-A");

      assert.equal(result.recovered, 1, "should recover the step (same worker)");
      assert.equal(result.failed, 0, "should not fail any steps");

      const step = db.prepare(
        "SELECT status, retry_count FROM steps WHERE id = ?"
      ).get(stepUuid) as { status: string; retry_count: number };
      assert.equal(step.status, "pending", "step should be reset to pending");
      assert.equal(step.retry_count, 1, "retry_count should be bumped");

      // Verify step.worker_lost event was emitted
      const events = getRunEvents(runId);
      const workerLostEvents = events.filter((e) => e.event === "step.worker_lost");
      assert.equal(workerLostEvents.length, 1, "should emit exactly 1 step.worker_lost event");
      const evt = workerLostEvents[0];
      assert.ok(evt.detail?.includes("job-A"), `event detail should mention worker jobId, got: ${evt.detail}`);
      assert.ok(evt.detail?.includes("retry 1/2"), `event detail should include retry info, got: ${evt.detail}`);
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // AC 2b: workerJobId recovers steps with NULL claim_job_id (legacy)
  it("recovers steps with NULL claim_job_id regardless of workerJobId", () => {
    const db = getDb();
    const agent = "test_ownership-recover-null-legacy";
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'ownership null legacy', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // Step WITHOUT ownership columns (NULL claim_job_id) — legacy row
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'legacy-step', ?, 0, '', '', 'running', 0, 2, 'single', ?, ?)`
    ).run(stepUuid, runId, agent, now, now);

    try {
      // Any worker should be able to recover legacy (NULL) steps
      const result = recoverOrphanedStepsForAgent(agent, runId, undefined, undefined, undefined, "job-X");

      assert.equal(result.recovered, 1, "should recover step with NULL claim_job_id");
      assert.equal(result.failed, 0);

      const step = db.prepare(
        "SELECT status, retry_count FROM steps WHERE id = ?"
      ).get(stepUuid) as { status: string; retry_count: number };
      assert.equal(step.status, "pending", "legacy step should be reset to pending");
      assert.equal(step.retry_count, 1);

      // Verify step.worker_lost event was emitted (workerJobId provided)
      const events = getRunEvents(runId);
      const workerLostEvents = events.filter((e) => e.event === "step.worker_lost");
      assert.equal(workerLostEvents.length, 1, "should emit step.worker_lost for worker exit");
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // AC 3: No workerJobId = backward compat — recover all running steps
  it("recovers all running steps when no workerJobId (backward compat)", () => {
    const db = getDb();
    const agent = "test_ownership-backward-compat";
    const runId = crypto.randomUUID();
    const stepAId = crypto.randomUUID();
    const stepBId = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'backward compat', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // Step claimed by worker-A
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, claim_job_id, claim_pid, claim_updated_at, created_at, updated_at)
       VALUES (?, ?, 'worker-a-step', ?, 0, '', '', 'running', 0, 2, 'single', 'job-A', 111, ?, ?, ?)`
    ).run(stepAId, runId, agent, now, now, now);

    // Step claimed by worker-B (different worker)
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, claim_job_id, claim_pid, claim_updated_at, created_at, updated_at)
       VALUES (?, ?, 'worker-b-step', ?, 0, '', '', 'running', 0, 2, 'single', 'job-B', 222, ?, ?, ?)`
    ).run(stepBId, runId, agent, now, now, now);

    try {
      // No workerJobId = backward compat — recover ALL running steps regardless of owner
      const result = recoverOrphanedStepsForAgent(agent, runId);

      assert.equal(result.recovered, 2, "should recover both steps (backward compat)");
      assert.equal(result.failed, 0);

      // Verify step.timeout events (NOT step.worker_lost) were emitted
      const events = getRunEvents(runId);
      const timeoutEvents = events.filter((e) => e.event === "step.timeout");
      const workerLostEvents = events.filter((e) => e.event === "step.worker_lost");
      assert.ok(timeoutEvents.length >= 2, `should emit step.timeout events, got ${timeoutEvents.length}`);
      assert.equal(workerLostEvents.length, 0, "should NOT emit step.worker_lost without workerJobId");
    } finally {
      db.prepare("DELETE FROM steps WHERE id IN (?, ?)").run(stepAId, stepBId);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // AC 4: step.worker_lost event distinct from step.timeout
  it("emits step.worker_lost (not step.timeout) when recovery is worker-exit", () => {
    const db = getDb();
    const agent = "test_ownership-worker-lost-event";
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'worker lost event', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, claim_job_id, claim_pid, claim_updated_at, created_at, updated_at)
       VALUES (?, ?, 'wl-step', ?, 0, '', '', 'running', 0, 3, 'single', 'job-wl', 555, ?, ?, ?)`
    ).run(stepUuid, runId, agent, now, now, now);

    try {
      // Worker exit with workerJobId
      const result = recoverOrphanedStepsForAgent(agent, runId, undefined, undefined, undefined, "job-wl");
      assert.equal(result.recovered, 1);

      const events = getRunEvents(runId);
      const workerLostEvents = events.filter((e) => e.event === "step.worker_lost");
      const timeoutEvents = events.filter((e) => e.event === "step.timeout");

      assert.equal(workerLostEvents.length, 1, "should emit step.worker_lost");
      assert.equal(timeoutEvents.length, 0, "should NOT emit step.timeout");

      const evt = workerLostEvents[0];
      assert.equal(evt.runId, runId, "event should have runId");
      assert.equal(evt.stepId, "wl-step", "event should have stepId");
      assert.ok(evt.detail?.includes("job-wl"), `detail should mention job-wl, got: ${evt.detail}`);
      assert.ok(evt.detail?.includes("retry 1/3"), `detail should include retry count, got: ${evt.detail}`);
      assert.ok(evt.detail?.includes("exited without completing"), `detail should describe reason, got: ${evt.detail}`);
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // AC 4b: stale sweeper (no workerJobId) emits step.timeout, not step.worker_lost
  it("stale sweeper (no workerJobId) emits step.timeout, not step.worker_lost", () => {
    const db = getDb();
    const agent = "test_ownership-stale-sweeper-event";
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'stale sweeper', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // Set updated_at to old so stale threshold catches it
    const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const dbNow = ts();
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, claim_job_id, claim_pid, claim_updated_at, created_at, updated_at)
       VALUES (?, ?, 'stale-step', ?, 0, '', '', 'running', 0, 2, 'single', 'job-stale', 777, ?, ?, ?)`
    ).run(stepUuid, runId, agent, oldTs, dbNow, oldTs);

    try {
      // Stale sweeper — no workerJobId
      const result = recoverOrphanedStepsForAgent(agent, runId, 5 * 60 * 1000);
      assert.equal(result.recovered, 1);

      const events = getRunEvents(runId);
      const timeoutEvents = events.filter((e) => e.event === "step.timeout");
      const workerLostEvents = events.filter((e) => e.event === "step.worker_lost");

      assert.ok(timeoutEvents.length >= 1, "should emit step.timeout");
      assert.equal(workerLostEvents.length, 0, "should NOT emit step.worker_lost for stale sweeper");
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // AC 5: ownership-aware with both same-worker and different-worker steps
  it("handles mixed ownership: recovers own, skips others", () => {
    const db = getDb();
    const agent = "test_ownership-mixed";
    const runId = crypto.randomUUID();
    const myStepId = crypto.randomUUID();
    const otherStepId = crypto.randomUUID();
    const legacyStepId = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'mixed ownership', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // Step 1: claimed by my worker (job-A)
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, claim_job_id, claim_pid, claim_updated_at, created_at, updated_at)
       VALUES (?, ?, 'my-step', ?, 0, '', '', 'running', 0, 2, 'single', 'job-A', 111, ?, ?, ?)`
    ).run(myStepId, runId, agent, now, now, now);

    // Step 2: claimed by different worker (job-B)
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, claim_job_id, claim_pid, claim_updated_at, created_at, updated_at)
       VALUES (?, ?, 'other-step', ?, 0, '', '', 'running', 0, 2, 'single', 'job-B', 222, ?, ?, ?)`
    ).run(otherStepId, runId, agent, now, now, now);

    // Step 3: NULL claim_job_id (legacy)
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'legacy-step-2', ?, 0, '', '', 'running', 0, 2, 'single', ?, ?)`
    ).run(legacyStepId, runId, agent, now, now);

    try {
      // Worker-A (job-A) exits
      const result = recoverOrphanedStepsForAgent(agent, runId, undefined, undefined, undefined, "job-A");

      assert.equal(result.recovered, 2, "should recover my-step and legacy-step");
      assert.equal(result.failed, 0);

      // my-step: should be recovered (pending)
      const myStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(myStepId) as { status: string };
      assert.equal(myStep.status, "pending");

      // other-step: should still be running (untouched by job-A)
      const otherStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(otherStepId) as { status: string };
      assert.equal(otherStep.status, "running");

      // legacy-step: should be recovered (pending)
      const legacyStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(legacyStepId) as { status: string };
      assert.equal(legacyStep.status, "pending");

      // Now verify that job-B can still recover the other-step
      const resultB = recoverOrphanedStepsForAgent(agent, runId, undefined, undefined, undefined, "job-B");
      assert.equal(resultB.recovered, 1, "job-B should recover its own step");
      const otherStepAfterB = db.prepare("SELECT status FROM steps WHERE id = ?").get(otherStepId) as { status: string };
      assert.equal(otherStepAfterB.status, "pending");
    } finally {
      db.prepare("DELETE FROM steps WHERE id IN (?, ?, ?)").run(myStepId, otherStepId, legacyStepId);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // AC: skipped count for loop verify_each mid-iteration pause
  it("skips loop step waiting on verify_each even with workerJobId", () => {
    const db = getDb();
    const agent = "test_ownership-loop-verify-skip";
    const runId = crypto.randomUUID();
    const loopStepUuid = crypto.randomUUID();
    const verifyStepUuid = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'loop verify skip', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // Loop step with verify_each, no current_story_id (mid-iteration pause)
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, loop_config, claim_job_id, claim_pid, claim_updated_at, created_at, updated_at)
       VALUES (?, ?, 'implement', ?, 0, '', '', 'running', 0, 2, 'loop',
               '{"over":"stories","verify_each":true,"verify_step":"verify"}',
               'job-loop', 333, ?, ?, ?)`
    ).run(loopStepUuid, runId, agent, now, now, now);

    // Verify step still running (or pending)
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'verify', 'verifier', 1, '', '', 'running', 0, 2, 'single', ?, ?)`
    ).run(verifyStepUuid, runId, now, now);

    try {
      const result = recoverOrphanedStepsForAgent(agent, runId, undefined, undefined, undefined, "job-loop");

      assert.equal(result.recovered, 0, "should recover 0 (waiting on verify)");
      assert.equal(result.failed, 0);
      assert.equal(result.skipped, 1, "should skip the loop step");

      const loopStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(loopStepUuid) as { status: string };
      assert.equal(loopStep.status, "running", "loop step should still be running");
    } finally {
      db.prepare("DELETE FROM steps WHERE id IN (?, ?)").run(loopStepUuid, verifyStepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// US-004: Focused regression tests for worker-lifecycle recovery
// ══════════════════════════════════════════════════════════════════════

describe("US-004: Worker-lifecycle recovery regression tests", () => {
  // ── Test 1: Claim single step with worker A, simulate worker exit, verify recovery ──
  it("claim single step → worker exit → step recovered with step.worker_lost event", () => {
    const db = getDb();
    const agent = "test_us004-single-step-recovery";
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'single step recovery', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // Create a pending step, then claim it with ownership
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'single-step', ?, 0, '', '', 'pending', 0, 2, 'single', ?, ?)`
    ).run(stepUuid, runId, agent, now, now);

    try {
      // Claim with worker ownership
      const claim = claimStep(agent, runId, { jobId: "job-A", pid: 12345 });
      assert.ok(claim.found, "step should be claimed");

      // Verify ownership columns were set
      const stepAfterClaim = db.prepare(
        "SELECT status, claim_job_id, claim_pid, claim_updated_at FROM steps WHERE id = ?"
      ).get(stepUuid) as { status: string; claim_job_id: string | null; claim_pid: number | null; claim_updated_at: string | null };
      assert.equal(stepAfterClaim.status, "running");
      assert.equal(stepAfterClaim.claim_job_id, "job-A");
      assert.equal(stepAfterClaim.claim_pid, 12345);
      assert.ok(stepAfterClaim.claim_updated_at, "claim_updated_at should be set");

      // Simulate worker A exit: recover with same workerJobId
      const result = recoverOrphanedStepsForAgent(agent, runId, undefined, undefined, undefined, "job-A");
      assert.equal(result.recovered, 1, "should recover 1 step");
      assert.equal(result.failed, 0, "should not fail");
      assert.equal(result.skipped, 0, "should not skip");

      // Verify step reset to pending with bumped retry_count
      const stepAfterRecovery = db.prepare(
        "SELECT status, retry_count FROM steps WHERE id = ?"
      ).get(stepUuid) as { status: string; retry_count: number };
      assert.equal(stepAfterRecovery.status, "pending");
      assert.equal(stepAfterRecovery.retry_count, 1);

      // Verify step.worker_lost event
      const events = getRunEvents(runId);
      const workerLostEvents = events.filter((e) => e.event === "step.worker_lost");
      assert.equal(workerLostEvents.length, 1, "should emit exactly 1 step.worker_lost event");
      assert.equal(workerLostEvents[0].runId, runId);
      assert.equal(workerLostEvents[0].stepId, "single-step");
      assert.ok(workerLostEvents[0].detail?.includes("job-A"), "detail should mention job-A");
      assert.ok(workerLostEvents[0].detail?.includes("retry 1/2"), "detail should include retry info");
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // ── Test 2: Claim loop story with worker A, simulate worker exit, verify story recovery ──
  it("claim loop story → worker exit → story recovered with step.worker_lost event", () => {
    const db = getDb();
    const agent = "test_us004-loop-story-recovery";
    const runId = crypto.randomUUID();
    const loopStepUuid = crypto.randomUUID();
    const storyUuid = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'loop story recovery', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // Loop step over stories
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, loop_config, created_at, updated_at)
       VALUES (?, ?, 'implement', ?, 0, '', '', 'pending', 0, 2, 'loop',
               '{"over":"stories","completion":"all_done","fresh_session":true}', ?, ?)`
    ).run(loopStepUuid, runId, agent, now, now);

    // A pending story
    db.prepare(
      `INSERT INTO stories (id, run_id, story_id, story_index, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at)
       VALUES (?, ?, 'US-100', 1, 'Test Story', 'Do something', '[]', 'pending', 0, 2, ?, ?)`
    ).run(storyUuid, runId, now, now);

    try {
      // Claim loop step with worker ownership
      const claim = claimStep(agent, runId, { jobId: "job-A", pid: 12345 });
      assert.ok(claim.found, "loop step should be claimed");

      // Verify ownership and current_story_id
      const stepAfterClaim = db.prepare(
        "SELECT status, claim_job_id, claim_pid, current_story_id FROM steps WHERE id = ?"
      ).get(loopStepUuid) as { status: string; claim_job_id: string | null; claim_pid: number | null; current_story_id: string | null };
      assert.equal(stepAfterClaim.status, "running");
      assert.equal(stepAfterClaim.claim_job_id, "job-A");
      assert.ok(stepAfterClaim.current_story_id, "current_story_id should be set");

      // Verify story is running
      const storyAfterClaim = db.prepare(
        "SELECT status FROM stories WHERE id = ?"
      ).get(storyUuid) as { status: string };
      assert.equal(storyAfterClaim.status, "running");

      // Simulate worker A exit: recover with same workerJobId
      const result = recoverOrphanedStepsForAgent(agent, runId, undefined, undefined, undefined, "job-A");
      assert.equal(result.recovered, 1, "should recover 1 (story)");
      assert.equal(result.failed, 0, "should not fail");
      assert.equal(result.skipped, 0, "should not skip");

      // Verify story reset to pending, story abandoned_count bumped (US-004 WLST)
      const storyAfterRecovery = db.prepare(
        "SELECT status, retry_count, abandoned_count FROM stories WHERE id = ?"
      ).get(storyUuid) as { status: string; retry_count: number; abandoned_count: number };
      assert.equal(storyAfterRecovery.status, "pending");
      assert.equal(storyAfterRecovery.abandoned_count, 1, "worker loss must increment abandoned_count, not retry_count");
      assert.equal(storyAfterRecovery.retry_count, 0, "retry_count must stay unchanged for worker-loss recovery");

      // Verify loop step reset to pending, current_story_id cleared
      const loopStepAfterRecovery = db.prepare(
        "SELECT status, current_story_id FROM steps WHERE id = ?"
      ).get(loopStepUuid) as { status: string; current_story_id: string | null };
      assert.equal(loopStepAfterRecovery.status, "pending");
      assert.equal(loopStepAfterRecovery.current_story_id, null);

      // Verify step.worker_lost event with story detail
      const events = getRunEvents(runId);
      const workerLostEvents = events.filter((e) => e.event === "step.worker_lost");
      assert.equal(workerLostEvents.length, 1, "should emit exactly 1 step.worker_lost event");
      assert.ok(workerLostEvents[0].detail?.includes("US-100"), `detail should mention story ID, got: ${workerLostEvents[0].detail}`);
      assert.ok(workerLostEvents[0].detail?.includes("story abandon 1/8"), `detail should include story abandon, got: ${workerLostEvents[0].detail}`);
    } finally {
      db.prepare("DELETE FROM stories WHERE id = ?").run(storyUuid);
      db.prepare("DELETE FROM steps WHERE id = ?").run(loopStepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // ── Test 3: Worker A claims step, then worker B reclaims, worker A exit skips ──
  it("worker A claims → worker B reclaims → worker A exit does NOT recover", () => {
    const db = getDb();
    const agent = "test_us004-worker-reclaim";
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'worker reclaim', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // Create a pending step
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'reclaim-step', ?, 0, '', '', 'pending', 0, 2, 'single', ?, ?)`
    ).run(stepUuid, runId, agent, now, now);

    try {
      // Worker A claims the step
      const claimA = claimStep(agent, runId, { jobId: "job-A", pid: 11111 });
      assert.ok(claimA.found, "worker A should claim step");

      // Verify A's ownership
      let step = db.prepare(
        "SELECT status, claim_job_id, claim_pid FROM steps WHERE id = ?"
      ).get(stepUuid) as { status: string; claim_job_id: string | null; claim_pid: number | null };
      assert.equal(step.claim_job_id, "job-A");
      assert.equal(step.claim_pid, 11111);

      // Simulate: step was recovered from A (reset to pending), then claimed by worker B
      // This simulates a newer polling round picking up the work
      db.prepare(
        "UPDATE steps SET status = 'pending', claim_job_id = NULL, claim_pid = NULL, claim_updated_at = NULL WHERE id = ?"
      ).run(stepUuid);

      const claimB = claimStep(agent, runId, { jobId: "job-B", pid: 22222 });
      assert.ok(claimB.found, "worker B should claim step after recovery");

      // Verify B's ownership
      step = db.prepare(
        "SELECT status, claim_job_id, claim_pid FROM steps WHERE id = ?"
      ).get(stepUuid) as { status: string; claim_job_id: string | null; claim_pid: number | null };
      assert.equal(step.claim_job_id, "job-B");
      assert.equal(step.status, "running");

      // Now worker A's exit handler runs (stale recovery) — should skip because
      // step now belongs to B (claim_job_id != 'job-A')
      const result = recoverOrphanedStepsForAgent(agent, runId, undefined, undefined, undefined, "job-A");
      assert.equal(result.recovered, 0, "worker A should recover 0 steps (step belongs to B)");
      assert.equal(result.failed, 0, "should fail 0");
      assert.equal(result.skipped, 0, "should skip 0");

      // Step should still be running (untouched)
      step = db.prepare(
        "SELECT status, claim_job_id FROM steps WHERE id = ?"
      ).get(stepUuid) as { status: string; claim_job_id: string | null };
      assert.equal(step.status, "running");
      assert.equal(step.claim_job_id, "job-B");

      // No worker_lost events should have been emitted
      const events = getRunEvents(runId);
      const workerLostEvents = events.filter((e) => e.event === "step.worker_lost");
      assert.equal(workerLostEvents.length, 0, "no step.worker_lost events for worker A");
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // ── Test 4: Normal completion — claim → complete → no recovery, step stays done ──
  it("normal completion: claim → complete → step stays done, no recovery", () => {
    const db = getDb();
    const agent = "test_us004-normal-completion";
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'normal completion', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // Create a pending step with expects matching the expected output
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'normal-step', ?, 0, '', '', 'pending', 0, 2, 'single', ?, ?)`
    ).run(stepUuid, runId, agent, now, now);

    try {
      // Claim with worker ownership
      const claim = claimStep(agent, runId, { jobId: "job-A", pid: 12345 });
      assert.ok(claim.found, "step should be claimed");
      assert.ok(claim.stepId, "stepId should be returned");

      // Complete normally
      const completeResult = completeStep(claim.stepId!, "STATUS: done\nCHANGES: implemented feature\nTESTS: all pass");
      assert.ok(completeResult.status === "completed" || completeResult.status === "advanced", `complete should succeed, got ${completeResult.status}`);

      // Verify step is done
      const stepAfterComplete = db.prepare(
        "SELECT status FROM steps WHERE id = ?"
      ).get(stepUuid) as { status: string };
      assert.ok(stepAfterComplete.status === "done" || stepAfterComplete.status === "done", `step should be done, got ${stepAfterComplete.status}`);

      // Capture events so far (to count later)
      const eventsBeforeRecovery = getRunEvents(runId);
      const workerLostBefore = eventsBeforeRecovery.filter((e) => e.event === "step.worker_lost").length;

      // Try recovery — should not touch the done step
      const result = recoverOrphanedStepsForAgent(agent, runId, undefined, undefined, undefined, "job-A");
      assert.equal(result.recovered, 0, "should recover 0 steps (step already done)");
      assert.equal(result.failed, 0, "should fail 0");
      assert.equal(result.skipped, 0, "should skip 0");

      // Step should still be done
      const stepAfterRecovery = db.prepare(
        "SELECT status FROM steps WHERE id = ?"
      ).get(stepUuid) as { status: string };
      assert.ok(stepAfterRecovery.status === "done" || stepAfterRecovery.status === "done", "step should remain done");

      // No new step.worker_lost events
      const eventsAfterRecovery = getRunEvents(runId);
      const workerLostAfter = eventsAfterRecovery.filter((e) => e.event === "step.worker_lost").length;
      assert.equal(workerLostAfter, workerLostBefore, "no new step.worker_lost events after recovery of done step");
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // ── Test 5: step.worker_lost event detail fields are correct ──
  it("step.worker_lost event has correct detail fields", () => {
    const db = getDb();
    const agent = "test_us004-event-fields";
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const now = ts();
    const workerJobId = "job-event-test-xyz";

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'event fields', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // Create a pending step, claim with ownership, then recover
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'event-step', ?, 0, '', '', 'pending', 0, 3, 'single', ?, ?)`
    ).run(stepUuid, runId, agent, now, now);

    try {
      // Claim with explicit workerJobId
      claimStep(agent, runId, { jobId: workerJobId, pid: 99999 });

      // Recover
      const result = recoverOrphanedStepsForAgent(agent, runId, undefined, undefined, undefined, workerJobId);
      assert.equal(result.recovered, 1);

      // Verify event structure
      const events = getRunEvents(runId);
      const workerLostEvents = events.filter((e) => e.event === "step.worker_lost");
      assert.equal(workerLostEvents.length, 1, "exactly 1 step.worker_lost event");

      const evt = workerLostEvents[0];

      // runId field
      assert.equal(evt.runId, runId, "event.runId must match the run");

      // stepId field
      assert.equal(evt.stepId, "event-step", "event.stepId must match the step");

      // event type
      assert.equal(evt.event, "step.worker_lost", "event type must be step.worker_lost");

      // ts should be a valid ISO timestamp
      assert.ok(evt.ts, "event.ts must be present");
      assert.ok(Date.parse(evt.ts) > 0, "event.ts must be a valid date");

      // detail field — must contain the workerJobId
      assert.ok(evt.detail, "event.detail must be present");
      assert.ok(evt.detail!.includes(workerJobId), `detail must contain workerJobId "${workerJobId}", got: ${evt.detail}`);
      assert.ok(evt.detail!.includes("exited without completing"), `detail must describe reason, got: ${evt.detail}`);
      assert.ok(evt.detail!.includes("retry 1/3"), `detail must include retry count, got: ${evt.detail}`);

      // workflowId should be present
      assert.ok(evt.workflowId, `event.workflowId should be present, got: ${evt.workflowId}`);
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });
});

  it("STORIES_JSON parse error recovers the running plan step instead of wedging", async () => {
    const db = getDb();
    const agent = "test_stories-json-wedge-recovery";
    const runId = crypto.randomUUID();
    const planStepUuid = crypto.randomUUID();
    const loopStepUuid = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'verify wedge fix', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // Plan step in 'running' — this is the wedged step the auto-complete
    // handler will try (and fail) to mark done because STORIES_JSON parse throws.
    // The input_template embeds {{retry_feedback}} so the test can verify
    // the recovery message reaches the retried planner via resolvedInput.
    const inputTemplate = "Plan task.\nRETRY FEEDBACK:\n{{retry_feedback}}";
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'plan', ?, 0, ?, 'STATUS: done', 'running', 0, 2, 'single', ?, ?)`
    ).run(planStepUuid, runId, agent, inputTemplate, now, now);

    // Downstream loop step over stories — completeStep on the plan step
    // calls parseAndInsertStories, which throws on the malformed JSON.
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, loop_config, created_at, updated_at)
       VALUES (?, ?, 'implement', 'developer', 1, '', 'STATUS: done', 'pending', 0, 2, 'loop',
               '{"over":"stories","completion":"all_done","fresh_session":true}', ?, ?)`
    ).run(loopStepUuid, runId, now, now);

    // Realistic planner output: valid STORIES_JSON array followed by
    // trailing prose — the exact shape that wedged run 24cb9c10.
    const assistantOutput = [
      "STATUS: done",
      "REPO: /home/igorhvr/idm/tamandua",
      "BRANCH: feature/test-wedge",
      'STORIES_JSON: [{"id":"US-001","title":"Test","description":"Test story","acceptanceCriteria":["Tests pass","Typecheck passes"]}]',
      "",
      "Plan summary: this is the trailing prose that breaks the parser.",
    ].join("\n");

    const metadata: PollingRoundMetadata = {
      assistantOutput,
      tokenUsage: 12345,
      runId,
      stepId: planStepUuid,
      jsonMetadataDetected: true,
    };

    const context: Record<string, unknown> = {
      jobId: "test-job",
      runId,
      agentId: agent,
      role: "analysis",
      timeoutSeconds: 1800,
      workdir: "/tmp",
      model: "default",
    };

    try {
      // Must not throw — the swallowed-error path exists by design,
      // but the recovery branch must run before returning.
      await autoCompleteStepIfRunning(context, metadata);

      const step = db.prepare(
        "SELECT status, retry_count, output FROM steps WHERE id = ?"
      ).get(planStepUuid) as { status: string; retry_count: number; output: string | null };

      assert.equal(step.status, "pending", "wedged plan step must be reset to pending");
      assert.equal(step.retry_count, 1, "retry_count must be bumped so on_fail policy fires");
      assert.ok(step.output, "step.output must be populated so retry_feedback surfaces the failure");
      assert.match(
        step.output ?? "",
        /STORIES_JSON|could not be auto-completed/i,
        "step.output should describe the parse failure",
      );

      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "running", "run should remain running so retry can proceed");

      // The retried planner must see the failure detail as RETRY FEEDBACK.
      // claimStep populates context.retry_feedback from step.output when
      // retry_count > 0, then resolves it into the input template — verify
      // the contract end-to-end by claiming and inspecting resolvedInput.
      const claim = claimStep(agent, runId);
      assert.ok(claim.found, "step must be re-claimable after recovery");
      assert.ok(claim.resolvedInput, "resolved input must be present");
      assert.match(
        claim.resolvedInput ?? "",
        /RETRY FEEDBACK:[\s\S]*(STORIES_JSON|could not be auto-completed)/i,
        "next planner attempt must see the parse failure under RETRY FEEDBACK",
      );
    } finally {
      db.prepare("DELETE FROM steps WHERE id IN (?, ?)").run(planStepUuid, loopStepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// US-004: CLMR — Immediate dangling claim recovery on no_work rounds
// ══════════════════════════════════════════════════════════════════════

describe("US-004 CLMR: immediate recovery on no_work", () => {
  // AC 1: no_work round with dangling claim owned by this job → released
  it("recovers dangling claim when no_work round owns the step", () => {
    const db = getDb();
    const agent = "test_clmr-dangling-own";
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const workerJobId = "job-clmr-001";
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'implement feature', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // Simulate a CLTX-type failure: the claim UPDATE succeeded but the
    // agent never received the payload — step sits at running with a
    // claim_job_id from this worker.
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, claim_job_id, created_at, updated_at)
       VALUES (?, ?, 'dev-step', ?, 0, '', '', 'running', 0, 3, 'single', ?, ?, ?)`
    ).run(stepUuid, runId, agent, workerJobId, now, now);

    try {
      // Simulate what executeDispatchRound does on no_work outcome:
      // recoverOrphanedStepsForAgent with staleThresholdMs=0 and workerJobId
      const result = recoverOrphanedStepsForAgent(agent, runId, 0, undefined, undefined, workerJobId);

      assert.equal(result.recovered, 1, "should recover 1 dangling step");
      assert.equal(result.failed, 0, "should not fail any steps");

      // Step is reset to pending (claim_job_id is not cleared by the
      // recovery code; that's existing sweeper behavior)
      const step = db.prepare(
        "SELECT status, retry_count FROM steps WHERE id = ?"
      ).get(stepUuid) as { status: string; retry_count: number };
      assert.equal(step.status, "pending", "step should be reset to pending");
      assert.equal(step.retry_count, 1, "retry_count should be bumped to 1");

      // Run should still be running
      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "running");

      // step.worker_lost event emitted
      const events = getRunEvents(runId);
      const workerLostEvents = events.filter((e) => e.event === "step.worker_lost");
      assert.equal(workerLostEvents.length, 1, "should emit exactly 1 step.worker_lost event");
      assert.match(
        workerLostEvents[0].detail as string,
        new RegExp(`Worker ${workerJobId} exited`),
        "event detail must mention the worker job id",
      );
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // AC 2: Dangling claim for a DIFFERENT job's step is NOT touched
  it("does NOT touch steps claimed by a different worker", () => {
    const db = getDb();
    const agent = "test_clmr-dangling-other";
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const otherWorkerJobId = "job-clmr-other-worker";
    const thisWorkerJobId = "job-clmr-this-worker";
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'implement feature', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // Step claimed by a DIFFERENT worker
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, claim_job_id, created_at, updated_at)
       VALUES (?, ?, 'dev-step', ?, 0, '', '', 'running', 0, 3, 'single', ?, ?, ?)`
    ).run(stepUuid, runId, agent, otherWorkerJobId, now, now);

    try {
      // Recover with a DIFFERENT workerJobId — should skip this step
      const result = recoverOrphanedStepsForAgent(agent, runId, 0, undefined, undefined, thisWorkerJobId);

      assert.equal(result.recovered, 0, "should recover 0 steps (different worker)");
      assert.equal(result.skipped, 0, "should skip 0 steps");

      // Step is still running, untouched
      const step = db.prepare(
        "SELECT status, retry_count, claim_job_id FROM steps WHERE id = ?"
      ).get(stepUuid) as { status: string; retry_count: number; claim_job_id: string | null };
      assert.equal(step.status, "running", "step from other worker must remain running");
      assert.equal(step.retry_count, 0, "retry_count must be unchanged");
      assert.equal(step.claim_job_id, otherWorkerJobId, "claim_job_id must be unchanged");
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // AC 3: Healthy round (no dangling step) — no-op, no events
  it("is a no-op when no dangling claims exist (healthy round)", () => {
    const db = getDb();
    const agent = "test_clmr-healthy";
    const runId = crypto.randomUUID();
    const workerJobId = "job-clmr-healthy";
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'implement feature', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    try {
      const result = recoverOrphanedStepsForAgent(agent, runId, 0, undefined, undefined, workerJobId);

      assert.equal(result.recovered, 0, "should recover 0 steps (nothing dangling)");
      assert.equal(result.failed, 0, "should fail 0 steps");
      assert.equal(result.skipped, 0, "should skip 0 steps");

      // No worker_lost events (nothing to recover)
      const events = getRunEvents(runId);
      const workerLostEvents = events.filter((e) => e.event === "step.worker_lost");
      assert.equal(workerLostEvents.length, 0, "should NOT emit step.worker_lost for healthy round");
    } finally {
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // AC 4: Story-level recovery with workerJobId → step.worker_lost event
  it("emits step.worker_lost (not step.timeout) for story-level recovery on no_work", () => {
    const db = getDb();
    const agent = "test_clmr-story-no-work";
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const storyUuid = crypto.randomUUID();
    const workerJobId = "job-clmr-story";
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'implement feature', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // Loop step with a story in progress
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, current_story_id, loop_config, claim_job_id, created_at, updated_at)
       VALUES (?, ?, 'dev-loop', ?, 0, '', '', 'running', 0, 3, 'loop', ?, '{}', ?, ?, ?)`
    ).run(stepUuid, runId, agent, storyUuid, workerJobId, now, now);

    db.prepare(
      `INSERT INTO stories (id, run_id, story_id, story_index, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at)
       VALUES (?, ?, 'US-004', 1, 'CLMR story', 'desc', 'ac', 'running', 0, 3, ?, ?)`
    ).run(storyUuid, runId, now, now);

    try {
      const result = recoverOrphanedStepsForAgent(agent, runId, 0, undefined, undefined, workerJobId);

      assert.equal(result.recovered, 1, "should recover 1 story");

      // Story is reset to pending, abandon_count incremented
      const story = db.prepare(
        "SELECT status, abandoned_count FROM stories WHERE id = ?"
      ).get(storyUuid) as { status: string; abandoned_count: number };
      assert.equal(story.status, "pending", "story should be reset to pending");
      assert.equal(story.abandoned_count, 1, "abandoned_count should be bumped");

      const events = getRunEvents(runId);
      const workerLostEvents = events.filter((e) => e.event === "step.worker_lost");
      assert.equal(workerLostEvents.length, 1, "should emit step.worker_lost for story recovery");
      assert.match(
        workerLostEvents[0].detail as string,
        /Worker.*exited without completing story/,
        "detail should indicate worker exited",
      );
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM stories WHERE id = ?").run(storyUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // AC 5: no_work with no stale threshold still matches (staleThresholdMs=0)
  it("matches immediately with staleThresholdMs=0 (no waiting)", () => {
    const db = getDb();
    const agent = "test_clmr-no-wait";
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const workerJobId = "job-clmr-nowait";
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'implement feature', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // Step just claimed — updated_at is now (very fresh)
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, claim_job_id, created_at, updated_at)
       VALUES (?, ?, 'dev-step', ?, 0, '', '', 'running', 0, 3, 'single', ?, ?, ?)`
    ).run(stepUuid, runId, agent, workerJobId, now, now);

    try {
      // staleThresholdMs=0 means the step must be recovered even though
      // updated_at is essentially now — zero wait, immediate release.
      const result = recoverOrphanedStepsForAgent(agent, runId, 0, undefined, undefined, workerJobId);

      assert.equal(result.recovered, 1, "fresh step must be recovered with staleThresholdMs=0");

      const step = db.prepare(
        "SELECT status, retry_count FROM steps WHERE id = ?"
      ).get(stepUuid) as { status: string; retry_count: number };
      assert.equal(step.status, "pending", "fresh step must be reset to pending immediately");
      assert.equal(step.retry_count, 1, "retry_count must be bumped");
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // AC 6: Abandon budget tracking — each no_work recovery increments abandon
  it("increments abandon_count on each no_work story recovery", () => {
    const db = getDb();
    const agent = "test_clmr-abandon-budget";
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const storyUuid = crypto.randomUUID();
    const workerJobId = "job-clmr-abandon";
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'implement feature', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, current_story_id, loop_config, claim_job_id, created_at, updated_at)
       VALUES (?, ?, 'dev-loop', ?, 0, '', '', 'running', 0, 3, 'loop', ?, '{}', ?, ?, ?)`
    ).run(stepUuid, runId, agent, storyUuid, workerJobId, now, now);

    db.prepare(
      `INSERT INTO stories (id, run_id, story_id, story_index, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at)
       VALUES (?, ?, 'US-004', 1, 'CLMR story', 'desc', 'ac', 'running', 0, 3, ?, ?)`
    ).run(storyUuid, runId, now, now);

    try {
      // First no_work recovery → abandon_count = 1
      let result = recoverOrphanedStepsForAgent(agent, runId, 0, undefined, undefined, workerJobId);
      assert.equal(result.recovered, 1);

      let story = db.prepare(
        "SELECT status, abandoned_count FROM stories WHERE id = ?"
      ).get(storyUuid) as { status: string; abandoned_count: number };
      assert.equal(story.status, "pending");
      assert.equal(story.abandoned_count, 1);

      // Re-claim the story (set it running again with same claim_job_id)
      db.prepare(
        "UPDATE steps SET status = 'running', current_story_id = ?, claim_job_id = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(storyUuid, workerJobId, stepUuid);
      db.prepare(
        "UPDATE stories SET status = 'running', updated_at = datetime('now') WHERE id = ?"
      ).run(storyUuid);

      // Second no_work recovery → abandon_count = 2
      result = recoverOrphanedStepsForAgent(agent, runId, 0, undefined, undefined, workerJobId);
      assert.equal(result.recovered, 1);

      story = db.prepare(
        "SELECT status, abandoned_count FROM stories WHERE id = ?"
      ).get(storyUuid) as { status: string; abandoned_count: number };
      assert.equal(story.status, "pending");
      assert.equal(story.abandoned_count, 2);
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM stories WHERE id = ?").run(storyUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });
});
});
