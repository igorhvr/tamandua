/**
 * Tier-2 STORM-REHEARSAL-FIX3 US-004 — simulate EVERY bundled workflow to
 * completion in-process through the REAL step-ops pipeline, using the
 * generated scripted behaviors as the canned agent outputs.
 *
 * This is the SF-1 acceptance criterion (attempt 3, run #61): the behaviors
 * generator must be complete for the WHOLE bundled catalog, not a hand-picked
 * list. The model is tests/workflow-graph-simulation.test.ts, but where that
 * test synthesizes its own outputs this test consumes the REAL
 * buildRehearsalScriptedBehaviors document — the exact canned outputs the
 * zero-model SCRIPTED_REHEARSAL runtimes feed the product. If a story producer
 * forgot STORIES_JSON, or a loop-body/verify agent lacks a per-story entry, or
 * a feed-forward key is missing, the run deadlocks here instead of in a
 * 3-hour rehearsal.
 *
 * No daemon, scheduler, subprocess or model is started: every effect is an
 * in-process step-ops call against a fresh temp HOME/state/DB. This file only
 * reads the bundled workflows/ directory and writes under its temp root.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { loadWorkflowSpec } from "../../dist/installer/workflow-spec.js";
import { getDb } from "../../dist/db.js";
import {
  advancePipeline,
  claimStep,
  completeStep,
  peekStep,
} from "../../dist/installer/step-ops.js";
import {
  buildRehearsalScriptedBehaviors,
  deriveStoryLoopProducers,
  parseWorkflowSteps,
  SCRIPTED_STORY_COUNT,
} from "../bin/tt-storm-rehearsal.mjs";

const repoRoot = process.cwd();
const BUNDLED_WORKFLOWS = path.join(repoRoot, "workflows");

// ── Environment isolation ───────────────────────────────────────────
// getDb/emitEvent resolve their paths lazily (first call). Setting env at
// describe-collection time, before any test body runs, isolates all state.
// TAMANDUA_CONTROL_PORT points at port 1 (nothing listens) so
// completion-triggered control-plane notifications fail fast instead of
// reaching a live daemon. HOME is required too: teardown continuations
// resolve the daemon secret via controlRequest when the port is set.
describe("STORM-REHEARSAL-FIX3 US-004 — every bundled workflow simulates to completion from the generated behaviors", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-storm-sim-"));
  process.env.HOME = home;
  process.env.TAMANDUA_STATE_DIR = path.join(home, ".tamandua");
  process.env.TAMANDUA_DB_PATH = path.join(home, ".tamandua", "tamandua.db");
  process.env.TAMANDUA_CONTROL_PORT = "1";

  after(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  // ── Catalog + behaviors (built ONCE, shared by every case) ────────

  function bundledWorkflowIds(): string[] {
    return fs
      .readdirSync(BUNDLED_WORKFLOWS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => fs.existsSync(path.join(BUNDLED_WORKFLOWS, name, "workflow.yml")))
      .sort();
  }

  function workflowText(id: string): string {
    return fs.readFileSync(path.join(BUNDLED_WORKFLOWS, id, "workflow.yml"), "utf8");
  }

  const workflowIds = bundledWorkflowIds();
  const workflowTexts: Record<string, string> = {};
  for (const id of workflowIds) workflowTexts[id] = workflowText(id);
  const behaviors: any = buildRehearsalScriptedBehaviors({ workflowTexts, workflowIds });

  function storyLoopWorkflowIds(): string[] {
    return workflowIds.filter((id) =>
      parseWorkflowSteps(workflowText(id)).some((s: any) => s.type === "loop" && s.loop?.over === "stories"),
    );
  }

  // ── Run creation (mirrors run.ts minus daemon/worktree/cron) ──────

  function seedContext(spec: any): Record<string, string> {
    const workspaceMode = spec.run?.workspace ?? "direct";
    const seeded: Record<string, string> = {
      task: `Simulated task for ${spec.id}`,
      workspace_mode: workspaceMode,
      no_hurry_save_tokens_mode: "false",
      harness_type: "pi",
      no_relaunch_upon_rugpull: "false",
      // This simulator does not execute real test commands or create ledger
      // rows; opt out explicitly (ledger-gate enforcement has a dedicated
      // integration suite with real git fixtures and gate evidence).
      merge_gate: "off",
      repo: "/sim/origin-repo",
      branch: `sim-branch-${spec.id}`,
      original_branch: "main",
      working_directory_for_harness: "/sim/origin-repo",
      base_branch_sha: "sim-sha",
    };
    if (workspaceMode === "worktree") {
      seeded.worktree_path = "/sim/worktree";
      seeded.worktree_origin_repository = "/sim/origin-repo";
      seeded.worktree_origin_ref = "main";
      seeded.worktree_origin_sha = "sim-sha";
      seeded.repo = "/sim/worktree";
      seeded.working_directory_for_harness = "/sim/worktree";
    }
    if (spec.id === "just-do-it") {
      seeded.target_working_directory_for_harness = "/sim/origin-repo";
    }
    // review-material keys are RESERVED — output parsing can never write them,
    // so a simulator that drives the conditional step manually must seed them
    // the way the rewrite detector would persist them after detection. Gate on
    // the workflow actually declaring the conditional step.
    if (
      spec.steps.some(
        (s: any) => s.type === "conditional" && s.condition === "test_cmd_review_required",
      )
    ) {
      seeded.test_cmd_review_established = "npm test";
      seeded.test_cmd_review_candidate = "npm test";
    }
    return seeded;
  }

  function createSimRun(spec: any): string {
    const db = getDb();
    const now = new Date().toISOString();
    const runId = crypto.randomUUID();
    const seeded = seedContext(spec);

    db.prepare(
      `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent,
                         scheduling_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, 0, NULL, ?, ?)`,
    ).run(runId, Math.floor(Math.random() * 1_000_000), spec.id, seeded.task, JSON.stringify(seeded), now, now);

    const insertStep = db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', 0, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < spec.steps.length; i++) {
      const step = spec.steps[i];
      insertStep.run(
        crypto.randomUUID(),
        runId,
        step.id,
        step.agent.startsWith(`${spec.id}_`) ? step.agent : `${spec.id}_${step.agent}`,
        i,
        step.input,
        step.expects,
        step.max_retries ?? 4,
        step.type ?? "single",
        step.loop ? JSON.stringify(step.loop) : null,
        now,
        now,
      );
    }

    advancePipeline(runId);
    return runId;
  }

  // ── Simulation ────────────────────────────────────────────────────

  function runStatus(runId: string): string {
    const row = getDb().prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    return row.status;
  }

  function stepsSnapshot(runId: string): string {
    const rows = getDb()
      .prepare("SELECT step_index, step_id, agent_id, status, retry_count FROM steps WHERE run_id = ? ORDER BY step_index")
      .all(runId) as Array<{ step_index: number; step_id: string; agent_id: string; status: string; retry_count: number }>;
    return rows
      .map((r) => `  #${r.step_index} ${r.step_id} (${r.agent_id}) status=${r.status} retries=${r.retry_count}`)
      .join("\n");
  }

  function stepsNotDone(runId: string): number {
    const row = getDb()
      .prepare("SELECT COUNT(*) AS cnt FROM steps WHERE run_id = ? AND status != 'done'")
      .get(runId) as { cnt: number };
    return row.cnt;
  }

  /** The distinct DB agent ids a run will dispatch (mirrors createSimRun). */
  function scopedAgentIds(spec: any): string[] {
    const ids = new Set<string>();
    for (const step of spec.steps) {
      ids.add(step.agent.startsWith(`${spec.id}_`) ? step.agent : `${spec.id}_${step.agent}`);
    }
    return [...ids];
  }

  function entriesOf(behavior: any): Array<{ output: string }> {
    return Array.isArray(behavior) ? behavior : [behavior];
  }

  const RETRY_VERIFY_OUTPUT = [
    "STATUS: retry",
    "ISSUES:",
    "- Simulated verification issue: story implementation needs improvement",
  ].join("\n");

  interface SimOptions {
    maxRounds?: number;
    /** Turn the FIRST verify_each verify claim into an honest retry verdict. */
    injectVerifyRetryOnce?: boolean;
  }

  interface SimResult {
    status: string;
    claims: number;
    consumedAgentKeys: Set<string>;
    injectedVerifyRetries: number;
    /** Stories observed 'pending' immediately after the injected retry. */
    pendingStoriesAfterInject: string[];
  }

  function simulateWorkflow(spec: any, runId: string, options: SimOptions = {}): SimResult {
    const maxRounds = options.maxRounds ?? 400;

    // Verify-step ids that belong to a verify_each loop.
    const verifyEachVerifyStepIds = new Set<string>();
    for (const step of spec.steps) {
      const loop = step.loop;
      if (loop && (loop.verifyEach || loop.verify_each)) {
        const vStepId = loop.verifyStep || loop.verify_step;
        if (vStepId) verifyEachVerifyStepIds.add(vStepId);
      }
    }

    const invocation = new Map<string, number>();
    const consumedAgentKeys = new Set<string>();
    const pendingStoriesAfterInject: string[] = [];
    let injectedVerifyRetries = 0;
    let claims = 0;
    let retried = false;

    for (let round = 0; round < maxRounds; round++) {
      const status = runStatus(runId);
      if (status !== "running") {
        return { status, claims, consumedAgentKeys, injectedVerifyRetries, pendingStoriesAfterInject };
      }

      let sawWork = false;
      for (const scopedAgentId of scopedAgentIds(spec)) {
        if (peekStep(scopedAgentId, runId) !== "HAS_WORK") continue;
        sawWork = true;

        const claim = claimStep(scopedAgentId, runId);
        // found:false covers loop-step internal transitions (story bookkeeping,
        // loop completion) — state changed, so continue to the next agent.
        if (!claim.found || !claim.stepId) continue;
        claims++;

        const stepRow = getDb()
          .prepare("SELECT agent_id, step_id FROM steps WHERE id = ?")
          .get(claim.stepId) as { agent_id: string; step_id: string };

        const behaviorKey = stepRow.agent_id;
        const behavior = behaviors.agents[behaviorKey];
        assert.ok(
          behavior,
          `generated behavior exists for consumed agent ${behaviorKey} (${spec.id}/${stepRow.step_id})`,
        );
        consumedAgentKeys.add(behaviorKey);

        const entries = entriesOf(behavior);
        const idx = invocation.get(behaviorKey) ?? 0;
        invocation.set(behaviorKey, idx + 1);

        if (options.injectVerifyRetryOnce && !retried && verifyEachVerifyStepIds.has(stepRow.step_id)) {
          retried = true;
          injectedVerifyRetries++;
          completeStep(claim.stepId, RETRY_VERIFY_OUTPUT);
          const pending = getDb()
            .prepare("SELECT story_id FROM stories WHERE run_id = ? AND status = 'pending' ORDER BY story_index")
            .all(runId) as Array<{ story_id: string }>;
          pendingStoriesAfterInject.push(...pending.map((r) => r.story_id));
          continue;
        }

        // Use the invocation-indexed entry; the runtime repeats the last entry
        // once the array is exhausted (retries / extra invocations).
        const entry = entries[Math.min(idx, entries.length - 1)];
        completeStep(claim.stepId, entry.output);
      }

      if (!sawWork && runStatus(runId) === "running") {
        assert.fail(
          `Workflow ${spec.id} deadlocked: run still 'running' but no agent has claimable work.\nSteps:\n${stepsSnapshot(runId)}`,
        );
      }
    }

    assert.fail(
      `Workflow ${spec.id} did not terminate within ${maxRounds} simulation rounds.\nSteps:\n${stepsSnapshot(runId)}`,
    );
  }

  // ── Cases ─────────────────────────────────────────────────────────

  it("S1: discovers the full bundled catalog and builds one behavior per agent", () => {
    assert.equal(workflowIds.length, 23, "the full bundled catalog is discovered");
    assert.ok(Object.keys(behaviors.agents).length >= 100, "behaviors cover every agent of every workflow");
    for (const wf of workflowIds) {
      const steps = parseWorkflowSteps(workflowText(wf));
      for (const step of steps) {
        if (!step.agent) continue;
        assert.ok(behaviors.agents[`${wf}_${step.agent}`], `${wf}/${step.id} agent ${step.agent} has a generated behavior`);
      }
    }
  });

  it("S2: every bundled workflow reaches 'completed' with no step left pending/running", async () => {
    const consumed: string[] = [];
    for (const wf of workflowIds) {
      const spec = await loadWorkflowSpec(path.join(BUNDLED_WORKFLOWS, wf));
      const runId = createSimRun(spec);
      const result = simulateWorkflow(spec, runId, { maxRounds: 400 });
      assert.equal(
        result.status,
        "completed",
        `${wf} should complete, got "${result.status}"\nSteps:\n${stepsSnapshot(runId)}`,
      );
      assert.equal(stepsNotDone(runId), 0, `${wf} leaves no step pending/running\nSteps:\n${stepsSnapshot(runId)}`);
      assert.ok(result.claims > 0, `${wf} dispatched at least one work round`);
      consumed.push(...result.consumedAgentKeys);
    }
    // AC4: every key consumed across the whole catalog exists in the generated
    // behaviors document (asserted per-claim above; this pins the aggregate).
    assert.ok(consumed.length >= 100, `consumed ${consumed.length} agent behaviors across the catalog`);
    for (const key of consumed) assert.ok(behaviors.agents[key], `${key} is a generated behavior`);
  });

  it("S3: the ten story-loop workflows drain the generated 2-story plan to completion", async () => {
    const loopIds = storyLoopWorkflowIds();
    assert.equal(loopIds.length, 10, "ten bundled workflows loop over stories");

    for (const wf of loopIds) {
      const spec = await loadWorkflowSpec(path.join(BUNDLED_WORKFLOWS, wf));
      const runId = createSimRun(spec);
      const result = simulateWorkflow(spec, runId, { maxRounds: 400 });
      assert.equal(result.status, "completed", `${wf} completes after the generated plan\nSteps:\n${stepsSnapshot(runId)}`);

      const stories = getDb()
        .prepare("SELECT story_id, status FROM stories WHERE run_id = ? ORDER BY story_index")
        .all(runId) as Array<{ story_id: string; status: string }>;
      assert.equal(stories.length, SCRIPTED_STORY_COUNT, `${wf} processed the generated ${SCRIPTED_STORY_COUNT}-story plan`);
      assert.deepEqual(stories.map((s) => s.story_id), ["US-001", "US-002"], `${wf} drained the generated story ids`);
      for (const s of stories) assert.equal(s.status, "done", `${wf} story ${s.story_id} is done`);
    }
  });

  it("S4: an injected first-iteration verify retry re-pends the story and the run still completes", async () => {
    const loopIds = storyLoopWorkflowIds();
    assert.equal(loopIds.length, 10, "ten story-loop workflows");

    for (const wf of loopIds) {
      const spec = await loadWorkflowSpec(path.join(BUNDLED_WORKFLOWS, wf));
      const runId = createSimRun(spec);
      const result = simulateWorkflow(spec, runId, { maxRounds: 400, injectVerifyRetryOnce: true });

      assert.equal(result.injectedVerifyRetries, 1, `${wf} injected exactly one verify retry`);
      assert.ok(
        result.pendingStoriesAfterInject.length >= 1,
        `${wf} re-pends the verified story after STATUS: retry (got ${JSON.stringify(result.pendingStoriesAfterInject)})`,
      );
      assert.equal(
        result.status,
        "completed",
        `${wf} still converges to completion after the retry verdict\nSteps:\n${stepsSnapshot(runId)}`,
      );
      assert.equal(stepsNotDone(runId), 0, `${wf} ends with no pending/running step`);

      const stories = getDb()
        .prepare("SELECT story_id, status FROM stories WHERE run_id = ? ORDER BY story_index")
        .all(runId) as Array<{ story_id: string; status: string }>;
      assert.equal(stories.length, SCRIPTED_STORY_COUNT, `${wf} still processes both stories`);
      for (const s of stories) assert.equal(s.status, "done", `${wf} story ${s.story_id} converges to done`);
    }
  });

  it("S5: the story-plan producer derivation is exercised for every loop workflow", () => {
    for (const wf of storyLoopWorkflowIds()) {
      const graph = deriveStoryLoopProducers(parseWorkflowSteps(workflowText(wf)));
      assert.ok(graph.loopStep, `${wf} derives its story loop`);
      assert.equal(graph.producers.length, 1, `${wf} has exactly one STORIES_JSON producer`);
      assert.ok(graph.bodyAgent, `${wf} derives its loop body agent`);
      assert.ok(graph.verifyAgent, `${wf} derives its verify agent`);
      const producer = behaviors.agents[`${wf}_${graph.producers[0].agent}`];
      assert.ok(producer && !Array.isArray(producer), `${wf} producer behavior is a single object`);
      assert.equal(
        (producer.output.match(/^STORIES_JSON:/gm) ?? []).length,
        1,
        `${wf} producer output carries exactly one STORIES_JSON line`,
      );
    }
  });
});
