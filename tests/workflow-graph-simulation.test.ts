/**
 * Workflow graph simulation — every bundled workflow, pure step-ops.
 *
 * For each bundled workflow this test simulates a full run to completion
 * IN-PROCESS through the real step-ops pipeline (peekStep / claimStep /
 * completeStep / failStep / advancePipeline) with auto-generated step
 * outputs — no daemon, no scheduler, no subprocesses, no models.
 * Milliseconds per workflow.
 *
 * What this pins (motor contract C1–C4, C8 — see tests/MOTOR-CONTRACT.md):
 * - every workflow's step graph terminates: no unreachable steps, no
 *   deadlocks, loop wiring (stories, verify_each) converges
 * - context propagation: KEY: value outputs resolve later {{placeholders}}
 * - a mid-run step failure retries and the run still completes
 * - exhausting a step's retries fails the run (retry exhaustion path)
 *
 * Output generation is generic: each completed step emits its `expects`
 * text plus a `KEY: sim-<key>` line for every {{placeholder}} any LATER
 * step references (mirroring how real agents feed context forward), and
 * steps whose instructions mention STORIES_JSON emit a two-story plan so
 * loop-over-stories steps have work.
 *
 * A workflow that hangs here would hang identically under any motor —
 * failures in this file are workflow-spec or step-ops regressions, not
 * polling-motor churn.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createTempHome } from "./helpers/test-env.ts";
import { loadWorkflowSpec } from "../dist/installer/workflow-spec.js";
import { resolveBundledWorkflowsDir } from "../dist/installer/paths.js";
import { AUTO_CONTEXT_KEYS } from "../dist/installer/workflow-contract.js";
import { getDb } from "../dist/db.js";
import {
  peekStep,
  claimStep,
  completeStep,
  failStep,
  advancePipeline,
} from "../dist/installer/step-ops.js";
import type { WorkflowSpec } from "../dist/installer/types.js";

// ── Environment isolation ───────────────────────────────────────────
// getDb/emitEvent/logger resolve their paths lazily (first call), so
// setting env here — after the hoisted imports but before any test body
// runs — isolates all state. TAMANDUA_CONTROL_PORT points at port 1
// (nothing listens there) so completion-triggered control-plane
// notifications fail fast instead of reaching a live daemon.
// createTempHome sets up an isolated temp home with automatic after() cleanup.

describe("workflow-graph-simulation", () => {
  const { tamanduaDir } = createTempHome("tamandua-graph-sim-");
  process.env.TAMANDUA_STATE_DIR = tamanduaDir;
  process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");
  process.env.TAMANDUA_CONTROL_PORT = "1";

// ── Run creation (mirrors the DB work of runWorkflow in run.ts, minus
//    daemon registration, worktree creation, and cron setup) ─────────

// AUTO_CONTEXT_KEYS imported from src/installer/workflow-contract.ts —
// single source of truth shared by step-ops (MISS), linter, and graph sim.

function seedContext(spec: WorkflowSpec): Record<string, string> {
  const workspaceMode = spec.run?.workspace ?? "direct";
  const seeded: Record<string, string> = {
    task: `Simulated task for ${spec.id}`,
    workspace_mode: workspaceMode,
    no_hurry_save_tokens_mode: "false",
    harness_type: "pi",
    no_relaunch_upon_rugpull: "false",
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
  return seeded;
}

function createSimRun(spec: WorkflowSpec): { runId: string; seeded: Record<string, string> } {
  const db = getDb();
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  const seeded = seedContext(spec);

  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent,
                       scheduling_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', ?, 0, NULL, ?, ?)`,
  ).run(runId, Math.floor(Math.random() * 1_000_000), spec.id, seeded.task, JSON.stringify(seeded), now, now);

  const insertStep = getDb().prepare(
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
  return { runId, seeded };
}

// ── Simulation ──────────────────────────────────────────────────────

const MAX_ROUNDS = 500;

const SIM_STORIES = [
  {
    id: "SIM-001",
    title: "First simulated story",
    description: "Do the first simulated thing",
    acceptanceCriteria: ["it works"],
  },
  {
    id: "SIM-002",
    title: "Second simulated story",
    description: "Do the second simulated thing",
    acceptanceCriteria: ["it also works"],
  },
];

function collectPlaceholders(template: string): string[] {
  const keys: string[] = [];
  template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_m, key: string) => {
    keys.push(key.toLowerCase());
    return "";
  });
  return keys;
}

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

interface SimState {
  emitted: Set<string>;
  storiesEmitted: boolean;
}

/**
 * Synthesize a plausible output line for a `regex:<pattern>` expects clause.
 *
 * Patterns follow the `regex:^KEY:\s*<value-pattern>` convention used by
 * parseEnforcedKeys in workflow-contract.ts (anchored) or `regex:KEY:<pattern>`
 * for unanchored patterns. The synthesis is generic and deterministic — no
 * hand-maintained candidate list needed.
 *
 * Value synthesis rules (in priority order):
 *   1. URL pattern (contains `://`) → synthetic github URL
 *   2. Alternation group `(val1|val2|...)` → pick the first value (closed enum)
 *   3. Numeric `\d+` → emit 0
 *   4. Non-whitespace `\S+` → emit `sim-<lowercase-key>`
 *   5. Fallback → emit `sim-<lowercase-key>`
 */
