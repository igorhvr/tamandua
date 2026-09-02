import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { getDb } from "../../dist/db.js";
import {
  claimStep,
  stepCurrent,
  completeStep,
  autoCompleteConditionalStep,
} from "../../dist/installer/step-ops.js";
import { getRunEvents } from "../../dist/installer/events.js";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";

// ── Sticky isolation env ─────────────────────────────────────────────
// claimStep / completeStep / autoCompleteConditionalStep on a terminal path
// fire scheduleRunCronTeardown → fire-and-forget import() continuations
// (removeRunCrons / terminateRunWithDaemon → controlRequest(secret) /
// teardownWorkflowCronsIfIdle → logger), and emitEvent fires a
// fire-and-forget webhook (fireWebhook → getDb), that resolve DB / log /
// daemon-secret paths AFTER the triggering test's afterEach has run.
// Restoring the operator's real env there trips the guard at the REAL
// ~/.tamandua (ledger entries with testFile null, "(unknown)"). Keep HOME /
// TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH pointed at a module-scoped temp dir
// for the whole file: every afterEach below restores to this sticky env
// (never the operator's), and the module after() drains pending
// setImmediates before restoring the originals (tests/step-ops.test.ts
// pattern). The ambient control port is dropped too so controlRequest's
// early guard return fires instead of ever reaching a live daemon.
const stickyState = (() => {
  const root = tamanduaTempDir("tamandua-conditional-sticky-");
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, homeDir, stateDir, dbPath: path.join(stateDir, "tamandua.db") };
})();
const originalHome = process.env.HOME;
const originalStateDir = process.env.TAMANDUA_STATE_DIR;
const originalDbPath = process.env.TAMANDUA_DB_PATH;
const originalControlPort = process.env.TAMANDUA_CONTROL_PORT;

function restoreOrDelete(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function applyStickyEnv(): void {
  process.env.HOME = stickyState.homeDir;
  process.env.TAMANDUA_STATE_DIR = stickyState.stateDir;
  process.env.TAMANDUA_DB_PATH = stickyState.dbPath;
  // Drop the ambient control port (3339 when the suite runs inside a
  // tamandua run): with HOME temp but TAMANDUA_CONTROL_PORT still set,
  // controlRequest would resolve the daemon secret from the temp HOME, pass
  // the guard, and reach a live daemon on that port.
  delete process.env.TAMANDUA_CONTROL_PORT;
}

after(async () => {
  // Drain a few event-loop turns while the sticky temp env is still active:
  // the fire-and-forget teardown/webhook continuations scheduled by the last
  // test land on the module-loader task queue and must resolve their
  // getDb/logger/controlRequest paths against the temp state, not the
  // restored real env.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  restoreOrDelete("HOME", originalHome);
  restoreOrDelete("TAMANDUA_STATE_DIR", originalStateDir);
  restoreOrDelete("TAMANDUA_DB_PATH", originalDbPath);
  restoreOrDelete("TAMANDUA_CONTROL_PORT", originalControlPort);
  try {
    fs.rmSync(stickyState.root, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

/**
 * WAVE-A US-002: a `type: conditional` step must flow through the existing
 * single-step path in claimStep/stepCurrent/completeStep — all type checks
 * in step-ops are `=== "loop"`, so 'conditional' is a single step with an
 * activation condition stored in steps.conditional_condition. The
 * zero-token auto-complete arm is US-003; this suite pins the claim/complete
 * corridor only.
 */
describe("conditional steps claim/complete through the single-step path (US-002)", () => {
  let tempHome: string;
  let stateDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-conditional-");
    stateDir = path.join(tempHome, ".tamandua");
    dbPath = path.join(stateDir, "tamandua.db");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = dbPath;
    // Guard awareness (test-isolation-guard): claim/complete emit events and
    // read the run DB through the same isolated temp state dir this suite
    // creates.
    assert.doesNotThrow(() =>
      assertStatePathIsolation(dbPath, "step-ops-conditional"),
    );
  });

  afterEach(() => {
    // Restore to the module-scoped sticky temp env (NOT the operator's real
    // env): claim/complete/auto-complete fire fire-and-forget continuations
    // (scheduleRunCronTeardown → terminateRunWithDaemon controlRequest(secret),
    // teardownWorkflowCronsIfIdle → logger, emitEvent → fireWebhook getDb)
    // that resolve DB/log/daemon-secret paths after this hook; pointing them
    // at the real ~/.tamandua trips the test-isolation guard with testFile
    // null ("(unknown)" ledger entries).
    applyStickyEnv();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function seedRunAndStep(step: {
    stepId: string;
    type: string;
    conditionalCondition: string | null;
    status: string;
    stepIndex: number;
    agentId: string;
    inputTemplate: string;
    expects: string;
  }, runContext: Record<string, string> = {}): { runId: string; stepDbId: string } {
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepDbId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'conditional task', 'running', ?, ?, ?)",
    ).run(runId, JSON.stringify(runContext), now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 4, ?, ?, ?, ?)`,
    ).run(
      stepDbId,
      runId,
      step.stepId,
      step.agentId,
      step.stepIndex,
      step.inputTemplate,
      step.expects,
      step.status,
      step.type,
      step.conditionalCondition,
      now,
      now,
    );
    return { runId, stepDbId };
  }

  it("claims a pending conditional step through the single-step path", () => {
    const { runId, stepDbId } = seedRunAndStep({
      stepId: "review",
      type: "conditional",
      conditionalCondition: "test_cmd_review_required",
      status: "pending",
      stepIndex: 0,
      agentId: "test-wf_dev",
      inputTemplate: "Review the rewrite\nReply with:\nVERDICT: ACCEPT",
      expects: "VERDICT: ACCEPT",
    });

    const claim = claimStep("test-wf_dev", runId);
    assert.equal(claim.found, true, "conditional step must be claimable");
    assert.equal(claim.stepId, stepDbId);
    assert.ok(claim.resolvedInput.includes("Review the rewrite"));

    const current = stepCurrent("test-wf_dev", runId);
    assert.ok(current, "stepCurrent must return the claimed conditional step");
    assert.equal(current!.stepId, stepDbId);

    const db = getDb();
    const row = db.prepare(
      "SELECT status, type, conditional_condition, auto_completed FROM steps WHERE id = ?",
    ).get(stepDbId) as {
      status: string;
      type: string;
      conditional_condition: string | null;
      auto_completed: number;
    };
    assert.equal(row.status, "running", "claim transitions the step to running");
    assert.equal(row.type, "conditional");
    assert.equal(row.conditional_condition, "test_cmd_review_required");
    assert.equal(row.auto_completed, 0, "an agent claim is never an auto-completion");
  });

  it("completes a claimed conditional step like a single step", () => {
    const { runId, stepDbId } = seedRunAndStep({
      stepId: "review",
      type: "conditional",
      conditionalCondition: "test_cmd_review_required",
      status: "pending",
      stepIndex: 0,
      agentId: "test-wf_dev",
      inputTemplate: "Review the rewrite\nReply with:\nVERDICT: ACCEPT",
      expects: "VERDICT: ACCEPT",
    });

    const claim = claimStep("test-wf_dev", runId);
    assert.equal(claim.found, true);

    const result = completeStep(stepDbId, "VERDICT: ACCEPT");
    assert.ok(
      result.status === "advanced" || result.status === "completed",
      `expected advanced/completed, got ${result.status}`,
    );

    const db = getDb();
    const row = db.prepare(
      "SELECT status, auto_completed FROM steps WHERE id = ?",
    ).get(stepDbId) as { status: string; auto_completed: number };
    assert.equal(row.status, "done");
    assert.equal(row.auto_completed, 0);
  });

  it("advances the pipeline past a conditional step to the next single step", () => {
    const db = getDb();
    const runId = crypto.randomUUID();
    const reviewDbId = crypto.randomUUID();
    const finalizeDbId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'conditional pipeline', 'running', '{}', ?, ?)",
    ).run(runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 4, ?, ?, ?, ?)`,
    ).run(
      reviewDbId, runId, "review", "test-wf_dev", 0,
      "Review the rewrite\nReply with:\nVERDICT: ACCEPT", "VERDICT: ACCEPT",
      "pending", "conditional", "test_cmd_review_required", now, now,
    );
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', 0, 4, 'single', NULL, ?, ?)`,
    ).run(
      finalizeDbId, runId, "finalize", "test-wf_merger", 1,
      "Finalize", "STATUS: done", now, now,
    );

    const claim = claimStep("test-wf_dev", runId);
    assert.equal(claim.found, true);
    assert.equal(claim.stepId, reviewDbId);

    const result = completeStep(reviewDbId, "VERDICT: ACCEPT");
    assert.equal(result.status, "advanced");

    // The downstream single step must now be pending and claimable.
    const next = claimStep("test-wf_merger", runId);
    assert.equal(next.found, true, "pipeline must advance past the conditional step");
    assert.equal(next.stepId, finalizeDbId);
  });
});

// ══════════════════════════════════════════════════════════════════════
// WAVE-A US-003: autoCompleteConditionalStep — zero-token dispatch primitive
// ══════════════════════════════════════════════════════════════════════

