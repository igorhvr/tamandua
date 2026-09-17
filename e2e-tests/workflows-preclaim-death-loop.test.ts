/**
 * Streaming Pre-Claim Death Loop E2E (OUTAGE-ROUNDS SCLS US-009) — fast, ZERO tokens
 *
 * The OUTAGE-ROUNDS change makes rounds that pass the launch probe, run LONGER
 * than the instant-fail wall threshold, and then exit/die WITHOUT claiming a
 * step a first-class failure shape: each one emits `step.preclaim_round_died`
 * and increments the durable per-step `steps.preclaim_death_count`; after K
 * consecutive deaths the relaunch is delayed by the escalating backoff and
 * after N the run is force-failed with a distinct `run.preclaim_death_loop`
 * alert. No retry budget is charged.
 *
 * This tier proves that exact path end-to-end through the REAL daemon →
 * scheduler → harness spawn → step-ops pipeline with a shim harness that:
 *
 *   1. ANSWERS the launch-time probe correctly (TAMANDUA_HARNESS_PROBE=1), so
 *      the run passes the probe and only breaks MID-RUN, and
 *   2. on every work round runs `stream-die-before-claim` with `sleepMs: 7000`
 *      and `exitCode: 1` — it streams non-empty output, lives ~7 s (past the
 *      pinned 6000 ms threshold), and exits non-zero WITHOUT ever claiming a
 *      step.
 *
 * With low thresholds via daemon env (K=2, N=3, base 2 s) the run must:
 *
 *   (a) record exactly N `step.preclaim_round_died` events, each carrying the
 *       pending execute-step id, a nonzero exit code and a `harnessWallMs`
 *       >= 6000 (the classification signal),
 *   (b) accumulate `steps.preclaim_death_count === N` and engage the
 *       escalating backoff after K (a gated `preclaim_death_backoff` tick is
 *       the regression evidence, with a real relaunch after it), and
 *   (c) force-fail with exactly one `run.preclaim_death_loop` alert carrying
 *       the pre-claim reason, immediately followed by `run.force_failed` with
 *       the same reason.
 *
 * The recorded step is NEVER claimed (`claim_pid IS NULL`, no
 * `step.running`/`step.done`, `retry_count 0`) — a pre-claim death consumes no
 * retry budget and causes no claim-driven status transition.
 *
 * No models are invoked — zero tokens.
 *
 * Run via: ./run-all-scripted-e2e-tests (or ./run-all-e2e-tests)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { openE2eDatabase } from "./helpers/e2e-database.mjs";
import {
  createTempHome,
  baseEnv,
  cliMustSucceed,
  spawnWorkflowRun,
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
  type ScriptedAgentConfig,
} from "./helpers/scripted-agent.ts";

const WORKFLOW_ID = "do-now"; // single agent (`doer`), single step (`execute`)
const TASK =
  "Pre-claim death loop e2e: do not modify files or run commands other than " +
  "the tamandua step commands. Reply with STATUS: done and REPORT: preclaim ok.";

// Low thresholds via daemon env (per the story): K=2 backoff threshold,
// N=3 escalation threshold, 2s backoff base. The base is short because the
// rounds themselves are ~7s, so the pre-claim death loop is already slow;
// the poll nudge cadence is tightened (below) so a tick deterministically
// lands inside the 2s window — a gated `preclaim_death_backoff` tick is the
// backoff evidence.
const K = 2;
const N = 3;
const BACKOFF_BASE_MS = 2_000;
// The new 6000 ms default is pinned explicitly for determinism under host
// load. The stream-die-before-claim shim lives ~7s, so its harness wall time
// is comfortably AT OR ABOVE the threshold — the pre-claim death shape.
const WALL_MS = 6_000;
// The shim streams output, waits 7s, then exits 1 without claiming. The 7s is
// deliberately past the 6000 ms threshold so the round classifies as a SLOW
// pre-claim death (never as a fast instant fail).
const ROUND_SLEEP_MS = 7_000;
const STREAM_OUTPUT = "working...\n";
// The default poll nudge cadence (~1.5s + CLI spawn time) can just miss a 2s
// backoff window. Nudge faster so at least one tick lands inside it and the
// `preclaim_death_backoff` gate is observed deterministically.
const NUDGE_INTERVAL_MS = 400;
const POLL_TIMEOUT_MS = 120_000; // the run must fail within about 120s
const TEST_TIMEOUT_MS = 150_000;

// ── Shared plumbing ─────────────────────────────────────────────────

interface PreclaimRunContext {
  env: Awaited<ReturnType<typeof createTempHome>>;
  daemon: ChildProcess;
}

/** Install the workflow and launch the daemon (probe ON, low IFLB thresholds, debug log). */
async function startPreclaimEnvironment(
  env: Awaited<ReturnType<typeof createTempHome>>,
  daemonEnv: Record<string, string>,
): Promise<PreclaimRunContext> {
  cliMustSucceed(
    ["workflow", "install", WORKFLOW_ID],
    baseEnv(env.homeDir, env.controlPort),
    `install ${WORKFLOW_ID}`,
  );
  await releasePortReservations(env);
  const daemon = await startIsolatedDaemon(env.homeDir, env.controlPort, {
    // Pin the probe ON: the harness must pass the launch-time probe and
    // only break mid-run (a pre-claim death requires a probe-passing round).
    TAMANDUA_HARNESS_PROBE: "1",
    // Debug lines carry the dispatch skip reasons (preclaim_death_backoff /
    // previous_round_in_flight).
    TAMANDUA_DEBUG: "1",
    // Low thresholds so the loop escalates within about 120s.
    TAMANDUA_INSTANT_FAIL_BACKOFF_K: String(K),
    TAMANDUA_INSTANT_FAIL_ESCALATION_N: String(N),
    TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS: String(BACKOFF_BASE_MS),
    // Pin the 6000 ms threshold explicitly.
    TAMANDUA_INSTANT_FAIL_WALL_MS: String(WALL_MS),
    ...daemonEnv,
  });
  return { env, daemon };
}

