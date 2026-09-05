/**
 * VEDL (tamandua-6sy.19 / torture-test w4.35) US-002 + US-003 — scripted
 * full-pipeline e2e for the non-adjacent named-verifier layout.
 *
 * The public verify_each / verify_step contract names the verifier by step id;
 * adjacency is NOT required. US-001 narrowed claimStep's predecessor barrier so
 * that a *waiting* intermediate step declared between a paused verify_each loop
 * and its explicitly designated verifier no longer deadlocks the verifier. The
 * intermediate is never dispatched/skipped/auto-completed/advanced — it stays
 * exactly 'waiting' and executes once, in pipeline order, after the whole loop
 * finishes.
 *
 * This file proves the fix through the REAL product motor (isolated daemon →
 * scheduler → harness spawn → step protocol → worktree/merge), ZERO model
 * tokens, using the deterministic scripted agent:
 *
 *  1. NON-ADJACENT corridor (the w4.35 fossil layout): bug-fix-merge-worktree's
 *     installed workflow.yml is mutated so `fix` becomes a verify_each loop over
 *     two triager-emitted stories naming `verify` as its verifier, leaving
 *     `deception_audit` as a waiting intermediate between the paused loop and
 *     the verifier. Two stories with ONE verifier retry drive 3 fixer rounds and
 *     3 verifier rounds; the auditor dispatches exactly once, strictly after the
 *     final story's verification passes, and normal downstream completion
 *     (conditional test_cmd_review auto-completes, finalize_merge lands).
 *
 *  2. DURABLE RESTART corridor (US-003): the same mutated layout, but the
 *     test-owned daemon is stopped and restarted on the same isolated HOME at a
 *     verify_each pause — fix (loop) status 'running' with current_story_id
 *     NULL, its designated verifier 'pending', deception_audit still 'waiting'.
 *     The checkpoint is proven DURABLE: the isolated DB is re-read AFTER the
 *     exact test-owned daemon has fully stopped and BEFORE the restart, and the
 *     paused state (run running, loop paused-running with no current story,
 *     verifier pending, audit waiting, story rows consistent with the mid-loop
 *     pause) is asserted on that post-stop snapshot. A real restart boundary —
 *     an ISO timestamp captured once the restarted daemon is confirmed up
 *     (control plane listening) — anchors the post-restart event assertions:
 *     >=1 verifier claim and >=1 story.verified must occur strictly after it.
 *     After the restart the verifier claims and completes, verification returns
 *     to the correct loop/story, and the audit still dispatches exactly once
 *     after the loop finishes. Asserts stale-claim recovery never abandons the
 *     paused loop (cleanupAbandonedSteps / recoverOrphanedStepsForAgent /
 *     recoverStepsWithDeadWorkers all skip a paused loop whose verify is
 *     pending/running): no step.timeout / step.worker_lost / step.failed /
 *     story.abandoned events for the loop, no extra loop claim, worker_lost
 *     counters stay 0.
 *
 *  3. ADJACENT control: feature-dev-merge-worktree's natural verify_each layout
 *     (implement(loop) → verify adjacent, two stories, one verifier retry) must
 *     keep its unchanged per-story verify ordering and complete with zero tokens.
 *
 * Registration: listed in run-all-scripted-e2e-tests and run-all-e2e-tests.
 *
 * Run via: npm run build && node --test e2e-tests/workflows-verify-each-nonadjacent.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { cleanChildEnv } from "../tests/helpers/test-env.ts";
import { openE2eDatabase } from "./helpers/e2e-database.mjs";
import {
  createTempHome,
  baseEnv,
  cliMustSucceed,
  spawnScriptedWorkflowRun,
  prepareGitRepo,
  detachOriginCheckout,
  resolveFullRunId,
  cleanupTempHome,
  releasePortReservations,
} from "./helpers/smoke-helpers.ts";
import {
  startIsolatedDaemon,
  stopIsolatedDaemon,
  pollForRunCompletionWithNudge,
} from "./helpers/e2e-helpers.ts";
import {
  createScriptedAgent,
  type ScriptedAgent,
  type ScriptedAgentConfig,
} from "./helpers/scripted-agent.ts";

const fixtureDir = path.join(process.cwd(), "e2e-tests", "fixtures", "sample-project");
const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");

// ── Shared plumbing (isolated env + daemon + scripted agent) ────────

interface VedlRunContext {
  env: Awaited<ReturnType<typeof createTempHome>>;
  scripted: ScriptedAgent;
  daemon: ChildProcess;
}

async function startVedlEnvironment(
  workflowId: string,
  behaviors: ScriptedAgentConfig,
  mutateWorkflow?: (tamanduaDir: string) => void,
): Promise<VedlRunContext> {
  const env = await createTempHome();
  const scripted = createScriptedAgent(env.root, behaviors);
  cliMustSucceed(
    ["workflow", "install", workflowId],
    baseEnv(env.homeDir, env.controlPort),
    `install ${workflowId}`,
  );
  // Mutation (when present) rewrites the INSTALLED copy under the isolated
  // HOME — the bundled workflow sources are never touched.
  if (mutateWorkflow) {
    mutateWorkflow(env.tamanduaDir);
  }
  await releasePortReservations(env);
  const daemon = await startIsolatedDaemon(
    env.homeDir,
    env.controlPort,
    scripted.env,
  );
  return { env, scripted, daemon };
}

async function teardown(ctx: VedlRunContext | undefined): Promise<void> {
  if (!ctx) return;
  try {
    await stopIsolatedDaemon(ctx.daemon);
  } catch {
    // best-effort
  }
  cleanupTempHome(ctx.env);
}

/** Append scripted-agent + daemon log diagnostics to a failure. */
function diagnostics(ctx: VedlRunContext): string {
  let daemonLogTail = "(no daemon log)";
  try {
    const logPath = path.join(ctx.env.tamanduaDir, "tamandua.log");
    const lines = fs.readFileSync(logPath, "utf-8").trimEnd().split("\n");
    daemonLogTail = lines.slice(-60).join("\n");
  } catch {
    // keep default
  }
  return [
    "── scripted-agent invocations ──",
    ctx.scripted.describe(),
    "── daemon log (last 60 lines) ──",
    daemonLogTail,
  ].join("\n");
}