describe("autoCompleteConditionalStep — zero-token conditional auto-complete (US-003)", () => {
  let tempHome: string;
  let stateDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-auto-complete-");
    stateDir = path.join(tempHome, ".tamandua");
    dbPath = path.join(stateDir, "tamandua.db");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = dbPath;
    assert.doesNotThrow(() =>
      assertStatePathIsolation(dbPath, "step-ops-auto-complete"),
    );
  });

  afterEach(() => {
    // Restore to the module-scoped sticky temp env (NOT the operator's real
    // env): claim/complete/auto-complete fire fire-and-forget continuations
    // (scheduleRunCronTeardown → terminateRunWithDaemon controlRequest(secret),
    // teardownWorkflowCronsIfIdle → logger, emitEvent → fireWebhook getDb)
    // that resolve DB/log/daemon-secret paths after this hook; pointing them
    // at the real ~/.tamandua trips the test-isolation guard with testFile
    // null ("(unknown)" ledger entries).
    applyStickyEnv();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function seedConditionalStep(overrides: {
    conditionKey?: string;
    runContext?: Record<string, string>;
    status?: string;
    stepIndex?: number;
    agentId?: string;
  } = {}): { runId: string; stepDbId: string } {
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepDbId = crypto.randomUUID();
    const now = new Date().toISOString();
    const conditionKey = overrides.conditionKey ?? "test_cmd_review_required";
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'conditional task', 'running', ?, ?, ?)",
    ).run(runId, JSON.stringify(overrides.runContext ?? {}), now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'review', ?, ?, 'Review', 'VERDICT: ACCEPT', ?, 0, 4, 'conditional', ?, ?, ?)`,
    ).run(
      stepDbId,
      runId,
      overrides.agentId ?? "test-wf_dev",
      overrides.stepIndex ?? 0,
      overrides.status ?? "pending",
      conditionKey,
      now,
      now,
    );
    return { runId, stepDbId };
  }

  it("marks a pending conditional step done with auto_completed=1 and reason 'condition_unset:<key>' when the flag is unset", () => {
    const { runId, stepDbId } = seedConditionalStep({ runContext: {} });

    const outcome = autoCompleteConditionalStep(runId, "test-wf_dev");
    assert.equal(outcome, "auto_completed");

    const db = getDb();
    const row = db.prepare(
      "SELECT status, auto_completed, auto_complete_reason FROM steps WHERE id = ?",
    ).get(stepDbId) as { status: string; auto_completed: number; auto_complete_reason: string | null };
    assert.equal(row.status, "done", "auto-complete must transition the step to done");
    assert.equal(row.auto_completed, 1, "auto-completed marker must be set");
    assert.equal(row.auto_complete_reason, "condition_unset:test_cmd_review_required");
  });

  it("auto-completes when the flag is absent, empty, whitespace, or a falsy literal", () => {
    const cases: Array<Record<string, string>> = [
      {}, // absent
      { test_cmd_review_required: "" },
      { test_cmd_review_required: "   " },
      { test_cmd_review_required: "false" },
      { test_cmd_review_required: "FALSE" },
      { test_cmd_review_required: "0" },
      { test_cmd_review_required: "no" },
      { test_cmd_review_required: "off" },
    ];
    for (const runContext of cases) {
      const { runId, stepDbId } = seedConditionalStep({ runContext });
      const outcome = autoCompleteConditionalStep(runId, "test-wf_dev");
      assert.equal(outcome, "auto_completed", `flag value ${JSON.stringify(runContext)} must auto-complete`);
      const db = getDb();
      const row = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbId) as { status: string };
      assert.equal(row.status, "done");
    }
  });

  it("emits step.auto_completed (stepId, condition, reason, agentId) and step.done", () => {
    const { runId } = seedConditionalStep({ runContext: {} });

    const outcome = autoCompleteConditionalStep(runId, "test-wf_dev");
    assert.equal(outcome, "auto_completed");

    const events = getRunEvents(runId);
    const autoCompleted = events.filter((e) => e.event === "step.auto_completed");
    assert.equal(autoCompleted.length, 1, "exactly one step.auto_completed event");
    assert.equal(autoCompleted[0]!.stepId, "review", "event must carry the workflow-defined step id");
    assert.equal(autoCompleted[0]!.condition, "test_cmd_review_required");
    assert.equal(autoCompleted[0]!.reason, "condition_unset:test_cmd_review_required");
    assert.equal(autoCompleted[0]!.agentId, "test-wf_dev");
    assert.equal(autoCompleted[0]!.runId, runId);

    // Parity with the normal completion lifecycle: step.done is also emitted.
    const done = events.filter((e) => e.event === "step.done");
    assert.equal(done.length, 1, "auto-complete must also emit step.done for lifecycle parity");
    assert.equal(done[0]!.stepId, "review");
  });

  it("returns 'dispatched' and leaves the step pending when the condition is SET (fail-closed)", () => {
    const setValues = ["true", "TRUE", "1", "yes", "on"];
    for (const flagValue of setValues) {
      const { runId, stepDbId } = seedConditionalStep({
        runContext: { test_cmd_review_required: flagValue },
      });

      const outcome = autoCompleteConditionalStep(runId, "test-wf_dev");
      assert.equal(outcome, "dispatched", `flag '${flagValue}' must dispatch, not auto-complete`);

      const db = getDb();
      const row = db.prepare(
        "SELECT status, auto_completed, auto_complete_reason FROM steps WHERE id = ?",
      ).get(stepDbId) as { status: string; auto_completed: number; auto_complete_reason: string | null };
      assert.equal(row.status, "pending", "a SET condition must leave the step pending");
      assert.equal(row.auto_completed, 0);
      assert.equal(row.auto_complete_reason, null);
    }
  });

  it("fail-closed arm: a conditional step with the condition SET can never be auto-completed", () => {
    const { runId, stepDbId } = seedConditionalStep({
      runContext: { test_cmd_review_required: "true" },
    });

    // Repeated calls (as a bounded dispatch sweep would make) must never
    // flip the step to auto-completed while the flag stays set.
    for (let i = 0; i < 5; i++) {
      assert.equal(autoCompleteConditionalStep(runId, "test-wf_dev"), "dispatched");
    }

    const db = getDb();
    const row = db.prepare(
      "SELECT status, auto_completed FROM steps WHERE id = ?",
    ).get(stepDbId) as { status: string; auto_completed: number };
    assert.equal(row.status, "pending");
    assert.equal(row.auto_completed, 0, "a SET condition must NEVER be auto-completed");

    const events = getRunEvents(runId);
    assert.equal(events.filter((e) => e.event === "step.auto_completed").length, 0);
  });

  it("never auto-completes non-conditional (single/loop) steps", () => {
    // Single step
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepDbId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'task', 'running', '{}', ?, ?)",
    ).run(runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'impl', 'test-wf_dev', 0, 'do it', 'STATUS: done', 'pending', 0, 4, 'single', NULL, ?, ?)`,
    ).run(stepDbId, runId, now, now);

    assert.equal(autoCompleteConditionalStep(runId, "test-wf_dev"), "none");
    assert.equal(
      (db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbId) as { status: string }).status,
      "pending",
    );

    // Loop step
    const runId2 = crypto.randomUUID();
    const loopDbId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'task', 'running', '{}', ?, ?)",
    ).run(runId2, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'loop', 'test-wf_dev', 0, 'do stories', 'STORIES_JSON', 'pending', 0, 4, 'loop', NULL, ?, ?)`,
    ).run(loopDbId, runId2, now, now);

    assert.equal(autoCompleteConditionalStep(runId2, "test-wf_dev"), "none");
    assert.equal(
      (db.prepare("SELECT status FROM steps WHERE id = ?").get(loopDbId) as { status: string }).status,
      "pending",
    );
  });

  it("returns 'none' when no conditional step is pending", () => {
    // Conditional step that is waiting (upstream-blocked) is not pending.
    const waiting = seedConditionalStep({ status: "waiting" });
    assert.equal(autoCompleteConditionalStep(waiting.runId, "test-wf_dev"), "none");

    // A conditional step whose condition is SET is pending but must dispatch,
    // never 'none' — the sweep needs to distinguish and fall through to spawn.
    const dispatched = seedConditionalStep({ runContext: { test_cmd_review_required: "true" } });
    assert.equal(autoCompleteConditionalStep(dispatched.runId, "test-wf_dev"), "dispatched");
  });

  it("fail-closed: a conditional step with no declared condition is dispatched, never auto-completed", () => {
    const { runId, stepDbId } = seedConditionalStep({ conditionKey: "" });

    assert.equal(autoCompleteConditionalStep(runId, "test-wf_dev"), "dispatched");

    const db = getDb();
    const row = db.prepare("SELECT status, auto_completed FROM steps WHERE id = ?").get(stepDbId) as {
      status: string;
      auto_completed: number;
    };
    assert.equal(row.status, "pending");
    assert.equal(row.auto_completed, 0);
  });

  it("does not auto-complete a pending conditional step with an incomplete upstream step (serial order)", () => {
    const db = getDb();
    const runId = crypto.randomUUID();
    const upstreamDbId = crypto.randomUUID();
    const reviewDbId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'task', 'running', '{}', ?, ?)",
    ).run(runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'impl', 'test-wf_dev', 0, 'do it', 'STATUS: done', 'pending', 0, 4, 'single', NULL, ?, ?)`,
    ).run(upstreamDbId, runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'review', 'test-wf_dev', 1, 'Review', 'VERDICT: ACCEPT', 'pending', 0, 4, 'conditional', 'test_cmd_review_required', ?, ?)`,
    ).run(reviewDbId, runId, now, now);

    // The conditional step is 'pending' in the DB but its upstream is not
    // done — it is not actually claimable, so it must not be auto-completed.
    assert.equal(autoCompleteConditionalStep(runId, "test-wf_dev"), "none");
    const row = db.prepare("SELECT status, auto_completed FROM steps WHERE id = ?").get(reviewDbId) as {
      status: string;
      auto_completed: number;
    };
    assert.equal(row.status, "pending");
    assert.equal(row.auto_completed, 0);
  });

  it("advances the pipeline after auto-complete so the next step becomes claimable", () => {
    const db = getDb();
    const runId = crypto.randomUUID();
    const reviewDbId = crypto.randomUUID();
    const finalizeDbId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'conditional pipeline', 'running', '{}', ?, ?)",
    ).run(runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'review', 'test-wf_dev', 0, 'Review', 'VERDICT: ACCEPT', 'pending', 0, 4, 'conditional', 'test_cmd_review_required', ?, ?)`,
    ).run(reviewDbId, runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'finalize', 'test-wf_merger', 1, 'Finalize', 'STATUS: done', 'waiting', 0, 4, 'single', NULL, ?, ?)`,
    ).run(finalizeDbId, runId, now, now);

    const outcome = autoCompleteConditionalStep(runId, "test-wf_dev");
    assert.equal(outcome, "auto_completed");

    // The downstream single step must now be pending and claimable.
    const next = claimStep("test-wf_merger", runId);
    assert.equal(next.found, true, "pipeline must advance past the auto-completed step");
    assert.equal(next.stepId, finalizeDbId);
  });

  it("completes the run when the auto-completed conditional step was the last step", () => {
    const { runId } = seedConditionalStep({ runContext: {} });

    const outcome = autoCompleteConditionalStep(runId, "test-wf_dev");
    assert.equal(outcome, "auto_completed");

    const db = getDb();
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "completed", "auto-completing the last step must complete the run");

    const events = getRunEvents(runId);
    assert.ok(events.some((e) => e.event === "run.completed"), "run.completed must be emitted");
  });
});

// ══════════════════════════════════════════════════════════════════════
// WAVE-A US-004: TEST_CMD establishment + rewrite detection
// ══════════════════════════════════════════════════════════════════════

describe("TEST_CMD establishment + rewrite detection (US-004)", () => {
  let tempHome: string;
  let stateDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-tcmd-");
    stateDir = path.join(tempHome, ".tamandua");
    dbPath = path.join(stateDir, "tamandua.db");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = dbPath;
    assert.doesNotThrow(() =>
      assertStatePathIsolation(dbPath, "step-ops-tcmd"),
    );
  });

  afterEach(() => {
    // Restore to the module-scoped sticky temp env (NOT the operator's real
    // env): claim/complete/auto-complete fire fire-and-forget continuations
    // (scheduleRunCronTeardown → terminateRunWithDaemon controlRequest(secret),
    // teardownWorkflowCronsIfIdle → logger, emitEvent → fireWebhook getDb)
    // that resolve DB/log/daemon-secret paths after this hook; pointing them
    // at the real ~/.tamandua trips the test-isolation guard with testFile
    // null ("(unknown)" ledger entries).
    applyStickyEnv();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /** Seed one run + one pending single step with optional established contract. */
  function seedTcmdRun(overrides: {
    runContext?: Record<string, string>;
    testCmdEstablished?: string | null;
    testCmdSource?: string | null;
    runNumber?: number;
    stepId?: string;
    stepIndex?: number;
    retryCount?: number;
    expects?: string;
  }): { runId: string; stepDbId: string } {
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepDbId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, run_number, test_cmd_established, test_cmd_source, created_at, updated_at) VALUES (?, 'test-wf', 'tcmd task', 'running', ?, ?, ?, ?, ?, ?)",
    ).run(
      runId,
      JSON.stringify(overrides.runContext ?? {}),
      overrides.runNumber ?? 1,
      overrides.testCmdEstablished ?? null,
      overrides.testCmdSource ?? null,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 4, 'single', NULL, ?, ?)`,
    ).run(
      stepDbId,
      runId,
      overrides.stepId ?? "setup",
      "test-wf_dev",
      overrides.stepIndex ?? 0,
      "Run the task",
      overrides.expects ?? "STATUS: done",
      overrides.retryCount ?? 0,
      now,
      now,
    );
    return { runId, stepDbId };
  }

  function readRun(runId: string): {
    context: Record<string, string>;
    test_cmd_established: string | null;
    test_cmd_source: string | null;
  } {
    const db = getDb();
    const row = db.prepare(
      "SELECT context, test_cmd_established, test_cmd_source FROM runs WHERE id = ?",
    ).get(runId) as {
      context: string;
      test_cmd_established: string | null;
      test_cmd_source: string | null;
    };
    return {
      context: JSON.parse(row.context) as Record<string, string>,
      test_cmd_established: row.test_cmd_established,
      test_cmd_source: row.test_cmd_source,
    };
  }

  it("launch-declared test_cmd is the contract (source 'launch'); a first equal marker is not a rewrite", () => {
    const { runId, stepDbId } = seedTcmdRun({
      runContext: { test_cmd: "npm test" },
      testCmdEstablished: "npm test",
      testCmdSource: "launch",
    });

    const claim = claimStep("test-wf_dev", runId);
    assert.equal(claim.found, true);
    const result = completeStep(stepDbId, "STATUS: done\nTEST_CMD: npm test");
    assert.ok(
      result.status === "advanced" || result.status === "completed",
      `expected advanced/completed, got ${result.status}`,
    );

    const run = readRun(runId);
    assert.equal(run.test_cmd_established, "npm test");
    assert.equal(run.test_cmd_source, "launch", "launch declaration must keep source 'launch'");
    assert.equal(run.context.test_cmd, "npm test");
    assert.equal(run.context.test_cmd_raw, "npm test");
    assert.ok(
      !("test_cmd_review_required" in run.context),
      "an equal marker must not set the review flag",
    );

    const events = getRunEvents(runId);
    assert.ok(
      !events.some((e) => e.event === "test_cmd.rewrite_detected"),
      "a first step marker equal to the launch-declared contract is not a rewrite",
    );
  });

  it("first step-emitted TEST_CMD (no launch declaration) establishes the contract with source = step id and merges into context", () => {
    const { runId, stepDbId } = seedTcmdRun({ stepId: "setup" });

    const claim = claimStep("test-wf_dev", runId);
    assert.equal(claim.found, true);
    const result = completeStep(stepDbId, "STATUS: done\nTEST_CMD: npm test");
    assert.ok(
      result.status === "advanced" || result.status === "completed",
      `expected advanced/completed, got ${result.status}`,
    );

    const run = readRun(runId);
    assert.equal(run.test_cmd_established, "npm test");
    assert.equal(run.test_cmd_source, "setup", "first-write establishment source must be the step id");
    assert.equal(run.context.test_cmd, "npm test");
    assert.equal(run.context.test_cmd_raw, "npm test");
    assert.ok(!("test_cmd_review_required" in run.context));

    const events = getRunEvents(runId);
    assert.ok(!events.some((e) => e.event === "test_cmd.rewrite_detected"));
  });

  it("a later differing TEST_CMD marker does NOT replace the contract; emits rewrite_detected {old,new,step,round} and sets the review flag", () => {
    const { runId, stepDbId } = seedTcmdRun({
      runContext: { test_cmd: "npm test", test_cmd_raw: "npm test" },
      testCmdEstablished: "npm test",
      testCmdSource: "launch",
      stepId: "implement",
      stepIndex: 1,
    });

    const claim = claimStep("test-wf_dev", runId);
    assert.equal(claim.found, true);
    const result = completeStep(stepDbId, "STATUS: done\nTEST_CMD: npm run build");
    assert.ok(
      result.status === "advanced" || result.status === "completed",
      `expected advanced/completed, got ${result.status}`,
    );

    const run = readRun(runId);
    assert.equal(run.test_cmd_established, "npm test", "the established contract must not be replaced");
    assert.equal(run.test_cmd_source, "launch");
    assert.equal(run.context.test_cmd, "npm test", "context.test_cmd must not be overwritten by the new marker");
    assert.equal(run.context.test_cmd_raw, "npm test", "context.test_cmd_raw must not be overwritten by the new marker");
    assert.equal(run.context.test_cmd_review_required, "true");
    // US-005: the review material is persisted so the conditional test_cmd_review
    // step's input can render both the established contract and the candidate.
    assert.equal(run.context.test_cmd_review_established, "npm test", "review material must carry the established command");
    assert.equal(run.context.test_cmd_review_candidate, "npm run build", "review material must carry the proposed command");

    const events = getRunEvents(runId);
    const rewrite = events.find((e) => e.event === "test_cmd.rewrite_detected");
    assert.ok(rewrite, "test_cmd.rewrite_detected must be emitted");
    assert.equal(rewrite.oldTestCmd, "npm test");
    assert.equal(rewrite.newTestCmd, "npm run build");
    assert.equal(rewrite.stepId, "implement");
    assert.equal(rewrite.round, 1, "first attempt round");
    assert.equal(rewrite.runNumber, 1);
  });

  it("re-emitting the identical value is not a rewrite", () => {
    const db = getDb();
    const runId = crypto.randomUUID();
    const step1DbId = crypto.randomUUID();
    const step2DbId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, run_number, created_at, updated_at) VALUES (?, 'test-wf', 'tcmd task', 'running', '{}', 1, ?, ?)",
    ).run(runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'setup', 'test-wf_dev', 0, 'Run', 'STATUS: done', 'pending', 0, 4, 'single', NULL, ?, ?)`,
    ).run(step1DbId, runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'implement', 'test-wf_dev', 1, 'Run', 'STATUS: done', 'pending', 0, 4, 'single', NULL, ?, ?)`,
    ).run(step2DbId, runId, now, now);

    // Step 1 establishes the contract (source = step id).
    const claim1 = claimStep("test-wf_dev", runId);
    assert.equal(claim1.found, true);
    assert.equal(claim1.stepId, step1DbId);
    completeStep(step1DbId, "STATUS: done\nTEST_CMD: npm test");

    // Step 2 re-emits the identical value — not a rewrite.
    const claim2 = claimStep("test-wf_dev", runId);
    assert.equal(claim2.found, true);
    assert.equal(claim2.stepId, step2DbId);
    const result = completeStep(step2DbId, "STATUS: done\nTEST_CMD: npm test");
    assert.ok(
      result.status === "advanced" || result.status === "completed",
      `expected advanced/completed, got ${result.status}`,
    );

    const run = readRun(runId);
    assert.equal(run.test_cmd_established, "npm test");
    assert.equal(run.test_cmd_source, "setup");
    assert.equal(run.context.test_cmd, "npm test");
    assert.ok(!("test_cmd_review_required" in run.context));

    const events = getRunEvents(runId);
    assert.ok(
      !events.some((e) => e.event === "test_cmd.rewrite_detected"),
      "re-emitting the identical value must not be a rewrite",
    );
  });

  it("TSTX-PQ: rejects TEST_CMD values that echo the tamandua-test shim wrapper", () => {
    const { runId, stepDbId } = seedTcmdRun({
      runContext: { test_cmd: "npm test", test_cmd_raw: "npm test" },
      testCmdEstablished: "npm test",
      testCmdSource: "launch",
      stepId: "implement",
    });

    const claim = claimStep("test-wf_dev", runId);
    assert.equal(claim.found, true);
    completeStep(
      stepDbId,
      "STATUS: done\nTEST_CMD: tamandua-test --repo /repo --run run-1 --step implement -- npm test",
    );

    const run = readRun(runId);
    assert.equal(run.test_cmd_established, "npm test");
    assert.equal(run.context.test_cmd, "npm test", "shim echo must not overwrite context.test_cmd");
    assert.equal(run.context.test_cmd_raw, "npm test");
    assert.ok(!("test_cmd_review_required" in run.context));

    const events = getRunEvents(runId);
    assert.ok(
      !events.some((e) => e.event === "test_cmd.rewrite_detected"),
      "a rejected shim echo must not be treated as a rewrite",
    );
  });

  it("trivially-equivalent forms still trigger detection (no equivalence engine in the detector)", () => {
    const { runId, stepDbId } = seedTcmdRun({
      runContext: { test_cmd: "npm test", test_cmd_raw: "npm test" },
      testCmdEstablished: "npm test",
      testCmdSource: "launch",
      stepId: "implement",
    });

    const claim = claimStep("test-wf_dev", runId);
    assert.equal(claim.found, true);
    // A quoted form is trivially equivalent to a human but a different string —
    // the detector must not build an equivalence engine; the reviewer's
    // fast-path handles equivalence.
    completeStep(stepDbId, 'STATUS: done\nTEST_CMD: "npm test"');

    const run = readRun(runId);
    assert.equal(run.test_cmd_established, "npm test", "contract must not be replaced by a trivially-equivalent form");
    assert.equal(run.context.test_cmd, "npm test");
    assert.equal(run.context.test_cmd_review_required, "true");

    const events = getRunEvents(runId);
    const rewrite = events.find((e) => e.event === "test_cmd.rewrite_detected");
    assert.ok(rewrite, "a trivially-equivalent form must still be detected");
    assert.equal(rewrite.newTestCmd, '"npm test"');
  });

  it("a second differing marker is detected against the still-established contract", () => {
    const db = getDb();
    const runId = crypto.randomUUID();
    const step1DbId = crypto.randomUUID();
    const step2DbId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, run_number, test_cmd_established, test_cmd_source, created_at, updated_at) VALUES (?, 'test-wf', 'tcmd task', 'running', ?, 1, 'npm test', 'launch', ?, ?)",
    ).run(runId, JSON.stringify({ test_cmd: "npm test", test_cmd_raw: "npm test" }), now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'setup', 'test-wf_dev', 0, 'Run', 'STATUS: done', 'pending', 0, 4, 'single', NULL, ?, ?)`,
    ).run(step1DbId, runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'implement', 'test-wf_dev', 1, 'Run', 'STATUS: done', 'pending', 0, 4, 'single', NULL, ?, ?)`,
    ).run(step2DbId, runId, now, now);

    claimStep("test-wf_dev", runId);
    completeStep(step1DbId, "STATUS: done\nTEST_CMD: npm run build");
    claimStep("test-wf_dev", runId);
    completeStep(step2DbId, "STATUS: done\nTEST_CMD: npm run lint");

    const run = readRun(runId);
    assert.equal(run.test_cmd_established, "npm test", "the contract is never replaced by a rewrite");
    assert.equal(run.context.test_cmd, "npm test");
    assert.equal(run.context.test_cmd_review_required, "true");

    const rewrites = getRunEvents(runId).filter((e) => e.event === "test_cmd.rewrite_detected");
    assert.equal(rewrites.length, 2, "each differing marker is detected");
    assert.equal(rewrites[0]!.oldTestCmd, "npm test");
    assert.equal(rewrites[0]!.newTestCmd, "npm run build");
    assert.equal(rewrites[1]!.oldTestCmd, "npm test");
    assert.equal(rewrites[1]!.newTestCmd, "npm run lint");
  });

  it("rewrite event round reflects the step's attempt (retry_count + 1)", () => {
    const { runId, stepDbId } = seedTcmdRun({
      runContext: { test_cmd: "npm test", test_cmd_raw: "npm test" },
      testCmdEstablished: "npm test",
      testCmdSource: "launch",
      stepId: "implement",
      retryCount: 2,
    });

    claimStep("test-wf_dev", runId);
    completeStep(stepDbId, "STATUS: done\nTEST_CMD: npm run build");

    const events = getRunEvents(runId);
    const rewrite = events.find((e) => e.event === "test_cmd.rewrite_detected");
    assert.ok(rewrite, "test_cmd.rewrite_detected must be emitted");
    assert.equal(rewrite.round, 3, "round = retry_count + 1");
    assert.equal(rewrite.runNumber, 1);
  });

  it("falls back to context values as the current contract when the established columns are unset (pre-column runs)", () => {
    const { runId, stepDbId } = seedTcmdRun({
      // Launch-declared contract in an old run: context carries it, columns NULL.
      runContext: { test_cmd: "npm test", test_cmd_raw: "npm test" },
      testCmdEstablished: null,
      testCmdSource: null,
      stepId: "setup",
    });

    claimStep("test-wf_dev", runId);
    const result = completeStep(stepDbId, "STATUS: done\nTEST_CMD: npm test");
    assert.ok(
      result.status === "advanced" || result.status === "completed",
      `expected advanced/completed, got ${result.status}`,
    );

    const run = readRun(runId);
    assert.equal(run.context.test_cmd, "npm test");
    assert.ok(!("test_cmd_review_required" in run.context));

    const events = getRunEvents(runId);
    assert.ok(
      !events.some((e) => e.event === "test_cmd.rewrite_detected"),
      "an identical marker must not be a rewrite even without the established columns",
    );
  });

  it("records the proposing step as test_cmd_rewriter_step when a rewrite is detected (US-006)", () => {
    const { runId, stepDbId } = seedTcmdRun({
      runContext: { test_cmd: "npm test", test_cmd_raw: "npm test" },
      testCmdEstablished: "npm test",
      testCmdSource: "launch",
      stepId: "implement",
    });

    claimStep("test-wf_dev", runId);
    completeStep(stepDbId, "STATUS: done\nTEST_CMD: npm run build");

    const run = readRun(runId);
    assert.equal(run.context.test_cmd_rewriter_step, "implement",
      "the detector must record which step proposed the rewrite");
    assert.equal(run.context.test_cmd_review_required, "true");
  });
});