async function teardown(ctx: PreclaimRunContext | undefined): Promise<void> {
  if (!ctx) return;
  try {
    await stopIsolatedDaemon(ctx.daemon);
  } catch {
    // best-effort
  }
  cleanupTempHome(ctx.env);
}

/** Append daemon log + run event diagnostics to a failure. */
function diagnostics(ctx: PreclaimRunContext, runId?: string): string {
  let daemonLogTail = "(no daemon log)";
  try {
    const logPath = path.join(ctx.env.tamanduaDir, "tamandua.log");
    const lines = fs.readFileSync(logPath, "utf-8").trimEnd().split("\n");
    daemonLogTail = lines.slice(-80).join("\n");
  } catch {
    // keep default
  }
  let events = "(no events)";
  if (runId) {
    try {
      const eventsPath = path.join(ctx.env.tamanduaDir, "events", `${runId}.jsonl`);
      events = fs
        .readFileSync(eventsPath, "utf-8")
        .trimEnd()
        .split("\n")
        .slice(-25)
        .join("\n");
    } catch {
      // keep default
    }
  }
  return ["── daemon log (last 80 lines) ──", daemonLogTail, "── run events (last 25) ──", events].join("\n");
}

async function waitForTerminalStatus(
  ctx: PreclaimRunContext,
  runId: string,
  timeoutMs: number,
): Promise<string> {
  try {
    return await pollForRunCompletionWithNudge(
      runId,
      baseEnv(ctx.env.homeDir, ctx.env.controlPort),
      timeoutMs,
      NUDGE_INTERVAL_MS,
    );
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n${diagnostics(ctx, runId)}`,
    );
  }
}

function readRunEvents(
  ctx: PreclaimRunContext,
  runId: string,
): Array<Record<string, unknown>> {
  const eventsPath = path.join(ctx.env.tamanduaDir, "events", `${runId}.jsonl`);
  if (!fs.existsSync(eventsPath)) return [];
  return fs
    .readFileSync(eventsPath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function dbRows<T>(ctx: PreclaimRunContext, sql: string, ...params: string[]): T[] {
  const db = openE2eDatabase(path.join(ctx.env.tamanduaDir, "tamandua.db"));
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/**
 * Read the daemon's tamandua.log and return the lines belonging to this run
 * (every scheduler dispatch log line carries `"runId":"<full id>"` in its
 * structured fields), in file order. Skip-reason lines are DEBUG-level, so
 * TAMANDUA_DEBUG=1 is set on the daemon env above.
 */
function readRunScopedLogLines(ctx: PreclaimRunContext, runId: string): string[] {
  const logPath = path.join(ctx.env.tamanduaDir, "tamandua.log");
  if (!fs.existsSync(logPath)) return [];
  const needle = `"runId":"${runId}"`;
  return fs
    .readFileSync(logPath, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.includes(needle));
}

// ── Tests ───────────────────────────────────────────────────────────

describe("streaming pre-claim death loop e2e (OUTAGE-ROUNDS SCLS US-009)", () => {
  it(
    "a probe-passing harness that streams and dies before claiming after ~7s records N preclaim deaths, backs off, and force-fails with run.preclaim_death_loop (K=2, N=3)",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      let ctx: PreclaimRunContext | undefined;
      const startedAt = Date.now();
      try {
        const env = await createTempHome();

        // Probe-aware shim harness: the scripted-agent runtime ANSWERS the
        // launch-time probe prompt (runs the quoted `<launcher> skill-path`
        // for real, replies with the PATH, never journaled), then applies
        // per-work-round behaviors. `stream-die-before-claim` with sleepMs
        // 7000 + exitCode 1 = a ~7s harness round that streams non-empty
        // output and dies before claiming — the slow streaming pre-claim
        // death shape.
        const behaviors: ScriptedAgentConfig = {
          agents: {
            doer: {
              mode: "stream-die-before-claim",
              sleepMs: ROUND_SLEEP_MS,
              streamOutput: STREAM_OUTPUT,
              exitCode: 1,
            },
          },
        };
        const scripted = createScriptedAgent(env.root, behaviors);

        ctx = await startPreclaimEnvironment(env, {
          ...scripted.env,
          TAMANDUA_PI_BINARY: scripted.binPath,
        });

        const workdir = path.join(env.root, "preclaim-death-workdir");
        fs.mkdirSync(workdir, { recursive: true });
        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            WORKFLOW_ID,
            TASK,
            "--working-directory-for-harness",
            workdir,
          ],
          baseEnv(env.homeDir, env.controlPort),
        );
        const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

        // The run must FAIL within about 120s (the poll deadline is the bound;
        // diagnostics are attached on timeout).
        const status = await waitForTerminalStatus(ctx, runId, POLL_TIMEOUT_MS);
        const elapsedMs = Date.now() - startedAt;
        assert.equal(
          status,
          "failed",
          `a pre-claim-death loop must force-fail the run, got "${status}" after ${elapsedMs}ms\n${diagnostics(ctx, runId)}`,
        );

        // ── Scenario check: the launch-time probe PASSED (the harness only
        // broke mid-run — never a harness_probe_failed) ──
        const events = readRunEvents(ctx, runId);
        const okProbes = events.filter((e) => e.event === "run.harness_probe_ok");
        assert.equal(
          okProbes.length,
          1,
          `exactly one run.harness_probe_ok expected (the shim answers the probe); events: ${events.map((e) => e.event).join(", ")}`,
        );
        assert.equal(
          events.filter((e) => e.event === "run.harness_probe_failed").length,
          0,
          "a probe-passing shim must never produce a probe-failure event",
        );

        // ── The pending execute step (do-now has exactly one) ──
        const stepRows = dbRows<{
          step_id: string;
          status: string;
          claim_pid: number | null;
          retry_count: number;
          preclaim_death_count: number;
        }>(
          ctx,
          "SELECT step_id, status, claim_pid, retry_count, preclaim_death_count FROM steps WHERE run_id = ?",
          runId,
        );
        assert.equal(
          stepRows.length,
          1,
          `do-now must seed exactly one step; got ${stepRows.length}`,
        );
        const executeStep = stepRows[0];
        assert.equal(executeStep.step_id, "execute", "the do-now step id is execute");

        // ── Exactly N step.preclaim_round_died events, each carrying the
        // pending stepId, a nonzero exit code and the >=threshold harness
        // wall time the classifier keyed on ──
        const deaths = events.filter((e) => e.event === "step.preclaim_round_died");
        assert.equal(
          deaths.length,
          N,
          `exactly ${N} step.preclaim_round_died events expected; deaths: ${deaths.length}\n${diagnostics(ctx, runId)}`,
        );
        deaths.forEach((death, i) => {
          assert.equal(
            death.stepId,
            executeStep.step_id,
            `step.preclaim_round_died[${i}] must carry the pending execute step id`,
          );
          assert.ok(
            typeof death.exitCode === "number" && death.exitCode !== 0,
            `step.preclaim_round_died[${i}] must carry a nonzero exitCode, got ${String(death.exitCode)}`,
          );
          assert.ok(
            typeof death.harnessWallMs === "number" && death.harnessWallMs >= WALL_MS,
            `step.preclaim_round_died[${i}] harnessWallMs must be >= ${WALL_MS} (the classification signal), got ${String(death.harnessWallMs)}`,
          );
        });
        assert.equal(
          deaths[N - 1].consecutivePreclaimDeaths,
          N,
          `the final step.preclaim_round_died must carry the consecutive count ${N}`,
        );

        // ── The slow shape must NOT be misclassified as a fast instant fail ──
        assert.equal(
          events.filter((e) => e.event === "run.instant_fail_loop").length,
          0,
          "a >=threshold streaming round must never classify as an instant fail",
        );
        const runs = dbRows<{
          status: string;
          instant_fail_count: number;
          harness_probe_status: string | null;
        }>(
          ctx,
          "SELECT status, instant_fail_count, harness_probe_status FROM runs WHERE id = ?",
          runId,
        );
        assert.equal(runs.length, 1);
        assert.equal(runs[0].status, "failed", "the run must be terminal failed in the DB");
        assert.equal(
          runs[0].instant_fail_count,
          0,
          "a pre-claim death loop must never charge the instant-fail counter",
        );
        assert.equal(
          runs[0].harness_probe_status,
          "ok",
          "the launch-time probe outcome must persist 'ok' (the run only broke mid-run)",
        );

        // ── Exactly one run.preclaim_death_loop immediately preceding the
        // run.force_failed terminal event, both carrying the pre-claim reason ──
        const loops = events.filter((e) => e.event === "run.preclaim_death_loop");
        assert.equal(
          loops.length,
          1,
          `exactly one run.preclaim_death_loop expected; loop events: ${loops.length}\n${diagnostics(ctx, runId)}`,
        );
        assert.equal(
          loops[0].consecutivePreclaimDeaths,
          N,
          `run.preclaim_death_loop must carry the consecutive count ${N}`,
        );
        const preclaimReasonRe =
          /^worker pre-claim death loop: \d+ consecutive >=6s rounds that exited\/died without claiming a step; last command: /;
        const loopReason = String(loops[0].reason ?? "");
        assert.match(
          loopReason,
          preclaimReasonRe,
          "run.preclaim_death_loop reason must match the pre-claim death shape",
        );

        const forceFailures = events.filter((e) => e.event === "run.force_failed");
        assert.equal(
          forceFailures.length,
          1,
          "the run must be force-failed exactly once through forceFailRun",
        );
        const ffReason = String(forceFailures[0].reason ?? "");
        assert.match(
          ffReason,
          preclaimReasonRe,
          "run.force_failed reason must match the pre-claim death shape",
        );
        const loopIdx = events.findIndex((e) => e.event === "run.preclaim_death_loop");
        const forceIdx = events.findIndex((e) => e.event === "run.force_failed");
        assert.equal(
          forceIdx,
          loopIdx + 1,
          `run.preclaim_death_loop must immediately precede run.force_failed (indices ${loopIdx} -> ${forceIdx})\n${diagnostics(ctx, runId)}`,
        );

        // ── The counter reached N for the recorded step, and the step was
        // never claimed: no claim-driven status transition, no retry charge ──
        const finalSteps = dbRows<{
          step_id: string;
          status: string;
          claim_pid: number | null;
          retry_count: number;
          preclaim_death_count: number;
        }>(
          ctx,
          "SELECT step_id, status, claim_pid, retry_count, preclaim_death_count FROM steps WHERE run_id = ?",
          runId,
        );
        assert.equal(finalSteps.length, 1);
        const finalStep = finalSteps[0];
        assert.equal(
          finalStep.preclaim_death_count,
          N,
          `steps.preclaim_death_count must reach the escalation threshold ${N}`,
        );
        assert.ok(
          finalStep.claim_pid === null,
          `step ${finalStep.step_id} must never have been claimed (claim_pid set): ${String(finalStep.claim_pid)}`,
        );
        assert.equal(
          finalStep.retry_count,
          0,
          "a pre-claim death must consume no retry budget (retry_count stays 0)",
        );
        assert.notEqual(finalStep.status, "running", "the step must never be running");
        assert.notEqual(finalStep.status, "done", "the step must never be done");
        assert.notEqual(finalStep.status, "failed", "the step must never be failed");

        // No claim-driven step activity events at all (force-fail teardown sets
        // the still-pending step to canceled without emitting a step event).
        const activityEvents = events.filter((e) =>
          ["step.running", "step.started", "step.done", "step.failed", "step.retry", "step.timeout"].includes(
            String(e.event),
          ),
        );
        assert.equal(
          activityEvents.length,
          0,
          `a pre-claim-death run must never start/complete a step; step events: ${events
            .filter((e) => String(e.event).startsWith("step."))
            .map((e) => String(e.event))
            .join(", ")}`,
        );

        // ── The shim must have been spawned for exactly the N work rounds
        // (the probe answer is never journaled and never consumes a work
        // index) ──
        const workRounds = scripted.workInvocations("doer");
        assert.equal(
          workRounds.length,
          N,
          `doer must run exactly ${N} stream-die-before-claim work rounds, got ${workRounds.length}\n${scripted.describe()}`,
        );

        // ── Daemon log: the preclaim backoff gate + relaunch evidence ──
        // The run-scoped log must show (1) at least one backoff-gated tick
        // (`preclaim_death_backoff` — the window engaged and a tick landed
        // inside it), (2) a work round relaunching AFTER that gated tick, and
        // (3) a pre-claim-death classification after the gate (the relaunched
        // round died the same way).
        const logLines = readRunScopedLogLines(ctx, runId);
        const indexesOf = (substr: string): number[] =>
          logLines
            .map((line, i) => (line.includes(substr) ? i : -1))
            .filter((i) => i >= 0);
        const backoffSkips = indexesOf("Dispatch round skipped — preclaim-death backoff");
        const roundStarts = indexesOf("Work round start");
        const classifications = indexesOf(
          "Worker round died before claiming a step (pre-claim death)",
        );

        assert.ok(
          backoffSkips.length >= 1,
          `at least one tick must land inside the preclaim backoff window (preclaim_death_backoff skip); run-scoped log lines: ${logLines.length}\n${diagnostics(ctx, runId)}`,
        );
        assert.equal(
          classifications.length,
          N,
          `all ${N} pre-claim death rounds must be classified (each relaunched round ends in a classification)`,
        );
        assert.ok(
          roundStarts.some((i) => i > backoffSkips[0]),
          "a work round must relaunch AFTER the first preclaim backoff-gated tick",
        );
        assert.ok(
          classifications.some((i) => i > backoffSkips[0]),
          "a pre-claim-death classification must follow the first backoff-gated tick (the relaunched round died pre-claim)",
        );
      } finally {
        await teardown(ctx);
      }
    },
  );
});
