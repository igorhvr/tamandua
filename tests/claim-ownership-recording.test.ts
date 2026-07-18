/**
 * US-002: Record worker ownership metadata when claiming a step
 *
 * Validates:
 * 1. claimStep() accepts optional WorkerOwnership parameter without
 *    breaking existing callers (no WorkerOwnership → columns NULL)
 * 2. Single-step claim records claim_job_id, claim_pid, claim_updated_at
 * 3. Loop step story claim also populates ownership columns
 * 4. claim_pgid is optional — recorded when provided, NULL when omitted
 * 5. Backward compatible: omitting workerOwnership leaves columns NULL
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { createTempHome } from "./helpers/test-env.ts";
import { claimStep } from "../dist/installer/step-ops.js";
import type { WorkerOwnership } from "../dist/installer/step-ops.js";
import { getDb } from "../dist/db.js";

// ── Environment isolation ──────────────────────────────────────────────
// createTempHome sets up an isolated temp home with automatic after() cleanup.

describe("claim-ownership-recording", () => {
  const { tamanduaDir } = createTempHome("tamandua-claim-ownership-");
  process.env.TAMANDUA_STATE_DIR = tamanduaDir;
  process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");

const TEST_AGENT = "test_claim-ownership-agent";
const TEST_LOOP_AGENT = "test_claim-ownership-loop-agent";

function ts(): string {
  return new Date().toISOString();
}

interface StepRow {
  id: string;
  claim_job_id: string | null;
  claim_pid: number | null;
  claim_pgid: number | null;
  claim_updated_at: string | null;
  status: string;
}

function queryStep(stepId: string): StepRow {
  const db = getDb();
  const row = db.prepare(
    "SELECT id, claim_job_id, claim_pid, claim_pgid, claim_updated_at, status FROM steps WHERE id = ?"
  ).get(stepId) as StepRow | undefined;
  if (!row) throw new Error(`Step not found: ${stepId}`);
  return row;
}

describe("claimStep ownership recording", () => {
  let singleRunId: string;
  let singleStepId: string;

  let loopRunId: string;
  let loopStepId: string;

  let legacyRunId: string;
  let legacyStepId: string;

  let withPgidRunId: string;
  let withPgidStepId: string;

  before(() => {
    const db = getDb();
    const now = ts();

    // ── Single-step claim test ──
    singleRunId = crypto.randomUUID();
    singleStepId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'test', 'running', '{}', ?, ?)"
    ).run(singleRunId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'single-step', ?, 0, 'test', 'STATUS: done', 'pending', 0, 2, 'single', ?, ?)`
    ).run(singleStepId, singleRunId, TEST_AGENT, now, now);

    // ── Loop-step story claim test ──
    loopRunId = crypto.randomUUID();
    loopStepId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'test loop', 'running', '{}', ?, ?)"
    ).run(loopRunId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, loop_config, created_at, updated_at)
       VALUES (?, ?, 'loop-step', ?, 0, 'test', 'STATUS: done', 'pending', 0, 2, 'loop',
        '{"over":"stories"}', ?, ?)`
    ).run(loopStepId, loopRunId, TEST_LOOP_AGENT, now, now);

    // Pre-create stories for the loop step so the claim succeeds
    const storyId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at)
       VALUES (?, ?, 0, 'US-001', 'Test Story', 'A test story', '["Works"]', 'pending', 0, 4, ?, ?)`
    ).run(storyId, loopRunId, now, now);

    // ── Legacy / backward-compat test (no WorkerOwnership) ──
    legacyRunId = crypto.randomUUID();
    legacyStepId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'legacy', 'running', '{}', ?, ?)"
    ).run(legacyRunId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'legacy-step', ?, 0, 'test', 'STATUS: done', 'pending', 0, 2, 'single', ?, ?)`
    ).run(legacyStepId, legacyRunId, TEST_AGENT, now, now);

    // ── With pgid test ──
    withPgidRunId = crypto.randomUUID();
    withPgidStepId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'with pgid', 'running', '{}', ?, ?)"
    ).run(withPgidRunId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'pgid-step', ?, 0, 'test', 'STATUS: done', 'pending', 0, 2, 'single', ?, ?)`
    ).run(withPgidStepId, withPgidRunId, TEST_AGENT, now, now);
  });

  // ── Test 1: Ownership recording on single-step claim ──────────────────
  it("records worker ownership metadata when claiming a single step", () => {
    const ownership: WorkerOwnership = {
      jobId: "tamandua-test-123",
      pid: 12345,
    };

    const result = claimStep(TEST_AGENT, singleRunId, ownership);
    assert.ok(result.found, "should claim the step");
    assert.equal(result.stepId, singleStepId);

    const step = queryStep(singleStepId);
    assert.equal(step.status, "running");
    assert.equal(step.claim_job_id, "tamandua-test-123");
    assert.equal(step.claim_pid, 12345);
    assert.equal(step.claim_pgid, null, "pgid should be null when not provided");
    assert.ok(step.claim_updated_at, "claim_updated_at should be set");
  });

  // ── Test 2: Ownership recording on loop-step story claim ──────────────
  it("records worker ownership metadata on loop step story claim", () => {
    const ownership: WorkerOwnership = {
      jobId: "tamandua-loop-test-456",
      pid: 99999,
    };

    const result = claimStep(TEST_LOOP_AGENT, loopRunId, ownership);
    assert.ok(result.found, "should claim the loop step with story");
    assert.equal(result.stepId, loopStepId);

    const step = queryStep(loopStepId);
    assert.equal(step.status, "running");
    assert.equal(step.claim_job_id, "tamandua-loop-test-456");
    assert.equal(step.claim_pid, 99999);
    assert.equal(step.claim_pgid, null);
    assert.ok(step.claim_updated_at, "claim_updated_at should be set on loop claim");
  });

  // ── Test 3: Backward compat — no WorkerOwnership leaves columns NULL ──
  it("leaves ownership columns NULL when WorkerOwnership is omitted (backward compat)", () => {
    const result = claimStep(TEST_AGENT, legacyRunId);
    assert.ok(result.found, "should claim the legacy step without ownership");

    const step = queryStep(legacyStepId);
    assert.equal(step.status, "running");
    assert.equal(step.claim_job_id, null);
    assert.equal(step.claim_pid, null);
    assert.equal(step.claim_pgid, null);
    assert.equal(step.claim_updated_at, null);
  });

  // ── Test 4: pgid is recorded when provided ────────────────────────────
  it("records claim_pgid when provided in WorkerOwnership", () => {
    const ownership: WorkerOwnership = {
      jobId: "tamandua-test-pgid-789",
      pid: 42,
      pgid: 99,
    };

    const result = claimStep(TEST_AGENT, withPgidRunId, ownership);
    assert.ok(result.found, "should claim the step with pgid");
    assert.equal(result.stepId, withPgidStepId);

    const step = queryStep(withPgidStepId);
    assert.equal(step.status, "running");
    assert.equal(step.claim_job_id, "tamandua-test-pgid-789");
    assert.equal(step.claim_pid, 42);
    assert.equal(step.claim_pgid, 99);
    assert.ok(step.claim_updated_at, "claim_updated_at should be set");
  });

  // ── Test 5: Called without WorkerOwnership (2-arg form) still works ──
  it("claimStep called with 2 args (no WorkerOwnership) does not error", () => {
    // The legacy test above already covers this, but let's explicitly
    // verify the call signature is backward-compatible
    const ownership: WorkerOwnership = {
      jobId: "tamandua-another-000",
      pid: 1,
    };

    // With ownership works — idempotent re-claim returns the held step
    const r1 = claimStep(TEST_AGENT, singleRunId, ownership);
    assert.equal(r1.found, true, "re-claim should return the already-held step");
    assert.equal(r1.stepId, singleStepId, "re-claim should return same stepId");

    // Without ownership works — idempotent re-claim returns the held legacy step
    const r2 = claimStep(TEST_AGENT, legacyRunId);
    assert.equal(r2.found, true, "re-claim should return the already-held legacy step");
    assert.equal(r2.stepId, legacyStepId, "re-claim should return same legacy stepId");
  });
});
});