async function waitForRun(
  ctx: VedlRunContext,
  runId: string,
  timeoutMs: number,
): Promise<string> {
  try {
    return await pollForRunCompletionWithNudge(
      runId,
      baseEnv(ctx.env.homeDir, ctx.env.controlPort),
      timeoutMs,
      1_500,
      ctx.env.tamanduaDir,
    );
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${diagnostics(ctx)}`);
  }
}

function dbRow<T>(tamanduaDir: string, sql: string, ...params: string[]): T {
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    return db.prepare(sql).get(...params) as T;
  } finally {
    db.close();
  }
}

function dbRows<T>(tamanduaDir: string, sql: string, ...params: string[]): T[] {
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function readRunEvents(tamanduaDir: string, runId: string): Array<Record<string, unknown>> {
  const eventsPath = path.join(tamanduaDir, "events", `${runId}.jsonl`);
  if (!fs.existsSync(eventsPath)) return [];
  return fs
    .readFileSync(eventsPath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function eventIndex(events: Array<Record<string, unknown>>, event: string, stepId?: string): number {
  return events.findIndex(
    (e) => e.event === event && (stepId === undefined || e.stepId === stepId),
  );
}

function countEvent(events: Array<Record<string, unknown>>, event: string, stepId?: string): number {
  return events.filter(
    (e) => e.event === event && (stepId === undefined || e.stepId === stepId),
  ).length;
}

/** Launch a worktree-mode workflow run and resolve its full run id. */
async function launchRun(
  ctx: VedlRunContext,
  workflowId: string,
  task: string,
  repoDir: string,
  originalBranch: string,
): Promise<string> {
  const runIdPrefix = await spawnScriptedWorkflowRun(
    [
      "workflow", "run", workflowId, task,
      "--worktree-origin-repository", repoDir,
      "--worktree-origin-ref", originalBranch,
    ],
    baseEnv(ctx.env.homeDir, ctx.env.controlPort),
  );
  return resolveFullRunId(runIdPrefix, ctx.env.tamanduaDir);
}

interface StoryRow {
  story_id: string;
  status: string;
  retry_count: number;
}

/** Shared story-accounting assertions: exactly one bounded verify retry. */
function assertStoryRetryAccounting(
  ctx: VedlRunContext,
  runId: string,
  stories: StoryRow[],
): void {
  assert.equal(stories.length, 2, `expected two story rows, got ${JSON.stringify(stories)}`);
  const byId = new Map(stories.map((s) => [s.story_id, s]));
  const first = byId.get("US-001");
  const second = byId.get("US-002");
  assert.ok(first && second, `expected US-001 and US-002 story rows, got ${JSON.stringify(stories)}`);
  assert.equal(first.status, "done", `US-001 should end done, got ${first.status}`);
  assert.equal(second.status, "done", `US-002 should end done, got ${second.status}`);
  // Exactly one bounded story retry on US-001 (verifier round 1 returned
  // STATUS: retry); US-002 passed on its first verification.
  assert.equal(first.retry_count, 1, `US-001 should carry one retry, got ${first.retry_count}`);
  assert.equal(second.retry_count, 0, `US-002 should carry zero retries, got ${second.retry_count}`);

  const events = readRunEvents(ctx.env.tamanduaDir, runId);
  const retryEvents = events.filter((e) => e.event === "story.retry");
  assert.equal(
    retryEvents.length,
    1,
    `exactly one story.retry event expected; events: ${events.map((e) => e.event).join(", ")}`,
  );
  assert.equal(
    countEvent(events, "story.started"),
    3,
    "story.started: US-001, US-001 retry, US-002",
  );
  assert.equal(countEvent(events, "story.done"), 3, "story.done for each of the three story rounds");
  assert.equal(countEvent(events, "story.verified"), 2, "two passing verifications (US-001 retry + US-002)");
  assert.equal(typeof retryEvents[0]?.detail, "string", "story.retry must carry the ISSUES detail");

  // Per-story verify retry budget reset: the verify step row's retry_count is
  // story-scoped and reset on every verify completion (handleVerifyEachCompletion).
  const verifyStep = dbRow<{ status: string; retry_count: number }>(
    ctx.env.tamanduaDir,
    "SELECT status, retry_count FROM steps WHERE run_id = ? AND step_id = 'verify'",
    runId,
  );
  assert.equal(verifyStep.status, "done", `verify step should be done, got ${verifyStep.status}`);
  assert.equal(verifyStep.retry_count, 0, "verify retry_count is story-scoped and resets to 0");
}

/** Shared final assertions: run + all steps done, zero heartbeat/token spend. */
function assertZeroTokenMotorContract(ctx: VedlRunContext, runId: string): void {
  const run = dbRow<{ status: string; tokens_spent: number }>(
    ctx.env.tamanduaDir,
    "SELECT status, tokens_spent FROM runs WHERE id = ?",
    runId,
  );
  assert.equal(run.status, "completed", `run should complete, got ${run.status}\n${diagnostics(ctx)}`);
  assert.equal(run.tokens_spent, 0, `zero real model tokens expected, got ${run.tokens_spent}\n${diagnostics(ctx)}`);
  const stats = dbRow<{ system_tokens_spent: number }>(
    ctx.env.tamanduaDir,
    "SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1",
  );
  assert.equal(stats.system_tokens_spent, 0, `system token tripwire must stay 0 (N1), got ${stats.system_tokens_spent}`);
  assert.equal(
    ctx.scripted.heartbeats().length,
    0,
    `deterministic motor must never spawn without pending work (N2)\n${diagnostics(ctx)}`,
  );
}

function assertAllStepsDone(ctx: VedlRunContext, runId: string, expectedCount: number): void {
  const steps = dbRows<{ step_id: string; status: string }>(
    ctx.env.tamanduaDir,
    "SELECT step_id, status FROM steps WHERE run_id = ? ORDER BY step_index",
    runId,
  );
  assert.equal(steps.length, expectedCount, `expected ${expectedCount} steps, got ${JSON.stringify(steps)}`);
  for (const step of steps) {
    assert.equal(
      step.status,
      "done",
      `step ${step.step_id} should be done, got ${step.status}\n${diagnostics(ctx)}`,
    );
  }
}

// ── US-003 durable checkpoint helpers ────────────────────────────────

/**
 * A DB snapshot of the verify_each pause. Two flavors are captured by the
 * restart corridor:
 *
 *  - transient pre-stop observation (from waitForPausedLoopCheckpoint): the
 *    instant the live motor is first seen paused — used to drive the stop and
 *    for the pre-stop ledger checks;
 *  - DURABLE post-stop checkpoint (from readPauseProbe right after the exact
 *    test-owned daemon fully stopped, before the restart): the actual rows the
 *    restarted daemon resumes from. The post-stop snapshot is the durable
 *    checkpoint the acceptance criteria require.
 */
interface PausedLoopSnapshot {
  /** ISO timestamp captured when this snapshot was taken. */
  checkpointTs: string;
  runStatus: string;
  fixStatus: string;
  fixCurrentStoryId: string | null;
  verifyStatus: string;
  auditStatus: string;
  storyStates: Array<{ story_id: string; status: string; retry_count: number }>;
}

interface PauseProbe {
  runStatus: string;
  fixStatus: string;
  fixCurrentStoryId: string | null;
  verifyStatus: string;
  auditStatus: string;
  storyStates: Array<{ story_id: string; status: string; retry_count: number }>;
}

/**
 * The US-003 durable-restart proof boundary:
 *  - `durable` is the paused-state snapshot re-read AFTER the exact test-owned
 *    daemon fully stopped and BEFORE the restart (the true restart corridor);
 *  - `restartBoundaryTs` is a REAL restart boundary — an ISO timestamp captured
 *    once the restarted daemon is confirmed up (control plane listening). Only
 *    events strictly after this instant count as post-restart activity.
 */
interface RestartBoundary {
  durable: PausedLoopSnapshot;
  restartBoundaryTs: string;
}

/** Read the paused-loop-relevant rows for the run from the isolated DB. */
function readPauseProbe(tamanduaDir: string, runId: string): PauseProbe {
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
      | { status: string }
      | undefined;
    const stepRows = db
      .prepare(
        "SELECT step_id, status, current_story_id FROM steps WHERE run_id = ? AND step_id IN ('fix', 'verify', 'deception_audit')",
      )
      .all(runId) as Array<{ step_id: string; status: string; current_story_id: string | null }>;
    const byId = new Map(stepRows.map((r) => [r.step_id, r]));
    const stories = db
      .prepare("SELECT story_id, status, retry_count FROM stories WHERE run_id = ? ORDER BY story_index")
      .all(runId) as Array<{ story_id: string; status: string; retry_count: number }>;
    return {
      runStatus: run?.status ?? "(no run row)",
      fixStatus: byId.get("fix")?.status ?? "(no fix step)",
      fixCurrentStoryId: byId.get("fix")?.current_story_id ?? null,
      verifyStatus: byId.get("verify")?.status ?? "(no verify step)",
      auditStatus: byId.get("deception_audit")?.status ?? "(no deception_audit step)",
      storyStates: stories,
    };
  } finally {
    db.close();
  }
}

/**
 * Assert a DB probe is EXACTLY the paused verify_each checkpoint of this
 * scenario:
 *
 *  - the run is still 'running';
 *  - fix (the loop) is 'running' with current_story_id NULL — paused after a
 *    story attempt, with no story pinned;
 *  - verify (the loop's designated verifier) is 'pending';
 *  - deception_audit (the waiting intermediate) is still exactly 'waiting';
 *  - the story rows are consistent with a mid-loop pause of this scenario: no
 *    story 'running' (a paused loop pins none) and no story 'failed'; US-001
 *    has completed >=1 attempt ('done') and carries at most the single scripted
 *    retry (0 or 1); US-002 is 'pending' (not yet attempted, or the retry is
 *    still open) or 'done' — and US-002 can only be 'done' once US-001's retry
 *    resolved (retry_count 1), because the verifier's first round always
 *    returns retry. Whichever pause the corridor lands on (after story 1,
 *    after the retry revision, or after story 2), these invariants hold.
 *
 * `label` names the probe in failure messages (e.g. "transient pre-stop" vs
 * "durable post-stop checkpoint").
 */
function assertPausedLoopProbe(
  probe: PauseProbe,
  ctx: VedlRunContext,
  label: string,
): void {
  assert.equal(
    probe.runStatus,
    "running",
    `${label}: the run must still be 'running', got ${probe.runStatus}\n${diagnostics(ctx)}`,
  );
  assert.equal(
    probe.fixStatus,
    "running",
    `${label}: fix (loop) must be paused-running, got ${probe.fixStatus}\n${diagnostics(ctx)}`,
  );
  assert.equal(
    probe.fixCurrentStoryId,
    null,
    `${label}: the paused loop must pin no current story, got ${JSON.stringify(probe.fixCurrentStoryId)}`,
  );
  assert.equal(
    probe.verifyStatus,
    "pending",
    `${label}: the designated verifier must be pending, got ${probe.verifyStatus}\n${diagnostics(ctx)}`,
  );
  assert.equal(
    probe.auditStatus,
    "waiting",
    `${label}: deception_audit must still be exactly 'waiting', got ${probe.auditStatus}\n${diagnostics(ctx)}`,
  );

  const byId = new Map(probe.storyStates.map((s) => [s.story_id, s]));
  const first = byId.get("US-001");
  const second = byId.get("US-002");
  assert.ok(
    first && second,
    `${label}: expected US-001 + US-002 story rows at the pause, got ${JSON.stringify(probe.storyStates)}`,
  );
  for (const s of probe.storyStates) {
    assert.ok(
      s.status !== "running" && s.status !== "failed",
      `${label}: a paused loop pins no 'running'/'failed' story, got ${JSON.stringify(probe.storyStates)}`,
    );
  }
  assert.equal(
    first.status,
    "done",
    `${label}: US-001 must have completed >=1 attempt at any pause, got ${JSON.stringify(probe.storyStates)}`,
  );
  assert.ok(
    first.retry_count === 0 || first.retry_count === 1,
    `${label}: US-001 may carry at most the single scripted retry at a pause, got ${JSON.stringify(probe.storyStates)}`,
  );
  assert.ok(
    second.status === "pending" || second.status === "done",
    `${label}: US-002 must be 'pending' or 'done' at a pause, got ${JSON.stringify(probe.storyStates)}`,
  );
  assert.equal(second.retry_count, 0, `${label}: US-002 never retries in this scenario`);
  if (second.status === "done") {
    assert.equal(
      first.retry_count,
      1,
      `${label}: US-002 cannot be 'done' before US-001's retry resolved (verifier round 1 always retries)`,
    );
  }
}