// ══════════════════════════════════════════════════════════════════════
// WAVE-A US-006: Reviewer verdict routing — ACCEPT adopts the contract;
// REJECT re-pends the rewriting step with the FINDING as feedback
// ══════════════════════════════════════════════════════════════════════

describe("test_cmd_review verdict routing (US-006)", () => {
  let tempHome: string;
  let stateDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-review-route-");
    stateDir = path.join(tempHome, ".tamandua");
    dbPath = path.join(stateDir, "tamandua.db");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = dbPath;
    assert.doesNotThrow(() =>
      assertStatePathIsolation(dbPath, "step-ops-review-route"),
    );
  });

  afterEach(() => {
    // Restore to the module-scoped sticky temp env (NOT the operator's real
    // env): claim/complete/auto-complete fire fire-and-forget continuations
    // (scheduleRunCronTeardown → terminateRunWithDaemon controlRequest(secret),
    // teardownWorkflowCronsIfIdle → logger, emitEvent → fireWebhook getDb)
    // that resolve DB/log/daemon-secret paths after this hook; pointing them
    // at the real ~/.tamandua trips the test-isolation guard with testFile
    // null ("(unknown)" ledger entries).
    applyStickyEnv();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /** Seed a run with an established contract, review material, and a reviewer step. */
  function seedReviewRun(overrides: {
    runContext?: Record<string, string>;
    testCmdEstablished?: string | null;
    testCmdSource?: string | null;
    reviewerRerouteCount?: number;
    reviewerRetryCount?: number;
    rewriterInputTemplate?: string;
  } = {}): { runId: string; reviewerDbId: string; rewriterDbId: string; finalizeDbId: string } {
    const db = getDb();
    const runId = crypto.randomUUID();
    const rewriterDbId = crypto.randomUUID();
    const reviewerDbId = crypto.randomUUID();
    const finalizeDbId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, run_number, test_cmd_established, test_cmd_source, created_at, updated_at) VALUES (?, 'test-wf', 'tcmd review task', 'running', ?, 1, ?, ?, ?, ?)",
    ).run(
      runId,
      JSON.stringify(overrides.runContext ?? {
        test_cmd: "npm test",
        test_cmd_raw: "npm test",
        test_cmd_review_required: "true",
        test_cmd_review_established: "npm test",
        test_cmd_review_candidate: "npm run build",
        test_cmd_rewriter_step: "setup",
      }),
      overrides.testCmdEstablished ?? "npm test",
      overrides.testCmdSource ?? "launch",
      now,
      now,
    );
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'setup', 'test-wf_dev', 0, ?, 'STATUS: done', 'done', 0, 4, 'single', NULL, ?, ?)`,
    ).run(
      rewriterDbId,
      runId,
      overrides.rewriterInputTemplate ?? "Setup\nRETRY FEEDBACK:\n{{retry_feedback}}",
      now,
      now,
    );
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, reroute_count, created_at, updated_at)
       VALUES (?, ?, 'test_cmd_review', 'test-wf_reviewer', 1, 'Review', 'STATUS: done\nregex:^VERDICT:\\s*(ACCEPT|REJECT)', 'pending', ?, 4, 'conditional', 'test_cmd_review_required', ?, ?, ?)`,
    ).run(
      reviewerDbId,
      runId,
      overrides.reviewerRetryCount ?? 0,
      overrides.reviewerRerouteCount ?? 0,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'finalize', 'test-wf_merger', 2, 'Finalize', 'STATUS: done', 'waiting', 0, 4, 'single', NULL, ?, ?)`,
    ).run(finalizeDbId, runId, now, now);
    return { runId, reviewerDbId, rewriterDbId, finalizeDbId };
  }

  function readRunContext(runId: string): Record<string, string> {
    const db = getDb();
    const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
    return JSON.parse(row.context) as Record<string, string>;
  }

  it("ACCEPT: adopts the reviewed command as the contract, clears the review flag, and emits test_cmd.review_accepted", () => {
    const { runId, reviewerDbId, finalizeDbId } = seedReviewRun();

    const claim = claimStep("test-wf_reviewer", runId);
    assert.equal(claim.found, true, "dispatched review must be claimable");
    const result = completeStep(reviewerDbId, "STATUS: done\nVERDICT: ACCEPT");
    assert.equal(result.status, "advanced");

    const db = getDb();
    const run = db.prepare(
      "SELECT context, test_cmd_established, test_cmd_source FROM runs WHERE id = ?",
    ).get(runId) as { context: string; test_cmd_established: string | null; test_cmd_source: string | null };
    assert.equal(run.test_cmd_established, "npm run build", "the reviewed command must become the contract");
    assert.equal(run.test_cmd_source, "reviewer");

    const ctx = JSON.parse(run.context) as Record<string, string>;
    assert.equal(ctx.test_cmd, "npm run build", "context.test_cmd must switch to the reviewed command");
    assert.equal(ctx.test_cmd_raw, "npm run build");
    assert.ok(!("test_cmd_review_required" in ctx), "ACCEPT must clear the review flag");
    assert.ok(!("test_cmd_rewriter_step" in ctx));
    // Review material stays for US-007 landing annotations (old+new commands).
    assert.equal(ctx.test_cmd_review_established, "npm test");
    assert.equal(ctx.test_cmd_review_candidate, "npm run build");

    const reviewRow = db.prepare("SELECT status, auto_completed FROM steps WHERE id = ?").get(reviewerDbId) as {
      status: string;
      auto_completed: number;
    };
    assert.equal(reviewRow.status, "done", "ACCEPT falls through to normal completion");
    assert.equal(reviewRow.auto_completed, 0);

    const events = getRunEvents(runId);
    const accepted = events.find((e) => e.event === "test_cmd.review_accepted");
    assert.ok(accepted, "test_cmd.review_accepted must be emitted");
    assert.equal(accepted!.oldTestCmd, "npm test");
    assert.equal(accepted!.newTestCmd, "npm run build");
    assert.equal(accepted!.stepId, "test_cmd_review");

    // Pipeline advances to finalize_merge.
    const next = claimStep("test-wf_merger", runId);
    assert.equal(next.found, true);
    assert.equal(next.stepId, finalizeDbId);
  });

  it("REJECT: re-pends the rewriting step with the FINDING as feedback; review flag stays set; rejection event emitted", () => {
    const { runId, reviewerDbId, rewriterDbId } = seedReviewRun();

    const claim = claimStep("test-wf_reviewer", runId);
    assert.equal(claim.found, true);
    const result = completeStep(
      reviewerDbId,
      "STATUS: done\nVERDICT: REJECT\nFINDING: unjustified-narrowing: the proposed command drops the integration suite",
    );
    assert.equal(result.status, "rerouted");

    const db = getDb();
    const rewriter = db.prepare(
      "SELECT status, output, claim_invalidated_by FROM steps WHERE id = ?",
    ).get(rewriterDbId) as { status: string; output: string | null; claim_invalidated_by: string | null };
    assert.equal(rewriter.status, "pending", "the rewriting step must be re-pended");
    assert.match(rewriter.output ?? "", /FINDING: unjustified-narrowing/,
      "the FINDING must be transported as retry feedback");
    assert.equal(rewriter.claim_invalidated_by, "reroute");

    const reviewer = db.prepare(
      "SELECT status, retry_count, reroute_count FROM steps WHERE id = ?",
    ).get(reviewerDbId) as { status: string; retry_count: number; reroute_count: number };
    assert.equal(reviewer.status, "waiting", "the reviewer resets to waiting so it re-runs after the rewrite is fixed");
    assert.equal(reviewer.reroute_count, 1, "one rejection consumes one reroute budget slot");

    const ctx = readRunContext(runId);
    assert.equal(ctx.test_cmd_review_required, "true", "REJECT must keep the review flag set");
    assert.equal(ctx.test_cmd_review_candidate, "npm run build");

    const events = getRunEvents(runId);
    const rejected = events.find((e) => e.event === "test_cmd.review_rejected");
    assert.ok(rejected, "test_cmd.review_rejected must be emitted");
    assert.equal(rejected!.oldTestCmd, "npm test");
    assert.equal(rejected!.newTestCmd, "npm run build");
    assert.equal(rejected!.stepId, "test_cmd_review");
    assert.match(rejected!.finding ?? "", /unjustified-narrowing/);
    assert.ok(events.some((e) => e.event === "step.rerouted"), "the shared reroute machinery must emit step.rerouted");
  });

  it("REJECT: the re-pended rewriter's next claim surfaces the FINDING via retry_feedback", () => {
    const { runId, reviewerDbId, rewriterDbId } = seedReviewRun();

    claimStep("test-wf_reviewer", runId);
    completeStep(
      reviewerDbId,
      "STATUS: done\nVERDICT: REJECT\nFINDING: task-evasion: the new command skips unit tests",
    );

    // The rewriting step (setup) is now the only claimable step.
    const claim = claimStep("test-wf_dev", runId);
    assert.equal(claim.found, true);
    assert.equal(claim.stepId, rewriterDbId);
    assert.match(claim.resolvedInput, /PREVIOUS ATTEMPT FEEDBACK/);
    assert.match(claim.resolvedInput, /task-evasion: the new command skips unit tests/);
  });

  it("accumulated rejections exhaust the reroute budget and fail the run legibly (no infinite loop)", () => {
    // test-wf declares no on_fail, so max_reroutes defaults to 2; seeding
    // reroute_count = 2 means the next REJECT hits the budget ceiling.
    const { runId, reviewerDbId } = seedReviewRun({ reviewerRerouteCount: 2 });

    const claim = claimStep("test-wf_reviewer", runId);
    assert.equal(claim.found, true);
    const result = completeStep(reviewerDbId, "STATUS: done\nVERDICT: REJECT\nFINDING: no-mechanism");
    assert.equal(result.status, "failed");

    const db = getDb();
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "the run must fail when rejections exhaust the reroute budget");
    const review = db.prepare("SELECT status FROM steps WHERE id = ?").get(reviewerDbId) as { status: string };
    assert.equal(review.status, "failed");

    const events = getRunEvents(runId);
    assert.ok(events.some((e) => e.event === "run.failed"), "run.failed must be emitted");
    assert.ok(events.some((e) => e.event === "test_cmd.review_rejected"),
      "the final rejection is still recorded");
  });

  it("withdrawal: the flagged rewriter re-emitting the established contract clears the review state", () => {
    const db = getDb();
    const runId = crypto.randomUUID();
    const rewriterDbId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, run_number, test_cmd_established, test_cmd_source, created_at, updated_at) VALUES (?, 'test-wf', 'tcmd', 'running', ?, 1, 'npm test', 'launch', ?, ?)",
    ).run(
      runId,
      JSON.stringify({
        test_cmd: "npm test",
        test_cmd_raw: "npm test",
        test_cmd_review_required: "true",
        test_cmd_review_established: "npm test",
        test_cmd_review_candidate: "npm run build",
        test_cmd_rewriter_step: "setup",
      }),
      now,
      now,
    );
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'setup', 'test-wf_dev', 0, 'Setup', 'STATUS: done', 'pending', 0, 4, 'single', NULL, ?, ?)`,
    ).run(rewriterDbId, runId, now, now);

    const claim = claimStep("test-wf_dev", runId);
    assert.equal(claim.found, true);
    completeStep(rewriterDbId, "STATUS: done\nTEST_CMD: npm test");

    const ctx = readRunContext(runId);
    assert.ok(!("test_cmd_review_required" in ctx), "withdrawal must clear the review flag");
    assert.ok(!("test_cmd_review_candidate" in ctx));
    assert.ok(!("test_cmd_review_established" in ctx));
    assert.ok(!("test_cmd_rewriter_step" in ctx));
    assert.equal(ctx.test_cmd, "npm test");

    const events = getRunEvents(runId);
    assert.ok(!events.some((e) => e.event === "test_cmd.rewrite_detected"),
      "re-emitting the established value is not a rewrite");
  });

  it("a different step re-emitting the established contract does NOT clear a pending review", () => {
    const db = getDb();
    const runId = crypto.randomUUID();
    const otherDbId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, run_number, test_cmd_established, test_cmd_source, created_at, updated_at) VALUES (?, 'test-wf', 'tcmd', 'running', ?, 1, 'npm test', 'launch', ?, ?)",
    ).run(
      runId,
      JSON.stringify({
        test_cmd: "npm test",
        test_cmd_raw: "npm test",
        test_cmd_review_required: "true",
        test_cmd_review_established: "npm test",
        test_cmd_review_candidate: "npm run build",
        test_cmd_rewriter_step: "setup",
      }),
      now,
      now,
    );
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'verify', 'test-wf_verifier', 0, 'Verify', 'STATUS: done', 'pending', 0, 4, 'single', NULL, ?, ?)`,
    ).run(otherDbId, runId, now, now);

    const claim = claimStep("test-wf_verifier", runId);
    assert.equal(claim.found, true);
    completeStep(otherDbId, "STATUS: done\nTEST_CMD: npm test");

    const ctx = readRunContext(runId);
    assert.equal(ctx.test_cmd_review_required, "true",
      "only the flagged rewriter's withdrawal clears the review");
    assert.equal(ctx.test_cmd_review_candidate, "npm run build");
    assert.equal(ctx.test_cmd_rewriter_step, "setup");
  });

  it("a test_cmd_review completed WITHOUT the review flag is not routed (falls through to normal completion)", () => {
    // Mirrors manual smoke flows / auto-complete-equivalent paths where the
    // conditional reviewer step is completed with the default ACCEPT verdict
    // but no rewrite was ever flagged.
    const { runId, reviewerDbId, finalizeDbId } = seedReviewRun({
      runContext: { test_cmd: "npm test", test_cmd_raw: "npm test" },
    });

    const claim = claimStep("test-wf_reviewer", runId);
    assert.equal(claim.found, true);
    const result = completeStep(reviewerDbId, "STATUS: done\nVERDICT: ACCEPT");
    assert.equal(result.status, "advanced");

    const db = getDb();
    const run = db.prepare(
      "SELECT context, test_cmd_established, test_cmd_source FROM runs WHERE id = ?",
    ).get(runId) as { context: string; test_cmd_established: string | null; test_cmd_source: string | null };
    assert.equal(run.test_cmd_established, "npm test", "no flag -> no adoption; contract unchanged");
    assert.equal(run.test_cmd_source, "launch");

    const events = getRunEvents(runId);
    assert.ok(!events.some((e) => e.event === "test_cmd.review_accepted"),
      "an unflagged review completion must not emit review_accepted");

    const next = claimStep("test-wf_merger", runId);
    assert.equal(next.found, true);
    assert.equal(next.stepId, finalizeDbId);
  });
});

// ══════════════════════════════════════════════════════════════════════
// WAVE-A TCMD US-007: gate coupling — finalize_merge refuses while a
// TEST_CMD review is pending or rejected; landing annotations name the
// old + new commands after a reviewed rewrite.
// ══════════════════════════════════════════════════════════════════════
describe("finalize_merge gate coupling with TEST_CMD review (US-007)", () => {
  let tempHome: string;
  let stateDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-conditional-us007-");
    stateDir = path.join(tempHome, ".tamandua");
    dbPath = path.join(stateDir, "tamandua.db");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = dbPath;
    assert.doesNotThrow(() =>
      assertStatePathIsolation(dbPath, "step-ops-conditional-us007"),
    );
  });

  afterEach(() => {
    // Restore to the module-scoped sticky temp env (NOT the operator's real
    // env): claim/complete/auto-complete fire fire-and-forget continuations
    // (scheduleRunCronTeardown → terminateRunWithDaemon controlRequest(secret),
    // teardownWorkflowCronsIfIdle → logger, emitEvent → fireWebhook getDb)
    // that resolve DB/log/daemon-secret paths after this hook; pointing them
    // at the real ~/.tamandua trips the test-isolation guard with testFile
    // null ("(unknown)" ledger entries).
    applyStickyEnv();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function seedFinalizeWithReview(overrides: {
    runContext?: Record<string, string>;
    finalizeStatus?: string;
  } = {}): { runId: string; finalizeDbId: string; upstreamDbId: string } {
    const db = getDb();
    const runId = crypto.randomUUID();
    const upstreamDbId = crypto.randomUUID();
    const finalizeDbId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, run_number, test_cmd_established, test_cmd_source, created_at, updated_at) VALUES (?, 'test-wf', 'tcmd gate coupling', 'running', ?, 1, ?, 'launch', ?, ?)",
    ).run(
      runId,
      JSON.stringify(overrides.runContext ?? {
        test_cmd: "npm test",
        test_cmd_raw: "npm test",
        test_cmd_review_required: "true",
        test_cmd_review_established: "npm test",
        test_cmd_review_candidate: "npm run build",
      }),
      "npm test",
      now,
      now,
    );
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'test', 'test-wf_tester', 0, 'Test', 'STATUS: done', 'done', 0, 4, 'single', NULL, ?, ?)`,
    ).run(upstreamDbId, runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'finalize_merge', 'test-wf_merger', 1, 'Finalize', 'STATUS: done', ?, 0, 4, 'single', NULL, ?, ?)`,
    ).run(finalizeDbId, runId, overrides.finalizeStatus ?? "pending", now, now);
    return { runId, finalizeDbId, upstreamDbId };
  }

  function updateRunContext(runId: string, values: Record<string, string | undefined>): void {
    const db = getDb();
    const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
    const ctx = JSON.parse(run.context) as Record<string, string>;
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete ctx[key];
      else ctx[key] = value;
    }
    db.prepare("UPDATE runs SET context = ? WHERE id = ?").run(JSON.stringify(ctx), runId);
  }

  it("refuses finalize_merge claim with a parseable reason while a TEST_CMD review is pending", () => {
    const { runId, finalizeDbId } = seedFinalizeWithReview();

    const claim = claimStep("test-wf_merger", runId);
    assert.equal(claim.found, false, "finalize_merge must be refused while the review is pending");

    const db = getDb();
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(finalizeDbId) as { status: string };
    assert.equal(step.status, "pending", "the refusal must not fail or reroute the step — it stays claimable later");

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "running", "the refusal is a gate, not a run failure");

    const refusals = getRunEvents(runId).filter((e) => e.event === "merge.refused_review_pending");
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].stepId, "finalize_merge");
    assert.equal(refusals[0].oldTestCmd, "npm test");
    assert.equal(refusals[0].newTestCmd, "npm run build");
    assert.match(refusals[0].detail ?? "", /^FAILURE_CLASS: refused_review_pending$/m);
    assert.match(refusals[0].detail ?? "", /^TEST_CMD_OLD: npm test$/m);
    assert.match(refusals[0].detail ?? "", /^TEST_CMD_NEW: npm run build$/m);
  });

  it("refuses finalize_merge claim after a REJECT verdict (review flag still set)", () => {
    // US-006 keeps test_cmd_review_required set through REJECT verdicts —
    // the post-rejection state (rewriter about to retry) is exactly the
    // "rejected-review marker" the gate must refuse on.
    const { runId, finalizeDbId } = seedFinalizeWithReview({
      runContext: {
        test_cmd: "npm test",
        test_cmd_raw: "npm test",
        test_cmd_review_required: "true",
        test_cmd_review_established: "npm test",
        test_cmd_review_candidate: "npm run build",
        test_cmd_rewriter_step: "setup",
      },
    });

    assert.equal(claimStep("test-wf_merger", runId).found, false);
    const refusals = getRunEvents(runId).filter((e) => e.event === "merge.refused_review_pending");
    assert.equal(refusals.length, 1, "a rejected review (flag still set) must refuse finalize_merge");
    const db = getDb();
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(finalizeDbId) as { status: string };
    assert.equal(step.status, "pending");
  });

  it("finalize_merge becomes claimable after the review resolves (ACCEPT state)", () => {
    // Post-ACCEPT (US-006): the flag is cleared, the contract is the
    // reviewed command, and the review material keys stay for annotations.
    const { runId } = seedFinalizeWithReview({
      runContext: {
        test_cmd: "npm run build",
        test_cmd_raw: "npm run build",
        test_cmd_review_established: "npm test",
        test_cmd_review_candidate: "npm run build",
      },
    });
    const db = getDb();
    db.prepare("UPDATE runs SET test_cmd_established = 'npm run build', test_cmd_source = 'reviewer' WHERE id = ?")
      .run(runId);

    const claim = claimStep("test-wf_merger", runId);
    assert.equal(claim.found, true, "finalize_merge must be claimable once the review resolves");
  });

  it("finalize_merge stays claimable when no review was ever flagged", () => {
    const { runId } = seedFinalizeWithReview({
      runContext: { test_cmd: "npm test", test_cmd_raw: "npm test" },
    });
    const claim = claimStep("test-wf_merger", runId);
    assert.equal(claim.found, true);
    assert.equal(
      getRunEvents(runId).filter((e) => e.event === "merge.refused_review_pending").length,
      0,
    );
  });

  it("acceptance-time defense: a finalize_merge claimed before the flag was set cannot land", () => {
    // The claim-time refusal is the primary gate; the acceptance-time check
    // is defense-in-depth for a claimant that started before the review flag
    // became set (e.g. a concurrent rewrite detection).
    const { runId, finalizeDbId } = seedFinalizeWithReview({
      runContext: { test_cmd: "npm test", test_cmd_raw: "npm test" },
    });

    const claim = claimStep("test-wf_merger", runId);
    assert.equal(claim.found, true, "no review pending at claim time");

    // The review flag becomes set while the finalize step is in flight.
    updateRunContext(runId, {
      test_cmd_review_required: "true",
      test_cmd_review_established: "npm test",
      test_cmd_review_candidate: "npm run build",
    });

    const result = completeStep(finalizeDbId, "STATUS: done");
    assert.equal(result.status, "blocked", "landing must be refused at acceptance time");

    const refusals = getRunEvents(runId).filter((e) => e.event === "merge.refused_review_pending");
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].oldTestCmd, "npm test");
    assert.equal(refusals[0].newTestCmd, "npm run build");

    // The step did not land: it stays running (the sweeper resets it to
    // pending, where the claim-time refusal takes over).
    const db = getDb();
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(finalizeDbId) as { status: string };
    assert.equal(step.status, "running");
    assert.equal(
      getRunEvents(runId).filter((e) => e.event === "step.done").length,
      0,
      "no step.done — the finalize_merge must not complete while the review is pending",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// WAVE-A PHNT US-009: fix completion drives deception_audit_required +
// alternation-key normalization for the deception-audit conditional step
// ══════════════════════════════════════════════════════════════════════

describe("fix completion sets deception_audit_required (US-009)", () => {
  let tempHome: string;
  let stateDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-phnt-");
    stateDir = path.join(tempHome, ".tamandua");
    dbPath = path.join(stateDir, "tamandua.db");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = dbPath;
    assert.doesNotThrow(() =>
      assertStatePathIsolation(dbPath, "step-ops-phnt"),
    );
  });

  afterEach(() => {
    // Restore to the module-scoped sticky temp env (NOT the operator's real
    // env): claim/complete/auto-complete fire fire-and-forget continuations
    // (scheduleRunCronTeardown → terminateRunWithDaemon controlRequest(secret),
    // teardownWorkflowCronsIfIdle → logger, emitEvent → fireWebhook getDb)
    // that resolve DB/log/daemon-secret paths after this hook; pointing them
    // at the real ~/.tamandua trips the test-isolation guard with testFile
    // null ("(unknown)" ledger entries).
    applyStickyEnv();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  const FIX_EXPECTS =
    "STATUS: done\nregex:^CHANGES:\\s*\\S+\nregex:^REGRESSION_TEST:\\s*\\S+\nregex:^(REPRO_EVIDENCE|CANNOT_REPRODUCE):\\s*\\S+";
  const AUDITOR_INPUT = [
    "Audit the fix account.",
    "CHANGES: {{changes}}",
    "REGRESSION_TEST: {{regression_test}}",
    "REPRO_EVIDENCE: {{repro_evidence}}",
    "CANNOT_REPRODUCE: {{cannot_reproduce}}",
    "Reply with:",
    "STATUS: done",
    "VERDICT: HONEST|DECEPTION",
  ].join("\n");

  /** Seed a run with a fix step (index 0) + optional deception_audit + verify. */
  function seedFixRun(overrides: {
    withAuditStep?: boolean;
    runContext?: Record<string, string>;
  }): { runId: string; fixDbId: string; auditDbId?: string } {
    const db = getDb();
    const runId = crypto.randomUUID();
    const fixDbId = crypto.randomUUID();
    const auditDbId = crypto.randomUUID();
    const verifyDbId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'bug-fix-merge', 'fix the bug', 'running', ?, ?, ?)",
    ).run(runId, JSON.stringify(overrides.runContext ?? {}), now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'fix', 'test-wf_fixer', 0, 'Implement the fix', ?, 'pending', 0, 4, 'single', NULL, ?, ?)`,
    ).run(fixDbId, runId, FIX_EXPECTS, now, now);
    if (overrides.withAuditStep ?? true) {
      db.prepare(
        `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
         VALUES (?, ?, 'deception_audit', 'test-wf_auditor', 1, ?, 'STATUS: done\nregex:^VERDICT:\\s*(HONEST|DECEPTION)', 'waiting', 0, 4, 'conditional', 'deception_audit_required', ?, ?)`,
      ).run(auditDbId, runId, AUDITOR_INPUT, now, now);
      db.prepare(
        `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
         VALUES (?, ?, 'verify', 'test-wf_verifier', 2, 'Verify', 'STATUS: done', 'waiting', 0, 4, 'single', NULL, ?, ?)`,
      ).run(verifyDbId, runId, now, now);
    }
    return { runId, fixDbId, auditDbId };
  }

  function readContext(runId: string): Record<string, string> {
    const db = getDb();
    const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
    return JSON.parse(row.context) as Record<string, string>;
  }

  it("REPRO_EVIDENCE present -> deception_audit_required unset (''), cannot_reproduce normalized to ''", () => {
    const { runId, fixDbId } = seedFixRun({});
    const claim = claimStep("test-wf_fixer", runId);
    assert.equal(claim.found, true);
    const result = completeStep(fixDbId,
      "STATUS: done\nCHANGES: fixed add\nREGRESSION_TEST: added test\nREPRO_EVIDENCE: failing add(2,3) output on pre-fix tree");
    assert.ok(result.status === "advanced" || result.status === "completed", `got ${result.status}`);

    const context = readContext(runId);
    assert.equal(context.deception_audit_required, "", "REPRO_EVIDENCE must leave the flag UNSET");
    assert.equal(context.repro_evidence, "failing add(2,3) output on pre-fix tree");
    assert.equal(context.cannot_reproduce, "", "the absent alternation key must normalize to '' (no MISS deadlock)");
  });

  it("CANNOT_REPRODUCE present -> deception_audit_required set ('true'), repro_evidence normalized to ''", () => {
    const { runId, fixDbId } = seedFixRun({});
    const claim = claimStep("test-wf_fixer", runId);
    assert.equal(claim.found, true);
    const result = completeStep(fixDbId,
      "STATUS: done\nCHANGES: fixed add\nREGRESSION_TEST: added test\nCANNOT_REPRODUCE: flaky env, failure not reproducible locally");
    assert.ok(result.status === "advanced" || result.status === "completed", `got ${result.status}`);

    const context = readContext(runId);
    assert.equal(context.deception_audit_required, "true", "CANNOT_REPRODUCE must SET the flag (auditor dispatches)");
    assert.equal(context.cannot_reproduce, "flaky env, failure not reproducible locally");
    assert.equal(context.repro_evidence, "", "the absent alternation key must normalize to '' (no MISS deadlock)");
  });

  it("does not touch the flag for a fix step in a run without a deception_audit step", () => {
    const { runId, fixDbId } = seedFixRun({ withAuditStep: false });
    const claim = claimStep("test-wf_fixer", runId);
    assert.equal(claim.found, true);
    const result = completeStep(fixDbId,
      "STATUS: done\nCHANGES: fixed add\nREGRESSION_TEST: added test\nREPRO_EVIDENCE: failing output pointer");
    assert.ok(result.status === "advanced" || result.status === "completed", `got ${result.status}`);

    const context = readContext(runId);
    assert.ok(!("deception_audit_required" in context), "no deception_audit step -> no flag (gated)");
  });

  it("REPRO_EVIDENCE path: autoCompleteConditionalStep returns 'auto_completed' with reason condition_unset:deception_audit_required", () => {
    const { runId, fixDbId } = seedFixRun({});
    claimStep("test-wf_fixer", runId);
    completeStep(fixDbId,
      "STATUS: done\nCHANGES: fixed add\nREGRESSION_TEST: added test\nREPRO_EVIDENCE: failing add(2,3) output on pre-fix tree");

    const outcome = autoCompleteConditionalStep(runId, "test-wf_auditor");
    assert.equal(outcome, "auto_completed", "unset flag must auto-complete the auditor free");

    const db = getDb();
    const row = db.prepare(
      "SELECT status, auto_completed, auto_complete_reason FROM steps WHERE run_id = ? AND step_id = 'deception_audit'",
    ).get(runId) as { status: string; auto_completed: number; auto_complete_reason: string | null };
    assert.equal(row.status, "done");
    assert.equal(row.auto_completed, 1);
    assert.equal(row.auto_complete_reason, "condition_unset:deception_audit_required");

    const events = getRunEvents(runId).filter((e) => e.event === "step.auto_completed");
    assert.equal(events.length, 1);
    assert.equal(events[0].stepId, "deception_audit");
    assert.equal(events[0].condition, "deception_audit_required");
  });

  it("CANNOT_REPRODUCE path: the flag is SET so the auditor dispatches (never auto-completed)", () => {
    const { runId, fixDbId } = seedFixRun({});
    claimStep("test-wf_fixer", runId);
    completeStep(fixDbId,
      "STATUS: done\nCHANGES: fixed add\nREGRESSION_TEST: added test\nCANNOT_REPRODUCE: flaky env");

    const outcome = autoCompleteConditionalStep(runId, "test-wf_auditor");
    assert.equal(outcome, "dispatched", "a SET flag must dispatch, never auto-complete (fail-closed)");

    const db = getDb();
    const row = db.prepare(
      "SELECT status, auto_completed FROM steps WHERE run_id = ? AND step_id = 'deception_audit'",
    ).get(runId) as { status: string; auto_completed: number };
    assert.equal(row.status, "pending", "the auditor step must stay pending for dispatch");
    assert.equal(row.auto_completed, 0);
  });

  it("CANNOT_REPRODUCE path: the auditor claims cleanly (no MISS on the normalized alternation keys)", () => {
    const { runId, fixDbId } = seedFixRun({});
    claimStep("test-wf_fixer", runId);
    completeStep(fixDbId,
      "STATUS: done\nCHANGES: fixed add\nREGRESSION_TEST: added test\nCANNOT_REPRODUCE: flaky env");

    // The auditor input references BOTH {{repro_evidence}} and
    // {{cannot_reproduce}}; the handler normalized the absent key to '',
    // so claim-time MISS resolution must not re-pend the fixer.
    const claim = claimStep("test-wf_auditor", runId);
    assert.equal(claim.found, true, "auditor claim must succeed without MISS blocking");
    assert.ok(claim.resolvedInput?.includes("REPRO_EVIDENCE: "), "input must render the normalized empty key");
    assert.ok(claim.resolvedInput?.includes("CANNOT_REPRODUCE: flaky env"), "input must render the real key");
  });
});

