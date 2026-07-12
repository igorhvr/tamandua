// tests/reroute-paths.test.ts
// Comprehensive unit tests for RETR (Retry Routing) across all exhaustion paths.
// Covers edge cases not covered by the main step-ops test suite:
//   - rugpull path intact after budget exhaustion
//   - retry_feedback truncation at 200-char boundary
//   - claim ownership fields cleared on consumer reset
//   - invalid target rejection in completeStep and orphan-recovery paths

//   - first-step self-reference (no upstream) is rejected

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  failStep,
  completeStep,
  claimStep,
  advancePipeline,
  recoverOrphanedStepsForAgent,
} from "../dist/installer/step-ops.js";
import { getRunEvents } from "../dist/installer/events.js";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import crypto from "node:crypto";

// ══════════════════════════════════════════════════════════════════════
// Workflow YAML fixtures
// ══════════════════════════════════════════════════════════════════════

// Standard two-step workflow: produce (idx 0) → consume (idx 1)
// consume declares on_fail.retry_step: produce
const rerouteWorkflowYaml = `
id: test-reroute-paths
agents:
  - id: producer
    workspace:
      baseDir: .
      files: {}
  - id: consumer
    workspace:
      baseDir: .
      files: {}
steps:
  - id: produce
    agent: producer
    input: "Produce output"
    expects: "STATUS: done"
    max_retries: 3
  - id: consume
    agent: consumer
    input: "Consume {{output}}"
    expects: "STATUS: done"
    max_retries: 2
    on_fail:
      retry_step: produce
`;

// Three-step workflow with intermediate step: a (0) → b (1) → c (2).
// c declares retry_step: a — reroute must skip over b.
const threeStepsYaml = `
id: test-reroute-three
agents:
  - id: a1
    workspace:
      baseDir: .
      files: {}
  - id: a2
    workspace:
      baseDir: .
      files: {}
steps:
  - id: produce
    agent: a1
    input: "Produce"
    expects: "STATUS: done"
    max_retries: 3
  - id: middle
    agent: a2
    input: "Middle"
    expects: "STATUS: done"
    max_retries: 3
  - id: consume
    agent: a2
    input: "Consume"
    expects: "STATUS: done"
    max_retries: 2
    on_fail:
      retry_step: produce
`;

// Consumer target is downstream (step_index higher than consumer) — invalid
const downstreamTargetYaml = `
id: test-reroute-downstream
agents:
  - id: a1
    workspace:
      baseDir: .
      files: {}
steps:
  - id: step_a
    agent: a1
    input: "A"
    expects: "STATUS: done"
    max_retries: 3
  - id: step_b
    agent: a1
    input: "B"
    expects: "STATUS: done"
    max_retries: 3
    on_fail:
      retry_step: step_c
  - id: step_c
    agent: a1
    input: "C"
    expects: "STATUS: done"
    max_retries: 3
`;

// First step (idx 0) targets itself — no upstream step exists, invalid
const firstStepSelfRefYaml = `
id: test-reroute-first-step
agents:
  - id: a1
    workspace:
      baseDir: .
      files: {}
steps:
  - id: step1
    agent: a1
    input: "Step 1"
    expects: "STATUS: done"
    max_retries: 2
    on_fail:
      retry_step: step1
`;

// Loop-over-stories workflow: develop (idx 0, loop) → verify (idx 1) → merge (idx 2).
// merge declares on_fail.retry_step: develop — reroute targets a loop step.
const loopRerouteWorkflowYaml = `
id: test-reroute-loop
agents:
  - id: dev
    workspace:
      baseDir: .
      files: {}
  - id: verifier
    workspace:
      baseDir: .
      files: {}
  - id: merger
    workspace:
      baseDir: .
      files: {}
steps:
  - id: develop
    agent: dev
    type: loop
    loop:
      over: stories
      completion: all_done
    input: "Develop story"
    expects: "STATUS: done"
    max_retries: 4
  - id: verify
    agent: verifier
    input: "Verify"
    expects: "STATUS: done"
    max_retries: 3
  - id: merge
    agent: merger
    input: "Merge"
    expects: "STATUS: done"
    max_retries: 2
    on_fail:
      retry_step: develop
`;

// ══════════════════════════════════════════════════════════════════════
// Test suite
// ══════════════════════════════════════════════════════════════════════