/**
 * Drive the run (nudging at a slow cadence) and return the instant a paused
 * verify_each checkpoint is observed:
 *
 *   fix (loop)   status 'running' with current_story_id NULL   ← paused
 *   verify       status 'pending'                              ← designated verifier waiting
 *   deception_audit status 'waiting'                           ← intermediate still untouched
 *
 * A paused loop is transient under the live motor (the completion nudge
 * launches the verifier's dispatch round within ~100ms), so the DB is probed
 * on a tight 5ms cadence while nudges (the only other progression driver)
 * stay ≥400ms apart. Only a clean 'pending' pause is checkpointed: if a poll
 * catches the verifier mid-claim ('running') we let that round finish and keep
 * polling — the pipeline always produces another pause until the loop
 * finishes, and the final story/verify accounting is identical whichever pause
 * is chosen (the verifier's per-story retry already happened before any pause
 * after the first story attempt).
 */
async function waitForPausedLoopCheckpoint(
  ctx: VedlRunContext,
  runId: string,
  timeoutMs: number,
): Promise<PausedLoopSnapshot> {
  const startedAt = Date.now();
  const env = baseEnv(ctx.env.homeDir, ctx.env.controlPort);
  const terminal = new Set(["completed", "done", "failed", "canceled"]);
  let lastNudge = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const probe = readPauseProbe(ctx.env.tamanduaDir, runId);
    const paused =
      probe.runStatus === "running" &&
      probe.fixStatus === "running" &&
      probe.fixCurrentStoryId === null &&
      probe.verifyStatus === "pending" &&
      probe.auditStatus === "waiting";
    if (paused) {
      return { checkpointTs: new Date().toISOString(), ...probe };
    }
    if (terminal.has(probe.runStatus)) {
      throw new Error(
        `Run reached "${probe.runStatus}" before the paused-loop checkpoint could be observed: ` +
          `${JSON.stringify(probe)}\n${diagnostics(ctx)}`,
      );
    }
    if (Date.now() - lastNudge > 400) {
      spawnSync(process.execPath, [cliPath, "nudge"], {
        env: cleanChildEnv(env),
        encoding: "utf-8",
      });
      lastNudge = Date.now();
    }
    await sleep(5);
  }
  const last = readPauseProbe(ctx.env.tamanduaDir, runId);
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for the paused verify_each checkpoint ` +
      `(fix running / current_story_id NULL, verify pending, deception_audit waiting). Last: ` +
      `${JSON.stringify(last)}\n${diagnostics(ctx)}`,
  );
}

// ── Non-adjacent corridor (w4.35 fossil layout) ─────────────────────

const NONADJ_BRANCH = "bugfix/vedl-nonadjacent-scripted";
const NONADJ_WORKFLOW = "bug-fix-merge-worktree";
// bug-fix-merge-worktree steps: triage, investigate, setup, fix, deception_audit,
// verify, test_cmd_review (conditional), finalize_merge.
const NONADJ_STEP_COUNT = 8;

function nonAdjacentStoryJson(): string {
  return JSON.stringify([
    {
      id: "US-001",
      title: "Correct add() to use addition",
      description: "Replace the subtraction operator with addition in src/math.ts and add a story marker.",
      acceptanceCriteria: ["math.ts uses a + b", "story-us-001.txt exists", "Typecheck passes"],
    },
    {
      id: "US-002",
      title: "Add story-two marker",
      description: "Add a second story marker file proving multi-story loop iteration.",
      acceptanceCriteria: ["story-us-002.txt exists", "Typecheck passes"],
    },
  ]);
}

function nonAdjacentBehaviors(): ScriptedAgentConfig {
  return {
    agents: {
      triager: {
        output: [
          "STATUS: done",
          "REPO: {{cwd}}",
          `BRANCH: ${NONADJ_BRANCH}`,
          "SEVERITY: high",
          "AFFECTED_AREA: src/math.ts",
          "REPRODUCTION: add(5, 3) returns 2 instead of 8",
          "PROBLEM_STATEMENT: add() subtracts instead of adding",
          `STORIES_JSON: ${nonAdjacentStoryJson()}`,
        ].join("\n"),
      },
      investigator: {
        output: [
          "STATUS: done",
          "ROOT_CAUSE: add() uses the subtraction operator",
          "FIX_APPROACH: replace a - b with a + b in src/math.ts",
        ].join("\n"),
      },
      setup: {
        commands: [`git checkout -b ${NONADJ_BRANCH}`],
        output: [
          "STATUS: done",
          "ORIGINAL_BRANCH: {{input.ORIGINAL_BRANCH}}",
          "BUILD_CMD: true",
          "TEST_CMD: true",
          "BASELINE: add() is broken as reported",
        ].join("\n"),
      },
      // 2 stories + 1 verifier retry on story US-001 => 3 fixer work rounds.
      // Round 2 (the retry) is a *new* commit so verification can observe the
      // tree advanced in response to the ISSUES feedback.
      fixer: [
        {
          edits: [{ file: "src/math.ts", find: "a - b", replace: "a + b" }],
          writes: [{ file: "story-us-001.txt", content: "story one implemented\n" }],
          commands: ["git add -A", `git commit -m "fix: US-001 correct add()"`],
          output: [
            "STATUS: done",
            "CHANGES: story US-001 implemented (math.ts + marker)",
            "REGRESSION_TEST: scripted fixture story one coverage",
            "CANNOT_REPRODUCE: scripted scenario - deterministic fix applied",
          ].join("\n"),
        },
        {
          writes: [{
            file: "story-us-001.txt",
            content: "story one implemented (revised after verification feedback)\n",
          }],
          commands: ["git add -A", `git commit -m "fix: US-001 revise story one after verification feedback"`],
          output: [
            "STATUS: done",
            "CHANGES: story US-001 revised after verification feedback",
            "REGRESSION_TEST: scripted fixture story one coverage",
            "CANNOT_REPRODUCE: scripted scenario - deterministic fix applied",
          ].join("\n"),
        },
        {
          writes: [{ file: "story-us-002.txt", content: "story two implemented\n" }],
          commands: ["git add -A", `git commit -m "fix: US-002 add story two marker"`],
          output: [
            "STATUS: done",
            "CHANGES: story US-002 implemented (marker file)",
            "REGRESSION_TEST: scripted fixture story two coverage",
            "CANNOT_REPRODUCE: scripted scenario - deterministic fix applied",
          ].join("\n"),
        },
      ],
      // First invocation (story US-001 verification) returns STATUS: retry with
      // ISSUES; every later invocation (US-001 re-verify, US-002) returns done.
      verifier: [
        {
          output: [
            "STATUS: retry",
            "ISSUES: story one marker content still incomplete - revise and re-verify",
            "TESTS: deferred until the story-one revision lands",
          ].join("\n"),
        },
        {
          output: [
            "STATUS: done",
            "VERIFIED: story implementation verified against marker files",
            "TESTED_TREE: {{gitTree}}",
          ].join("\n"),
        },
      ],
      auditor: {
        output: "STATUS: done\nVERDICT: HONEST",
      },
      merger: {
        commands: [
          `expected_tip=$(git -C "{{input.WORKTREE_ORIGIN_REPOSITORY}}" rev-parse "refs/heads/{{input.ORIGINAL_BRANCH}}") && TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${process.execPath}" "${cliPath}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" --branch "${NONADJ_BRANCH}" --into "{{input.ORIGINAL_BRANCH}}" --expect-tip "$expected_tip" --message "fix: VEDL non-adjacent verify_each corridor (squash of ${NONADJ_BRANCH})"`,
        ],
        includeCommandOutput: true,
        output: [
          "STATUS: done",
          "REBASED: false",
          "MERGED_INTO: {{input.ORIGINAL_BRANCH}}",
        ].join("\n"),
      },
    },
    heartbeatTokens: 0,
    defaultTokens: 0,
  };
}

