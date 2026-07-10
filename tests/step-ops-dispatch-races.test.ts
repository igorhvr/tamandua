/**
 * Dispatch-race invariants on step-ops (motor contract C5 — see
 * tests/MOTOR-CONTRACT.md).
 *
 * The polling motor dispatches slowly (one model round per interval), so
 * these races almost never fire today. A deterministic motor dispatches
 * fast and concurrently, so the claim/complete primitives themselves must
 * be race-safe:
 *
 * - concurrent claims: exactly one claimant wins a pending step
 * - duplicate completion (at-least-once delivery: agent CLI retry, orphan
 *   recovery reclaim race) must be a no-op — not re-merge context,
 *   re-insert STORIES_JSON stories, or re-advance the pipeline
 * - late completion after a stale-claim sweep is still accepted (the work
 *   was done; the reset to pending was the sweeper's guess, not fact)
 * - agents cannot claim each other's steps
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { createTempHome } from "./helpers/test-env.ts";
import { getDb } from "../dist/db.js";
import {
  peekStep,
  claimStep,
  completeStep,
  failStep,
  recoverOrphanedStepsForAgent,
  advancePipeline,
} from "../dist/installer/step-ops.js";

// ── Environment isolation (see orphaned-step-recovery.test.ts) ──────
// createTempHome sets up an isolated temp home with automatic after() cleanup.

describe("step-ops-dispatch-races", () => {
  const { tamanduaDir } = createTempHome("tamandua-races-");
  process.env.TAMANDUA_STATE_DIR = tamanduaDir;
  process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");
  process.env.TAMANDUA_CONTROL_PORT = "1"; // nothing listens; control-plane calls fail fast

// ── Fixtures: a minimal synthetic two-step run ──────────────────────

interface Fixture {
  runId: string;
  agentA: string;
  agentB: string;
  step1DbId: string;
  step2DbId: string;
}

function createTwoStepRun(maxRetries = 4): Fixture {
  const db = getDb();
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  const wf = `race-wf-${runId.slice(0, 8)}`;
  const agentA = `${wf}_agent-a`;
  const agentB = `${wf}_agent-b`;

  db.prepare(
    `INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, ?, 'race test', 'running', '{"task":"race test"}', 0, ?, ?)`,
  ).run(runId, wf, now, now);

  const insertStep = db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'STATUS: done', 'waiting', 0, ?, 'single', ?, ?)`,
  );
  const step1DbId = crypto.randomUUID();
  const step2DbId = crypto.randomUUID();
  insertStep.run(step1DbId, runId, "first", agentA, 0, "do the first thing for {{task}}", maxRetries, now, now);
  insertStep.run(step2DbId, runId, "second", agentB, 1, "do the second thing", maxRetries, now, now);
  advancePipeline(runId);

  return { runId, agentA, agentB, step1DbId, step2DbId };
}

function stepStatus(stepDbId: string): string {
  return (getDb().prepare("SELECT status FROM steps WHERE id = ?").get(stepDbId) as { status: string }).status;
}

function storyCount(runId: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS cnt FROM stories WHERE run_id = ?").get(runId) as { cnt: number }).cnt;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("dispatch races (motor contract C5)", () => {
  it("two claim attempts for the same agent: exactly one wins", () => {
    const fx = createTwoStepRun();

    const first = claimStep(fx.agentA, fx.runId);
    assert.ok(first.found && first.stepId, "first claim should win the pending step");

    const second = claimStep(fx.agentA, fx.runId);
    assert.equal(second.found, false, "second claim must not hand out the running step again");
    assert.equal(stepStatus(fx.step1DbId), "running");
    assert.equal(peekStep(fx.agentA, fx.runId), "NO_WORK", "peek must not advertise a running step");
  });

  it("agents cannot claim each other's steps", () => {
    const fx = createTwoStepRun();

    const wrongAgent = claimStep(fx.agentB, fx.runId);
    assert.equal(wrongAgent.found, false, "agent B must not claim agent A's pending step");
    assert.equal(stepStatus(fx.step1DbId), "pending");
  });

  it("duplicate completion is a no-op: no context re-merge, no story re-insert, no pipeline corruption", () => {
    const fx = createTwoStepRun();

    const claim = claimStep(fx.agentA, fx.runId);
    assert.ok(claim.found && claim.stepId);

    const outputWithStories = [
      "STATUS: done",
      "MARKER: from-first-completion",
      `STORIES_JSON: ${JSON.stringify([
        { id: "SIM-001", title: "story", description: "desc", acceptanceCriteria: ["ok"] },
      ])}`,
    ].join("\n");

    const first = completeStep(claim.stepId!, outputWithStories);
    assert.notEqual(first.status, "blocked", `first completion should be processed, got ${JSON.stringify(first)}`);
    assert.equal(stepStatus(fx.step1DbId), "done");
    assert.equal(stepStatus(fx.step2DbId), "pending", "pipeline should have advanced step 2");
    assert.equal(storyCount(fx.runId), 1);

    // At-least-once delivery: the same completion arrives again (CLI retry,
    // duplicate polling round). It must not be processed a second time.
    const second = completeStep(claim.stepId!, outputWithStories.replace("from-first-completion", "from-duplicate"));
    assert.equal(second.status, "blocked", `duplicate completion must be blocked, got ${JSON.stringify(second)}`);
    assert.equal(storyCount(fx.runId), 1, "duplicate completion must not re-insert stories");

    const context = JSON.parse(
      (getDb().prepare("SELECT context FROM runs WHERE id = ?").get(fx.runId) as { context: string }).context,
    ) as Record<string, string>;
    assert.equal(context.marker, "from-first-completion", "duplicate completion must not overwrite context");
  });

  it("late completion after a stale-claim sweep is accepted (work was done)", () => {
    const fx = createTwoStepRun();

    const claim = claimStep(fx.agentA, fx.runId);
    assert.ok(claim.found && claim.stepId);

    // Sweeper decides the claim is stale (threshold 0) and resets to pending.
    const recovery = recoverOrphanedStepsForAgent(fx.agentA, fx.runId, 0);
    assert.equal(recovery.recovered, 1, "sweep should reset the running step to pending");
    assert.equal(stepStatus(fx.step1DbId), "pending");

    // The original agent finishes late and reports. The work is real; the
    // completion must be accepted, not dropped.
    const late = completeStep(claim.stepId!, "STATUS: done\nMARKER: late-but-valid");
    assert.notEqual(late.status, "blocked", `late completion should be accepted, got ${JSON.stringify(late)}`);
    assert.equal(stepStatus(fx.step1DbId), "done");
    assert.equal(stepStatus(fx.step2DbId), "pending", "pipeline should advance after late completion");
  });

  it("completion after permanent failure stays rejected", async () => {
    const fx = createTwoStepRun(0); // max_retries 0: first failure is fatal

    const claim = claimStep(fx.agentA, fx.runId);
    assert.ok(claim.found && claim.stepId);

    await failStep(claim.stepId!, "fatal simulated failure");
    assert.equal(stepStatus(fx.step1DbId), "failed");

    const zombie = completeStep(claim.stepId!, "STATUS: done");
    assert.equal(zombie.status, "blocked", "completion of a permanently failed step must be blocked");
    assert.equal(stepStatus(fx.step1DbId), "failed", "zombie completion must not resurrect the step");
  });
});
});
