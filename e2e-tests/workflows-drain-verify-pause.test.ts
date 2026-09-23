/**
 * DRVP (US-004) — isolated scripted full-pipeline e2e proving the
 * drain-verify-pause finalization (R4a) through the REAL daemon → scheduler
 * → harness spawn → step protocol (ZERO model tokens, deterministic scripted
 * agent via TAMANDUA_PI_BINARY).
 *
 * Background (evidence, READ ONLY — never mutate):
 *   /home/igorhvr/idm/tamandua/torture-test/var/review-logs/
 *     drain-verify-pause.wdEWpm/
 * On 2026-09-05 a drain was requested at 07:00:55Z while the FINAL
 * verify_each round was in flight; the final story verified at 07:01:37Z and
 * the finishing harness exited at 07:01:43Z, yet at 07:05Z the run was still
 * running/draining_pause with ZERO running steps and a downstream test step
 * left pending that the drain never dispatched. The npm-tier regression
 * (src/installer/step-ops-drain-verify-pause.test.ts) proves the fixed
 * routing in completeStepInternal's verify_each branch (finalizeDrainingPause
 * after handleVerifyEachCompletion) on seeded rows; this file proves the SAME
 * fix end-to-end through the built product's real motor: an actual
 * verify_each workflow run whose final verify round is in flight when the
 * drain pause is requested, whose canned 'STATUS: done' completion must
 * finalize the run to paused (never hang in running/draining_pause), retain
 * the final verification report, leave the downstream step pending
 * (no-new-dispatch while draining), grant the finishing harness its output
 * flush, and then resume to dispatch the downstream step and complete.
 *
 * Corridors (feature-dev-merge-worktree natural verify_each layout, 1 story
 * US-001 — implement(loop) → verify adjacent, then the downstream test /
 * test_cmd_review / finalize_merge steps; no workflow mutation):
 *
 *  1. MAIN R4a corridor: while the final verify round is running (scripted
 *     verifier holds the round ~10s), request the drain pause via the daemon
 *     control plane. Assert the drain is NOT finalized while the verify is
 *     in flight (run stays running/draining_pause, no run.paused), then the
 *     verify's canned 'STATUS: done' completion finalizes it: run.status and
 *     scheduling_status become 'paused', exactly ONE run.paused event
 *     (ordered after story.verified and after the downstream step is
 *     promoted to pending), the final verification report is retained on the
 *     verify step row, the downstream test step is pending and NEVER claimed
 *     between the drain request and the pause, and the finishing harness was
 *     allowed to flush (its post-completion usage event reaches the motor —
 *     the run's final token total includes the finishing round's usage).
 *     A plain resume then re-activates the run, the downstream pending step
 *     dispatches and the run completes normally (test → test_cmd_review
 *     auto-complete → finalize_merge lands). Finally a drain-pause request
 *     on the completed run is refused with 409 (terminal control).
 *
 *  2. resume-cancels-pending-drain corridor: same shape, but resume (no
 *     flags) arrives while the drain is STILL pending (verify round still
 *     sleeping). The control plane reports drainCancelled, the pause_drain
 *     marker is cleared, run.drain_cancelled_by_resume is emitted, NO
 *     run.paused ever occurs, and the run completes normally.
 *
 *  3. non-draining control: identical workflow with no pause at all —
 *     completes normally with no run.pause_requested / run.paused, and the
 *     completed terminal state refuses a later drain pause with 409.
 *
 *  4. terminal-state controls: real failed and canceled runs (through the
 *     motor: a seeded single-step run whose scripted worker reports
 *     `step fail`, and a seeded run stopped mid-round via `workflow stop`)
 *     refuse drain-pause with 409 and are never flipped to paused.
 *
 *  5. US-002 multi-step corridor (SMALL-FIXES-0923 PAUSE-DRAIN part 2): the
 *     drain is requested while the IMPLEMENT step is in flight (the #66
 *     shape). After implement completes the scheduler must dispatch NO new
 *     verify/test round, finalize exactly one run.paused with no retry
 *     charge, and a plain resume must dispatch verify -> test and complete
 *     the run. The other corridors cover only the final-verify step.
 *
 * Registration: listed in run-all-scripted-e2e-tests and run-all-e2e-tests.
 *
 * Run via: npm run build && node --test e2e-tests/workflows-drain-verify-pause.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ChildProcess } from "node:child_process";
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
  type ScriptedBehavior,
} from "./helpers/scripted-agent.ts";

const fixtureDir = path.join(process.cwd(), "e2e-tests", "fixtures", "sample-project");
const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");

// feature-dev-merge-worktree natural step order: plan, setup, implement,
// verify, test, test_cmd_review (conditional), finalize_merge.
const STEP_COUNT = 7;

// ── Shared corridor plumbing (isolated env + daemon + scripted agent) ──

interface DrvpRunContext {
  env: Awaited<ReturnType<typeof createTempHome>>;
  scripted: ScriptedAgent;
  daemon: ChildProcess;
}

async function startDrvpEnvironment(
  workflowId: string,
  behaviors: ScriptedAgentConfig,
): Promise<DrvpRunContext> {
  const env = await createTempHome();
  const scripted = createScriptedAgent(env.root, behaviors);
  cliMustSucceed(
    ["workflow", "install", workflowId],
    baseEnv(env.homeDir, env.controlPort),
    `install ${workflowId}`,
  );
  await releasePortReservations(env);
  const daemon = await startIsolatedDaemon(
    env.homeDir,
    env.controlPort,
    scripted.env,
  );
  return { env, scripted, daemon };
}

async function teardown(ctx: DrvpRunContext | undefined): Promise<void> {
  if (!ctx) return;
  try {
    await stopIsolatedDaemon(ctx.daemon);
  } catch {
    // best-effort
  }
  cleanupTempHome(ctx.env);
}

/** Append scripted-agent + daemon log diagnostics to a failure. */
function diagnostics(ctx: DrvpRunContext, runId?: string): string {
  let daemonLogTail = "(no daemon log)";
  try {
    const logPath = path.join(ctx.env.tamanduaDir, "tamandua.log");
    const lines = fs.readFileSync(logPath, "utf-8").trimEnd().split("\n");
    daemonLogTail = lines.slice(-80).join("\n");
  } catch {
    // keep default
  }
  let runTail = "";
  if (runId) {
    try {
      const eventsPath = path.join(ctx.env.tamanduaDir, "events", `${runId}.jsonl`);
      const lines = fs.readFileSync(eventsPath, "utf-8").trimEnd().split("\n");
      runTail = `── run events (last 30) ──\n${lines.slice(-30).join("\n")}`;
    } catch {
      runTail = "(no run events file)";
    }
  }
  return [
    "── scripted-agent invocations ──",
    ctx.scripted.describe(),
    "── daemon log (last 80 lines) ──",
    daemonLogTail,
    runTail,
  ].join("\n");
}