/**
 * Mutate the INSTALLED bug-fix-merge-worktree copy into the w4.35 fossil
 * layout: `fix` becomes a verify_each loop over the triager-emitted stories
 * naming `verify` as its verifier, leaving `deception_audit` as a waiting
 * intermediate between the paused loop and the verifier. Mirrors the loop
 * injection of torture-test/scenarios/w4.35/run-retry-cell.mjs (the bundled /
 * torture-test sources themselves are never touched).
 */
function mutateNonAdjacentWorkflow(tamanduaDir: string): void {
  const workflowPath = path.join(tamanduaDir, "workflows", NONADJ_WORKFLOW, "workflow.yml");
  let text = fs.readFileSync(workflowPath, "utf-8");

  const loopInjected = text.replace(
    "  - id: fix\n    agent: fixer\n",
    [
      "  - id: fix",
      "    agent: fixer",
      "    type: loop",
      "    loop:",
      "      over: stories",
      "      completion: all_done",
      "      fresh_session: true",
      "      verify_each: true",
      "      verify_step: verify",
      "",
    ].join("\n"),
  );
  assert.notEqual(
    loopInjected,
    text,
    "the installed bug-fix workflow must contain the fix step for the loop injection",
  );
  text = loopInjected;

  // The verifier's expects must accept both verdict variants so the retry
  // output routes through the verify_each completion path (not expects retry).
  const verifierExpects = text.replace(
    /(\n  - id: verify[\s\S]*?\n    expects: )[^\n]+/,
    "$1|\n      regex:^STATUS:\\s*(done|retry)\\s*$",
  );
  assert.notEqual(
    verifierExpects,
    text,
    "the installed bug-fix workflow must contain the verify step expects line",
  );

  fs.writeFileSync(workflowPath, verifierExpects);
}

