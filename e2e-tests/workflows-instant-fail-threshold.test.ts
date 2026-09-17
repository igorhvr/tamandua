/**
 * Instant-Fail Wall-Threshold E2E (OUTAGE-ROUNDS US-008) — fast, ZERO tokens
 *
 * The OUTAGE-ROUNDS change raises the instant-fail wall threshold default from
 * 2000 ms to 6000 ms so provider refusals that die after a network round trip
 * (e.g. a dsh `QUOTA:` refusal at ~3 s) join the existing escalating backoff
 * and run cap instead of being respawned invisibly.
 *
 * This tier proves that exact boundary through the REAL daemon → scheduler →
 * harness path with a shim harness that:
 *
 *   1. ANSWERS the launch-time probe correctly (TAMANDUA_HARNESS_PROBE=1), so
 *      the run passes the probe and only breaks MID-RUN, and
 *   2. on every work round runs `die-before-claim` with `sleepMs: 3000` and
 *      `exitCode: 1` — it lives ~3 s, writes ZERO stdout, and exits non-zero
 *      WITHOUT ever claiming a step.
 *
 * With `TAMANDUA_INSTANT_FAIL_WALL_MS=6000` pinned (the new default), a ~3 s
 * empty-stdout nonzero-exit round is SUB-threshold and must classify as an
 * instant fail (not a slow pre-claim death). With low thresholds via daemon
 * env (K=2, N=4, base 3 s) the run must:
 *
 *   (a) engage the escalating backoff after K rounds and relaunch after the
 *       window (a gated `instant_fail_backoff` tick is the regression
 *       evidence), and
 *   (b) force-fail with exactly one `run.instant_fail_loop` carrying the RSPN
 *       `sub-6s` reason, with `runs.instant_fail_count === N` and zero steps
 *       completed (no claim ever happens).
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
  "Instant-fail threshold e2e: do not modify files or run commands other than " +
  "the tamandua step commands. Reply with STATUS: done and REPORT: threshold ok.";

// Low thresholds via daemon env (per the story): K=2 backoff threshold,
// N=4 escalation threshold. The backoff base is 3s (not 1s) so a poll
// nudge (~1.7s cadence) deterministically lands inside each backoff
// window — a gated `instant_fail_backoff` tick is the regression evidence.
const K = 2;
const N = 4;
const BACKOFF_BASE_MS = 3_000;
// The new 6000 ms default is pinned explicitly for determinism under host
// load. A die-before-claim round that sleeps 3s and emits empty stdout must
// still be SUB-threshold at 6s (US-008 acceptance criterion 1).
const WALL_MS = 6_000;
// The shim itself lives ~3s per round (sleepMs), so an empty-stdout nonzero
// exit at ~3s < 6s classifies as an INSTANT fail (the provider-refusal
// shape), never as a slow pre-claim death.
const ROUND_SLEEP_MS = 3_000;
const POLL_TIMEOUT_MS = 90_000; // the run must fail within about 90s
const TEST_TIMEOUT_MS = 150_000;

// ── Shared plumbing ─────────────────────────────────────────────────

interface ThresholdRunContext {
  env: Awaited<ReturnType<typeof createTempHome>>;
  daemon: ChildProcess;
}

/** Install the workflow and launch the daemon (probe ON, low IFLB thresholds, debug log). */
async function startThresholdEnvironment(
  env: Awaited<ReturnType<typeof createTempHome>>,
  daemonEnv: Record<string, string>,
): Promise<ThresholdRunContext> {
  cliMustSucceed(
    ["workflow", "install", WORKFLOW_ID],
    baseEnv(env.homeDir, env.controlPort),
    `install ${WORKFLOW_ID}`,
  );
  await releasePortReservations(env);
  const daemon = await startIsolatedDaemon(env.homeDir, env.controlPort, {
    // Pin the probe ON: the harness must pass the launch-time probe and
    // only break mid-run.
    TAMANDUA_HARNESS_PROBE: "1",
    // Debug lines carry the dispatch skip reasons (instant_fail_backoff /
    // previous_round_in_flight).
    TAMANDUA_DEBUG: "1",
    // Low thresholds so the loop escalates within about 90s.
    TAMANDUA_INSTANT_FAIL_BACKOFF_K: String(K),
    TAMANDUA_INSTANT_FAIL_ESCALATION_N: String(N),
    TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS: String(BACKOFF_BASE_MS),
    // Pin the NEW 6000 ms default explicitly.
    TAMANDUA_INSTANT_FAIL_WALL_MS: String(WALL_MS),
    ...daemonEnv,
  });
  return { env, daemon };
}

async function teardown(ctx: ThresholdRunContext | undefined): Promise<void> {
  if (!ctx) return;
  try {
    await stopIsolatedDaemon(ctx.daemon);
  } catch {
    // best-effort
  }
  cleanupTempHome(ctx.env);
}