function synthesizeRegexLine(regexLine: string): string {
  const regexBody = regexLine.slice("regex:".length);

  // Extract key: optional ^ anchor, then KEY:
  const keyMatch = regexBody.match(/^\^?([A-Z_]+):(.*)/);
  if (!keyMatch) {
    return "synthetic: sim-value";
  }
  const key = keyMatch[1];
  const valuePattern = keyMatch[2];

  // URL pattern → synthetic github URL (handles PR: regex without ^ anchor)
  if (/:\/\//.test(valuePattern)) {
    return `${key}: https://github.com/sim-org/sim-repo/pull/1`;
  }

  // MRG2: Merge success simulation must not claim a rebase.  When the REBASED
  // regex alternation includes "false", force that value so the synthesized
  // "STATUS: done + REBASED: true" combination never violates the merge-contract
  // conjunction gate (done => REBASED: false).
  // Retry/rebase paths are injected separately by the simulator.  This keeps
  // synthetic done outputs compatible with the merge contract.
  if (key === "REBASED" && /\bfalse\b/.test(valuePattern)) {
    return `${key}: false`;
  }

  // Closed enum alternation: (critical|high|medium|low) → pick first
  const altMatch = valuePattern.match(/\(([^)]+)\)/);
  if (altMatch) {
    const firstAlt = altMatch[1].split("|")[0].trim();
    return `${key}: ${firstAlt}`;
  }

  // Numeric pattern: \d+ → 0
  if (/\\d\+/.test(valuePattern)) {
    return `${key}: 0`;
  }

  // Generic non-whitespace or fallback
  return `${key}: sim-${key.toLowerCase()}`;
}