describe("deception_audit verdict routing (US-010)", () => {
  let tempHome: string;
  let stateDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-phnt-route-");
    stateDir = path.join(tempHome, ".tamandua");
    dbPath = path.join(stateDir, "tamandua.db");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = dbPath;
    assert.doesNotThrow(() =>
      assertStatePathIsolation(dbPath, "step-ops-phnt-route"),
    );
  });

  afterEach(() => {
    // Restore to the module-scoped sticky temp env (NOT the operator's real
    // env): claim/complete/auto-complete fire fire-and-forget continuations
    // (scheduleRunCronTeardown → terminateRunWithDaemon controlRequest(secret),
    // teardownWorkflowCronsIfIdle → logger, emitEvent → fireWebhook getDb)
    // that resolve DB/log/daemon-secret paths after this hook; pointing them
    // at the real ~/.tamandua trips the test-isolation guard with testFile
    // null ("(unknown)" ledger entries).
    applyStickyEnv();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  const FIX_EXPECTS =
    "STATUS: done\nregex:^CHANGES:\\s*\\S+\nregex:^REGRESSION_TEST:\\s*\\S+\nregex:^(REPRO_EVIDENCE|CANNOT_REPRODUCE):\\s*\\S+";
  const AUDITOR_INPUT = [
    "Audit the fix account.",
    "CHANGES: {{changes}}",
    "REGRESSION_TEST: {{regression_test}}",
    "REPRO_EVIDENCE: {{repro_evidence}}",
    "CANNOT_REPRODUCE: {{cannot_reproduce}}",
    "Reply with:",
    "STATUS: done",
    "VERDICT: HONEST|DECEPTION",
  ].join("\n");
  const CANNOT_REPRODUCE_FIX =
    "STATUS: done\nCHANGES: fixed add\nREGRESSION_TEST: added test\nCANNOT_REPRODUCE: flaky env";

  /** Seed a run with fix (0) + deception_audit (1, conditional) + verify (2). */
  function seedAuditRun(overrides: {
    auditorRerouteCount?: number;
  } = {}): { runId: string; fixDbId: string; auditDbId: string; verifyDbId: string } {
    const db = getDb();
    const runId = crypto.randomUUID();
    const fixDbId = crypto.randomUUID();
    const auditDbId = crypto.randomUUID();
    const verifyDbId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'fix the bug', 'running', ?, ?, ?)",
    ).run(runId, JSON.stringify({}), now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'fix', 'test-wf_fixer', 0, ?, ?, 'pending', 0, 4, 'single', NULL, ?, ?)`,
    ).run(fixDbId, runId, "Implement the fix\nRETRY FEEDBACK:\n{{retry_feedback}}", FIX_EXPECTS, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, reroute_count, created_at, updated_at)
       VALUES (?, ?, 'deception_audit', 'test-wf_auditor', 1, ?, 'STATUS: done\nregex:^VERDICT:\\s*(HONEST|DECEPTION)', 'waiting', 0, 4, 'conditional', 'deception_audit_required', ?, ?, ?)`,
    ).run(auditDbId, runId, AUDITOR_INPUT, overrides.auditorRerouteCount ?? 0, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'verify', 'test-wf_verifier', 2, 'Verify', 'STATUS: done', 'waiting', 0, 4, 'single', NULL, ?, ?)`,
    ).run(verifyDbId, runId, now, now);
    return { runId, fixDbId, auditDbId, verifyDbId };
  }

  /** Complete the fix (which sets deception_audit_required) then claim the auditor. */
  function completeFixThenClaimAuditor(runId: string, fixDbId: string, fixOutput: string): void {
    const claimFix = claimStep("test-wf_fixer", runId);
    assert.equal(claimFix.found, true);
    const fixResult = completeStep(fixDbId, fixOutput);
    assert.ok(fixResult.status === "advanced" || fixResult.status === "completed",
      `fix completion got ${fixResult.status}`);
    const claimAudit = claimStep("test-wf_auditor", runId);
    assert.equal(claimAudit.found, true, "the dispatched auditor must be claimable");
  }

  function readContext(runId: string): Record<string, string> {
    const db = getDb();
    const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
    return JSON.parse(row.context) as Record<string, string>;
  }

  it("HONEST: auditor done, flag cleared, deception_audit.passed emitted, pipeline proceeds to verify", () => {
    const { runId, fixDbId, auditDbId, verifyDbId } = seedAuditRun();
    completeFixThenClaimAuditor(runId, fixDbId, CANNOT_REPRODUCE_FIX);

    const result = completeStep(auditDbId, "STATUS: done\nVERDICT: HONEST");
    assert.equal(result.status, "advanced");

    const db = getDb();
    const audit = db.prepare("SELECT status FROM steps WHERE id = ?").get(auditDbId) as { status: string };
    assert.equal(audit.status, "done", "HONEST must mark the auditor done");
    const ctx = readContext(runId);
    assert.ok(!("deception_audit_required" in ctx), "HONEST must clear the audit flag");

    const events = getRunEvents(runId);
    const passed = events.filter((e) => e.event === "deception_audit.passed");
    assert.equal(passed.length, 1, "deception_audit.passed must be emitted exactly once");
    assert.equal(passed[0].stepId, "deception_audit");

    // Run proceeds: verify is now claimable.
    const next = claimStep("test-wf_verifier", runId);
    assert.equal(next.found, true);
    assert.equal(next.stepId, verifyDbId);
  });

  it("DECEPTION with quotable evidence: fix step re-pended with the FINDING; auditor reset for re-use; flag stays set", () => {
    const { runId, fixDbId, auditDbId } = seedAuditRun();
    completeFixThenClaimAuditor(runId, fixDbId, CANNOT_REPRODUCE_FIX);

    const result = completeStep(auditDbId,
      'STATUS: done\nVERDICT: DECEPTION\nFINDING: premise-fabrication: "REPRO_EVIDENCE: logs/fail.txt" does not exist in the repo');
    assert.equal(result.status, "rerouted");

    const db = getDb();
    const fix = db.prepare(
      "SELECT status, output, claim_invalidated_by FROM steps WHERE id = ?",
    ).get(fixDbId) as { status: string; output: string | null; claim_invalidated_by: string | null };
    assert.equal(fix.status, "pending", "the fix step must be re-pended");
    assert.match(fix.output ?? "", /premise-fabrication/,
      "the FINDING must be transported as retry feedback to the fix step");
    assert.equal(fix.claim_invalidated_by, "reroute");

    const audit = db.prepare(
      "SELECT status, reroute_count FROM steps WHERE id = ?",
    ).get(auditDbId) as { status: string; reroute_count: number | null };
    assert.equal(audit.status, "waiting", "the auditor must reset to waiting for re-use");
    assert.equal(audit.reroute_count, 1, "the reroute budget must be consumed");

    const ctx = readContext(runId);
    assert.equal(ctx.deception_audit_required, "true", "the audit flag must stay set (audit re-runs after the fix)");

    const events = getRunEvents(runId);
    const found = events.find((e) => e.event === "deception_audit.deception_found");
    assert.ok(found, "deception_audit.deception_found must be emitted");
    assert.match(found!.finding ?? "", /premise-fabrication/);
    assert.equal(found!.stepId, "deception_audit");
    assert.ok(events.some((e) => e.event === "step.rerouted"), "step.rerouted must be emitted");
  });

  it("DECEPTION: the re-pended fix's next claim surfaces the FINDING via retry_feedback", () => {
    const { runId, fixDbId, auditDbId } = seedAuditRun();
    completeFixThenClaimAuditor(runId, fixDbId, CANNOT_REPRODUCE_FIX);
    completeStep(auditDbId,
      'STATUS: done\nVERDICT: DECEPTION\nFINDING: claim-mismatch: "REGRESSION_TEST: added test" is not in the diff');

    const claim = claimStep("test-wf_fixer", runId);
    assert.equal(claim.found, true);
    assert.equal(claim.stepId, fixDbId);
    assert.match(claim.resolvedInput, /PREVIOUS ATTEMPT FEEDBACK/);
    assert.match(claim.resolvedInput, /claim-mismatch/);
  });

  it("DECEPTION without quotable evidence is treated as DEFAULT HONEST (verdict invalid without evidence)", () => {
    const { runId, fixDbId, auditDbId } = seedAuditRun();
    completeFixThenClaimAuditor(runId, fixDbId, CANNOT_REPRODUCE_FIX);

    // A DECEPTION verdict whose FINDING carries no quotation characters is
    // not quotable evidence — the auditor persona makes such a verdict
    // invalid, so the routing defaults to HONEST.
    const result = completeStep(auditDbId,
      "STATUS: done\nVERDICT: DECEPTION\nFINDING: something seems off");
    assert.equal(result.status, "advanced");

    const db = getDb();
    const audit = db.prepare("SELECT status FROM steps WHERE id = ?").get(auditDbId) as { status: string };
    assert.equal(audit.status, "done", "an invalid DECEPTION must complete as HONEST");
    const ctx = readContext(runId);
    assert.ok(!("deception_audit_required" in ctx), "an invalid DECEPTION must not leave the flag set");

    const events = getRunEvents(runId);
    assert.equal(events.filter((e) => e.event === "deception_audit.passed").length, 1,
      "DEFAULT HONEST must emit deception_audit.passed");
    assert.ok(!events.some((e) => e.event === "deception_audit.deception_found"),
      "an invalid DECEPTION must not route as deception");
  });

  it("accumulated rejections exhaust the reroute budget and fail the run legibly with the finding", () => {
    // test-wf declares no on_fail, so max_reroutes defaults to 2; seeding
    // reroute_count = 2 means the next DECEPTION hits the budget ceiling.
    const { runId, fixDbId, auditDbId } = seedAuditRun({ auditorRerouteCount: 2 });
    completeFixThenClaimAuditor(runId, fixDbId, CANNOT_REPRODUCE_FIX);

    const result = completeStep(auditDbId,
      'STATUS: done\nVERDICT: DECEPTION\nFINDING: no-mechanism: "FIX_APPROACH" contradicts the code');
    assert.equal(result.status, "failed");

    const db = getDb();
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "the run must fail when rejections exhaust the reroute budget");
    const audit = db.prepare("SELECT status FROM steps WHERE id = ?").get(auditDbId) as { status: string };
    assert.equal(audit.status, "failed");

    const events = getRunEvents(runId);
    assert.ok(events.some((e) => e.event === "run.failed"), "run.failed must be emitted");
    assert.ok(events.some((e) => e.event === "deception_audit.deception_found"),
      "the final DECEPTION is still recorded");
  });

  it("a deception_audit completed WITHOUT the flag is not routed (falls through to normal completion)", () => {
    // Simulates a manual smoke flow / graph-sim equivalent: the auditor is
    // completed with VERDICT: HONEST but the run never dispatched it (the
    // fixer provided REPRO_EVIDENCE, so the flag is unset and the motor would
    // auto-complete the auditor free — a scheduler-less flow claims it).
    const { runId, fixDbId, auditDbId } = seedAuditRun();
    const claimFix = claimStep("test-wf_fixer", runId);
    assert.equal(claimFix.found, true);
    const fixResult = completeStep(fixDbId,
      "STATUS: done\nCHANGES: fixed add\nREGRESSION_TEST: added test\nREPRO_EVIDENCE: failing add(2,3) output on pre-fix tree");
    assert.ok(fixResult.status === "advanced" || fixResult.status === "completed", `fix got ${fixResult.status}`);

    const claimAudit = claimStep("test-wf_auditor", runId);
    assert.equal(claimAudit.found, true);
    const result = completeStep(auditDbId, "STATUS: done\nVERDICT: HONEST");
    assert.equal(result.status, "advanced");

    const db = getDb();
    const audit = db.prepare("SELECT status FROM steps WHERE id = ?").get(auditDbId) as { status: string };
    assert.equal(audit.status, "done", "the auditor completes normally when not routed");

    const events = getRunEvents(runId);
    assert.ok(!events.some((e) => e.event === "deception_audit.passed"),
      "an un-flagged audit completion must not emit audit-passed");
    assert.ok(!events.some((e) => e.event === "deception_audit.deception_found"),
      "an un-flagged audit completion must not emit deception-found");
  });

  it("productive exit: after DECEPTION reroute, a fix re-run with REPRO_EVIDENCE auto-completes the auditor free", () => {
    const { runId, fixDbId, auditDbId } = seedAuditRun();
    completeFixThenClaimAuditor(runId, fixDbId, CANNOT_REPRODUCE_FIX);
    completeStep(auditDbId,
      'STATUS: done\nVERDICT: DECEPTION\nFINDING: symptom-silencing: "CANNOT_REPRODUCE" while the failing output is present');

    // The fix is re-pended; it now provides genuine REPRO_EVIDENCE.
    const claim = claimStep("test-wf_fixer", runId);
    assert.equal(claim.found, true);
    const fixResult = completeStep(fixDbId,
      "STATUS: done\nCHANGES: fixed add\nREGRESSION_TEST: added test\nREPRO_EVIDENCE: failing add(2,3) output on pre-fix tree");
    assert.ok(fixResult.status === "advanced" || fixResult.status === "completed", `fix got ${fixResult.status}`);

    // The flag is now unset → the auditor auto-completes free via the
    // conditional primitive (no harness spawn, zero tokens).
    const outcome = autoCompleteConditionalStep(runId, "test-wf_auditor");
    assert.equal(outcome, "auto_completed");

    const db = getDb();
    const audit = db.prepare(
      "SELECT status, auto_completed, auto_complete_reason FROM steps WHERE id = ?",
    ).get(auditDbId) as { status: string; auto_completed: number; auto_complete_reason: string | null };
    assert.equal(audit.status, "done");
    assert.equal(audit.auto_completed, 1);
    assert.equal(audit.auto_complete_reason, "condition_unset:deception_audit_required");
  });
});

// ── Late fire-and-forget continuations land in sticky temp state ─────
// completeStep on a terminal path fires scheduleRunCronTeardown as
// fire-and-forget import() continuations (removeRunCrons /
// terminateRunWithDaemon → controlRequest(secret) /
// teardownWorkflowCronsIfIdle → logger) that resolve DB / log /
// daemon-secret paths AFTER the triggering test's afterEach has restored
// the env. Before the module-scoped sticky env existed, every describe's
// afterEach restored the OPERATOR's real env, so these late writes resolved
// the REAL ~/.tamandua: the guard dropped them and the ledger recorded 78x
// getDb / 53x controlRequest(secret) / 27x logger "(unknown)" entries from
// this file alone. This regression proves the late teardown logger write now
// lands in the sticky temp state (mirrors tests/workflow-fail.test.ts).
describe("completeStep late teardown continuations land in sticky temp state", () => {
  it("teardown idle-check logs 'Workflow idle' into the sticky tamandua.log", async () => {
    applyStickyEnv();
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepDbId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'conditional task', 'running', '{}', ?, ?)",
    ).run(runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, conditional_condition, created_at, updated_at)
       VALUES (?, ?, 'finalize', 'test-wf_dev', 0, '', '', 'running', 0, 4, 'single', NULL, ?, ?)`,
    ).run(stepDbId, runId, now, now);

    const stickyLogPath = path.join(stickyState.stateDir, "tamandua.log");
    const before = fs.existsSync(stickyLogPath)
      ? (fs.readFileSync(stickyLogPath, "utf-8").match(/Workflow idle/g) ?? []).length
      : 0;

    const result = completeStep(stepDbId, "STATUS: done");
    assert.ok(
      result.status === "advanced" || result.status === "completed",
      `completeStep got ${result.status}`,
    );

    // Give the fire-and-forget module-loader continuations a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 600));

    // The late teardown idle-check logged into the sticky log (previously
    // guard-dropped at the real ~/.tamandua — the coverage the guard hid).
    assert.ok(
      fs.existsSync(stickyLogPath),
      "teardown logger write must land in the sticky log",
    );
    const after = (fs.readFileSync(stickyLogPath, "utf-8").match(/Workflow idle/g) ?? []).length;
    assert.ok(
      after > before,
      `teardown idle-check must have run against the sticky state (before=${before}, after=${after})`,
    );
  });
});