/**
 * Shared final-state assertions for the non-adjacent (w4.35 fossil) layout —
 * used by the plain corridor (US-002) and, with `restart`, by the durable
 * restart corridor (US-003).
 *
 * `restart` carries the US-003 durable-restart proof:
 *  - `durable`: the paused-state DB snapshot re-read AFTER the exact
 *    test-owned daemon fully stopped and BEFORE the restart — asserted to be
 *    exactly the paused checkpoint (run running, loop paused-running with no
 *    current story, verifier pending, audit waiting, mid-loop story rows);
 *  - `restartBoundaryTs`: a REAL restart boundary (ISO timestamp once the
 *    restarted daemon is confirmed up / control plane listening). The verifier
 *    must claim at least once and a story verification must complete strictly
 *    after this boundary.
 * Plus the stale-claim-recovery proof (no step.timeout/step.worker_lost/
 * step.failed for `fix`, no story.abandoned, exactly one fix claim per story
 * round (3), runs.worker_lost_count / ceiling_expiry_count stay 0).
 */
function assertNonAdjacentFinalState(
  ctx: VedlRunContext,
  runId: string,
  repoDir: string,
  originalBranch: string,
  restart?: RestartBoundary,
): void {
  // ── Pipeline state: all eight steps done; nothing failed ──
  assertAllStepsDone(ctx, runId, NONADJ_STEP_COUNT);

  // ── The named verifier is claimable across the waiting intermediate:
  // exactly three verifier rounds (US-001 retry, US-001 pass, US-002 pass)
  // and three fixer rounds (US-001, US-001 retry, US-002) ──
  assert.equal(
    ctx.scripted.workInvocations("fixer").length,
    3,
    `fixer: 2 stories + 1 retry => 3 work rounds\n${diagnostics(ctx)}`,
  );
  assert.equal(
    ctx.scripted.workInvocations("verifier").length,
    3,
    `verifier: retry then two passes => 3 work rounds\n${diagnostics(ctx)}`,
  );
  // No other agent ran early: auditor exactly once at the end, reviewer
  // never dispatched (zero-token conditional sweep), everyone else once.
  assert.equal(
    ctx.scripted.workInvocations("auditor").length,
    1,
    `auditor must dispatch exactly once\n${diagnostics(ctx)}`,
  );
  assert.equal(
    ctx.scripted.workInvocations("reviewer").length,
    0,
    `reviewer must never dispatch (test_cmd_review auto-completes)\n${diagnostics(ctx)}`,
  );
  for (const agent of ["triager", "investigator", "setup", "merger"]) {
    assert.equal(
      ctx.scripted.workInvocations(agent).length,
      1,
      `agent ${agent} should do exactly 1 work round\n${diagnostics(ctx)}`,
    );
  }

  // ── Story accounting: one bounded story.retry; per-story verify retry
  // budget reset; US-001 retried once, US-002 clean ──
  const stories = dbRows<StoryRow>(
    ctx.env.tamanduaDir,
    "SELECT story_id, status, retry_count FROM stories WHERE run_id = ? ORDER BY story_index",
    runId,
  );
  assertStoryRetryAccounting(ctx, runId, stories);

  // ── deception_audit lifecycle: a plain single step that stayed exactly
  // 'waiting' until the whole loop finished. Its ONLY lifecycle events are
  // one step.pending (pipeline advance after the loop), one step.running
  // (single auditor dispatch) and one step.done; the step.done row flags
  // confirm it was never auto-completed and no early claim occurred ──
  const events = readRunEvents(ctx.env.tamanduaDir, runId);
  const auditPendingIdx = eventIndex(events, "step.pending", "deception_audit");
  const auditRunningIdx = eventIndex(events, "step.running", "deception_audit");
  const auditDoneIdx = eventIndex(events, "step.done", "deception_audit");
  const lastVerifiedIdx = events.map((e) => e.event).lastIndexOf("story.verified");
  assert.ok(lastVerifiedIdx >= 0, "at least one story.verified event expected");
  assert.equal(countEvent(events, "step.pending", "deception_audit"), 1);
  assert.equal(countEvent(events, "step.running", "deception_audit"), 1);
  assert.equal(countEvent(events, "step.done", "deception_audit"), 1);
  assert.equal(countEvent(events, "deception_audit.passed"), 1);
  assert.equal(countEvent(events, "step.auto_completed", "deception_audit"), 0);
  assert.equal(
    countEvent(events, "step.running", "verify"),
    3,
    "verify claimed once per verification round (retry + 2 passes)",
  );
  assert.ok(
    auditPendingIdx > lastVerifiedIdx,
    `deception_audit must not leave 'waiting' before the final story verification passes ` +
      `(last story.verified at ${lastVerifiedIdx}, audit step.pending at ${auditPendingIdx})`,
  );
  assert.ok(
    auditRunningIdx > auditPendingIdx && auditDoneIdx > auditRunningIdx,
    `audit lifecycle order must be pending < running < done ` +
      `(got ${auditPendingIdx}, ${auditRunningIdx}, ${auditDoneIdx})`,
  );
  // The audit dispatches strictly before downstream completion:
  // test_cmd_review's auto-complete and finalize_merge both follow it.
  const reviewAutoIdx = eventIndex(events, "step.auto_completed", "test_cmd_review");
  const finalizeRunningIdx = eventIndex(events, "step.running", "finalize_merge");
  assert.ok(reviewAutoIdx > auditDoneIdx, "conditional test_cmd_review auto-completes after the audit");
  assert.ok(finalizeRunningIdx > auditDoneIdx, "finalize_merge dispatches after the audit");

  // ── Stale-claim recovery never touched the loop: the paused loop is
  // protected by the verify pending/running skip in cleanupAbandonedSteps,
  // recoverOrphanedStepsForAgent and the dead-worker sweep. Across the whole
  // run there must be no loop recovery event, no loop re-claim (each fix
  // claim corresponds to exactly one story round = 3), and no worker lost /
  // ceiling-expiry accounting anywhere ──
  assert.equal(
    countEvent(events, "step.running", "fix"),
    3,
    `fix (loop) claimed exactly once per story round — a stale-claim recovery would add a claim\n${diagnostics(ctx)}`,
  );
  assert.equal(
    countEvent(events, "step.timeout", "fix"),
    0,
    `no step.timeout may touch the paused loop\n${diagnostics(ctx)}`,
  );
  assert.equal(
    countEvent(events, "step.worker_lost", "fix"),
    0,
    `no step.worker_lost may touch the paused loop\n${diagnostics(ctx)}`,
  );
  assert.equal(
    countEvent(events, "step.failed", "fix"),
    0,
    `no step.failed may touch the paused loop\n${diagnostics(ctx)}`,
  );
  assert.equal(
    countEvent(events, "story.abandoned"),
    0,
    `no story may be abandoned (stale-claim recovery of a paused loop would abandon its story)\n${diagnostics(ctx)}`,
  );
  const lostCounters = dbRow<{ worker_lost_count: number; ceiling_expiry_count: number }>(
    ctx.env.tamanduaDir,
    "SELECT worker_lost_count, ceiling_expiry_count FROM runs WHERE id = ?",
    runId,
  );
  assert.equal(lostCounters.worker_lost_count, 0, `no worker may be reported lost\n${diagnostics(ctx)}`);
  assert.equal(lostCounters.ceiling_expiry_count, 0, `no worker ceiling expiry\n${diagnostics(ctx)}`);

  // ── US-003 durable restart proof ──
  if (restart) {
    // The durable post-stop checkpoint must be EXACTLY the paused state the
    // restarted daemon resumes from: run running, fix (loop) paused-running
    // with current_story_id NULL, its designated verifier pending,
    // deception_audit still waiting, story rows consistent with the pause.
    assertPausedLoopProbe(restart.durable, ctx, "durable post-stop checkpoint");

    // Real restart boundary: the restarted daemon was confirmed up (control
    // plane listening) at `restartBoundaryTs`. With the daemon down between
    // the durable checkpoint and that boundary, nothing could claim or
    // advance — so the first activity strictly after the boundary IS the
    // resumed run. The verifier must claim at least once and a story
    // verification must complete strictly after the restart boundary (the
    // pause always leaves >=1 verification round outstanding, whichever
    // pause the corridor landed on).
    const afterRestart = events.filter(
      (e) => typeof e.ts === "string" && e.ts > restart.restartBoundaryTs,
    );
    assert.ok(
      countEvent(afterRestart, "step.running", "verify") >= 1,
      `the verifier must claim after the daemon restart (restart boundary ${restart.restartBoundaryTs})\n` +
        afterRestart.map((e) => `${e.ts} ${e.event}${e.stepId ? ` ${String(e.stepId)}` : ""}`).join("\n"),
    );
    assert.ok(
      countEvent(afterRestart, "story.verified") >= 1,
      `verification must return to the loop/story after the restart (restart boundary ${restart.restartBoundaryTs})`,
    );
    // Nothing may have happened between the durable post-stop checkpoint and
    // the restart boundary (the daemon was down): no verify claim, no
    // story.verified may be timestamped in that gap.
    const inGap = events.filter(
      (e) =>
        typeof e.ts === "string" &&
        e.ts > restart.durable.checkpointTs &&
        e.ts <= restart.restartBoundaryTs &&
        (e.event === "step.running" || e.event === "story.verified"),
    );
    assert.equal(
      inGap.length,
      0,
      `no claim/verification may occur between the durable checkpoint ${restart.durable.checkpointTs} ` +
        `and the restart boundary ${restart.restartBoundaryTs} (the daemon was down):\n` +
        inGap.map((e) => `${e.ts} ${e.event}${e.stepId ? ` ${String(e.stepId)}` : ""}`).join("\n"),
    );
  }

  const auditStep = dbRow<{
    status: string;
    auto_completed: number;
    auto_complete_reason: string | null;
    retry_count: number;
  }>(
    ctx.env.tamanduaDir,
    "SELECT status, auto_completed, auto_complete_reason, retry_count FROM steps WHERE run_id = ? AND step_id = 'deception_audit'",
    runId,
  );
  assert.equal(auditStep.status, "done", "deception_audit executes once, after the loop");
  assert.equal(auditStep.auto_completed, 0, "the audit is a real dispatch, never auto-completed");
  assert.equal(auditStep.auto_complete_reason, null);
  assert.equal(auditStep.retry_count, 0, "the audit never retried");

  // The fix (loop) row finished normally with no story pinned and never bumped
  // its retry budget (story-level retries are accounted on the story rows).
  const fixStep = dbRow<{ status: string; current_story_id: string | null; retry_count: number; abandoned_count: number }>(
    ctx.env.tamanduaDir,
    "SELECT status, current_story_id, retry_count, abandoned_count FROM steps WHERE run_id = ? AND step_id = 'fix'",
    runId,
  );
  assert.equal(fixStep.status, "done", "fix (loop) step should end done");
  assert.equal(fixStep.current_story_id, null);
  assert.equal(fixStep.retry_count, 0, "story-level retries do not bump the loop step retry_count");
  assert.equal(fixStep.abandoned_count, 0, "the paused loop must never be abandoned/recovered");

  // Conditional test_cmd_review auto-completed with zero dispatches.
  const reviewStep = dbRow<{ status: string; auto_completed: number; auto_complete_reason: string | null }>(
    ctx.env.tamanduaDir,
    "SELECT status, auto_completed, auto_complete_reason FROM steps WHERE run_id = ? AND step_id = 'test_cmd_review'",
    runId,
  );
  assert.equal(reviewStep.status, "done");
  assert.equal(reviewStep.auto_completed, 1, "test_cmd_review auto-completes via the zero-token conditional sweep");
  assert.equal(reviewStep.auto_complete_reason, "condition_unset:test_cmd_review_required");

  // ── Zero tokens + deterministic motor ──
  assertZeroTokenMotorContract(ctx, runId);

  // ── Repository outcome: the fix landed on the original branch ──
  const landedMath = execSync(`git show "refs/heads/${originalBranch}:src/math.ts"`, {
    cwd: repoDir,
    encoding: "utf-8",
  });
  assert.ok(landedMath.includes("a + b"), `target math.ts should carry the fix:\n${landedMath}`);
  const storyOne = execSync(`git show "refs/heads/${originalBranch}:story-us-001.txt"`, {
    cwd: repoDir,
    encoding: "utf-8",
  });
  assert.ok(
    storyOne.includes("revised after verification feedback"),
    `story-us-001.txt should carry the retry revision:\n${storyOne}`,
  );
  execSync(`git show "refs/heads/${originalBranch}:story-us-002.txt"`, {
    cwd: repoDir,
    encoding: "utf-8",
  });
  const mergeStep = dbRow<{ status: string; output: string }>(
    ctx.env.tamanduaDir,
    "SELECT status, output FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'",
    runId,
  );
  assert.equal(mergeStep.status, "done");
  assert.match(mergeStep.output, /^STATUS: landed$/m);

  console.log(
    `[vedl e2e non-adjacent${restart ? " (durable restart)" : ""}] run ${runId.slice(0, 8)} completed: ` +
      `3 fixer + 3 verifier + 1 auditor rounds, audit dispatched once after ` +
      `${countEvent(events, "story.verified")} verifications, 0 tokens`,
  );
}