/** Append daemon log + run event diagnostics to a failure. */
function diagnostics(ctx: ThresholdRunContext, runId?: string): string {
  let daemonLogTail = "(no daemon log)";
  try {
    const logPath = path.join(ctx.env.tamanduaDir, "tamandua.log");
    const lines = fs.readFileSync(logPath, "utf-8").trimEnd().split("\n");
    daemonLogTail = lines.slice(-60).join("\n");
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
        .slice(-20)
        .join("\n");
    } catch {
      // keep default
    }
  }
  return ["── daemon log (last 60 lines) ──", daemonLogTail, "── run events (last 20) ──", events].join("\n");
}

async function waitForTerminalStatus(
  ctx: ThresholdRunContext,
  runId: string,
  timeoutMs: number,
): Promise<string> {
  try {
    return await pollForRunCompletionWithNudge(
      runId,
      baseEnv(ctx.env.homeDir, ctx.env.controlPort),
      timeoutMs,
    );
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n${diagnostics(ctx, runId)}`,
    );
  }
}

function readRunEvents(
  ctx: ThresholdRunContext,
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

function dbRows<T>(ctx: ThresholdRunContext, sql: string, ...params: string[]): T[] {
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
function readRunScopedLogLines(ctx: ThresholdRunContext, runId: string): string[] {
  const logPath = path.join(ctx.env.tamanduaDir, "tamandua.log");
  if (!fs.existsSync(logPath)) return [];
  const needle = `"runId":"${runId}"`;
  return fs
    .readFileSync(logPath, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.includes(needle));
}

// ── Tests ───────────────────────────────────────────────────────────

describe("instant-fail wall-threshold e2e (OUTAGE-ROUNDS US-008)", () => {
  it(
    "a probe-passing harness that sleeps 3s and exit-1s with zero output classifies at the 6000 ms threshold, backs off, and force-fails with run.instant_fail_loop (K=2, N=4)",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      let ctx: ThresholdRunContext | undefined;
      const startedAt = Date.now();
      try {
        const env = await createTempHome();

        // Probe-aware shim harness: the scripted-agent runtime ANSWERS the
        // launch-time probe prompt (runs the quoted `<launcher> skill-path`
        // for real, replies with the PATH, never journaled), then applies
        // per-work-round behaviors. `die-before-claim` with sleepMs 3000 and
        // exitCode 1 = a ~3s harness round that emits ZERO stdout and dies
        // before claiming — the provider-refusal shape that must classify as
        // an instant fail at the 6000 ms threshold.
        const behaviors: ScriptedAgentConfig = {
          agents: {
            doer: { mode: "die-before-claim", sleepMs: ROUND_SLEEP_MS, exitCode: 1 },
          },
        };
        const scripted = createScriptedAgent(env.root, behaviors);

        ctx = await startThresholdEnvironment(env, {
          ...scripted.env,
          TAMANDUA_PI_BINARY: scripted.binPath,
        });

        const workdir = path.join(env.root, "instant-fail-threshold-workdir");
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

        // The run must FAIL within about 90s (the poll deadline is the bound;
        // diagnostics are attached on timeout).
        const status = await waitForTerminalStatus(ctx, runId, POLL_TIMEOUT_MS);
        const elapsedMs = Date.now() - startedAt;
        assert.equal(
          status,
          "failed",
          `an instant-fail threshold loop must force-fail the run, got "${status}" after ${elapsedMs}ms\n${diagnostics(ctx, runId)}`,
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

        // ── Exactly one run.instant_fail_loop with the consecutive count and
        // the sub-6s reason (proves classification at the 6 s threshold) ──
        const loops = events.filter((e) => e.event === "run.instant_fail_loop");
        assert.equal(
          loops.length,
          1,
          `exactly one run.instant_fail_loop expected; loop events: ${loops.length}\n${diagnostics(ctx, runId)}`,
        );
        assert.equal(
          loops[0].consecutiveInstantFails,
          N,
          `run.instant_fail_loop must carry the consecutive count ${N}`,
        );
        const loopReason = String(loops[0].reason ?? "");
        assert.match(
          loopReason,
          /^worker instant-fail loop: \d+ consecutive sub-6s exit-1 rounds; last command: /,
          "run.instant_fail_loop reason must render sub-6s (the pinned 6000 ms threshold)",
        );

        // ── The run is force-failed through the sanctioned path with the
        // same reason, and the alert precedes the terminal event ──
        const forceFailures = events.filter((e) => e.event === "run.force_failed");
        assert.equal(
          forceFailures.length,
          1,
          "the run must be force-failed exactly once through forceFailRun",
        );
        const ffReason = String(forceFailures[0].reason ?? "");
        assert.match(
          ffReason,
          /^worker instant-fail loop: \d+ consecutive sub-6s exit-1 rounds; last command: /,
          "run.force_failed reason must render sub-6s (the pinned 6000 ms threshold)",
        );
        const loopIdx = events.findIndex((e) => e.event === "run.instant_fail_loop");
        const forceIdx = events.findIndex((e) => e.event === "run.force_failed");
        assert.ok(
          loopIdx >= 0 && forceIdx > loopIdx,
          "run.instant_fail_loop must precede the run.force_failed terminal event",
        );

        // ── The slow shape must NOT be misclassified as a pre-claim death:
        // the ~3s rounds stay SUB-threshold, so no preclaim event/counter. ──
        assert.equal(
          events.filter((e) => e.event === "step.preclaim_round_died").length,
          0,
          "a sub-threshold exit-1 round must classify as an instant fail, never as a pre-claim death",
        );
        assert.equal(
          events.filter((e) => e.event === "run.preclaim_death_loop").length,
          0,
          "a sub-threshold instant-fail loop must not emit the preclaim death cap",
        );

        // ── Zero steps completed: no claim ever happened (the shim dies
        // before claiming) ──
        const activityEvents = events.filter((e) =>
          ["step.running", "step.started", "step.done", "step.failed", "step.retry", "step.timeout"].includes(
            String(e.event),
          ),
        );
        assert.equal(
          activityEvents.length,
          0,
          `an instant-fail-loop run must never start/complete a step; step events: ${events
            .filter((e) => String(e.event).startsWith("step."))
            .map((e) => String(e.event))
            .join(", ")}`,
        );
        const steps = dbRows<{
          step_id: string;
          status: string;
          claim_pid: number | null;
          preclaim_death_count: number;
        }>(
          ctx,
          "SELECT step_id, status, claim_pid, preclaim_death_count FROM steps WHERE run_id = ?",
          runId,
        );
        assert.ok(steps.length >= 1, "the run should have seeded its workflow steps");
        for (const step of steps) {
          assert.notEqual(step.status, "done", `step ${step.step_id} must never be done`);
          assert.notEqual(step.status, "failed", `step ${step.step_id} must never be failed`);
          assert.notEqual(step.status, "running", `step ${step.step_id} must never be running`);
          assert.ok(
            step.claim_pid === null,
            `step ${step.step_id} must never have been claimed (claim_pid set)`,
          );
          assert.equal(
            step.preclaim_death_count,
            0,
            `step ${step.step_id} must never accrue pre-claim deaths (sub-threshold rounds)`,
          );
        }

        // ── DB: run failed with the counter at N and the probe 'ok' ──
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
          N,
          `runs.instant_fail_count must reach the escalation threshold ${N}`,
        );
        assert.equal(
          runs[0].harness_probe_status,
          "ok",
          "the launch-time probe outcome must persist 'ok' (the run only broke mid-run)",
        );

        // ── The shim must have been spawned for exactly the N work rounds
        // (the probe answer is never journaled and never consumes a work
        // index) ──
        const workRounds = scripted.workInvocations("doer");
        assert.equal(
          workRounds.length,
          N,
          `doer must run exactly ${N} die-before-claim work rounds, got ${workRounds.length}\n${scripted.describe()}`,
        );

        // ── Daemon log: the backoff/relaunch evidence ──
        // The run-scoped log must show (1) at least one backoff-gated tick
        // (`instant_fail_backoff`), (2) real relaunches AFTER that gated tick
        // (work-round starts + instant-fail classifications for the relaunched
        // rounds), and (3) NO `previous_round_in_flight` skip after the first
        // backoff-gated tick (the leaked in-flight mark regression).
        const logLines = readRunScopedLogLines(ctx, runId);
        const indexesOf = (substr: string): number[] =>
          logLines
            .map((line, i) => (line.includes(substr) ? i : -1))
            .filter((i) => i >= 0);
        const backoffSkips = indexesOf("Dispatch round skipped — instant-fail backoff");
        const inFlightSkips = indexesOf("previous round still in flight");
        const roundStarts = indexesOf("Work round start");
        const classifications = indexesOf("Worker round classified as instant fail");

        assert.ok(
          backoffSkips.length >= 1,
          `at least one tick must land inside a backoff window (instant_fail_backoff skip); run-scoped log lines: ${logLines.length}\n${diagnostics(ctx, runId)}`,
        );
        assert.equal(
          classifications.length,
          N,
          `all ${N} instant-fail rounds must be classified (each relaunched round ends in a classification)`,
        );
        assert.ok(
          roundStarts.some((i) => i > backoffSkips[0]),
          "a work round must relaunch AFTER the first backoff-gated tick",
        );
        assert.ok(
          classifications.some((i) => i > backoffSkips[0]),
          "an instant-fail classification must follow the first backoff-gated tick (the relaunched round got classified)",
        );
        const inFlightAfterBackoff = inFlightSkips.filter((i) => i > backoffSkips[0]);
        assert.equal(
          inFlightAfterBackoff.length,
          0,
          `no previous_round_in_flight skip may follow a backoff-gated tick (leaked in-flight mark); run-scoped skips: ${logLines
            .filter((l) => l.includes("Dispatch round skipped"))
            .join("\n")}\n${diagnostics(ctx, runId)}`,
        );
      } finally {
        await teardown(ctx);
      }
    },
  );
});