function dbRow<T>(tamanduaDir: string, sql: string, ...params: string[]): T | undefined {
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    return db.prepare(sql).get(...params) as T | undefined;
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

function dbRun(
  ctx: DrvpRunContext,
  runId: string,
): { status: string; scheduling_status: string | null; context: string; tokens_spent: number } | undefined {
  return dbRow<{ status: string; scheduling_status: string | null; context: string; tokens_spent: number }>(
    ctx.env.tamanduaDir,
    "SELECT status, scheduling_status, context, tokens_spent FROM runs WHERE id = ?",
    runId,
  );
}

function dbStep(
  ctx: DrvpRunContext,
  runId: string,
  stepId: string,
): { status: string; output: string | null; retry_count: number } | undefined {
  return dbRow<{ status: string; output: string | null; retry_count: number }>(
    ctx.env.tamanduaDir,
    "SELECT status, output, retry_count FROM steps WHERE run_id = ? AND step_id = ?",
    runId,
    stepId,
  );
}

function readRunEvents(ctx: DrvpRunContext, runId: string): Array<Record<string, unknown>> {
  const eventsPath = path.join(ctx.env.tamanduaDir, "events", `${runId}.jsonl`);
  if (!fs.existsSync(eventsPath)) return [];
  return fs
    .readFileSync(eventsPath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function eventIndexes(
  events: Array<Record<string, unknown>>,
  event: string,
  stepId?: string,
): number[] {
  return events
    .map((e, i) => (e.event === event && (stepId === undefined || e.stepId === stepId) ? i : -1))
    .filter((i) => i >= 0);
}

function countEvent(events: Array<Record<string, unknown>>, event: string, stepId?: string): number {
  return eventIndexes(events, event, stepId).length;
}

function contextJson(ctx: DrvpRunContext, runId: string): Record<string, string> {
  const run = dbRun(ctx, runId);
  assert.ok(run, `run ${runId} missing`);
  return JSON.parse(run.context) as Record<string, string>;
}

// ── Control-plane (daemon) helpers ────────────────────────────────────

function readDaemonSecret(homeDir: string): string {
  const secretPath = path.join(homeDir, ".tamandua", "daemon-secret");
  return fs.readFileSync(secretPath, "utf-8").trim();
}

interface ControlResponse {
  status: number;
  body: Record<string, unknown>;
}

async function controlFetch(
  ctx: DrvpRunContext,
  pathName: string,
  method = "GET",
  body?: unknown,
  timeoutMs = 45_000,
): Promise<ControlResponse> {
  const secret = readDaemonSecret(ctx.env.homeDir);
  const headers: Record<string, string> = {};
  if (secret) headers["x-tamandua-secret"] = secret;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${ctx.env.controlPort}${pathName}`, {
    method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let resBody: Record<string, unknown>;
  try {
    resBody = (await res.json()) as Record<string, unknown>;
  } catch {
    resBody = {};
  }
  return { status: res.status, body: resBody };
}

async function requestDrainPause(
  ctx: DrvpRunContext,
  runId: string,
): Promise<ControlResponse> {
  return controlFetch(ctx, "/control/pause-run", "POST", {
    runId,
    drain: true,
    requestedBy: "drvp-e2e-test (drain)",
  });
}

async function requestPlainResume(
  ctx: DrvpRunContext,
  runId: string,
): Promise<ControlResponse> {
  return controlFetch(ctx, "/control/resume-run", "POST", {
    runId,
    requestedBy: "drvp-e2e-test (resume)",
  });
}

/** Wait until a DB predicate holds; throws with diagnostics on timeout. */
async function waitForDb(
  ctx: DrvpRunContext,
  runId: string,
  label: string,
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 200,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for: ${label}\n${diagnostics(ctx, runId)}`,
  );
}

/**
 * Wait for a workflow run to reach terminal status by DB, nudging the
 * scheduler every cycle (mirrors pollForRunCompletionWithNudge but reads the
 * isolated DB directly so paused/draining mid-states are visible too).
 */
async function waitForRunTerminalByDb(
  ctx: DrvpRunContext,
  runId: string,
  timeoutMs: number,
): Promise<string> {
  const startedAt = Date.now();
  let lastStatus = "";
  while (Date.now() - startedAt < timeoutMs) {
    const run = dbRun(ctx, runId);
    if (run) {
      lastStatus = run.status;
      if (["completed", "done", "failed", "canceled"].includes(run.status)) {
        return run.status;
      }
    }
    // Wake every scheduled agent for the next round (best-effort). While the
    // run is paused/draining the daemon skips dispatch, so this is harmless.
    spawnSync(process.execPath, [cliPath, "nudge"], {
      env: baseEnv(ctx.env.homeDir, ctx.env.controlPort),
      encoding: "utf-8",
    });
    await sleep(700);
  }
  throw new Error(
    `Timeout after ${timeoutMs}ms waiting for run ${runId.slice(0, 8)} terminal; last status: ${lastStatus || "(unknown)"}\n${diagnostics(ctx, runId)}`,
  );
}

/** Launch a worktree-mode workflow run and resolve its full run id. */
async function launchRun(
  ctx: DrvpRunContext,
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

function assertZeroHeartbeatContract(ctx: DrvpRunContext, runId: string): void {
  const stats = dbRow<{ system_tokens_spent: number }>(
    ctx.env.tamanduaDir,
    "SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1",
  );
  assert.equal(
    stats?.system_tokens_spent ?? 0,
    0,
    `system token tripwire must stay 0 (N1), got ${stats?.system_tokens_spent}`,
  );
  assert.equal(
    ctx.scripted.heartbeats().length,
    0,
    `deterministic motor must never spawn without pending work (N2)\n${diagnostics(ctx, runId)}`,
  );
}

function assertAllStepsDone(ctx: DrvpRunContext, runId: string): void {
  const steps = dbRows<{ step_id: string; status: string }>(
    ctx.env.tamanduaDir,
    "SELECT step_id, status FROM steps WHERE run_id = ? ORDER BY step_index",
    runId,
  );
  assert.equal(steps.length, STEP_COUNT, `expected ${STEP_COUNT} steps, got ${JSON.stringify(steps)}`);
  for (const step of steps) {
    assert.equal(
      step.status,
      "done",
      `step ${step.step_id} should be done, got ${step.status}\n${diagnostics(ctx, runId)}`,
    );
  }
}

// ── Behaviors: natural 1-story verify_each corridor ──────────────────

/**
 * Shared 1-story feature-dev-merge-worktree corridor behaviors. The verifier
 * is supplied per-corridor: array entries are consumed one per invocation.
 */
function corridorBehaviors(opts: {
  branch: string;
  markerContent: string;
  verifier: ScriptedBehavior[];
  /**
   * Optional developer (implement) behavior overrides merged over the
   * default writer+committer shape. Used by the US-002 multi-step corridor to
   * hold the implement step open (a `sleep` command) so a drain can be
   * requested while the pipeline is still mid-flight.
   */
  developer?: Partial<ScriptedBehavior>;
}): ScriptedAgentConfig {
  return {
    agents: {
      planner: {
        output: [
          "STATUS: done",
          "REPO: {{cwd}}",
          `BRANCH: ${opts.branch}`,
          `STORIES_JSON: ${JSON.stringify([
            {
              id: "US-001",
              title: "Drain-verify-pause story one",
              description: "Single story for the DRVP drain-verify-pause scripted regression.",
              acceptanceCriteria: ["marker-one exists", "Typecheck passes"],
            },
          ])}`,
        ].join("\n"),
      },
      setup: {
        commands: [`git checkout -b ${opts.branch}`],
        output: [
          "STATUS: done",
          "ORIGINAL_BRANCH: {{input.ORIGINAL_BRANCH}}",
          "BUILD_CMD: true",
          "TEST_CMD: true",
          "BASELINE: fixture project ready",
        ].join("\n"),
      },
      developer: {
        writes: [{ file: "marker-one.txt", content: opts.markerContent }],
        commands: ["git add -A", `git commit -m "feat: US-001 - drain-verify-pause marker one"`],
        output: [
          "STATUS: done",
          "CHANGES: story US-001 marker added",
          "TESTS: scripted fixture",
        ].join("\n"),
        ...opts.developer,
      },
      verifier: opts.verifier,
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
          `expected_tip=$(git -C "{{input.WORKTREE_ORIGIN_REPOSITORY}}" rev-parse "refs/heads/{{input.ORIGINAL_BRANCH}}") && TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${process.execPath}" "${cliPath}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" --branch "${opts.branch}" --into "{{input.ORIGINAL_BRANCH}}" --expect-tip "$expected_tip" --message "feat: DRVP drain-verify-pause scripted corridor (squash of ${opts.branch})"`,
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

/** Canned verifier pass report (distinctive so retention is assertable). */
function verifierPassReport(storyNote: string): string {
  return [
    "STATUS: done",
    `VERIFIED: ${storyNote} confirmed against the marker file`,
    "TESTED_TREE: {{gitTree}}",
  ].join("\n");
}

const MAIN_BRANCH = "feature/drvp-drain-pause-scripted";
const MAIN_MARKER = "drain-verify-pause main corridor story one\n";

describe("DRVP US-004: scripted e2e - drain pause finalizes on final-verify completion through the real motor", { concurrency: 1 }, () => {
  it(
    "R4a main corridor: drain requested while the final verify is in flight finalizes to paused exactly once; no downstream dispatch; resume dispatches it and the run completes",
    { timeout: 360_000 },
    async () => {
      let ctx: DrvpRunContext | undefined;
      try {
        const FINAL_VERIFY_TOKENS = 7; // nonzero usage on the finishing round
        ctx = await startDrvpEnvironment("feature-dev-merge-worktree", corridorBehaviors({
          branch: MAIN_BRANCH,
          markerContent: MAIN_MARKER,
          verifier: [
            {
              // Hold the final (only) verify round open ~10s after claim so the
              // test can request the drain pause while the round is in flight,
              // then pass with a plain 'STATUS: done' (the R4a hang shape: last
              // story verifies → downstream step promoted → run must finalize
              // the drain to paused instead of hanging running/draining_pause).
              commands: ["sleep 10"],
              // reportBeforeEmit: step complete (which finalizes the drain
              // pause) happens BEFORE the final message_end carrying this
              // round's usage — the completion-teardown grace window. If the
              // finalization ever killed/teared down the completing harness
              // without the flush grace, this usage event would be lost and
              // the run's final token total would not include it.
              reportBeforeEmit: true,
              tokens: FINAL_VERIFY_TOKENS,
              output: verifierPassReport("story one (main drain corridor)"),
            },
          ],
        }));
        const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
        const { branch: originalBranch } = detachOriginCheckout(repoDir);
        const runId = await launchRun(
          ctx,
          "feature-dev-merge-worktree",
          "Exercise the DRVP drain-verify-pause scripted regression (main corridor)",
          repoDir,
          originalBranch,
        );

        // ── Phase 1: reach the final verify round (in flight) ─────────
        await waitForDb(
          ctx,
          runId,
          "verify step claimed (running)",
          () => dbStep(ctx!, runId, "verify")?.status === "running",
          120_000,
        );
        // Sanity: the story is in flight (implement done, verify pending done
        // state) and the run is actively scheduled — never paused yet.
        const runBefore = dbRun(ctx, runId);
        assert.ok(runBefore, "run row should exist");
        assert.equal(runBefore.status, "running");
        assert.equal(runBefore.scheduling_status, "active");

        // ── Phase 2: request the drain pause while verify is in flight ─
        const drainResp = await requestDrainPause(ctx, runId);
        assert.equal(
          drainResp.status,
          200,
          `drain pause should succeed, got ${drainResp.status}: ${JSON.stringify(drainResp.body)}\n${diagnostics(ctx, runId)}`,
        );
        assert.equal(drainResp.body.state, "draining_pause");

        // Still-in-flight control: the drain must NOT be finalized while the
        // verify round is running — run stays running/draining_pause with no
        // run.paused yet (deferred until the final completion).
        const runDraining = dbRun(ctx, runId);
        assert.ok(runDraining, "run row missing");
        assert.equal(
          runDraining.status,
          "running",
          `drain must not pause the run while a step is in flight; got ${JSON.stringify(runDraining)}\n${diagnostics(ctx, runId)}`,
        );
        assert.equal(runDraining.scheduling_status, "draining_pause");
        const drainCtx = contextJson(ctx, runId);
        assert.equal(drainCtx.pause_drain, "true", "pause_drain attribution should be set");
        let events = readRunEvents(ctx, runId);
        assert.equal(
          countEvent(events, "run.paused"),
          0,
          `no run.paused while the verify round is still in flight\n${diagnostics(ctx, runId)}`,
        );
        assert.equal(countEvent(events, "run.pause_requested"), 1, "exactly one pause request");

        // ── Phase 3: the final verify completes → drain finalized ─────
        // The verify's canned 'STATUS: done' completes the last story; the
        // pipeline promotes the downstream test step to pending and the fixed
        // verify_each branch finalizes the drain: status/scheduling 'paused',
        // exactly one run.paused, report retained, downstream step pending and
        // NEVER claimed during the drain.
        await waitForDb(
          ctx,
          runId,
          "run finalized to paused after final verify completion",
          () => {
            const run = dbRun(ctx!, runId);
            return run?.status === "paused" && run?.scheduling_status === "paused";
          },
          // 120s (not 60s): the daemon must process the verify completion and
          // promote the downstream step before it can finalize the drain; on a
          // loaded shared runner that has exceeded 60s. AGENTS.md prescribes
          // raising the absolute deadline rather than polling.
          120_000,
        );

        events = readRunEvents(ctx, runId);
        assert.equal(countEvent(events, "run.paused"), 1, `exactly one run.paused; ledger: ${events.map((e) => e.event).join(",")}`);
        const pauseReqIdx = eventIndexes(events, "run.pause_requested")[0]!;
        const pausedIdx = eventIndexes(events, "run.paused")[0]!;
        const verifiedIdx = eventIndexes(events, "story.verified")[0];
        const testPendingIdx = eventIndexes(events, "step.pending", "test")[0];
        assert.ok(verifiedIdx !== undefined, "story.verified must exist");
        assert.ok(testPendingIdx !== undefined, "downstream test step must be promoted to pending");
        assert.ok(
          pauseReqIdx < verifiedIdx && verifiedIdx < pausedIdx && testPendingIdx < pausedIdx,
          `ordering must be pause_requested < story.verified < run.paused with the test step promoted before the pause ` +
            `(pauseReq=${pauseReqIdx}, verified=${verifiedIdx}, testPending=${testPendingIdx}, paused=${pausedIdx})`,
        );
        assert.equal(countEvent(events, "run.resumed"), 0, "no resume before the pause");

        // No-new-dispatch while draining: between the pause request and the
        // pause there must be no step claim/dispatch at all (the verify round
        // was already running before the request).
        const runningBetween = events
          .map((e, i) => (e.event === "step.running" && i > pauseReqIdx && i < pausedIdx ? i : -1))
          .filter((i) => i >= 0);
        assert.equal(
          runningBetween.length,
          0,
          `no step may be claimed between the drain request and the pause; claimed at indices ${runningBetween}\n${diagnostics(ctx, runId)}`,
        );
        assert.equal(countEvent(events, "step.running", "test"), 0, "downstream test step never claimed during the drain");
        assert.equal(countEvent(events, "step.running", "verify"), 1, "the final verify round ran exactly once");

        // Final verification report retained on the verify step row, story
        // verified, loop done.
        const verifyPaused = dbStep(ctx, runId, "verify");
        assert.equal(verifyPaused?.status, "done", "verify step should be done at pause");
        assert.ok(
          verifyPaused?.output?.includes("STATUS: done") &&
            verifyPaused.output.includes("confirmed against the marker file"),
          `final verification report must be retained on the verify row at pause; got: ${verifyPaused?.output}\n${diagnostics(ctx, runId)}`,
        );
        const testPaused = dbStep(ctx, runId, "test");
        assert.equal(
          testPaused?.status,
          "pending",
          `downstream test step must be pending (never dispatched) at pause; got ${testPaused?.status}\n${diagnostics(ctx, runId)}`,
        );
        const stories = dbRows<StoryRow>(
          ctx.env.tamanduaDir,
          "SELECT story_id, status, retry_count FROM stories WHERE run_id = ?",
          runId,
        );
        assert.equal(stories.length, 1, `expected one story row, got ${JSON.stringify(stories)}`);
        assert.equal(stories[0]!.status, "done", "the single story must be verified/done at pause");
        assert.equal(stories[0]!.retry_count, 0, "no story retry on this path");

        // ── Phase 4: plain resume cancels the drain, downstream dispatch ─
        const resumeResp = await requestPlainResume(ctx, runId);
        assert.ok(
          resumeResp.status === 200 || resumeResp.status === 202,
          `resume should succeed, got ${resumeResp.status}: ${JSON.stringify(resumeResp.body)}\n${diagnostics(ctx, runId)}`,
        );

        const terminal = await waitForRunTerminalByDb(ctx, runId, 240_000);
        assert.equal(terminal, "completed", `run should complete after resume, got ${terminal}\n${diagnostics(ctx, runId)}`);

        assertAllStepsDone(ctx, runId);

        // Event ledger after the full lifecycle: exactly one pause; the
        // downstream step dispatches only after the resume.
        events = readRunEvents(ctx, runId);
        assert.equal(countEvent(events, "run.paused"), 1, `exactly one run.paused for the whole run; ledger: ${events.map((e) => e.event).join(",")}`);
        assert.equal(countEvent(events, "run.resume_requested"), 1);
        assert.equal(countEvent(events, "run.resumed"), 1);
        assert.equal(countEvent(events, "run.drain_cancelled_by_resume"), 0, "drain already finalized — plain resume is not a cancel");
        const resumedIdx = eventIndexes(events, "run.resumed")[0]!;
        const testRunningIdx = eventIndexes(events, "step.running", "test");
        assert.equal(testRunningIdx.length, 1, "downstream test step runs exactly once (after resume)");
        assert.ok(
          testRunningIdx[0]! > resumedIdx,
          `downstream test step must dispatch only after the resume (test at ${testRunningIdx[0]}, resumed at ${resumedIdx})`,
        );
        assert.ok(
          eventIndexes(events, "run.completed")[0]! > testRunningIdx[0]!,
          "run completes after the downstream test step",
        );
        assert.equal(countEvent(events, "step.running", "verify"), 1);
        assert.equal(countEvent(events, "story.started"), 1, "single story started once");

        // Finishing-output grace: the completing harness was allowed to flush
        // after the pause — its post-completion usage (7) must be attributed.
        // (Late attribution can trail terminal status, so poll.)
        await waitForDb(
          ctx,
          runId,
          "finishing verify round usage attributed (flush grace honored)",
          () => (dbRun(ctx!, runId)?.tokens_spent ?? 0) >= FINAL_VERIFY_TOKENS,
          30_000,
        );
        const runFinal = dbRun(ctx, runId);
        assert.equal(
          runFinal?.tokens_spent,
          FINAL_VERIFY_TOKENS,
          `the finishing round's usage must land (harness allowed to flush); got ${runFinal?.tokens_spent}\n${diagnostics(ctx, runId)}`,
        );

        assertZeroHeartbeatContract(ctx, runId);

        // Repository outcome: the marker landed on the original branch.
        const marker = execFileSync("git", ["show", `refs/heads/${originalBranch}:marker-one.txt`], {
          cwd: repoDir,
          encoding: "utf-8",
        });
        assert.ok(marker.includes("main corridor"), `marker-one.txt should carry the story marker:\n${marker}`);
        const mergeStep = dbStep(ctx, runId, "finalize_merge");
        assert.equal(mergeStep?.status, "done");
        assert.match(mergeStep?.output ?? "", /^STATUS: landed$/m);

        // ── Phase 5: terminal-state control — completed never flips to paused ──
        const pauseTerminal = await requestDrainPause(ctx, runId);
        assert.equal(
          pauseTerminal.status,
          409,
          `drain pause on a completed run must be refused (409), got ${pauseTerminal.status}: ${JSON.stringify(pauseTerminal.body)}`,
        );
        const runAfterTerminalPause = dbRun(ctx, runId);
        assert.equal(runAfterTerminalPause?.status, "completed", "completed run must stay completed");
        events = readRunEvents(ctx, runId);
        assert.equal(countEvent(events, "run.paused"), 1, "no additional run.paused after the terminal refusal");

        console.log(
          `[drvp e2e main corridor] run ${runId.slice(0, 8)}: drain during final verify finalized to paused once, ` +
            `report retained, no downstream dispatch under drain, flush grace honored (tokens ${runFinal?.tokens_spent}), ` +
            `plain resume dispatched the test step and the run completed; terminal pause refused 409`,
        );
      } finally {
        await teardown(ctx);
      }
    },
  );

  it(
    "US-002 multi-step corridor: drain requested while implement is in flight stops the verify/test dispatch, pauses exactly once with no retry, and a plain resume completes the run",
    { timeout: 360_000 },
    async () => {
      let ctx: DrvpRunContext | undefined;
      try {
        const MULTI_BRANCH = "feature/drvp-multistep-drain-scripted";
        const MULTI_MARKER = "drain-verify-pause multi-step corridor story one\n";
        ctx = await startDrvpEnvironment("feature-dev-merge-worktree", corridorBehaviors({
          branch: MULTI_BRANCH,
          markerContent: MULTI_MARKER,
          developer: {
            // Hold the implement step open ~15s after claim so the test can
            // request the drain while the pipeline is still mid-flight, then
            // finish the marker commit normally. This is the reported #66
            // shape: a multi-step implement -> verify -> test run that used to
            // keep advancing after the drain request.
            commands: [
              "sleep 15",
              "git add -A",
              `git commit -m "feat: US-001 - drain-verify-pause multi-step marker one"`,
            ],
          },
          verifier: [
            {
              output: verifierPassReport("story one (multi-step drain corridor)"),
            },
          ],
        }));
        const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
        const { branch: originalBranch } = detachOriginCheckout(repoDir);
        const runId = await launchRun(
          ctx,
          "feature-dev-merge-worktree",
          "Exercise the DRVP multi-step drain corridor (US-002)",
          repoDir,
          originalBranch,
        );

        // ── Phase 1: reach the in-flight IMPLEMENT step ────────────────
        await waitForDb(
          ctx,
          runId,
          "implement step claimed (running)",
          () => dbStep(ctx!, runId, "implement")?.status === "running",
          120_000,
        );
        // Pipeline is mid-flight: implement is running, verify/test untouched.
        const runBefore = dbRun(ctx, runId);
        assert.ok(runBefore, "run row should exist");
        assert.equal(runBefore.status, "running");
        assert.equal(runBefore.scheduling_status, "active");
        // verify/test are still upstream-blocked: never claimed yet.
        assert.notEqual(dbStep(ctx, runId, "verify")?.status, "running");
        assert.notEqual(dbStep(ctx, runId, "test")?.status, "running");
        let events = readRunEvents(ctx, runId);
        assert.equal(countEvent(events, "step.running", "implement"), 1, "implement claimed once");
        assert.equal(countEvent(events, "step.running", "verify"), 0, "verify not dispatched yet");
        assert.equal(countEvent(events, "step.running", "test"), 0, "test not dispatched yet");

        // ── Phase 2: request the drain while implement is in flight ────
        const drainResp = await requestDrainPause(ctx, runId);
        assert.equal(
          drainResp.status,
          200,
          `drain pause should succeed, got ${drainResp.status}: ${JSON.stringify(drainResp.body)}\n${diagnostics(ctx, runId)}`,
        );
        assert.equal(drainResp.body.state, "draining_pause");

        // Still-in-flight control: the drain must NOT be finalized while the
        // implement round is running — run stays running/draining_pause with
        // no run.paused yet (deferred until the last in-flight session ends).
        const runDraining = dbRun(ctx, runId);
        assert.ok(runDraining, "run row missing");
        assert.equal(
          runDraining.status,
          "running",
          `drain must not pause the run while implement is in flight; got ${JSON.stringify(runDraining)}\n${diagnostics(ctx, runId)}`,
        );
        assert.equal(runDraining.scheduling_status, "draining_pause");
        assert.equal(contextJson(ctx, runId).pause_drain, "true", "pause_drain attribution should be set");
        events = readRunEvents(ctx, runId);
        assert.equal(countEvent(events, "run.paused"), 0, "no run.paused while implement is still in flight");
        assert.equal(countEvent(events, "run.pause_requested"), 1, "exactly one pause request");

        // ── Phase 3: implement completes → no verify/test dispatch → pause ─
        await waitForDb(
          ctx,
          runId,
          "run finalized to paused after implement completion with the drain pending",
          () => {
            const run = dbRun(ctx!, runId);
            return run?.status === "paused" && run?.scheduling_status === "paused";
          },
          180_000,
        );

        events = readRunEvents(ctx, runId);
        assert.equal(countEvent(events, "run.paused"), 1, `exactly one run.paused; ledger: ${events.map((e) => e.event).join(",")}`);
        const pauseReqIdx = eventIndexes(events, "run.pause_requested")[0]!;
        const pausedIdx = eventIndexes(events, "run.paused")[0]!;

        // No-new-dispatch while draining: between the drain request and the
        // pause there must be no new step claim at all (implement was already
        // running before the request; nothing else may start).
        const runningBetween = events
          .map((e, i) => (e.event === "step.running" && i > pauseReqIdx && i < pausedIdx ? i : -1))
          .filter((i) => i >= 0);
        assert.equal(
          runningBetween.length,
          0,
          `no step may be claimed between the drain request and the pause; claimed at indices ${runningBetween}\n${diagnostics(ctx, runId)}`,
        );
        assert.equal(countEvent(events, "step.running", "implement"), 1, "implement ran exactly once");
        assert.equal(countEvent(events, "step.running", "verify"), 0, "verify must NOT dispatch during the drain");
        assert.equal(countEvent(events, "step.running", "test"), 0, "test must NOT dispatch during the drain");

        // A drain pause is not a worker loss and never charges a retry.
        assert.equal(countEvent(events, "step.worker_lost"), 0, "a drain pause must not emit step.worker_lost");
        assert.equal(countEvent(events, "story.retry"), 0, "no story retry on this path");
        const stepsAtPause = dbRows<{ step_id: string; status: string; retry_count: number }>(
          ctx.env.tamanduaDir,
          "SELECT step_id, status, retry_count FROM steps WHERE run_id = ?",
          runId,
        );
        for (const step of stepsAtPause) {
          assert.equal(
            step.retry_count,
            0,
            `step ${step.step_id} must not be charged a retry; got ${step.retry_count}\n${diagnostics(ctx, runId)}`,
          );
        }
        // The implement loop step stays open (verify_each: it holds the loop
        // across its verify) or is already done — either way it was never
        // retried. verify is promoted but never claimed; test stays
        // upstream-blocked behind verify.
        const implementAtPause = dbStep(ctx, runId, "implement");
        assert.ok(
          implementAtPause?.status === "running" || implementAtPause?.status === "done",
          `implement loop must stay open (running) or be done at pause; got ${implementAtPause?.status}\n${diagnostics(ctx, runId)}`,
        );
        assert.equal(
          dbStep(ctx, runId, "verify")?.status,
          "pending",
          `verify must be promoted (never claimed) at pause; got ${dbStep(ctx, runId, "verify")?.status}\n${diagnostics(ctx, runId)}`,
        );
        assert.equal(
          dbStep(ctx, runId, "test")?.status,
          "waiting",
          `test must stay upstream-blocked (never claimed) at pause; got ${dbStep(ctx, runId, "test")?.status}\n${diagnostics(ctx, runId)}`,
        );

        // ── Phase 4: plain resume dispatches the remaining steps ───────
        const resumeResp = await requestPlainResume(ctx, runId);
        assert.ok(
          resumeResp.status === 200 || resumeResp.status === 202,
          `resume should succeed, got ${resumeResp.status}: ${JSON.stringify(resumeResp.body)}\n${diagnostics(ctx, runId)}`,
        );

        const terminal = await waitForRunTerminalByDb(ctx, runId, 240_000);
        assert.equal(terminal, "completed", `run should complete after resume, got ${terminal}\n${diagnostics(ctx, runId)}`);

        assertAllStepsDone(ctx, runId);

        // Full lifecycle: one pause, one resume; verify then test dispatches
        // only after the resume and the run completes after them.
        events = readRunEvents(ctx, runId);
        assert.equal(countEvent(events, "run.paused"), 1, `exactly one run.paused for the whole run; ledger: ${events.map((e) => e.event).join(",")}`);
        assert.equal(countEvent(events, "run.resume_requested"), 1);
        assert.equal(countEvent(events, "run.resumed"), 1);
        const resumedIdx = eventIndexes(events, "run.resumed")[0]!;
        const verifyRunning = eventIndexes(events, "step.running", "verify");
        const testRunning = eventIndexes(events, "step.running", "test");
        assert.equal(verifyRunning.length, 1, "verify dispatches exactly once after the resume");
        assert.equal(testRunning.length, 1, "test dispatches exactly once after the resume");
        assert.ok(
          verifyRunning[0]! > resumedIdx,
          `verify must dispatch only after the resume (verify at ${verifyRunning[0]}, resumed at ${resumedIdx})`,
        );
        assert.ok(
          testRunning[0]! > verifyRunning[0]!,
          `test must dispatch after verify (test at ${testRunning[0]}, verify at ${verifyRunning[0]})`,
        );
        assert.ok(
          eventIndexes(events, "run.completed")[0]! > testRunning[0]!,
          "run completes after the downstream test step",
        );
        assert.equal(countEvent(events, "step.worker_lost"), 0, "no worker loss across the whole lifecycle");
        assert.equal(countEvent(events, "story.retry"), 0, "no story retry across the whole lifecycle");

        // Zero model tokens / no heartbeat rounds on the scripted corridor.
        const runFinal = dbRun(ctx, runId);
        assert.equal(runFinal?.tokens_spent, 0, "zero model tokens on the multi-step drain corridor");
        assertZeroHeartbeatContract(ctx, runId);

        // Repository outcome: the marker landed on the original branch.
        const marker = execFileSync("git", ["show", `refs/heads/${originalBranch}:marker-one.txt`], {
          cwd: repoDir,
          encoding: "utf-8",
        });
        assert.ok(marker.includes("multi-step corridor"), `marker-one.txt should carry the story marker:\n${marker}`);
        const mergeStep = dbStep(ctx, runId, "finalize_merge");
        assert.equal(mergeStep?.status, "done");
        assert.match(mergeStep?.output ?? "", /^STATUS: landed$/m);

        console.log(
          `[drvp e2e US-002 multi-step corridor] run ${runId.slice(0, 8)}: drain during implement stopped the ` +
            `verify/test dispatch, paused once with no retry, and a plain resume dispatched verify -> test ` +
            `and the run completed`,
        );
      } finally {
        await teardown(ctx);
      }
    },
  );

  it(
    "resume-cancels-pending-drain: plain resume while the drain is still pending cancels it (no run.paused) and the run completes",
    { timeout: 360_000 },
    async () => {
      let ctx: DrvpRunContext | undefined;
      try {
        const CANCEL_BRANCH = "feature/drvp-resume-cancels-drain-scripted";
        ctx = await startDrvpEnvironment("feature-dev-merge-worktree", corridorBehaviors({
          branch: CANCEL_BRANCH,
          markerContent: "drain-verify-pause resume-cancels-drain story one\n",
          verifier: [
            {
              commands: ["sleep 10"],
              output: verifierPassReport("story one (resume-cancels-drain corridor)"),
            },
          ],
        }));
        const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
        const { branch: originalBranch } = detachOriginCheckout(repoDir);
        const runId = await launchRun(
          ctx,
          "feature-dev-merge-worktree",
          "Exercise the DRVP resume-cancels-drain scripted regression",
          repoDir,
          originalBranch,
        );

        await waitForDb(
          ctx,
          runId,
          "verify step claimed (running)",
          () => dbStep(ctx!, runId, "verify")?.status === "running",
          120_000,
        );

        // Request the drain while the final verify round is in flight…
        const drainResp = await requestDrainPause(ctx, runId);
        assert.equal(drainResp.status, 200, `drain pause should succeed, got ${drainResp.status}: ${JSON.stringify(drainResp.body)}`);
        assert.equal(drainResp.body.state, "draining_pause");
        const drainCtx = contextJson(ctx, runId);
        assert.equal(drainCtx.pause_drain, "true");

        // …then resume (no flags) BEFORE the verify round completes: the plain
        // resume CANCELS the pending drain (drainCancelled in the response,
        // pause_drain marker cleared, run.drain_cancelled_by_resume event).
        const resumeResp = await requestPlainResume(ctx, runId);
        assert.ok(
          resumeResp.status === 200 || resumeResp.status === 202,
          `resume should succeed, got ${resumeResp.status}: ${JSON.stringify(resumeResp.body)}\n${diagnostics(ctx, runId)}`,
        );
        assert.equal(
          resumeResp.body.drainCancelled,
          true,
          `resume of a pending drain must report drainCancelled, got ${JSON.stringify(resumeResp.body)}\n${diagnostics(ctx, runId)}`,
        );

        // The drain never finalizes: no run.paused, and the pause_drain
        // marker is gone after the cancel.
        await waitForDb(
          ctx,
          runId,
          "run back to active scheduling after resume-cancel",
          () => {
            const run = dbRun(ctx!, runId);
            return run?.status === "running" && run?.scheduling_status === "active";
          },
          30_000,
        );
        const ctxAfterResume = contextJson(ctx, runId);
        assert.equal(ctxAfterResume.pause_drain, undefined, "pause_drain marker must be cleared by the resume-cancel");

        const terminal = await waitForRunTerminalByDb(ctx, runId, 240_000);
        assert.equal(terminal, "completed", `run should complete, got ${terminal}\n${diagnostics(ctx, runId)}`);

        assertAllStepsDone(ctx, runId);

        const events = readRunEvents(ctx, runId);
        assert.equal(
          countEvent(events, "run.paused"),
          0,
          `a cancelled pending drain must never pause the run; ledger: ${events.map((e) => e.event).join(",")}\n${diagnostics(ctx, runId)}`,
        );
        assert.equal(countEvent(events, "run.pause_requested"), 1);
        assert.equal(countEvent(events, "run.drain_cancelled_by_resume"), 1, "resume-cancel of a pending drain must be audited");
        assert.equal(countEvent(events, "run.resumed"), 1);
        const resumedIdx = eventIndexes(events, "run.resumed")[0]!;
        const testRunningIdx = eventIndexes(events, "step.running", "test");
        assert.equal(testRunningIdx.length, 1, "downstream test step dispatches exactly once");
        assert.ok(
          testRunningIdx[0]! > resumedIdx,
          `downstream test step must dispatch after the resume-cancel (test at ${testRunningIdx[0]}, resumed at ${resumedIdx})`,
        );
        assert.equal(countEvent(events, "story.verified"), 1, "the story verifies exactly once");
        assert.equal(countEvent(events, "story.retry"), 0, "no story retry");

        const stories = dbRows<StoryRow>(
          ctx.env.tamanduaDir,
          "SELECT story_id, status, retry_count FROM stories WHERE run_id = ?",
          runId,
        );
        assert.equal(stories.length, 1);
        assert.equal(stories[0]!.status, "done");
        assert.equal(stories[0]!.retry_count, 0);

        const runFinal = dbRun(ctx, runId);
        assert.equal(runFinal?.tokens_spent, 0, "zero model tokens on the resume-cancel corridor");
        assertZeroHeartbeatContract(ctx, runId);

        execFileSync("git", ["show", `refs/heads/${originalBranch}:marker-one.txt`], {
          cwd: repoDir,
          encoding: "utf-8",
        });

        console.log(
          `[drvp e2e resume-cancel corridor] run ${runId.slice(0, 8)}: plain resume cancelled the pending drain ` +
            `(drainCancelled, no run.paused), the in-flight verify completed, and the run completed normally`,
        );
      } finally {
        await teardown(ctx);
      }
    },
  );

  it(
    "non-draining control: the same final verify without any pause keeps the run running and it completes with no run.paused",
    { timeout: 360_000 },
    async () => {
      let ctx: DrvpRunContext | undefined;
      try {
        const CONTROL_BRANCH = "feature/drvp-non-drain-control-scripted";
        ctx = await startDrvpEnvironment("feature-dev-merge-worktree", corridorBehaviors({
          branch: CONTROL_BRANCH,
          markerContent: "drain-verify-pause non-drain control story one\n",
          verifier: [
            {
              output: verifierPassReport("story one (non-drain control)"),
            },
          ],
        }));
        const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
        const { branch: originalBranch } = detachOriginCheckout(repoDir);
        const runId = await launchRun(
          ctx,
          "feature-dev-merge-worktree",
          "Exercise the DRVP non-draining control",
          repoDir,
          originalBranch,
        );

        const terminal = await waitForRunTerminalByDb(ctx, runId, 240_000);
        assert.equal(terminal, "completed", `run should complete, got ${terminal}\n${diagnostics(ctx, runId)}`);

        assertAllStepsDone(ctx, runId);

        // The run was NEVER paused or drained: no pause events anywhere, and
        // at no point was scheduling_status draining_pause (the run went
        // straight through to completed). The verify row retains the report.
        const events = readRunEvents(ctx, runId);
        assert.equal(countEvent(events, "run.pause_requested"), 0, "no pause requested on the non-draining path");
        assert.equal(countEvent(events, "run.paused"), 0, "no run.paused on the non-draining path");
        const verifyStep = dbStep(ctx, runId, "verify");
        assert.equal(verifyStep?.status, "done");
        assert.ok(
          verifyStep?.output?.includes("confirmed against the marker file"),
          `final verification report retained: ${verifyStep?.output}`,
        );
        const testStep = dbStep(ctx, runId, "test");
        assert.equal(testStep?.status, "done", "downstream test step ran and completed");
        assert.equal(eventIndexes(events, "step.running", "test").length, 1);
        assert.equal(countEvent(events, "story.verified"), 1);
        assert.equal(countEvent(events, "story.retry"), 0);

        const runFinal = dbRun(ctx, runId);
        assert.equal(runFinal?.tokens_spent, 0, "zero model tokens on the non-drain control");
        assertZeroHeartbeatContract(ctx, runId);

        execFileSync("git", ["show", `refs/heads/${originalBranch}:marker-one.txt`], {
          cwd: repoDir,
          encoding: "utf-8",
        });

        // Terminal-state control (completed): a drain pause on the completed
        // run is refused — never flipped to paused.
        const pauseTerminal = await requestDrainPause(ctx, runId);
        assert.equal(
          pauseTerminal.status,
          409,
          `drain pause on a completed run must be refused (409), got ${pauseTerminal.status}: ${JSON.stringify(pauseTerminal.body)}`,
        );
        const runAfter = dbRun(ctx, runId);
        assert.equal(runAfter?.status, "completed", "completed run must stay completed");
        assert.equal(readRunEvents(ctx, runId).filter((e) => e.event === "run.paused").length, 0);

        console.log(
          `[drvp e2e non-drain control] run ${runId.slice(0, 8)}: completed with no pause events; ` +
            `later drain pause refused 409 (terminal control)`,
        );
      } finally {
        await teardown(ctx);
      }
    },
  );

  it(
    "terminal-state controls: real failed and canceled runs refuse drain-pause (409) and are never flipped to paused",
    { timeout: 360_000 },
    async () => {
      // ── Sub-case A: a real FAILED run (motor: seeded single step whose
      // scripted worker reports `step fail`; max_retries 0 ⇒ first failure
      // fails the run) must refuse a drain pause with 409. ──
      let failedCtx: DrvpRunContext | undefined;
      try {
        const env = await createTempHome();
        const workflowId = "feature-dev-merge";
        const scripted = createScriptedAgent(env.root, {
          agents: {
            developer: {
              stepAction: "fail",
              failReason: "scripted failure for the DRVP failed-terminal control",
            },
          },
          heartbeatTokens: 0,
          defaultTokens: 0,
        });
        cliMustSucceed(["workflow", "install", workflowId], baseEnv(env.homeDir, env.controlPort), `install ${workflowId}`);
        const runId = seedSingleStepRun(env, workflowId, { maxRetries: 0 });
        await releasePortReservations(env);
        const daemon = await startIsolatedDaemon(env.homeDir, env.controlPort, scripted.env);
        failedCtx = { env, scripted, daemon };

        await registerAndNudge(failedCtx, runId);

        await waitForDb(
          failedCtx,
          runId,
          "seeded step worker failed the run",
          () => dbRun(failedCtx!, runId)?.status === "failed",
          90_000,
        );
        const failedEvents = readRunEvents(failedCtx, runId);
        assert.equal(countEvent(failedEvents, "run.failed"), 1, "run.failed must be emitted");

        const pauseFailed = await requestDrainPause(failedCtx, runId);
        assert.equal(
          pauseFailed.status,
          409,
          `drain pause on a failed run must be refused (409), got ${pauseFailed.status}: ${JSON.stringify(pauseFailed.body)}`,
        );
        const runFailed = dbRun(failedCtx, runId);
        assert.equal(runFailed?.status, "failed", "failed run must stay failed");
        assert.equal(countEvent(readRunEvents(failedCtx, runId), "run.paused"), 0, "failed run never flipped to paused");

        console.log(`[drvp e2e terminal control] failed run ${runId.slice(0, 8)} refused drain pause 409`);
      } finally {
        await teardown(failedCtx);
      }

      // ── Sub-case B: a real CANCELED run (motor: seeded single-step run
      // whose scripted worker hangs after claim, cancelled mid-round via
      // `tamandua workflow stop`) must refuse a drain pause with 409. ──
      let canceledCtx: DrvpRunContext | undefined;
      try {
        const env = await createTempHome();
        const workflowId = "feature-dev-merge";
        const scripted = createScriptedAgent(env.root, {
          agents: {
            developer: { mode: "hang-after-claim" },
          },
          heartbeatTokens: 0,
          defaultTokens: 0,
        });
        cliMustSucceed(["workflow", "install", workflowId], baseEnv(env.homeDir, env.controlPort), `install ${workflowId}`);
        const runId = seedSingleStepRun(env, workflowId, {});
        await releasePortReservations(env);
        const daemon = await startIsolatedDaemon(env.homeDir, env.controlPort, scripted.env);
        canceledCtx = { env, scripted, daemon };

        await registerAndNudge(canceledCtx, runId);

        // Wait for the scripted worker to claim the step and hold it running.
        await waitForDb(
          canceledCtx,
          runId,
          "seeded step claimed (running)",
          () => {
            const rows = dbRows<{ status: string }>(
              canceledCtx!.env.tamanduaDir,
              "SELECT status FROM steps WHERE run_id = ? AND status = 'running'",
              runId,
            );
            return rows.length > 0;
          },
          90_000,
        );

        // Cancel the running run through the CLI (real motor cancel path:
        // marks steps + run canceled, tears down crons, settles in-flight
        // rounds, emits run.canceled).
        const stop = spawnSync(
          process.execPath,
          [cliPath, "workflow", "stop", runId],
          { env: baseEnv(canceledCtx.env.homeDir, canceledCtx.env.controlPort), encoding: "utf-8", timeout: 60_000 },
        );
        assert.equal(stop.status, 0, `workflow stop failed: ${stop.stderr || stop.stdout}`);

        await waitForDb(
          canceledCtx,
          runId,
          "run canceled",
          () => dbRun(canceledCtx!, runId)?.status === "canceled",
          60_000,
        );
        const canceledEvents = readRunEvents(canceledCtx, runId);
        assert.equal(countEvent(canceledEvents, "run.canceled"), 1, "run.canceled must be emitted");

        const pauseCanceled = await requestDrainPause(canceledCtx, runId);
        assert.equal(
          pauseCanceled.status,
          409,
          `drain pause on a canceled run must be refused (409), got ${pauseCanceled.status}: ${JSON.stringify(pauseCanceled.body)}`,
        );
        const runCanceled = dbRun(canceledCtx, runId);
        assert.equal(runCanceled?.status, "canceled", "canceled run must stay canceled");
        assert.equal(countEvent(readRunEvents(canceledCtx, runId), "run.paused"), 0, "canceled run never flipped to paused");

        console.log(`[drvp e2e terminal control] canceled run ${runId.slice(0, 8)} refused drain pause 409`);
      } finally {
        await teardown(canceledCtx);
      }
    },
  );
});

// ── Seeded single-step run helpers (real daemon register → dispatch) ──

/**
 * Seed one run row + one pending 'implement' step row in the isolated DB.
 * The schema is created by the BUILT product's own migrate() (a throwaway
 * dist/db.js getDb() in the isolated env), then the rows are inserted with
 * explicit columns so they are robust to added nullable columns. Must run
 * BEFORE the isolated daemon starts: the daemon's first getDb() (at the
 * register-run control request) then finds the run + step to schedule.
 */
function seedSingleStepRun(
  env: Awaited<ReturnType<typeof createTempHome>>,
  workflowId: string,
  opts: { maxRetries?: number },
): string {
  const migrateEval = [
    'import { getDb } from "./dist/db.js";',
    "getDb();",
  ].join("");
  const migrate = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", migrateEval],
    { env: baseEnv(env.homeDir, env.controlPort), encoding: "utf-8", cwd: process.cwd() },
  );
  assert.equal(
    migrate.status,
    0,
    `seeded-run DB migrate failed (exit ${migrate.status}): ${migrate.stderr || migrate.stdout}`,
  );

  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  const harnessDir = env.homeDir;
  const context = JSON.stringify({
    task: "DRVP terminal-state control",
    repo: harnessDir,
    working_directory_for_harness: harnessDir,
  });
  const stepId = crypto.randomUUID();
  const maxRetries = opts.maxRetries ?? 4;
  const db = openE2eDatabase(path.join(env.tamanduaDir, "tamandua.db"));
  try {
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`,
    ).run(runId, workflowId, "DRVP terminal-state control", context, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, max_retries, created_at, updated_at)
       VALUES (?, ?, 'implement', ?, 0, 'Implement the seeded DRVP terminal-control step', 'STATUS: done', 'pending', 'single', ?, ?, ?)`,
    ).run(stepId, runId, `${workflowId}_developer`, maxRetries, now, now);
  } finally {
    db.close();
  }
  return runId;
}

async function registerAndNudge(ctx: DrvpRunContext, runId: string): Promise<void> {
  const regResp = await controlFetch(ctx, "/control/register-run", "POST", { runId });
  assert.ok(
    regResp.status === 200 || regResp.status === 202,
    `register-run should succeed, got ${regResp.status}: ${JSON.stringify(regResp.body)}\n${diagnostics(ctx, runId)}`,
  );
  // Nudge to trigger immediate dispatch instead of waiting for the interval.
  const nudge = await controlFetch(ctx, "/control/nudge", "POST", undefined, 15_000);
  assert.equal(nudge.status, 200, `nudge should succeed, got ${nudge.status}: ${JSON.stringify(nudge.body)}`);
}
