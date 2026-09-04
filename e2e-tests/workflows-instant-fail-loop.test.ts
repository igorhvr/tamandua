/**
 * Mid-Run Instant-Fail Loop E2E (IFLB-mid US-004) — fast, ZERO model tokens
 *
 * This tier drives the MID-RUN instant-fail loop through the REAL daemon →
 * scheduler → harness path (the same real-pipeline plumbing as
 * workflows-scripted.test.ts / workflows-harness-probe.test.ts, but focused
 * on the IFLB-mid regression US-001 fixed):
 *
 * A run launched with a shim harness that ANSWERS the launch-time probe
 * correctly (the probe-aware canned runtime — so the run passes the probe
 * and only breaks MID-RUN) but then exits 1 instantly with zero output on
 * EVERY work round. With low thresholds via daemon env (K=2, N=4, base 3s)
 * the run must:
 *
 *   (a) relaunch after each escalating backoff window — never strand as
 *       `previous_round_in_flight` after a backoff-gated tick (the leaked
 *       in-flight mark: pre-fix, the first tick inside the backoff window
 *       leaked the job's in-flight mark and every later tick was skipped
 *       as previous_round_in_flight, so no relaunch ever happened and N
 *       was unreachable), and
 *   (b) force-fail within about a minute with exactly one
 *       run.instant_fail_loop event carrying the RSPN reason, zero steps
 *       completed (no claim ever happens — the shim dies before claiming).
 *
 * The probe is ENABLED (TAMANDUA_HARNESS_PROBE=1 pinned in the daemon env):
 * the run must pass the launch-time probe and only break mid-run. No
 * models are invoked — zero tokens.
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
  "Instant-fail-loop e2e: do not modify files or run commands other than the " +
  "tamandua step commands. Reply with STATUS: done and REPORT: instant-fail ok.";

// Low thresholds via daemon env (per the story): K=2 backoff threshold,
// N=4 escalation threshold. The backoff base is 3s (not 1s) so a poll
// nudge (~1.7s cadence) deterministically lands inside each backoff
// window — a gated `instant_fail_backoff` tick is the regression evidence.
const K = 2;
const N = 4;
const BACKOFF_BASE_MS = 3_000;
// Generous wall-clock threshold: the die-before-claim shim round includes a
// node startup + `step peek` child spawn; under a loaded fast lane it must
// still classify as an instant fail (sub-threshold), never as a slow round.
const WALL_MS = 20_000;
const POLL_TIMEOUT_MS = 60_000; // the run must fail within about a minute

// ── Shared plumbing ─────────────────────────────────────────────────

interface InstantFailRunContext {
  env: Awaited<ReturnType<typeof createTempHome>>;
  daemon: ChildProcess;
}

/** Install the workflow and launch the daemon (probe ON, low IFLB thresholds, debug log). */
async function startInstantFailEnvironment(
  env: Awaited<ReturnType<typeof createTempHome>>,
  daemonEnv: Record<string, string>,
): Promise<InstantFailRunContext> {
  cliMustSucceed(
    ["workflow", "install", WORKFLOW_ID],
    baseEnv(env.homeDir, env.controlPort),
    `install ${WORKFLOW_ID}`,
  );
  await releasePortReservations(env);
  const daemon = await startIsolatedDaemon(env.homeDir, env.controlPort, {
    // Pin the probe ON: the harness must pass the launch-time probe and
    // only break mid-run (the exact IFLB-mid scenario).
    TAMANDUA_HARNESS_PROBE: "1",
    // Debug lines carry the dispatch skip reasons (instant_fail_backoff /
    // previous_round_in_flight) — the leaked-mark regression evidence.
    TAMANDUA_DEBUG: "1",
    // Low thresholds so the loop escalates within about a minute.
    TAMANDUA_INSTANT_FAIL_BACKOFF_K: String(K),
    TAMANDUA_INSTANT_FAIL_ESCALATION_N: String(N),
    TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS: String(BACKOFF_BASE_MS),
    // Generous wall threshold (see WALL_MS note above).
    TAMANDUA_INSTANT_FAIL_WALL_MS: String(WALL_MS),
    ...daemonEnv,
  });
  return { env, daemon };
}

async function teardown(ctx: InstantFailRunContext | undefined): Promise<void> {
  if (!ctx) return;
  try {
    await stopIsolatedDaemon(ctx.daemon);
  } catch {
    // best-effort
  }
  cleanupTempHome(ctx.env);
}