describe("RETR: Comprehensive Reroute Paths", () => {
  let _savedStateDir: string | undefined;
  let _savedDbPath: string | undefined;
  let _isolationDir: string;
  let _workflowsDir: string;

  before(() => {
    _savedStateDir = process.env.TAMANDUA_STATE_DIR;
    _savedDbPath = process.env.TAMANDUA_DB_PATH;
    _isolationDir = tamanduaTempDir("tamandua-reroute-paths-");
    process.env.TAMANDUA_STATE_DIR = _isolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_isolationDir, "tamandua.db");

    // Create workflow dirs
    _workflowsDir = path.join(_isolationDir, "workflows");
    const workflows = {
      "test-reroute-paths": rerouteWorkflowYaml,
      "test-reroute-three": threeStepsYaml,
      "test-reroute-downstream": downstreamTargetYaml,
      "test-reroute-first-step": firstStepSelfRefYaml,
      "test-reroute-loop": loopRerouteWorkflowYaml,
    };
    for (const [id, yml] of Object.entries(workflows)) {
      const dir = path.join(_workflowsDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "workflow.yml"), yml);
    }
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_isolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  async function getTestDb() {
    return (await import("../dist/db.js")).getDb();
  }

  /**
   * Insert a run with its steps. Returns runId and per-step { rowId, step_id }.
   */
  function insertRunAndSteps(
    db: ReturnType<typeof import("../dist/db.js").getDb>,
    workflowId: string,
    stepsData: Array<{
      step_id: string;
      agent_id: string;
      step_index: number;
      status: string;
      retry_count: number;
      max_retries: number;
      input_template: string;
      expects: string;
      type?: string;
      loop_config?: string | null;
      output?: string;
      claim_job_id?: string | null;
      claim_pid?: number | null;
      claim_pgid?: number | null;
      claim_invalidated_by?: string | null;
    }>,
  ): { runId: string; stepRows: Array<{ rowId: string; step_id: string }> } {
    const runId = crypto.randomUUID();
    const now = ts();
    const seededContext = JSON.stringify({ task: "test task", repo: "/tmp/repo", branch: "test-branch" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, ?, 'test task', 'running', ?, 0, ?, ?)"
    ).run(runId, workflowId, seededContext, now, now);

    const stepRows: Array<{ rowId: string; step_id: string }> = [];
    for (const sd of stepsData) {
      const rowId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
         status, retry_count, max_retries, type, loop_config, output, claim_job_id, claim_pid, claim_pgid,
         claim_invalidated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        rowId, runId, sd.step_id, sd.agent_id, sd.step_index, sd.input_template,
        sd.expects, sd.status, sd.retry_count, sd.max_retries,
        sd.type ?? "single", sd.loop_config ?? null, sd.output ?? null,
        sd.claim_job_id ?? null, sd.claim_pid ?? null, sd.claim_pgid ?? null,
        sd.claim_invalidated_by ?? null,
        now, now,
      );
      stepRows.push({ rowId, step_id: sd.step_id });
    }

    return { runId, stepRows };
  }

  /**
   * Insert stories into the stories table for loop-over-stories reroute tests.
   */
  function insertStories(
    db: ReturnType<typeof import("../dist/db.js").getDb>,
    runId: string,
    stories: Array<{
      story_id: string;
      title: string;
      status: string;
      retry_count?: number;
      max_retries?: number;
      story_index?: number;
    }>,
  ): void {
    const now = ts();
    for (let i = 0; i < stories.length; i++) {
      const s = stories[i];
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria,
         status, retry_count, max_retries, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', '[]', ?, ?, ?, ?, ?)`
      ).run(
        id, runId, s.story_index ?? i, s.story_id, s.title,
        s.status, s.retry_count ?? 0, s.max_retries ?? 4,
        now, now,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Gap 1: retry_feedback truncation at 200-char boundary
  // ────────────────────────────────────────────────────────────────

  describe("retry_feedback truncation", () => {
    it("truncates error messages longer than 200 chars in producer feedback", async () => {
      const db = await getTestDb();
      // Build an error string longer than 200 chars
      const longPrefix = "A".repeat(190);
      const longError = `${longPrefix} and then some extra text that makes it way over 200 characters total`;

      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      const result = await failStep(consumerRowId, longError);
      assert.equal(result.status, "rerouted");

      // Producer output must contain truncated feedback (≤ 200 chars from error + metadata)
      const producer = db.prepare("SELECT output FROM steps WHERE id = ?").get(producerRowId) as { output: string | null };
      assert.ok(producer.output, "producer must have output");
      // The full feedback includes metadata like 'Reroute from "consume" (reroute 1/2). Consumer failure: '
      // The error part should be truncated with "..."
      assert.ok(producer.output!.includes("..."), `expect truncation ellipsis, got: ${producer.output!.slice(0, 100)}`);
      // The original long error should NOT appear in full
      assert.ok(!producer.output!.includes(longError), "full long error must NOT appear in feedback");
      // The truncation should preserve at least 197 chars of the original error
      assert.ok(producer.output!.includes(longPrefix), `truncated output should contain the first 190 chars prefix, got: ${producer.output!.slice(0, 300)}`);
    });

    it("does NOT truncate error messages under 200 chars", async () => {
      const db = await getTestDb();
      const shortError = "Consumer failed: invalid output format";

      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      const result = await failStep(consumerRowId, shortError);
      assert.equal(result.status, "rerouted");

      const producer = db.prepare("SELECT output FROM steps WHERE id = ?").get(producerRowId) as { output: string | null };
      assert.ok(producer.output, "producer must have output");
      // Short error should appear in full (no truncation)
      assert.ok(producer.output!.includes(shortError), `short error should appear in full, got: ${producer.output}`);
      // ... is part of the full Reroute messaging, not the error
      // The error itself should be intact
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Gap 2: claim ownership fields cleared on consumer reset
  // ────────────────────────────────────────────────────────────────

  describe("claim ownership reset on consumer", () => {
    it("clears claim_job_id, claim_pid, and claim_pgid when consumer is reset to waiting", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        // Consumer claimed by a worker (has claim ownership), at retry exhaustion
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done", claim_job_id: "job-123", claim_pid: 9999, claim_pgid: 9998 },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;

      // Verify claim ownership is set before reroute
      const before = db.prepare("SELECT claim_job_id, claim_pid, claim_pgid FROM steps WHERE id = ?").get(consumerRowId) as { claim_job_id: string | null; claim_pid: number | null; claim_pgid: number | null };
      assert.equal(before.claim_job_id, "job-123");
      assert.equal(before.claim_pid, 9999);
      assert.equal(before.claim_pgid, 9998);

      const result = await failStep(consumerRowId, "Consumer crash");
      assert.equal(result.status, "rerouted");

      // After reroute, claim ownership must be cleared
      const after = db.prepare("SELECT status, retry_count, claim_job_id, claim_pid, claim_pgid FROM steps WHERE id = ?").get(consumerRowId) as { status: string; retry_count: number; claim_job_id: string | null; claim_pid: number | null; claim_pgid: number | null };
      assert.equal(after.status, "waiting");
      assert.equal(after.retry_count, 0);
      assert.equal(after.claim_job_id, null, "claim_job_id must be null after reset");
      assert.equal(after.claim_pid, null, "claim_pid must be null after reset");
      assert.equal(after.claim_pgid, null, "claim_pgid must be null after reset");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Gap 4: invalid retry_step in completeStep expects-validation path
  // ────────────────────────────────────────────────────────────────

  describe("completeStep expects-validation invalid target", () => {
    it("rejects downstream retry_step target in completeStep expectations path", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-downstream", [
        { step_id: "step_a", agent_id: "a1", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "A", expects: "STATUS: done", output: "STATUS: done" },
        // step_b targets step_c (idx 2) which is downstream from step_b (idx 1) — invalid
        { step_id: "step_b", agent_id: "a1", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "B", expects: "STATUS: done", type: "single" },
        { step_id: "step_c", agent_id: "a1", step_index: 2, status: "waiting", retry_count: 0, max_retries: 3, input_template: "C", expects: "STATUS: done" },
      ]);

      const stepBRowId = stepRows.find(s => s.step_id === "step_b")!.rowId;

      // completeStep with invalid output → expects validation fails → retries exhausted → reroute → invalid target
      const result = completeStep(stepBRowId, "bad output without STATUS line");
      assert.equal(result.status, "failed", "should fail on invalid retry_step target, got: " + JSON.stringify(result));

      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "failed", "run should be failed");

      // Step must be failed (the invalid_target error is logged, not written to output)
      const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepBRowId) as { status: string };
      assert.equal(step.status, "failed", "step must be failed");

      // No reroute events (invalid target rejected the reroute)
      const events = getRunEvents(runId);
      const rerouteEvents = events.filter(e => e.event === "step.rerouted");
      assert.equal(rerouteEvents.length, 0, "no reroute events for invalid target");

      // run.failed event fires
      const runFailedEvents = events.filter(e => e.event === "run.failed");
      assert.equal(runFailedEvents.length, 1, "run.failed must fire");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Gap 5: invalid retry_step in orphan-recovery path
  // ────────────────────────────────────────────────────────────────

  describe("orphan-recovery invalid target", () => {
    it("rejects downstream retry_step target in orphan-recovery path", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-downstream", [
        { step_id: "step_a", agent_id: "a1", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "A", expects: "STATUS: done", output: "STATUS: done" },
        // step_b targets step_c which is downstream — invalid
        { step_id: "step_b", agent_id: "a1", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "B", expects: "STATUS: done", type: "single" },
        { step_id: "step_c", agent_id: "a1", step_index: 2, status: "waiting", retry_count: 0, max_retries: 3, input_template: "C", expects: "STATUS: done" },
      ]);

      // Orphan recovery for agent "a1": step_b is running with exhausted retries.
      // retry_step points to downstream step_c → invalid → should fail (not recover).
      const result = recoverOrphanedStepsForAgent("a1", runId);

      assert.equal(result.failed, 1, `step should be failed on invalid target, got failed=${result.failed}`);
      assert.equal(result.recovered, 0, `no steps should be recovered, got recovered=${result.recovered}`);

      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "failed", "run should be failed");

      // Step must be failed (invalid_target error is logged, output is the generic orphan failure message)
      const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepRows[1].rowId) as { status: string };
      assert.equal(step.status, "failed", "step must be failed");

      // No reroute events (invalid target rejected the reroute)
      const events = getRunEvents(runId);
      const rerouteEvents = events.filter(e => e.event === "step.rerouted");
      assert.equal(rerouteEvents.length, 0, "no reroute events for invalid target");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Gap 6: first-step self-reference (no upstream) is rejected
  // ────────────────────────────────────────────────────────────────

  describe("first-step self-reference", () => {
    it("rejects retry_step pointing to itself (first step, no upstream)", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-first-step", [
        // step1 is the only step (idx 0) and targets itself — invalid
        { step_id: "step1", agent_id: "a1", step_index: 0, status: "running", retry_count: 2, max_retries: 2, input_template: "Step 1", expects: "STATUS: done" },
      ]);

      const stepRowId = stepRows.find(s => s.step_id === "step1")!.rowId;

      const result = await failStep(stepRowId, "Self-referencing step failed");
      assert.equal(result.status, "failed", "should fail on self-reference (no upstream)");

      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "failed");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Gap 7: rugpull path intact after budget exhaustion
  // ────────────────────────────────────────────────────────────────

  describe("rugpull path intact after budget exhaustion", () => {
    it("runs the full failure path (step.failed, run.failed, step.reroute_budget_exhausted) after budget exhaustion", async () => {
      // This test proves that after reroute budget exhaustion, the normal failure
      // path runs correctly — including step.failed/run.failed events
      // and the rugpull setImmediate block (which we verify
      // indirectly by checking the run's terminal state and events).
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;

      // Set reroute_count to budget (2) — budget exhausted
      db.prepare("UPDATE steps SET reroute_count = 2 WHERE id = ?").run(consumerRowId);

      const result = await failStep(consumerRowId, "Final consumer failure after all reroutes");
      assert.equal(result.status, "failed", "should fail when reroute budget exhausted");

      // Run must be failed
      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "failed", "run should be failed");

      // Consumer must be failed
      const consumer = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(consumerRowId) as { status: string; retry_count: number };
      assert.equal(consumer.status, "failed", "consumer step should be failed");
      assert.equal(consumer.retry_count, 3, "consumer retry_count should be incremented (2+1=3)");

      // Events: step.failed, run.failed, step.reroute_budget_exhausted
      const events = getRunEvents(runId);

      const failedEvents = events.filter(e => e.event === "step.failed");
      assert.equal(failedEvents.length, 1, "step.failed event must be emitted");

      const runFailedEvents = events.filter(e => e.event === "run.failed");
      assert.equal(runFailedEvents.length, 1, "run.failed event must be emitted");

      // No step.escalation events (escalation concept removed)
      const escalationEvents = events.filter(e => e.event === "step.escalation");
      assert.equal(escalationEvents.length, 0, "step.escalation must NOT be emitted");

      const budgetEvents = events.filter(e => e.event === "step.reroute_budget_exhausted");
      assert.equal(budgetEvents.length, 1, "step.reroute_budget_exhausted must be emitted");

      // No step.rerouted events (budget was already exhausted)
      const rerouteEvents = events.filter(e => e.event === "step.rerouted");
      assert.equal(rerouteEvents.length, 0, "no reroute events when budget exhausted");
    });

    it("rugpull setImmediate path is reachable after budget exhaustion (run terminal state is correct)", async () => {
      // The rugpull detection runs in a fire-and-forget setImmediate.
      // We can't directly test it without a real git repo, but we CAN verify
      // that the terminal state after budget exhaustion is correct:
      // - run is failed
      // - cron teardown is scheduled (verified by run status)
      // - step output contains the error
      //
      // This confirms the failure path (which includes the rugpull block)
      // is correctly reached and does not throw.

      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;

      // Budget exhausted for this test
      db.prepare("UPDATE steps SET reroute_count = 2 WHERE id = ?").run(consumerRowId);

      const result = await failStep(consumerRowId, "Terminal failure");
      assert.equal(result.status, "failed");

      // Run terminal state
      const run = db.prepare("SELECT status, updated_at FROM runs WHERE id = ?").get(runId) as { status: string; updated_at: string };
      assert.equal(run.status, "failed");
      assert.ok(run.updated_at, "run should have updated_at set");

      // Step terminal state
      const step = db.prepare("SELECT status, output, retry_count FROM steps WHERE id = ?").get(consumerRowId) as { status: string; output: string | null; retry_count: number };
      assert.equal(step.status, "failed");
      assert.equal(step.retry_count, 3, "retry_count should be final exhausted value (2+1)");
      assert.ok(step.output?.includes("Terminal failure"), `step output should contain error, got: ${step.output}`);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Gap 8: completeStep with no retry_step (just max_retries exhaustion)
  // ────────────────────────────────────────────────────────────────

  describe("completeStep expects fallback to normal failure", () => {
    it("falls through to normal run failure when no retry_step declared and expects validation fails at max_retries", async () => {
      // Use produce step (idx 0) which has no on_fail declared
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "running", retry_count: 3, max_retries: 3, input_template: "Produce", expects: "STATUS: done", type: "single" },
      ]);

      const stepRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      const result = completeStep(stepRowId, "no STATUS marker here");
      // produce has no on_fail block → no retry_step → normal failure
      assert.equal(result.status, "failed", "should fail normally when no retry_step, got: " + JSON.stringify(result));

      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "failed", "run should be failed");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Gap 9: consumer output cleared and reset to null on reroute
  // ────────────────────────────────────────────────────────────────

  describe("consumer output cleared on reroute", () => {
    it("clears consumer output to null when resetting to waiting", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        // Consumer has a previous error output from earlier retries
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done", output: "Previous error output from earlier retry" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;

      const result = await failStep(consumerRowId, "New consumer failure");
      assert.equal(result.status, "rerouted");

      // Consumer output must be null (cleared)
      const consumer = db.prepare("SELECT output FROM steps WHERE id = ?").get(consumerRowId) as { output: string | null };
      assert.equal(consumer.output, null, "consumer output must be null after reset");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Gap 10: intermediate done steps untouched (3-step workflow)
  // ────────────────────────────────────────────────────────────────

  describe("3-step reroute preserves intermediate steps", () => {
    it("leaves done intermediate step untouched when rerouting over it", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-three", [
        { step_id: "produce", agent_id: "a1", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done\nDATA: initial" },
        { step_id: "middle", agent_id: "a2", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Middle", expects: "STATUS: done", output: "STATUS: done\nMIDDLE: processed" },
        { step_id: "consume", agent_id: "a2", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const middleRowId = stepRows.find(s => s.step_id === "middle")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      const result = await failStep(consumerRowId, "Consumer invalid");
      assert.equal(result.status, "rerouted");

      // Middle step untouched
      const middle = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(middleRowId) as { status: string; retry_count: number; output: string | null };
      assert.equal(middle.status, "done", "intermediate done step stays done");
      assert.equal(middle.retry_count, 0, "intermediate retry_count unchanged");
      assert.equal(middle.output, "STATUS: done\nMIDDLE: processed", "intermediate output preserved");

      // Producer re-pended
      const producer = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(producerRowId) as { status: string; retry_count: number };
      assert.equal(producer.status, "pending", "producer re-pended");
      assert.equal(producer.retry_count, 0, "producer retry_count unchanged");

      // Consumer reset
      const consumer = db.prepare("SELECT status, retry_count, reroute_count FROM steps WHERE id = ?").get(consumerRowId) as { status: string; retry_count: number; reroute_count: number };
      assert.equal(consumer.status, "waiting", "consumer reset to waiting");
      assert.equal(consumer.retry_count, 0, "consumer retry_count reset");
      assert.equal(consumer.reroute_count, 1, "consumer reroute_count incremented");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Gap 11: advancePipeline re-pends consumer after producer re-done
  // ────────────────────────────────────────────────────────────────

  describe("advancePipeline after reroute", () => {
    it("advances consumer from waiting to pending after rerouted producer completes", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done\nOUTPUT: val" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      // Trigger reroute
      const failResult = await failStep(consumerRowId, "Consumer failure");
      assert.equal(failResult.status, "rerouted");

      // Consumer waiting, producer pending
      assert.equal((db.prepare("SELECT status FROM steps WHERE id = ?").get(consumerRowId) as { status: string }).status, "waiting");
      assert.equal((db.prepare("SELECT status FROM steps WHERE id = ?").get(producerRowId) as { status: string }).status, "pending");

      // Producer re-completes
      db.prepare("UPDATE steps SET status = 'done', output = 'STATUS: done\nOUTPUT: new-value', updated_at = datetime('now') WHERE id = ?").run(producerRowId);

      // advancePipeline should make consumer pending
      const advResult = advancePipeline(runId);
      assert.equal(advResult.advanced, true, "advancePipeline should advance consumer to pending");

      const consumerAfter = db.prepare("SELECT status FROM steps WHERE id = ?").get(consumerRowId) as { status: string };
      assert.equal(consumerAfter.status, "pending", "consumer should now be pending");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // US-002: producer claim ownership cleared on reroute
  // ────────────────────────────────────────────────────────────────

  describe("producer claim ownership cleared on reroute", () => {
    it("clears producer claim_job_id, claim_pid, claim_pgid and sets claim_invalidated_by = 'reroute'", async () => {
      const db = await getTestDb();
      // Producer was previously claimed by a worker (has claim ownership)
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done\nDATA: old", claim_job_id: "job-xyz", claim_pid: 5555, claim_pgid: 5554 },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      // Verify producer claim ownership is set before reroute
      const before = db.prepare("SELECT claim_job_id, claim_pid, claim_pgid, claim_invalidated_by FROM steps WHERE id = ?").get(producerRowId) as { claim_job_id: string | null; claim_pid: number | null; claim_pgid: number | null; claim_invalidated_by: string | null };
      assert.equal(before.claim_job_id, "job-xyz");
      assert.equal(before.claim_pid, 5555);
      assert.equal(before.claim_pgid, 5554);
      assert.equal(before.claim_invalidated_by, null);

      const result = await failStep(consumerRowId, "Consumer failure from US-003");
      assert.equal(result.status, "rerouted");

      // After reroute, producer claim ownership must be cleared and claim_invalidated_by set to 'reroute'
      const after = db.prepare("SELECT status, output, claim_job_id, claim_pid, claim_pgid, claim_invalidated_by FROM steps WHERE id = ?").get(producerRowId) as { status: string; output: string | null; claim_job_id: string | null; claim_pid: number | null; claim_pgid: number | null; claim_invalidated_by: string | null };
      assert.equal(after.status, "pending", "producer should be pending");
      assert.ok(after.output, "producer should have feedback output");
      assert.ok(after.output!.includes("Consumer failure from US-003"), `output should contain failure text, got: ${after.output}`);
      assert.equal(after.claim_job_id, null, "producer claim_job_id must be null after reroute");
      assert.equal(after.claim_pid, null, "producer claim_pid must be null after reroute");
      assert.equal(after.claim_pgid, null, "producer claim_pgid must be null after reroute");
      assert.equal(after.claim_invalidated_by, "reroute", "producer claim_invalidated_by must be 'reroute'");
    });

    it("consumer claim ownership still cleared as before after reroute", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done", claim_job_id: "job-abc", claim_pid: 1234, claim_pgid: 1233 },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done", claim_job_id: "job-def", claim_pid: 5678, claim_pgid: 5677 },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;

      // Verify consumer claim ownership is set before reroute
      const before = db.prepare("SELECT claim_job_id, claim_pid, claim_pgid FROM steps WHERE id = ?").get(consumerRowId) as { claim_job_id: string | null; claim_pid: number | null; claim_pgid: number | null };
      assert.equal(before.claim_job_id, "job-def");
      assert.equal(before.claim_pid, 5678);
      assert.equal(before.claim_pgid, 5677);

      const result = await failStep(consumerRowId, "Consumer failure");
      assert.equal(result.status, "rerouted");

      // After reroute, consumer claim ownership must still be cleared
      const after = db.prepare("SELECT status, claim_job_id, claim_pid, claim_pgid FROM steps WHERE id = ?").get(consumerRowId) as { status: string; claim_job_id: string | null; claim_pid: number | null; claim_pgid: number | null };
      assert.equal(after.status, "waiting");
      assert.equal(after.claim_job_id, null, "consumer claim_job_id must be null after reroute");
      assert.equal(after.claim_pid, null, "consumer claim_pid must be null after reroute");
      assert.equal(after.claim_pgid, null, "consumer claim_pgid must be null after reroute");
    });

    it("producer claim_invalidated_by = 'reroute' set via completeStep expects-validation path (rerouteStepSync)", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done", claim_job_id: "job-sync", claim_pid: 1111, claim_pgid: 1110 },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      // completeStep triggers expects validation failure → retries exhausted → rerouteStepSync
      const result = completeStep(consumerRowId, "bad output without STATUS line");
      assert.equal(result.status, "rerouted", `should reroute, got: ${JSON.stringify(result)}`);

      // Producer must have claim_invalidated_by = 'reroute' and cleared claim ownership
      const producer = db.prepare("SELECT status, claim_job_id, claim_pid, claim_pgid, claim_invalidated_by FROM steps WHERE id = ?").get(producerRowId) as { status: string; claim_job_id: string | null; claim_pid: number | null; claim_pgid: number | null; claim_invalidated_by: string | null };
      assert.equal(producer.status, "pending", "producer should be pending");
      assert.equal(producer.claim_job_id, null, "producer claim_job_id must be null after reroute (sync path)");
      assert.equal(producer.claim_pid, null, "producer claim_pid must be null after reroute (sync path)");
      assert.equal(producer.claim_pgid, null, "producer claim_pgid must be null after reroute (sync path)");
      assert.equal(producer.claim_invalidated_by, "reroute", "producer claim_invalidated_by must be 'reroute' (sync path)");
    });

    it("producer without prior claim ownership still gets claim_invalidated_by = 'reroute'", async () => {
      const db = await getTestDb();
      // Producer with no prior claim ownership (fields are NULL)
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      const result = await failStep(consumerRowId, "Consumer failure");
      assert.equal(result.status, "rerouted");

      // Producer should still have claim_invalidated_by = 'reroute' even when no prior claim
      const after = db.prepare("SELECT claim_job_id, claim_pid, claim_pgid, claim_invalidated_by FROM steps WHERE id = ?").get(producerRowId) as { claim_job_id: string | null; claim_pid: number | null; claim_pgid: number | null; claim_invalidated_by: string | null };
      assert.equal(after.claim_job_id, null);
      assert.equal(after.claim_pid, null);
      assert.equal(after.claim_pgid, null);
      assert.equal(after.claim_invalidated_by, "reroute", "claim_invalidated_by must be 'reroute' even with no prior claim");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // US-003: stale-completion guard using claim_invalidated_by
  // ────────────────────────────────────────────────────────────────

  describe("stale-completion guard using claim_invalidated_by", () => {
    it("blocks stale completion for reroute-invalidated step (claim_invalidated_by='reroute')", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      // Trigger reroute → producer is re-pended with claim_invalidated_by = 'reroute'
      const rerouteResult = await failStep(consumerRowId, "Consumer failure");
      assert.equal(rerouteResult.status, "rerouted");

      // Verify producer is pending with claim_invalidated_by = 'reroute'
      const producerBefore = db.prepare("SELECT status, claim_invalidated_by FROM steps WHERE id = ?").get(producerRowId) as { status: string; claim_invalidated_by: string | null };
      assert.equal(producerBefore.status, "pending");
      assert.equal(producerBefore.claim_invalidated_by, "reroute");

      // Stale completion (carrying old claim from before reroute) MUST be blocked
      const completeResult = completeStep(producerRowId, "STATUS: done\nOUTPUT: stale-from-before-reroute");
      assert.equal(completeResult.status, "blocked", `expected blocked, got ${JSON.stringify(completeResult)}`);
      assert.ok(completeResult.detail!.includes("rerouted"), `detail should mention reroute, got: ${completeResult.detail}`);

      // Producer status must not have changed — still pending with claim_invalidated_by intact
      const producerAfter = db.prepare("SELECT status, claim_invalidated_by FROM steps WHERE id = ?").get(producerRowId) as { status: string; claim_invalidated_by: string | null };
      assert.equal(producerAfter.status, "pending", "producer status must not change on blocked completion");
      assert.equal(producerAfter.claim_invalidated_by, "reroute", "claim_invalidated_by must remain 'reroute'");
    });

    it("C5: accepts completion for sweeper-reset step (claim_invalidated_by=NULL)", async () => {
      const db = await getTestDb();
      // Simulate a producer step that was claimed, then sweeper-reset:
      // sweeper clears claim fields and sets status=pending, but does NOT
      // set claim_invalidated_by. C5 guarantees late work from the original
      // claim is still accepted.
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "pending", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", claim_job_id: null, claim_pid: null, claim_pgid: null, claim_invalidated_by: null },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "waiting", retry_count: 0, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      // Verify producer is pending with claim_invalidated_by = NULL (sweeper reset)
      const producerBefore = db.prepare("SELECT status, claim_invalidated_by, claim_job_id FROM steps WHERE id = ?").get(producerRowId) as { status: string; claim_invalidated_by: string | null; claim_job_id: string | null };
      assert.equal(producerBefore.status, "pending");
      assert.equal(producerBefore.claim_invalidated_by, null);
      assert.equal(producerBefore.claim_job_id, null);

      // C5: late work from sweeper-reset step is accepted
      const completeResult = completeStep(producerRowId, "STATUS: done\nOUTPUT: late-but-valid");
      assert.notEqual(completeResult.status, "blocked", `C5 late work must be accepted, got: ${JSON.stringify(completeResult)}`);

      // Producer should now be done
      const producerAfter = db.prepare("SELECT status FROM steps WHERE id = ?").get(producerRowId) as { status: string };
      assert.equal(producerAfter.status, "done", "producer should be done after accepted completion");
    });

    it("fresh claim after reroute clears claim_invalidated_by to NULL", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      // Trigger reroute → producer gets claim_invalidated_by = 'reroute'
      const rerouteResult = await failStep(consumerRowId, "Consumer failure");
      assert.equal(rerouteResult.status, "rerouted");

      // Verify claim_invalidated_by is set
      const afterReroute = db.prepare("SELECT status, claim_invalidated_by FROM steps WHERE id = ?").get(producerRowId) as { status: string; claim_invalidated_by: string | null };
      assert.equal(afterReroute.status, "pending");
      assert.equal(afterReroute.claim_invalidated_by, "reroute");

      // Fresh claim on the rerouted producer should clear claim_invalidated_by
      const claimResult = claimStep("producer", runId, { jobId: "fresh-job", pid: process.pid, pgid: process.pid });
      assert.equal(claimResult.found, true, `claim must succeed, got: ${JSON.stringify(claimResult)}`);

      // After claim, claim_invalidated_by must be NULL
      const afterClaim = db.prepare("SELECT claim_invalidated_by, claim_job_id FROM steps WHERE id = ?").get(producerRowId) as { claim_invalidated_by: string | null; claim_job_id: string | null };
      assert.equal(afterClaim.claim_invalidated_by, null, "claim_invalidated_by must be NULL after fresh claim");
      assert.equal(afterClaim.claim_job_id, "fresh-job", "claim_job_id must be set to the new job");

      // Now a completion should be accepted (not blocked)
      const completeResult = completeStep(producerRowId, "STATUS: done\nOUTPUT: fresh-work");
      assert.notEqual(completeResult.status, "blocked", `fresh completion must be accepted, got: ${JSON.stringify(completeResult)}`);
    });

    it("fresh claim without workerOwnership also clears claim_invalidated_by (single-step path)", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      // Trigger reroute
      await failStep(consumerRowId, "Consumer failure");

      // Claim without workerOwnership (legacy path)
      const claimResult = claimStep("producer", runId);
      assert.equal(claimResult.found, true, `claim must succeed without workerOwnership, got: ${JSON.stringify(claimResult)}`);

      // claim_invalidated_by must be NULL even without workerOwnership
      const afterClaim = db.prepare("SELECT claim_invalidated_by FROM steps WHERE id = ?").get(producerRowId) as { claim_invalidated_by: string | null };
      assert.equal(afterClaim.claim_invalidated_by, null, "claim_invalidated_by must be NULL after fresh claim (no workerOwnership)");
    });

    it("rejects stale completion even when step output matches expects", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      // Trigger reroute
      await failStep(consumerRowId, "Consumer failure");

      // A stale completion that perfectly matches expects (valid output) must STILL be blocked
      const completeResult = completeStep(producerRowId, "STATUS: done");
      assert.equal(completeResult.status, "blocked", "valid output from stale claim must still be blocked");
      assert.ok(completeResult.detail!.includes("rerouted"), `detail should mention reroute, got: ${completeResult.detail}`);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // US-004: Story reset on reroute — parse story IDs and reset matching stories
  // ────────────────────────────────────────────────────────────────

  describe("story reset on reroute to loop step", () => {
    it("resets cited done story to pending with retry_count incremented when failure text contains US-001", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      // Insert stories: US-001 is done, US-002 is done, US-003 is done
      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 1 },
        { story_id: "US-002", title: "Story 2", status: "done", retry_count: 0 },
        { story_id: "US-003", title: "Story 3", status: "done", retry_count: 0 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      // Reroute with failure text citing US-001
      const result = await failStep(mergeRowId, "Verification failed for US-001: missing tests");
      assert.equal(result.status, "rerouted");

      // US-001 should be reset to pending with retry_count incremented
      const us1 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string; retry_count: number };
      assert.equal(us1.status, "pending", "US-001 should be reset to pending");
      assert.equal(us1.retry_count, 2, "US-001 retry_count should be incremented (1→2)");

      // US-002 and US-003 should remain done (not cited in failure text)
      const us2 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-002") as { status: string; retry_count: number };
      assert.equal(us2.status, "done", "US-002 should remain done");
      assert.equal(us2.retry_count, 0, "US-002 retry_count unchanged");

      const us3 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-003") as { status: string; retry_count: number };
      assert.equal(us3.status, "done", "US-003 should remain done");
      assert.equal(us3.retry_count, 0, "US-003 retry_count unchanged");

      // verify_feedback should be written into run context
      const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
      const ctx = JSON.parse(run.context);
      assert.ok(ctx.verify_feedback, "verify_feedback should be set in run context");
      assert.ok(ctx.verify_feedback.includes("US-001"), `verify_feedback should mention US-001, got: ${ctx.verify_feedback}`);
    });

    it("resets multiple cited stories when failure text contains multiple US-\\d+ IDs", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 0 },
        { story_id: "US-002", title: "Story 2", status: "done", retry_count: 1 },
        { story_id: "US-003", title: "Story 3", status: "done", retry_count: 0 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      // Failure text cites US-001 and US-003 but not US-002
      const result = await failStep(mergeRowId, "Issues found in US-001 and US-003: needs rework");
      assert.equal(result.status, "rerouted");

      // US-001 reset
      const us1 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string; retry_count: number };
      assert.equal(us1.status, "pending");
      assert.equal(us1.retry_count, 1);

      // US-002 NOT reset (not cited)
      const us2 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-002") as { status: string; retry_count: number };
      assert.equal(us2.status, "done");
      assert.equal(us2.retry_count, 1);

      // US-003 reset
      const us3 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-003") as { status: string; retry_count: number };
      assert.equal(us3.status, "pending");
      assert.equal(us3.retry_count, 1);
    });

    it("does NOT reset pending or running stories even if cited in failure text", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 0 },
        { story_id: "US-002", title: "Story 2", status: "pending", retry_count: 2 },
        { story_id: "US-003", title: "Story 3", status: "running", retry_count: 0 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      // Failure text cites ALL stories
      const result = await failStep(mergeRowId, "US-001 failed, US-002 broken, US-003 needs fix");
      assert.equal(result.status, "rerouted");

      // US-001 is done → should be reset
      const us1 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string; retry_count: number };
      assert.equal(us1.status, "pending");
      assert.equal(us1.retry_count, 1);

      // US-002 is pending → NOT reset
      const us2 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-002") as { status: string; retry_count: number };
      assert.equal(us2.status, "pending");
      assert.equal(us2.retry_count, 2, "pending story retry_count unchanged");

      // US-003 is running → NOT reset
      const us3 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-003") as { status: string; retry_count: number };
      assert.equal(us3.status, "running");
      assert.equal(us3.retry_count, 0, "running story retry_count unchanged");
    });

    it("falls back to resetting most recently updated done story when no story IDs in failure text", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 0 },
        { story_id: "US-002", title: "Story 2", status: "done", retry_count: 1 },
        { story_id: "US-003", title: "Story 3", status: "done", retry_count: 0 },
      ]);

      // Touch US-003 with a later timestamp using the same ISO format as other inserts
      db.prepare("UPDATE stories SET updated_at = ? WHERE run_id = ? AND story_id = ?").run(new Date(Date.now() + 2000).toISOString(), runId, "US-003");

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      // Failure text has NO story IDs
      const result = await failStep(mergeRowId, "Build failed with type errors");
      assert.equal(result.status, "rerouted");

      // US-003 (most recently updated) should be reset
      const us3 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-003") as { status: string; retry_count: number };
      assert.equal(us3.status, "pending", "most recently updated done story (US-003) should be reset");
      assert.equal(us3.retry_count, 1);

      // US-001 and US-002 should remain done
      const us1 = db.prepare("SELECT status FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string };
      assert.equal(us1.status, "done");
      const us2 = db.prepare("SELECT status FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-002") as { status: string };
      assert.equal(us2.status, "done");
    });

    it("silently ignores story IDs in failure text that are not in database", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      // Only US-001 exists in DB
      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 0 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      // Failure text cites US-001 (exists) and US-999 (doesn't exist)
      const result = await failStep(mergeRowId, "US-001 and US-999 both need fixes");
      assert.equal(result.status, "rerouted");

      // US-001 should be reset (found in DB)
      const us1 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string; retry_count: number };
      assert.equal(us1.status, "pending");
      assert.equal(us1.retry_count, 1);

      // US-999 doesn't exist — no error, silently ignored (logger.warn is emitted but no crash)
    });

    it("does not reset stories when target step is not a loop-over-stories step (single type)", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      // Insert stories — even if they exist, a single-type step should not trigger story reset
      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 0 },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;

      // Reroute with US-001 in failure text — but target is a single step, not a loop
      const result = await failStep(consumerRowId, "US-001 failed verification");
      assert.equal(result.status, "rerouted");

      // US-001 should NOT be reset — target is a single step, not loop-over-stories
      const us1 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string; retry_count: number };
      assert.equal(us1.status, "done", "story should remain done for non-loop target");
      assert.equal(us1.retry_count, 0, "story retry_count should be unchanged for non-loop target");
    });

    it("resets story via completeStep expects-validation path (rerouteStepSync)", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        // merge at retry exhaustion — completeStep with bad output should trigger rerouteStepSync
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 2 },
        { story_id: "US-002", title: "Story 2", status: "done", retry_count: 0 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      // completeStep with bad output → expects validation fails → retries exhausted → rerouteStepSync
      const result = completeStep(mergeRowId, "no STATUS marker, US-001 issues");
      assert.equal(result.status, "rerouted", `should reroute via sync path, got: ${JSON.stringify(result)}`);

      // US-001 should be reset via rerouteStepSync's story reset
      const us1 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string; retry_count: number };
      assert.equal(us1.status, "pending", "US-001 should be reset via sync path");
      assert.equal(us1.retry_count, 3, "US-001 retry_count incremented (2→3)");

      // US-002 should remain done
      const us2 = db.prepare("SELECT status FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-002") as { status: string };
      assert.equal(us2.status, "done");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // US-005: Story retry count bounding on reroute reset
  // ────────────────────────────────────────────────────────────────

  describe("story retry count bounding on reroute reset", () => {
    it("resets story to pending when within max_retries budget", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      insertStories(db, runId, [
        // US-001: retry_count=1, max_retries=4 — within budget
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 1, max_retries: 4 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      const result = await failStep(mergeRowId, "US-001 failed verification");
      assert.equal(result.status, "rerouted");

      // US-001 within budget → reset to pending with retry_count incremented
      const us1 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string; retry_count: number };
      assert.equal(us1.status, "pending", "within budget should reset to pending");
      assert.equal(us1.retry_count, 2, "retry_count incremented (1→2)");
    });

    it("transitions story to failed when retry_count + 1 exceeds max_retries", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      insertStories(db, runId, [
        // US-001: retry_count=4, max_retries=4 — at limit, next retry (5) exceeds
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 4, max_retries: 4 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      const result = await failStep(mergeRowId, "US-001 failed verification");
      assert.equal(result.status, "rerouted");

      // US-001 at budget → transition to failed with retry_count incremented
      const us1 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string; retry_count: number };
      assert.equal(us1.status, "failed", "at budget should transition to failed");
      assert.equal(us1.retry_count, 5, "retry_count incremented (4→5)");

      // Verify story.failed event emitted
      const events = getRunEvents(runId);
      const storyFailedEvents = events.filter(e => e.event === "story.failed");
      assert.equal(storyFailedEvents.length, 1, "story.failed event must be emitted");
      const storyFailedEvent = storyFailedEvents[0] as any;
      assert.equal(storyFailedEvent.storyId, "US-001", "event should reference US-001");
      assert.ok(storyFailedEvent.detail.includes("retries exhausted"), `detail should mention retries exhausted, got: ${JSON.stringify(storyFailedEvent.detail)}`);
    });

    it("transitions story slightly over max_retries to failed (retry_count + 1 > max_retries)", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      insertStories(db, runId, [
        // US-001: retry_count=3, max_retries=2 — already over budget (edge case from prior manual intervention)
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 3, max_retries: 2 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      const result = await failStep(mergeRowId, "US-001 failed verification");
      assert.equal(result.status, "rerouted");

      // US-001 already over budget → transition to failed
      const us1 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string; retry_count: number };
      assert.equal(us1.status, "failed", "already over budget should transition to failed");
      assert.equal(us1.retry_count, 4, "retry_count incremented (3→4)");
    });

    it("does NOT transition story to failed when within budget — only when exhausted", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      insertStories(db, runId, [
        // Multiple stories with different retry states
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 0, max_retries: 3 },
        { story_id: "US-002", title: "Story 2", status: "done", retry_count: 2, max_retries: 3 }, // partially used
        { story_id: "US-003", title: "Story 3", status: "done", retry_count: 3, max_retries: 3 }, // at limit
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      const result = await failStep(mergeRowId, "US-001 failed verification, US-002 also has issues");
      assert.equal(result.status, "rerouted");

      // US-001: within budget → pending
      const us1 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string; retry_count: number };
      assert.equal(us1.status, "pending", "within budget → pending");
      assert.equal(us1.retry_count, 1, "retry_count incremented (0→1)");

      // US-002: within budget → pending
      const us2 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-002") as { status: string; retry_count: number };
      assert.equal(us2.status, "pending", "within budget → pending");
      assert.equal(us2.retry_count, 3, "retry_count incremented (2→3)");

      // US-003: not cited, remains done
      const us3 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-003") as { status: string; retry_count: number };
      assert.equal(us3.status, "done", "not cited, stays done");
      assert.equal(us3.retry_count, 3, "retry_count unchanged");
    });

    it("transitions story to failed via fallback heuristic when at max_retries", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      // Only one done story, and it's at max_retries
      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 3, max_retries: 3 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      // No story IDs in failure text → falls back to most recently updated done story
      const result = await failStep(mergeRowId, "Something went wrong");
      assert.equal(result.status, "rerouted");

      // Fallback story at max_retries → failed
      const us1 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string; retry_count: number };
      assert.equal(us1.status, "failed", "fallback at budget should transition to failed");
      assert.equal(us1.retry_count, 4, "retry_count incremented (3→4)");

      // Verify story.failed event emitted for fallback path
      const events = getRunEvents(runId);
      const storyFailedEvents = events.filter(e => e.event === "story.failed");
      assert.equal(storyFailedEvents.length, 1, "story.failed event must be emitted via fallback");
    });

    it("emits story.failed event only for exhausted stories, not for pending resets", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 0, max_retries: 3 },
        { story_id: "US-002", title: "Story 2", status: "done", retry_count: 4, max_retries: 4 }, // at limit
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      // Both stories cited — US-001 within budget, US-002 at limit
      const result = await failStep(mergeRowId, "US-001 and US-002 failed");
      assert.equal(result.status, "rerouted");

      // US-001: within budget → pending (no story.failed event)
      const us1 = db.prepare("SELECT status FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string };
      assert.equal(us1.status, "pending");

      // US-002: at budget → failed
      const us2 = db.prepare("SELECT status FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-002") as { status: string };
      assert.equal(us2.status, "failed");

      // Only 1 story.failed event (for US-002), not 2
      const events = getRunEvents(runId);
      const storyFailedEvents = events.filter(e => e.event === "story.failed");
      assert.equal(storyFailedEvents.length, 1, "only one story.failed event for exhausted story");
      const storyFailedEvent = storyFailedEvents[0] as any;
      assert.equal(storyFailedEvent.storyId, "US-002", "event should reference US-002");
    });

    it("works via completeStep expects-validation sync path when fallback story at max_retries", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        // merge at retry exhaustion — completeStep with bad output triggers rerouteStepSync
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      // Only one done story, at max_retries. The expects-validation error text
      // won't contain story IDs, so the fallback heuristic fires.
      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 3, max_retries: 3 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      // completeStep with bad output → expects validation fails → retries exhausted → rerouteStepSync
      // The error passed is the validation error (e.g., "Output missing expects string: STATUS: done"),
      // so the fallback heuristic (most recently updated done story) fires.
      const result = completeStep(mergeRowId, "no STATUS marker here at all");
      assert.equal(result.status, "rerouted", `should reroute via sync path, got: ${JSON.stringify(result)}`);

      // Fallback story at max_retries → failed via sync path
      const us1 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string; retry_count: number };
      assert.equal(us1.status, "failed", "fallback at budget via sync path → failed");
      assert.equal(us1.retry_count, 4, "retry_count incremented (3→4)");

      // Verify story.failed event emitted via fallback sync path
      const events = getRunEvents(runId);
      const storyFailedEvents = events.filter(e => e.event === "story.failed");
      assert.equal(storyFailedEvents.length, 1, "story.failed event must be emitted via fallback sync path");
    });
  });

  describe("verify_feedback context on reroute", () => {
    it("writes verify_feedback and retry_feedback to run context when reroute targets loop step", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 0 },
        { story_id: "US-002", title: "Story 2", status: "done", retry_count: 1 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      const errorText = "Verification failed for US-001: tests are missing edge cases";
      const result = await failStep(mergeRowId, errorText);
      assert.equal(result.status, "rerouted");

      // verify_feedback should contain the full failure text
      const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
      const ctx = JSON.parse(run.context);
      assert.ok(ctx.verify_feedback, "verify_feedback should be set in run context after reroute to loop step");
      assert.equal(ctx.verify_feedback, errorText, "verify_feedback should contain the full consumer failure text");

      // retry_feedback should also be set to the same value
      assert.ok(ctx.retry_feedback, "retry_feedback should be set in run context after reroute to loop step");
      assert.equal(ctx.retry_feedback, errorText, "retry_feedback should match verify_feedback value");

      // Producer output (step.output) still contains the reroute feedback (existing behavior preserved)
      const developRow = stepRows.find(s => s.step_id === "develop")!;
      const producerStep = db.prepare("SELECT output FROM steps WHERE id = ?").get(developRow.rowId) as { output: string };
      assert.ok(producerStep.output, "producer output should still have reroute feedback");
      assert.ok(producerStep.output.includes("Reroute from"), "producer output should contain reroute feedback prefix");
      assert.ok(producerStep.output.includes("US-001"), "producer output should mention the cited story");
    });

    it("writes verify_feedback to context even when NO stories are reset", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        // merge is running and retries exhausted → reroute
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      // All stories are pending (not done). Story IDs in failure text won't
      // match "done" stories, and the fallback heuristic also finds nothing.
      // resetCount stays 0 — but verify_feedback must still be written.
      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "pending", retry_count: 0 },
        { story_id: "US-002", title: "Story 2", status: "pending", retry_count: 0 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      const errorText = "US-001 needs rework: verify_feedback should be surfaced";
      const result = await failStep(mergeRowId, errorText);
      assert.equal(result.status, "rerouted");

      // Stories should NOT be reset (they are already pending, not done)
      const us1 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string; retry_count: number };
      assert.equal(us1.status, "pending", "US-001 should remain pending (already pending)");
      assert.equal(us1.retry_count, 0, "US-001 retry_count unchanged (not reset)");

      // verify_feedback should STILL be written to context despite resetCount=0
      const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
      const ctx = JSON.parse(run.context);
      assert.ok(ctx.verify_feedback, "verify_feedback should be set even when no stories are reset");
      assert.equal(ctx.verify_feedback, errorText, "verify_feedback should contain the full failure text");
      assert.ok(ctx.retry_feedback, "retry_feedback should also be set");
    });

    it("writes verify_feedback via sync path (completeStep expects-validation reroute)", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 1 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      // completeStep with bad output → expects validation fails → retries exhausted → rerouteStepSync
      const result = completeStep(mergeRowId, "no STATUS marker present");
      assert.equal(result.status, "rerouted", `should reroute via sync path, got: ${JSON.stringify(result)}`);

      // verify_feedback should be written via rerouteStepSync
      const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
      const ctx = JSON.parse(run.context);
      assert.ok(ctx.verify_feedback, "verify_feedback should be set in context via sync path");
      assert.ok(ctx.verify_feedback.length > 0, "verify_feedback should not be empty via sync path");
      assert.ok(ctx.retry_feedback, "retry_feedback should also be set via sync path");
    });

    it("does NOT write verify_feedback to context when reroute target is NOT a loop step", async () => {
      const db = await getTestDb();
      // Use single-type steps (not loop) — the "test-reroute-paths" workflow fixture
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      // Save the current context to compare after reroute
      const contextBefore = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
      const ctxBefore = contextBefore ? JSON.parse(contextBefore.context) : {};

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;

      const result = await failStep(consumerRowId, "Consumer failure for non-loop target");
      assert.equal(result.status, "rerouted");

      // Context should NOT have verify_feedback for non-loop reroute targets
      const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
      const ctxAfter = JSON.parse(run.context);
      
      // If verify_feedback wasn't there before, it shouldn't be there after
      if (!ctxBefore.verify_feedback) {
        assert.ok(!ctxAfter.verify_feedback, "verify_feedback should NOT be set for non-loop reroute target");
      }
      // retry_feedback should also not be set by the reroute (unless it was already there)
      if (!ctxBefore.retry_feedback) {
        assert.ok(!ctxAfter.retry_feedback, "retry_feedback should NOT be set for non-loop reroute target");
      }
    });

    it("retry_feedback in step.output continues to work for consumer on next claim", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 0 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;
      const developRowId = stepRows.find(s => s.step_id === "develop")!.rowId;

      const errorText = "US-001 needs more test coverage";
      const result = await failStep(mergeRowId, errorText);
      assert.equal(result.status, "rerouted");

      // The rerouted producer (develop) should have feedback in its output column
      // This is the existing retry_feedback behavior through step.output
      const developStep = db.prepare("SELECT output FROM steps WHERE id = ?").get(developRowId) as { output: string };
      assert.ok(developStep.output, "producer output should contain reroute feedback");
      assert.ok(developStep.output.includes("Reroute from"), "output should have Reroute prefix");
      assert.ok(developStep.output.includes("US-001"), "output should reference the cited story ID");

      // The consumer (merge) should be reset to waiting with cleared output
      const mergeStep = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(mergeRowId) as { status: string; output: string | null };
      assert.equal(mergeStep.status, "waiting", "consumer should be reset to waiting");
      assert.equal(mergeStep.output, null, "consumer output should be cleared after reroute");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // US-007: No-op bounce detection
  // ────────────────────────────────────────────────────────────────

  describe("no-op bounce detection", () => {
    it("emits step.reroute_noop in completeStep when completion arrives without fresh claim after reroute", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      // Trigger reroute via failStep
      const result = await failStep(consumerRowId, "Consumer failure");
      assert.equal(result.status, "rerouted");

      // Verify producer has claim_updated_at = NULL (set by reroute)
      const producer = db.prepare(
        "SELECT claim_updated_at, claim_invalidated_by, status FROM steps WHERE id = ?"
      ).get(producerRowId) as { claim_updated_at: string | null; claim_invalidated_by: string | null; status: string };
      assert.equal(producer.claim_updated_at, null, "claim_updated_at should be NULL after reroute");
      assert.equal(producer.claim_invalidated_by, "reroute", "claim_invalidated_by should be 'reroute'");
      assert.equal(producer.status, "pending", "producer should be re-pended");

      // Now call completeStep directly for the producer without claiming first.
      // This simulates a no-op completion arriving after reroute.
      const completeResult = completeStep(producerRowId, "STATUS: done");
      assert.equal(completeResult.status, "blocked", "should be blocked as stale/no-op completion");

      // Verify step.reroute_noop event was emitted
      const events = getRunEvents(runId);
      const noopEvents = events.filter((e: any) => e.event === "step.reroute_noop");
      assert.equal(noopEvents.length, 1, "exactly one step.reroute_noop event should be emitted");
      assert.equal(noopEvents[0].stepId, "produce", "event should reference the producer step_id");
      assert.ok(noopEvents[0].detail.includes("no claim after reroute"), "detail should mention no claim");
    });

    it("does NOT flag normal completions (with fresh claim) as no-op", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      // Trigger reroute
      await failStep(consumerRowId, "Consumer failure");

      // Simulate a fresh claim on the producer (this is what claimStep does)
      // claimStep sets claim_updated_at = datetime('now') and claim_invalidated_by = NULL
      db.prepare(
        "UPDATE steps SET status = 'running', claim_job_id = 'fresh-claim', claim_updated_at = datetime('now'), claim_invalidated_by = NULL, updated_at = datetime('now') WHERE id = ?"
      ).run(producerRowId);

      // Now complete — should be accepted (not a no-op since claim happened)
      const completeResult = completeStep(producerRowId, "STATUS: done");
      assert.notEqual(completeResult.status, "blocked", "normal completion after fresh claim should not be blocked");

      // Verify NO step.reroute_noop event was emitted
      const events = getRunEvents(runId);
      const noopEvents = events.filter((e: any) => e.event === "step.reroute_noop");
      assert.equal(noopEvents.length, 0, "no step.reroute_noop events should be emitted for normal completion");
    });

    it("detects no-op bounce in claimStep auto-complete path for rerouted loop with all stories already done", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      // All stories are done — nothing pending for the loop to work on.
      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 0 },
        { story_id: "US-002", title: "Story 2", status: "done", retry_count: 0 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;
      const developRowId = stepRows.find(s => s.step_id === "develop")!.rowId;

      // Simulate what rerouteStep does to the producer BUT WITHOUT
      // running resetStoriesOnReroute (so stories stay done). We set
      // claim_updated_at = NULL and claim_invalidated_by = 'reroute'
      // so claimStep's auto-complete path can detect the no-op bounce.
      db.prepare(
        "UPDATE steps SET status = 'pending', claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL, claim_updated_at = NULL, claim_invalidated_by = 'reroute', updated_at = datetime('now') WHERE id = ?"
      ).run(developRowId);

      // Now claimStep for the dev agent. The loop step was rerouted but all
      // stories are still done (no reset happened). claimStep claims it,
      // finds no pending stories, and auto-completes — this IS a no-op bounce.
      const claimResult = claimStep("dev", runId);
      assert.equal(claimResult.found, false, "claimStep should return no work after auto-completing");

      // Verify step.reroute_noop event was emitted
      const events = getRunEvents(runId);
      const noopEvents = events.filter((e: any) => e.event === "step.reroute_noop");
      assert.equal(noopEvents.length, 1, "exactly one step.reroute_noop event should be emitted");
      assert.ok(noopEvents[0].detail.includes("all stories were already done"), "detail should mention all stories done");

      // The step should be marked done (auto-complete behavior is preserved)
      const developStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(developRowId) as { status: string };
      assert.equal(developStep.status, "done", "step should be auto-completed to done");
    });

    it("does NOT emit no-op event for loop step with pending stories (normal reroute work found)", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      // US-001 is done, US-002 is pending — agent has real work to do
      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 0 },
        { story_id: "US-002", title: "Story 2", status: "pending", retry_count: 0 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      // Trigger reroute (story reset happens, but US-002 is already pending so nothing changes)
      await failStep(mergeRowId, "Merge failed");

      // claimStep for dev: pending stories exist → normal claim, agent runs
      const claimResult = claimStep("dev", runId);
      assert.equal(claimResult.found, true, "claimStep should find pending work");

      // Verify NO step.reroute_noop event was emitted (normal flow)
      const events = getRunEvents(runId);
      const noopEvents = events.filter((e: any) => e.event === "step.reroute_noop");
      assert.equal(noopEvents.length, 0, "no step.reroute_noop events should be emitted for normal reroute with pending stories");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // US-008: Integration tests — story reset + claimStep dispatch
  // ────────────────────────────────────────────────────────────────

  describe("integration: story reset on reroute + claimStep dispatch", () => {
    it("all-done loop reroute with story ID in failure text → story reset → claimStep finds pending story", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      // All stories are done — no pending work
      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 1 },
        { story_id: "US-002", title: "Story 2", status: "done", retry_count: 0 },
        { story_id: "US-003", title: "Story 3", status: "done", retry_count: 2 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;
      const developRowId = stepRows.find(s => s.step_id === "develop")!.rowId;

      // Verify no pending stories before reroute
      const pendingBefore = db.prepare("SELECT count(*) as cnt FROM stories WHERE run_id = ? AND status = 'pending'").get(runId) as { cnt: number };
      assert.equal(pendingBefore.cnt, 0, "should have no pending stories before reroute");

      // Trigger reroute — failure text cites US-001
      const rerouteResult = await failStep(mergeRowId, "Verification failed for US-001: tests need edge case coverage");
      assert.equal(rerouteResult.status, "rerouted");

      // US-001 should be reset to pending with retry_count incremented
      const us1 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string; retry_count: number };
      assert.equal(us1.status, "pending", "US-001 should be reset to pending");
      assert.equal(us1.retry_count, 2, "US-001 retry_count should be incremented (1→2)");

      // US-002 and US-003 should remain done
      const us2 = db.prepare("SELECT status FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-002") as { status: string };
      assert.equal(us2.status, "done", "US-002 should remain done");
      const us3 = db.prepare("SELECT status FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-003") as { status: string };
      assert.equal(us3.status, "done", "US-003 should remain done");

      // Now the full integration check: claimStep for the dev agent
      // The develop step was re-pended by reroute, but after the story reset
      // we need the developer agent to be able to claim it.
      // First, manually advance the pipeline so develop goes from pending → ready to claim.
      // (rerouteStep sets producer to 'pending'; for a loop step at index 0, no predecessor blocks it)
      const producerAfter = db.prepare("SELECT status FROM steps WHERE id = ?").get(developRowId) as { status: string };
      assert.equal(producerAfter.status, "pending", "producer should be pending after reroute");

      // claimStep should find the develop step pending and claim it with a story
      const claimResult = claimStep("dev", runId);
      assert.equal(claimResult.found, true, "claimStep must find the rerouted develop step pending with stories to work on");
      assert.ok(claimResult.stepId, "claimResult must have stepId");
      assert.ok(claimResult.resolvedInput, "claimResult must have resolvedInput");

      // The step should now be running (claimed)
      const devStepAfter = db.prepare("SELECT status, current_story_id FROM steps WHERE id = ?").get(developRowId) as { status: string; current_story_id: string | null };
      assert.equal(devStepAfter.status, "running", "producer should be running after claim");
      assert.ok(devStepAfter.current_story_id, "should have current_story_id set to the claimed story");

      // The claimed story should be US-001 (the reset story)
      const claimedStory = db.prepare("SELECT story_id, status FROM stories WHERE id = ?").get(devStepAfter.current_story_id!) as { story_id: string; status: string };
      assert.equal(claimedStory.story_id, "US-001", "claimed story should be the reset US-001");
      assert.equal(claimedStory.status, "running", "claimed story should be running");

      // story.started event should be emitted
      const events = getRunEvents(runId);
      const storyStartedEvents = events.filter((e: any) => e.event === "story.started");
      assert.equal(storyStartedEvents.length, 1, "story.started event must be emitted on claim");
      assert.equal((storyStartedEvents[0] as any).storyId, "US-001", "story.started should reference US-001");
    });

    it("partially-done loop reroute citing US-003 → only US-003 reset, US-001 stays done", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      // Mixed states: US-001 done, US-002 pending, US-003 done
      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 0 },
        { story_id: "US-002", title: "Story 2", status: "pending", retry_count: 1 },
        { story_id: "US-003", title: "Story 3", status: "done", retry_count: 0 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;
      const developRowId = stepRows.find(s => s.step_id === "develop")!.rowId;

      // Reroute citing only US-003
      const rerouteResult = await failStep(mergeRowId, "US-003 failed: needs additional null-check handling");
      assert.equal(rerouteResult.status, "rerouted");

      // US-003 should be reset to pending (cited in failure text)
      const us3 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-003") as { status: string; retry_count: number };
      assert.equal(us3.status, "pending", "US-003 should be reset to pending");
      assert.equal(us3.retry_count, 1, "US-003 retry_count should be incremented (0→1)");

      // US-001 should remain done (not cited)
      const us1 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string; retry_count: number };
      assert.equal(us1.status, "done", "US-001 should remain done");
      assert.equal(us1.retry_count, 0, "US-001 retry_count should be unchanged");

      // US-002 should remain pending (was already pending, not reset by reroute)
      const us2 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-002") as { status: string; retry_count: number };
      assert.equal(us2.status, "pending", "US-002 should remain pending");
      assert.equal(us2.retry_count, 1, "US-002 retry_count unchanged");

      // claimStep should find work — both US-002 and US-003 are pending
      // claimStep picks the lowest story_index, which is US-002 (index 1)
      const claimResult = claimStep("dev", runId);
      assert.equal(claimResult.found, true, "claimStep must find pending work after reroute");
      assert.ok(claimResult.stepId, "claimResult must have stepId");
      assert.ok(claimResult.resolvedInput, "claimResult must have resolvedInput");

      // Verify the step was claimed and has a current_story_id set
      const devStepAfter = db.prepare("SELECT status, current_story_id FROM steps WHERE run_id = ? AND step_id = ?").get(runId, "develop") as { status: string; current_story_id: string | null };
      assert.equal(devStepAfter.status, "running", "develop step should be running after claim");
      assert.ok(devStepAfter.current_story_id, "should have current_story_id set");
    });

    it("story retry exceeding max_retries on reroute → story fails → claimStep with no pending stories fails the run", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      // Only one done story, at its max_retries limit
      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 4, max_retries: 4 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      // Reroute citing US-001 — retry_count already at 4, max_retries=4 → increment (5) exceeds → failed
      const rerouteResult = await failStep(mergeRowId, "US-001 verification failed: missing error handling");
      assert.equal(rerouteResult.status, "rerouted");

      // US-001 should transition to failed (not pending)
      const us1 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string; retry_count: number };
      assert.equal(us1.status, "failed", "story at max_retries should transition to failed");
      assert.equal(us1.retry_count, 5, "retry_count should be incremented (4→5)");

      // story.failed event must be emitted
      const events = getRunEvents(runId);
      const storyFailedEvents = events.filter((e: any) => e.event === "story.failed");
      assert.equal(storyFailedEvents.length, 1, "story.failed event must be emitted");
      assert.equal((storyFailedEvents[0] as any).storyId, "US-001");

      // Now the integration check: claimStep for the dev agent.
      // Since the only story is now failed (not pending), and the rerouted producer is pending,
      // claimStep should find the step pending but then detect no pending stories and fail the run.
      // The develop step is re-pended as 'pending' by reroute.
      const claimResult = claimStep("dev", runId);
      assert.equal(claimResult.found, false, "claimStep must NOT find work — all stories are failed, no pending");

      // The develop step should be marked failed (loop can't continue)
      const devStep = db.prepare("SELECT status, output FROM steps WHERE run_id = ? AND step_id = ?").get(runId, "develop") as { status: string; output: string };
      assert.equal(devStep.status, "failed", "develop step should be failed when all stories are failed");
      assert.ok(devStep.output.includes("Loop cannot continue"), `output should indicate loop failure, got: ${devStep.output}`);

      // The run should also be failed
      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "failed", "run should be failed when loop has only failed stories");
    });

    it("only the cited story is reset when multiple are done — claimStep dispatches for the cited story", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      // Multiple done stories, but only US-002 is cited in failure text
      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 0 },
        { story_id: "US-002", title: "Story 2", status: "done", retry_count: 1 },
        { story_id: "US-003", title: "Story 3", status: "done", retry_count: 0 },
        { story_id: "US-004", title: "Story 4", status: "done", retry_count: 2 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      // Reroute citing only US-002 — the verifier found issues specifically with US-002
      const rerouteResult = await failStep(mergeRowId, "US-002 has insufficient test coverage for edge cases");
      assert.equal(rerouteResult.status, "rerouted");

      // Only US-002 should be reset to pending
      const us2 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-002") as { status: string; retry_count: number };
      assert.equal(us2.status, "pending", "US-002 should be reset to pending (cited in failure text)");
      assert.equal(us2.retry_count, 2, "US-002 retry_count incremented (1→2)");

      // All other stories should remain done
      const us1 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string; retry_count: number };
      assert.equal(us1.status, "done", "US-001 should remain done (not cited)");
      assert.equal(us1.retry_count, 0, "US-001 retry_count unchanged");

      const us3 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-003") as { status: string; retry_count: number };
      assert.equal(us3.status, "done", "US-003 should remain done (not cited)");
      assert.equal(us3.retry_count, 0, "US-003 retry_count unchanged");

      const us4 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-004") as { status: string; retry_count: number };
      assert.equal(us4.status, "done", "US-004 should remain done (not cited)");
      assert.equal(us4.retry_count, 2, "US-004 retry_count unchanged");

      // Verify only the cited story is pending before claimStep
      // US-002 should be pending, all others done
      const pendingBeforeClaim = db.prepare("SELECT count(*) as cnt FROM stories WHERE run_id = ? AND status = 'pending'").get(runId) as { cnt: number };
      assert.equal(pendingBeforeClaim.cnt, 1, "only one story should be pending (US-002) before claim");
      const pendingStory = db.prepare("SELECT story_id FROM stories WHERE run_id = ? AND status = 'pending'").get(runId) as { story_id: string };
      assert.equal(pendingStory.story_id, "US-002", "pending story should be US-002 (cited in failure text)");

      // The done count should be 3 (US-001, US-003, US-004 still done)
      const doneAfter = db.prepare("SELECT count(*) as cnt FROM stories WHERE run_id = ? AND status = 'done'").get(runId) as { cnt: number };
      assert.equal(doneAfter.cnt, 3, "three stories should remain done (US-001, US-003, US-004)");

      // Now claimStep should find and claim US-002
      const claimResult = claimStep("dev", runId);
      assert.equal(claimResult.found, true, "claimStep must find the reset US-002 story");
      assert.ok(claimResult.stepId, "claimResult must have stepId");

      // Verify the claimed story is US-002
      const devStepAfter = db.prepare("SELECT current_story_id FROM steps WHERE run_id = ? AND step_id = ?").get(runId, "develop") as { current_story_id: string | null };
      const claimedStory = db.prepare("SELECT story_id FROM stories WHERE id = ?").get(devStepAfter.current_story_id!) as { story_id: string };
      assert.equal(claimedStory.story_id, "US-002", "claimed story should be US-002 (cited in failure text)");

      // Verify story.started event references US-002
      const events = getRunEvents(runId);
      const storyStartedEvents = events.filter((e: any) => e.event === "story.started");
      assert.equal(storyStartedEvents.length, 1, "story.started event must be emitted on claim");
      assert.equal((storyStartedEvents[0] as any).storyId, "US-002", "story.started should reference the cited US-002");
    });

    it("reroute without story IDs in failure text → fallback resets most recently updated done story → claimStep dispatches", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      insertStories(db, runId, [
        { story_id: "US-001", title: "Story 1", status: "done", retry_count: 0 },
        { story_id: "US-002", title: "Story 2", status: "done", retry_count: 1 },
        { story_id: "US-003", title: "Story 3", status: "done", retry_count: 0 },
      ]);

      // Touch US-003 with a later ISO timestamp so it becomes "most recently updated"
      db.prepare("UPDATE stories SET updated_at = ? WHERE run_id = ? AND story_id = ?").run(
        new Date(Date.now() + 5000).toISOString(), runId, "US-003"
      );

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      // Failure text has NO story IDs — fallback heuristic fires
      const rerouteResult = await failStep(mergeRowId, "Build failed with unexpected type error");
      assert.equal(rerouteResult.status, "rerouted");

      // US-003 (most recently updated done story) should be reset
      const us3 = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-003") as { status: string; retry_count: number };
      assert.equal(us3.status, "pending", "most recently updated done story (US-003) should be reset");
      assert.equal(us3.retry_count, 1, "US-003 retry_count incremented (0→1)");

      // US-001 and US-002 should remain done
      const us1 = db.prepare("SELECT status FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-001") as { status: string };
      assert.equal(us1.status, "done", "US-001 should remain done");
      const us2 = db.prepare("SELECT status FROM stories WHERE run_id = ? AND story_id = ?").get(runId, "US-002") as { status: string };
      assert.equal(us2.status, "done", "US-002 should remain done");

      // claimStep should find US-003 as the pending story
      const claimResult = claimStep("dev", runId);
      assert.equal(claimResult.found, true, "claimStep must find the fallback-reset story");
      assert.ok(claimResult.stepId, "claimResult must have stepId");
      assert.ok(claimResult.resolvedInput, "claimResult must have resolvedInput");

      // Verify the claimed story is US-003 (fallback target)
      const devStepAfter = db.prepare("SELECT current_story_id FROM steps WHERE run_id = ? AND step_id = ?").get(runId, "develop") as { current_story_id: string | null };
      const claimedStory = db.prepare("SELECT story_id FROM stories WHERE id = ?").get(devStepAfter.current_story_id!) as { story_id: string };
      assert.equal(claimedStory.story_id, "US-003", "claimed story should be US-003 (fallback heuristic)");

      // Verify verify_feedback is in run context
      const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
      const ctx = JSON.parse(run.context);
      assert.ok(ctx.verify_feedback, "verify_feedback should be in run context");
      assert.ok(ctx.verify_feedback.includes("Build failed"), "verify_feedback should contain the failure message");

      // story.started event should reference US-003
      const events = getRunEvents(runId);
      const storyStartedEvents = events.filter((e: any) => e.event === "story.started");
      assert.equal(storyStartedEvents.length, 1, "story.started event must be emitted");
      assert.equal((storyStartedEvents[0] as any).storyId, "US-003", "story.started should reference the fallback story US-003");
    });

    it("verify_feedback is accessible to the developer agent on next claim after reroute", async () => {
      const db = await getTestDb();
      const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-loop", [
        { step_id: "develop", agent_id: "dev", step_index: 0, status: "done", retry_count: 0, max_retries: 4, input_template: "Develop", expects: "STATUS: done", type: "loop", loop_config: loopConfig, output: "STATUS: done" },
        { step_id: "verify", agent_id: "verifier", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Verify", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "merge", agent_id: "merger", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Merge", expects: "STATUS: done" },
      ]);

      insertStories(db, runId, [
        { story_id: "US-001", title: "Add error handling", status: "done", retry_count: 0 },
        { story_id: "US-002", title: "Add null checks", status: "done", retry_count: 1 },
      ]);

      const mergeRowId = stepRows.find(s => s.step_id === "merge")!.rowId;

      const failureText = "US-001 verification failed: edge case in handleResponse not covered by tests";
      const rerouteResult = await failStep(mergeRowId, failureText);
      assert.equal(rerouteResult.status, "rerouted");

      // claimStep for the dev agent — the feedback should be in the input context
      const claimResult = claimStep("dev", runId);
      assert.equal(claimResult.found, true, "claimStep must find pending work after story reset");
      assert.ok(claimResult.stepId, "claimResult must have stepId");
      assert.ok(claimResult.resolvedInput, "claimResult must have resolvedInput");

      // verify_feedback is in the DB context (set by writeRerouteFeedbackContext)
      const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
      const ctx = JSON.parse(run.context);
      assert.ok(ctx.verify_feedback, "verify_feedback should be in run context");
      assert.ok(ctx.verify_feedback.includes("US-001"), `verify_feedback should reference US-001, got: ${ctx.verify_feedback}`);

      // The claimed story should be US-001 (the reset story)
      const devStepAfter = db.prepare("SELECT current_story_id FROM steps WHERE run_id = ? AND step_id = ?").get(runId, "develop") as { current_story_id: string | null };
      const claimedStory = db.prepare("SELECT story_id FROM stories WHERE id = ?").get(devStepAfter.current_story_id!) as { story_id: string };
      assert.equal(claimedStory.story_id, "US-001", "claimed story should be the reset US-001");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // US-009: Integration tests for claim fencing and C5 regression
  // ────────────────────────────────────────────────────────────────

  describe("integration: claim fencing and C5 regression", () => {
    it("full claim fencing lifecycle: reroute → stale blocked → fresh claim → completion accepted → pipeline advances", async () => {
      const db = await getTestDb();
      // Two-step pipeline: produce (idx 0) → consume (idx 1).
      // consume declares on_fail.retry_step: produce.
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done", claim_job_id: "old-job", claim_pid: 12345, claim_pgid: 12344 },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      // ── Phase 1: Consumer fails → reroute to produce ──
      const rerouteResult = await failStep(consumerRowId, "Consumer failure: invalid output");
      assert.equal(rerouteResult.status, "rerouted");

      // Producer is re-pended with claim_invalidated_by = 'reroute'
      const producerAfterReroute = db.prepare("SELECT status, claim_invalidated_by, claim_job_id, claim_pid FROM steps WHERE id = ?").get(producerRowId) as { status: string; claim_invalidated_by: string | null; claim_job_id: string | null; claim_pid: number | null };
      assert.equal(producerAfterReroute.status, "pending");
      assert.equal(producerAfterReroute.claim_invalidated_by, "reroute");
      assert.equal(producerAfterReroute.claim_job_id, null, "stale claim_job_id must be cleared");
      assert.equal(producerAfterReroute.claim_pid, null, "stale claim_pid must be cleared");

      // Consumer reset to waiting
      const consumerAfterReroute = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(consumerRowId) as { status: string; retry_count: number };
      assert.equal(consumerAfterReroute.status, "waiting");
      assert.equal(consumerAfterReroute.retry_count, 0, "consumer retry_count reset");

      // ── Phase 2: Stale completion from old worker MUST be blocked ──
      const staleComplete = completeStep(producerRowId, "STATUS: done\nOUTPUT: stale-from-before-reroute");
      assert.equal(staleComplete.status, "blocked", "stale completion must be blocked");
      assert.ok(staleComplete.detail!.includes("rerouted"), "detail should mention reroute");

      // Producer state unchanged after blocked completion
      const producerAfterBlocked = db.prepare("SELECT status, claim_invalidated_by FROM steps WHERE id = ?").get(producerRowId) as { status: string; claim_invalidated_by: string | null };
      assert.equal(producerAfterBlocked.status, "pending", "producer must stay pending after blocked completion");
      assert.equal(producerAfterBlocked.claim_invalidated_by, "reroute", "claim_invalidated_by must persist");

      // ── Phase 3: Fresh claim clears invalidation marker ──
      const freshClaim = claimStep("producer", runId, { jobId: "fresh-job-001", pid: process.pid, pgid: process.pid });
      assert.equal(freshClaim.found, true, "fresh claim must succeed");
      assert.ok(freshClaim.stepId, "claimResult must have stepId");

      const producerAfterClaim = db.prepare("SELECT claim_invalidated_by, claim_job_id, claim_pid FROM steps WHERE id = ?").get(producerRowId) as { claim_invalidated_by: string | null; claim_job_id: string | null; claim_pid: number | null };
      assert.equal(producerAfterClaim.claim_invalidated_by, null, "claim_invalidated_by must be NULL after fresh claim");
      assert.equal(producerAfterClaim.claim_job_id, "fresh-job-001", "new claim_job_id must be set");

      // ── Phase 4: Fresh completion accepted → pipeline advances ──
      const freshComplete = completeStep(producerRowId, "STATUS: done\nOUTPUT: fresh-rewritten");
      assert.notEqual(freshComplete.status, "blocked", `fresh completion must be accepted, got: ${JSON.stringify(freshComplete)}`);

      const producerDone = db.prepare("SELECT status FROM steps WHERE id = ?").get(producerRowId) as { status: string };
      assert.equal(producerDone.status, "done", "producer must be done after fresh completion");

      // Pipeline advances: consumer should now be pending
      const consumerAfterAdvance = db.prepare("SELECT status FROM steps WHERE id = ?").get(consumerRowId) as { status: string };
      assert.equal(consumerAfterAdvance.status, "pending", "consumer must advance to pending after producer completes");

      // Verify step.rerouted event was emitted
      const events = getRunEvents(runId);
      const reroutedEvents = events.filter((e: any) => e.event === "step.rerouted");
      assert.equal(reroutedEvents.length, 1, "step.rerouted event must be emitted");
      const reroutedEvent = reroutedEvents[0] as any;
      assert.equal(reroutedEvent.stepId, "consume", "rerouted event should reference the consumer that triggered the reroute");
    });

    it("multiple stale completions after reroute are ALL blocked", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      // Trigger reroute
      await failStep(consumerRowId, "Consumer crash");

      // Verify reroute applied
      const afterReroute = db.prepare("SELECT status, claim_invalidated_by FROM steps WHERE id = ?").get(producerRowId) as { status: string; claim_invalidated_by: string | null };
      assert.equal(afterReroute.status, "pending");
      assert.equal(afterReroute.claim_invalidated_by, "reroute");

      // Try 3 different stale completions — ALL must be blocked
      for (const attempt of ["attempt-1", "attempt-2", "attempt-3"]) {
        const result = completeStep(producerRowId, `STATUS: done\nOUTPUT: ${attempt}`);
        assert.equal(result.status, "blocked", `stale completion ${attempt} must be blocked`);
      }

      // Step state must be unchanged after all blocked attempts
      const finalProducer = db.prepare("SELECT status, claim_invalidated_by, output FROM steps WHERE id = ?").get(producerRowId) as { status: string; claim_invalidated_by: string | null; output: string | null };
      assert.equal(finalProducer.status, "pending", "producer must stay pending after all blocked completions");
      assert.equal(finalProducer.claim_invalidated_by, "reroute", "claim_invalidated_by must persist through multiple blocks");
      // Output should be the reroute feedback, NOT any of the stale completion outputs
      assert.ok(finalProducer.output!.includes("Reroute"), `output should contain reroute metadata, got: ${finalProducer.output}`);
    });

    it("C5 regression: sweeper-reset step (claim_invalidated_by=NULL) accepts late completion and pipeline advances", async () => {
      const db = await getTestDb();
      // Create steps with produce initially claimed by a worker, then manually
      // simulate a sweeper reset: clear claim fields, set pending, but do NOT
      // set claim_invalidated_by. This is exactly what recoverOrphanedStepsForAgent
      // does — the C5 guarantee. We test both the low-level DB state AND
      // verify recoverOrphanedStepsForAgent itself produces the right state.
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "running", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", claim_job_id: "worker-job", claim_pid: 99999, claim_pgid: 99998 },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "waiting", retry_count: 0, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      // Verify produce is running with claim ownership
      const beforeSweeper = db.prepare("SELECT status, claim_job_id, claim_invalidated_by FROM steps WHERE id = ?").get(producerRowId) as { status: string; claim_job_id: string | null; claim_invalidated_by: string | null };
      assert.equal(beforeSweeper.status, "running");
      assert.equal(beforeSweeper.claim_job_id, "worker-job");
      assert.equal(beforeSweeper.claim_invalidated_by, null);

      // Use recoverOrphanedStepsForAgent with staleThresholdMs=0 to force reset.
      // The sweeper resets status to pending and bumps retry_count, but does NOT
      // clear claim fields (claim_job_id, claim_pid). Critically, it does NOT set
      // claim_invalidated_by either — this is the C5 contract.
      // Backdate the claim first: a same-instant updated_at under the sweeper's
      // strict julianday comparison is a rounding coin-flip (see sibling test).
      db.prepare("UPDATE steps SET updated_at = datetime('now', '-5 seconds') WHERE id = ?").run(producerRowId);
      const sweeperResult = recoverOrphanedStepsForAgent("producer", runId, 0);
      assert.equal(sweeperResult.recovered, 1, "sweeper should reset the running step");

      // After sweeper reset: status=pending, claim fields unchanged, claim_invalidated_by=NULL
      const afterSweeper = db.prepare("SELECT status, claim_job_id, claim_pid, claim_invalidated_by FROM steps WHERE id = ?").get(producerRowId) as { status: string; claim_job_id: string | null; claim_pid: number | null; claim_invalidated_by: string | null };
      assert.equal(afterSweeper.status, "pending", "sweeper must reset to pending");
      // C5 note: sweeper does NOT clear claim fields — it preserves them so late
      // completion can still carry the original claim metadata.
      assert.equal(afterSweeper.claim_invalidated_by, null, "sweeper must NOT set claim_invalidated_by (C5 contract)");

      // C5: late completion from the original worker must be accepted
      const lateComplete = completeStep(producerRowId, "STATUS: done\nOUTPUT: late-but-valid-work");
      assert.notEqual(lateComplete.status, "blocked", `C5 late completion must be accepted, got: ${JSON.stringify(lateComplete)}`);

      const producerDone = db.prepare("SELECT status FROM steps WHERE id = ?").get(producerRowId) as { status: string };
      assert.equal(producerDone.status, "done", "producer must be done after late completion");

      // Pipeline advances: consumer pending
      const consumerAfterAdvance = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepRows.find(s => s.step_id === "consume")!.rowId) as { status: string };
      assert.equal(consumerAfterAdvance.status, "pending", "pipeline must advance after late completion");
    });

    it("sweeper-reset followed by fresh claim then reroute → stale completion still blocked", async () => {
      const db = await getTestDb();
      // Complex scenario: sweeper resets → fresh claim → consumer triggers reroute →
      // producer gets claim_invalidated_by='reroute' → stale completion blocked.
      // This validates that claim fencing works correctly even after a prior sweeper cycle.
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 0, max_retries: 1, input_template: "Consume", expects: "STATUS: done", claim_job_id: "consume-job", claim_pid: 20000, claim_pgid: 19999 },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      // ── Step 1: Consumer is running, sweeper resets it (simulating crashed worker) ──
      // Use max_retries=1: sweeper bumps retry_count to 1 (still ≤ 1 so stays
      // pending), then failStep bumps to 2 > 1 → reroute triggers.

      // Backdate the claim so the step is genuinely stale: the fixture stamps
      // updated_at with the JS clock and the sweeper compares julianday('now')
      // with a strict >, so a same-instant timestamp is a rounding coin-flip.
      db.prepare("UPDATE steps SET updated_at = datetime('now', '-5 seconds') WHERE id = ?").run(consumerRowId);
      const sweeperResult = recoverOrphanedStepsForAgent("consumer", runId, 0);
      assert.equal(sweeperResult.recovered, 1, "sweeper should reset consumer");

      const consumerAfterSweeper = db.prepare("SELECT status, claim_invalidated_by, retry_count FROM steps WHERE id = ?").get(consumerRowId) as { status: string; claim_invalidated_by: string | null; retry_count: number };
      assert.equal(consumerAfterSweeper.status, "pending", "consumer should be pending after sweeper");
      assert.equal(consumerAfterSweeper.claim_invalidated_by, null, "sweeper-reset consumer must have NULL claim_invalidated_by");
      assert.equal(consumerAfterSweeper.retry_count, 1, "sweeper increments retry_count");

      // ── Step 2: Consumer is re-claimed and then fails again ──
      const reclaim = claimStep("consumer", runId, { jobId: "consume-reclaimed", pid: process.pid, pgid: process.pid });
      assert.equal(reclaim.found, true, "consumer must be reclaimable");

      // Now fail it — triggers reroute to produce
      // (consumer still has max_retries=3, retry_count=1, so it can fail again)
      const rerouteResult = await failStep(consumerRowId, "Consumer failed after reclaim");
      assert.equal(rerouteResult.status, "rerouted");

      // ── Step 3: Producer now has claim_invalidated_by='reroute' ──
      const producerAfterReroute = db.prepare("SELECT status, claim_invalidated_by FROM steps WHERE id = ?").get(producerRowId) as { status: string; claim_invalidated_by: string | null };
      assert.equal(producerAfterReroute.status, "pending");
      assert.equal(producerAfterReroute.claim_invalidated_by, "reroute");

      // ── Step 4: Stale completion on rerouted producer is blocked ──
      const staleComplete = completeStep(producerRowId, "STATUS: done\nOUTPUT: stale");
      assert.equal(staleComplete.status, "blocked", "stale completion on rerouted producer must be blocked");

      // ── Step 5: Fresh claim clears marker, fresh completion accepted ──
      const freshClaim = claimStep("producer", runId, { jobId: "fresh-after-sweeper", pid: process.pid, pgid: process.pid });
      assert.equal(freshClaim.found, true, "fresh claim must succeed after fence");

      const produceAfterClaim = db.prepare("SELECT claim_invalidated_by FROM steps WHERE id = ?").get(producerRowId) as { claim_invalidated_by: string | null };
      assert.equal(produceAfterClaim.claim_invalidated_by, null, "fresh claim must clear claim_invalidated_by");

      const freshComplete = completeStep(producerRowId, "STATUS: done\nOUTPUT: fresh-after-everything");
      assert.notEqual(freshComplete.status, "blocked", `fresh completion must be accepted, got: ${JSON.stringify(freshComplete)}`);

      // Pipeline should advance consumer to pending
      const consumerFinal = db.prepare("SELECT status FROM steps WHERE id = ?").get(consumerRowId) as { status: string };
      assert.equal(consumerFinal.status, "pending", "consumer should advance to pending after producer completes");
    });
  });
});