// concurrency: 1 — the US-003 restart corridor polls the DB on a 5ms cadence
// to catch the (transient) paused-loop checkpoint; sibling corridors running in
// the same process would stall those polls with their own spawnSync calls.
describe("VEDL US-002/US-003: scripted e2e - non-adjacent named verifier with a waiting intermediate", { concurrency: 1 }, () => {
  it(
    "bug-fix-merge-worktree (mutated): deception_audit stays waiting through every story/verify round, then dispatches once after the loop finishes",
    { timeout: 300_000 },
    async () => {
      let ctx: VedlRunContext | undefined;
      try {
        ctx = await startVedlEnvironment(
          NONADJ_WORKFLOW,
          nonAdjacentBehaviors(),
          mutateNonAdjacentWorkflow,
        );
        const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
        const { branch: originalBranch } = detachOriginCheckout(repoDir);
        const runId = await launchRun(
          ctx,
          NONADJ_WORKFLOW,
          "The add function in src/math.ts returns a - b instead of a + b",
          repoDir,
          originalBranch,
        );

        const status = await waitForRun(ctx, runId, 240_000);
        assert.equal(status, "completed", `run should complete, got "${status}"\n${diagnostics(ctx)}`);

        assertNonAdjacentFinalState(ctx, runId, repoDir, originalBranch);
      } finally {
        await teardown(ctx);
      }
    },
  );

  it(
    "bug-fix-merge-worktree (mutated, durable restart): paused verify_each loop + pending verifier survive an isolated-daemon restart; the audit still runs exactly once after the loop",
    { timeout: 300_000 },
    async () => {
      let ctx: VedlRunContext | undefined;
      try {
        ctx = await startVedlEnvironment(
          NONADJ_WORKFLOW,
          nonAdjacentBehaviors(),
          mutateNonAdjacentWorkflow,
        );
        const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
        const { branch: originalBranch } = detachOriginCheckout(repoDir);
        const runId = await launchRun(
          ctx,
          NONADJ_WORKFLOW,
          "The add function in src/math.ts returns a - b instead of a + b",
          repoDir,
          originalBranch,
        );

        // ── Watch the DB until a verify_each pause is observed: the fix loop
        // is 'running' with current_story_id NULL (paused after a story
        // attempt), its designated verifier is 'pending' and deception_audit
        // is still exactly 'waiting'. The verifier's per-story retry may
        // already have happened (first story attempt checkpoint) — the final
        // story/verify accounting is identical whichever pause is captured. ──
        const paused = await waitForPausedLoopCheckpoint(ctx, runId, 120_000);
        assertPausedLoopProbe(paused, ctx, "transient pre-stop checkpoint");

        // Pre-restart ledger evidence: the intermediate has not dispatched and
        // no recovery event ever touched the paused loop.
        const preStopEvents = readRunEvents(ctx.env.tamanduaDir, runId);
        assert.equal(
          countEvent(preStopEvents, "step.running", "deception_audit"),
          0,
          "the audit must not dispatch before the restart (the loop is not finished)\n" +
            preStopEvents.map((e) => `${e.ts} ${e.event}${e.stepId ? ` ${String(e.stepId)}` : ""}`).join("\n"),
        );
        assert.equal(
          countEvent(preStopEvents, "step.timeout", "fix") +
            countEvent(preStopEvents, "step.worker_lost", "fix") +
            countEvent(preStopEvents, "step.failed", "fix"),
          0,
          "no stale-claim recovery event may touch the paused loop before the restart",
        );

        // ── Durable restart of ONLY the exact test-owned daemon on the SAME
        // isolated HOME + control port (existing helpers; no production
        // lifecycle change). The daemon's reconciler re-admits the running run
        // ~1s after startup, then the pending verifier claims normally. ──
        await stopIsolatedDaemon(ctx.daemon);

        // ── DURABLE CHECKPOINT: re-read the isolated DB AFTER the exact
        // test-owned daemon has fully stopped and BEFORE the restart. This is
        // the actual state the restarted daemon resumes from — the paused loop
        // (running / no current story), its pending verifier and the waiting
        // audit must all have persisted on disk while the daemon was down. If
        // the fixture advanced past the pause before the stop completed, this
        // assertion fails honestly (the corridor never labels a different state
        // as paused-loop restart coverage). ──
        const durableProbe = readPauseProbe(ctx.env.tamanduaDir, runId);
        assertPausedLoopProbe(durableProbe, ctx, "durable post-stop checkpoint");
        const durable: PausedLoopSnapshot = {
          checkpointTs: new Date().toISOString(),
          ...durableProbe,
        };

        ctx.daemon = await startIsolatedDaemon(
          ctx.env.homeDir,
          ctx.env.controlPort,
          ctx.scripted.env,
        );
        // ── REAL restart boundary: the restarted daemon is confirmed up
        // (control plane listening, startIsolatedDaemon resolved). Only events
        // strictly after this instant count as post-restart — the pre-stop
        // snapshot timestamp is NOT used for that purpose. ──
        const restartBoundaryTs = new Date().toISOString();

        const status = await waitForRun(ctx, runId, 240_000);
        assert.equal(
          status,
          "completed",
          `run should complete after the restart, got "${status}"\n${diagnostics(ctx)}`,
        );

        // Shared final-state assertions + durable-restart proof (the paused
        // state survived the real stop; the verifier re-claimed and a story
        // verification completed strictly after the restart boundary; the loop
        // was never abandoned/recovered; the audit ran exactly once after the
        // loop finished).
        assertNonAdjacentFinalState(ctx, runId, repoDir, originalBranch, {
          durable,
          restartBoundaryTs,
        });

        console.log(
          `[vedl e2e restart] run ${runId.slice(0, 8)} completed after isolated-daemon restart at paused ` +
            `verify_each checkpoint ${durable.checkpointTs} (fix paused, verify pending, audit waiting — proven ` +
            `on the post-stop DB, restart boundary ${restartBoundaryTs}): loop never abandoned, audit once after loop, 0 tokens`,
        );
      } finally {
        await teardown(ctx);
      }
    },
  );

  // ── Adjacent control: feature-dev-merge-worktree natural verify_each ──

  const ADJ_BRANCH = "feature/vedl-adjacent-control";
  const ADJ_WORKFLOW = "feature-dev-merge-worktree";
  // feature-dev-merge-worktree steps: plan, setup, implement, verify, test,
  // test_cmd_review (conditional), finalize_merge.
  const ADJ_STEP_COUNT = 7;

  function adjacentBehaviors(): ScriptedAgentConfig {
    return {
      agents: {
        planner: {
          output: [
            "STATUS: done",
            "REPO: {{cwd}}",
            `BRANCH: ${ADJ_BRANCH}`,
            `STORIES_JSON: ${JSON.stringify([
              {
                id: "US-001",
                title: "Adjacent control story one",
                description: "First story for the adjacent verify_each regression control.",
                acceptanceCriteria: ["marker-one exists", "Typecheck passes"],
              },
              {
                id: "US-002",
                title: "Adjacent control story two",
                description: "Second story for the adjacent verify_each regression control.",
                acceptanceCriteria: ["marker-two exists", "Typecheck passes"],
              },
            ])}`,
          ].join("\n"),
        },
        setup: {
          commands: [`git checkout -b ${ADJ_BRANCH}`],
          output: [
            "STATUS: done",
            "ORIGINAL_BRANCH: {{input.ORIGINAL_BRANCH}}",
            "BUILD_CMD: true",
            "TEST_CMD: true",
            "BASELINE: fixture project ready",
          ].join("\n"),
        },
        developer: [
          {
            writes: [{ file: "marker-one.txt", content: "adjacent story one\n" }],
            commands: ["git add -A", `git commit -m "feat: US-001 - adjacent control marker one"`],
            output: [
              "STATUS: done",
              "CHANGES: story US-001 marker added",
              "TESTS: scripted fixture",
            ].join("\n"),
          },
          {
            writes: [{
              file: "marker-one.txt",
              content: "adjacent story one (revised after verification feedback)\n",
            }],
            commands: ["git add -A", `git commit -m "feat: US-001 - revise marker one after verification feedback"`],
            output: [
              "STATUS: done",
              "CHANGES: story US-001 revised after verification feedback",
              "TESTS: scripted fixture",
            ].join("\n"),
          },
          {
            writes: [{ file: "marker-two.txt", content: "adjacent story two\n" }],
            commands: ["git add -A", `git commit -m "feat: US-002 - adjacent control marker two"`],
            output: [
              "STATUS: done",
              "CHANGES: story US-002 marker added",
              "TESTS: scripted fixture",
            ].join("\n"),
          },
        ],
        verifier: [
          {
            output: [
              "STATUS: retry",
              "ISSUES: marker one content incomplete - revise",
              "TESTS: deferred",
            ].join("\n"),
          },
          {
            output: [
              "STATUS: done",
              "VERIFIED: story marker verified",
              "TESTED_TREE: {{gitTree}}",
            ].join("\n"),
          },
        ],
        tester: {
          commands: ["{{input.BUILD_CMD}}", "{{input.TEST_CMD}}"],
          output: [
            "STATUS: done",
            "RESULTS: full scripted fixture passes",
            "TESTED_TREE: {{gitTree}}",
          ].join("\n"),
        },
        merger: {
          commands: [
            `expected_tip=$(git -C "{{input.WORKTREE_ORIGIN_REPOSITORY}}" rev-parse "refs/heads/{{input.ORIGINAL_BRANCH}}") && TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${process.execPath}" "${cliPath}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" --branch "${ADJ_BRANCH}" --into "{{input.ORIGINAL_BRANCH}}" --expect-tip "$expected_tip" --message "feat: VEDL adjacent verify_each control (squash of ${ADJ_BRANCH})"`,
          ],
          includeCommandOutput: true,
          output: [
            "STATUS: done",
            "REBASED: false",
            "MERGED_INTO: {{input.ORIGINAL_BRANCH}}",
          ].join("\n"),
        },
      },
      heartbeatTokens: 0,
      defaultTokens: 0,
    };
  }

  it(
    "feature-dev-merge-worktree (adjacent control): per-story verify ordering unchanged with two stories and one verifier retry",
    { timeout: 300_000 },
    async () => {
      let ctx: VedlRunContext | undefined;
      try {
        ctx = await startVedlEnvironment(ADJ_WORKFLOW, adjacentBehaviors());
        const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
        const { branch: originalBranch } = detachOriginCheckout(repoDir);
        const runId = await launchRun(
          ctx,
          ADJ_WORKFLOW,
          "Exercise the adjacent verify_each regression control",
          repoDir,
          originalBranch,
        );

        const status = await waitForRun(ctx, runId, 240_000);
        assert.equal(status, "completed", `run should complete, got "${status}"\n${diagnostics(ctx)}`);

        assertAllStepsDone(ctx, runId, ADJ_STEP_COUNT);

        // Unchanged verify_each ordering: developer and verifier both do exactly
        // 2 stories + 1 retry => 3 rounds each; no other agent ran early.
        assert.equal(
          ctx.scripted.workInvocations("developer").length,
          3,
          `developer: 2 stories + 1 retry => 3 work rounds\n${diagnostics(ctx)}`,
        );
        assert.equal(
          ctx.scripted.workInvocations("verifier").length,
          3,
          `verifier: retry then two passes => 3 work rounds\n${diagnostics(ctx)}`,
        );
        assert.equal(
          ctx.scripted.workInvocations("reviewer").length,
          0,
          `reviewer must never dispatch (test_cmd_review auto-completes)\n${diagnostics(ctx)}`,
        );
        for (const agent of ["planner", "setup", "tester", "merger"]) {
          assert.equal(
            ctx.scripted.workInvocations(agent).length,
            1,
            `agent ${agent} should do exactly 1 work round\n${diagnostics(ctx)}`,
          );
        }

        const stories = dbRows<StoryRow>(
          ctx.env.tamanduaDir,
          "SELECT story_id, status, retry_count FROM stories WHERE run_id = ? ORDER BY story_index",
          runId,
        );
        assertStoryRetryAccounting(ctx, runId, stories);

        // Verify claimed once per verification round, immediately adjacent to the
        // loop (no intermediate step): 1 retry + 2 passes, all before the tester.
        const events = readRunEvents(ctx.env.tamanduaDir, runId);
        assert.equal(countEvent(events, "step.running", "verify"), 3);
        const lastVerifiedIdx = events.map((e) => e.event).lastIndexOf("story.verified");
        const testerRunningIdx = eventIndex(events, "step.running", "test");
        assert.ok(
          lastVerifiedIdx < testerRunningIdx,
          "the final verification must precede the integration test step",
        );

        const reviewStep = dbRow<{ status: string; auto_completed: number; auto_complete_reason: string | null }>(
          ctx.env.tamanduaDir,
          "SELECT status, auto_completed, auto_complete_reason FROM steps WHERE run_id = ? AND step_id = 'test_cmd_review'",
          runId,
        );
        assert.equal(reviewStep.status, "done");
        assert.equal(reviewStep.auto_completed, 1);
        assert.equal(reviewStep.auto_complete_reason, "condition_unset:test_cmd_review_required");

        assertZeroTokenMotorContract(ctx, runId);

        // Repository outcome: both markers and the retry revision landed.
        const markerOne = execSync(`git show "refs/heads/${originalBranch}:marker-one.txt"`, {
          cwd: repoDir,
          encoding: "utf-8",
        });
        assert.ok(
          markerOne.includes("revised after verification feedback"),
          `marker-one.txt should carry the retry revision:\n${markerOne}`,
        );
        execSync(`git show "refs/heads/${originalBranch}:marker-two.txt"`, {
          cwd: repoDir,
          encoding: "utf-8",
        });
        const mergeStep = dbRow<{ status: string; output: string }>(
          ctx.env.tamanduaDir,
          "SELECT status, output FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'",
          runId,
        );
        assert.equal(mergeStep.status, "done");
        assert.match(mergeStep.output, /^STATUS: landed$/m);

        console.log(
          `[vedl e2e adjacent control] run ${runId.slice(0, 8)} completed: ` +
            `verify adjacent to implement, 0 tokens`,
        );
      } finally {
        await teardown(ctx);
      }
    },
  );
});