function satisfyExpects(expects: string): string[] {
  const lines: string[] = [];
  for (const rawLine of (expects.trim() || "STATUS: done").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("regex:")) {
      lines.push(synthesizeRegexLine(line));
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function generateOutput(spec: WorkflowSpec, stepIndex: number, state: SimState): string {
  const specStep = spec.steps[stepIndex];
  const lines: string[] = satisfyExpects(specStep.expects ?? "STATUS: done");

  // Track keys produced by the expects lines so feed-forward doesn't double-emit
  for (const line of lines) {
    const keyMatch = line.match(/^([A-Z_]+):/);
    if (keyMatch) state.emitted.add(keyMatch[1].toLowerCase());
  }

  // Feed forward every key any LATER step's template references, the way a
  // real agent's structured output block does.
  const futureKeys = new Set<string>();
  for (let j = stepIndex + 1; j < spec.steps.length; j++) {
    for (const key of collectPlaceholders(spec.steps[j].input)) futureKeys.add(key);
  }
  for (const key of futureKeys) {
    if (state.emitted.has(key) || AUTO_CONTEXT_KEYS.has(key)) continue;
    lines.push(`${key.toUpperCase()}: sim-${key}`);
    state.emitted.add(key);
  }

  // Planner steps that are instructed to produce a story plan feed the
  // loop-over-stories step. Emit exactly once per run.
  if (
    !state.storiesEmitted &&
    /STORIES_JSON/.test(specStep.input) &&
    spec.steps.some((s) => s.type === "loop")
  ) {
    lines.push(`STORIES_JSON: ${JSON.stringify(SIM_STORIES)}`);
    state.storiesEmitted = true;
  }

  return lines.join("\n");
}

interface SimulateOptions {
  /**
   * Fail the Nth successful claim once before proceeding (1-based).
   *
   * When the target step is a verify step inside a verify_each loop,
   * the simulated agent emits STATUS: retry with ISSUES instead of
   * failing — this exercises the handleVerifyEachCompletion story-reset
   * path (honest verdict code path, US-003).
   */
  failOnceAtClaim?: number;
}

interface SimulateResult {
  status: string;
  workRounds: number;
  failuresInjected: number;
  /** Count of STATUS: retry verdicts emitted for verify_each verify steps (US-003). */
  retryVerdictsInjected: number;
}

async function simulate(
  spec: WorkflowSpec,
  runId: string,
  seeded: Record<string, string>,
  options: SimulateOptions = {},
): Promise<SimulateResult> {
  const state: SimState = { emitted: new Set(Object.keys(seeded)), storiesEmitted: false };
  let claims = 0;
  let failuresInjected = 0;
  let retryVerdictsInjected = 0;

  // Build a set of verify-step IDs that belong to a verify_each loop, so the
  // retry scenario can emit STATUS: retry instead of a step failure (US-003).
  const verifyEachVerifyStepIds = new Set<string>();
  for (const step of spec.steps) {
    if (step.loop && (step.loop.verifyEach || step.loop.verify_each)) {
      const vStepId = step.loop.verifyStep || step.loop.verify_step;
      if (vStepId) verifyEachVerifyStepIds.add(vStepId);
    }
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const status = runStatus(runId);
    if (status !== "running") {
      return { status, workRounds: claims, failuresInjected, retryVerdictsInjected };
    }

    let sawWork = false;
    for (const agent of spec.agents) {
      const scopedAgentId = `${spec.id}_${agent.id}`;
      if (peekStep(scopedAgentId, runId) !== "HAS_WORK") continue;
      sawWork = true;

      const claim = claimStep(scopedAgentId, runId);
      // found:false covers loop-step internal transitions (story bookkeeping,
      // loop completion) — state changed, so just continue to the next round.
      if (!claim.found || !claim.stepId) continue;
      claims++;

      const stepRow = getDb()
        .prepare("SELECT step_index, step_id FROM steps WHERE id = ?")
        .get(claim.stepId) as { step_index: number; step_id: string };

      if (options.failOnceAtClaim === claims) {
        // US-003: For verify_each verify steps, emit an honest STATUS: retry
        // verdict instead of injecting a step failure. This exercises the
        // handleVerifyEachCompletion story-reset code path (story re-pended,
        // verify_feedback set, re-implemented, re-verified).
        if (verifyEachVerifyStepIds.has(stepRow.step_id)) {
          retryVerdictsInjected++;
          const retryOutput = `STATUS: retry
ISSUES:
- Simulated verification issue: story implementation needs improvement`;
          completeStep(claim.stepId, retryOutput);
          continue;
        }

        failuresInjected++;
        await failStep(claim.stepId, "simulated agent failure");
        continue;
      }

      completeStep(claim.stepId, generateOutput(spec, stepRow.step_index, state));
    }

    if (!sawWork && runStatus(runId) === "running") {
      assert.fail(
        `Workflow ${spec.id} deadlocked: run still 'running' but no agent has claimable work.\nSteps:\n${stepsSnapshot(runId)}`,
      );
    }
  }

  assert.fail(
    `Workflow ${spec.id} did not terminate within ${MAX_ROUNDS} simulation rounds.\nSteps:\n${stepsSnapshot(runId)}`,
  );
}

// ── Discover bundled workflows ──────────────────────────────────────

const workflowsDir = resolveBundledWorkflowsDir();
const workflowIds = fs
  .readdirSync(workflowsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(workflowsDir, e.name, "workflow.yml")))
  .map((e) => e.name)
  .sort();

describe("workflow graph simulation (all bundled workflows, pure step-ops)", () => {
  before(() => {
    assert.ok(workflowIds.length >= 20, `expected the full bundled catalog, found ${workflowIds.length}`);
  });

  for (const workflowId of workflowIds) {
    describe(workflowId, () => {
      it("simulates to completion (happy path)", async () => {
        const spec = await loadWorkflowSpec(path.join(workflowsDir, workflowId));
        const { runId, seeded } = createSimRun(spec);
        const result = await simulate(spec, runId, seeded);
        assert.equal(
          result.status,
          "completed",
          `run should complete, got "${result.status}"\nSteps:\n${stepsSnapshot(runId)}`,
        );
        const notDone = getDb()
          .prepare("SELECT COUNT(*) AS cnt FROM steps WHERE run_id = ? AND status != 'done'")
          .get(runId) as { cnt: number };
        assert.equal(notDone.cnt, 0, `all steps should be done\nSteps:\n${stepsSnapshot(runId)}`);
      });

      it("recovers from a single mid-run step failure (retry) and completes", async () => {
        const spec = await loadWorkflowSpec(path.join(workflowsDir, workflowId));
        const { runId, seeded } = createSimRun(spec);
        // Fail the second claim: exercises retry on a step that already has
        // upstream context (the first step's failure path is equivalent but
        // covers less of the context-propagation surface).
        //
        // US-003: For verify_each workflows, the second claim targets the
        // verify step and emits an honest STATUS: retry verdict (story
        // reset → re-implement → re-verify) instead of a step failure.
        // For non-verify_each workflows, a regular step failure is injected.
        const target = spec.steps.length > 1 ? 2 : 1;
        const result = await simulate(spec, runId, seeded, { failOnceAtClaim: target });
        const setbacksInjected = result.failuresInjected + result.retryVerdictsInjected;
        assert.equal(setbacksInjected, 1, "exactly one setback should have been injected");
        assert.equal(
          result.status,
          "completed",
          `run should complete after a retried failure, got "${result.status}"\nSteps:\n${stepsSnapshot(runId)}`,
        );
      });

      it("fails the run when the first step exhausts its retries", async () => {
        const spec = await loadWorkflowSpec(path.join(workflowsDir, workflowId));
        const { runId } = createSimRun(spec);
        const firstAgent = `${spec.id}_${spec.steps[0].agent.replace(new RegExp(`^${spec.id}_`), "")}`;
        const maxRetries = spec.steps[0].max_retries ?? 4;

        for (let attempt = 0; attempt <= maxRetries + 1; attempt++) {
          if (runStatus(runId) !== "running") break;
          const claim = claimStep(firstAgent, runId);
          assert.ok(claim.found && claim.stepId, `attempt ${attempt}: first step should be claimable while run is running`);
          await failStep(claim.stepId!, "simulated persistent failure");
        }

        assert.equal(
          runStatus(runId),
          "failed",
          `run should fail after ${maxRetries} retries are exhausted\nSteps:\n${stepsSnapshot(runId)}`,
        );
      });
    });
  }
});
});