/** Append daemon log + run event diagnostics to a failure. */
function diagnostics(ctx: InstantFailRunContext, runId?: string): string {
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
  ctx: InstantFailRunContext,
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
  ctx: InstantFailRunContext,
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

function dbRows<T>(ctx: InstantFailRunContext, sql: string, ...params: string[]): T[] {
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
function readRunScopedLogLines(ctx: InstantFailRunContext, runId: string): string[] {
  const logPath = path.join(ctx.env.tamanduaDir, "tamandua.log");
  if (!fs.existsSync(logPath)) return [];
  const needle = `"runId":"${runId}"`;
  return fs
    .readFileSync(logPath, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.includes(needle));
}

// ── Tests ───────────────────────────────────────────────────────────

describe("mid-run instant-fail loop e2e (IFLB-mid US-004)", () => {
  it(
    "a probe-passing harness that exit-1s with zero output on every work round relaunches after each backoff window and force-fails with run.instant_fail_loop (K=2, N=4)",
    { timeout: 120_000 },
    async () => {
      let ctx: InstantFailRunContext | undefined;
      const startedAt = Date.now();
      try {
        const env = await createTempHome();

        // Probe-aware shim harness: the scripted-agent runtime ANSWERS the
        // launch-time probe prompt (runs the quoted `<launcher> skill-path`
        // for real, replies with the PATH, never journaled), then applies
        // per-work-round behaviors. `die-before-claim` + exitCode 1 = the
        // mid-run breakage: peek confirms HAS_WORK, then exit 1 instantly
        // with ZERO stdout — never claiming the step.
        const behaviors: ScriptedAgentConfig = {
          agents: {
            doer: { mode: "die-before-claim", exitCode: 1 },
          },
        };
        const scripted = createScriptedAgent(env.root, behaviors);

        ctx = await startInstantFailEnvironment(env, {
          ...scripted.env,
          TAMANDUA_PI_BINARY: scripted.binPath,
        });

        const workdir = path.join(env.root, "instant-fail-workdir");
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

        // The run must FAIL within about a minute (the poll deadline is the
        // "about a minute" bound; diagnostics are attached on timeout).
        const status = await waitForTerminalStatus(ctx, runId, POLL_TIMEOUT_MS);
        const elapsedMs = Date.now() - startedAt;
        assert.equal(
          status,
          "failed",
          `a mid-run instant-fail loop must force-fail the run, got "${status}" after ${elapsedMs}ms\n${diagnostics(ctx, runId)}`,
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

        // ── Exactly one run.instant_fail_loop with the consecutive count ──
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
          /^worker instant-fail loop: \d+ consecutive sub-\d+s exit-1 rounds; last command: /,
          "run.instant_fail_loop reason must match the RSPN shape",
        );

        // ── The run is force-failed through the sanctioned path with the
        // same RSPN reason, and the alert precedes the terminal event ──
        const forceFailures = events.filter((e) => e.event === "run.force_failed");
        assert.equal(
          forceFailures.length,
          1,
          "the run must be force-failed exactly once through forceFailRun",
        );
        const ffReason = String(forceFailures[0].reason ?? "");
        assert.match(
          ffReason,
          /^worker instant-fail loop: \d+ consecutive sub-\d+s exit-1 rounds; last command: /,
          "run.force_failed reason must match the RSPN shape",
        );
        const loopIdx = events.findIndex((e) => e.event === "run.instant_fail_loop");
        const forceIdx = events.findIndex((e) => e.event === "run.force_failed");
        assert.ok(
          loopIdx >= 0 && forceIdx > loopIdx,
          "run.instant_fail_loop must precede the run.force_failed terminal event",
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
        const steps = dbRows<{ step_id: string; status: string; claim_pid: number | null }>(
          ctx,
          "SELECT step_id, status, claim_pid FROM steps WHERE run_id = ?",
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
        }

        // ── DB: run failed with the counter at N and the probe 'ok' ──
        const runs = dbRows<{ status: string; instant_fail_count: number; harness_probe_status: string | null }>(
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

        // ── Daemon log: the leaked-mark regression ──
        // The run-scoped log must show (1) at least one backoff-gated tick
        // (`instant_fail_backoff` — the backoff window engaged and a tick
        // landed inside it), (2) real relaunches AFTER that gated tick
        // (work-round starts + instant-fail classifications for the
        // relaunched rounds — pre-fix, nothing ever relaunched after the
        // first gated tick), and (3) NO `previous_round_in_flight` skip
        // after the first backoff-gated tick (the leaked in-flight mark:
        // pre-fix the gated tick leaked the mark and every later tick was
        // skipped as previous_round_in_flight).
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
          "a work round must relaunch AFTER the first backoff-gated tick (pre-fix, no relaunch ever happened)",
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
