/**
 * Instant-fail round classification, thresholds, and backoff policy.
 *
 * The dispatch motor's round loop used to treat a harness that exits
 * nonzero with zero output before claiming any step as a benign empty
 * round: no step was ever claimed, so clean-exit-without-STATUS recovery
 * found nothing to recover, no WLST5 counter (worker_lost/ceiling_expiry)
 * ticked, and the 15s dispatch tick simply respawned the broken harness
 * forever — no backoff, no escalation, no run failure, no status
 * surfacing. This module owns the CONSERVATIVE classification (fast +
 * zero trimmed output + nonzero exit or signal-death), the
 * consecutive-streak thresholds (K for backoff, N for escalation), and
 * the escalating relaunch delay, so the scheduler, status surfacing, and
 * tests all agree on the policy.
 *
 * Classification is deliberately narrow: legitimate short rounds (idle
 * checks, no-op verifies) exit 0 and/or produce output, so they never
 * match. Output is measured TRIMMED — whitespace-only stdout cannot carry
 * a STATUS marker, and harnesses (e.g. dsh) print a lone trailing
 * newline even when aborting (the MISSING_CREDENTIAL shape), so trimming
 * aligns with the scheduler's own outcome classifier
 * (summarizeWorkRoundOutput). Signal-death rounds (killed sub-threshold
 * with no output, e.g. SIGKILL/OOM loops) classify alongside nonzero
 * exits. Timed-out rounds belong to the ceiling-expiry class (WLST5) and
 * are never classified here.
 */

import type { HarnessRoundResult } from "./harness-adapter.js";

// ── Defaults (conservative) ──────────────────────────────────────────

/**
 * Wall-clock threshold (ms) below which a round may be classified as an
 * instant fail. Default 6s. The earlier 2s default was too tight: a
 * provider refusal (e.g. a dsh QUOTA round) dies after a network round
 * trip of ~3s, so it never matched and the 15s tick respawned the refused
 * harness invisibly. 6s keeps legitimate short rounds out (they exit 0
 * and/or produce output) while admitting those refusal rounds.
 * Override: TAMANDUA_INSTANT_FAIL_WALL_MS. A round that produced output
 * or exited 0 never matches regardless of duration.
 */
export const DEFAULT_INSTANT_FAIL_WALL_THRESHOLD_MS = 6_000;

/**
 * Consecutive instant-fail rounds (K) after which the motor applies an
 * escalating delay between relaunches instead of the fixed 15s tick.
 * Default 6: the first K rounds relaunch on the 15s tick, then the delay
 * escalates 30s → 60s → 120s (capped).
 */
export const DEFAULT_INSTANT_FAIL_BACKOFF_THRESHOLD = 6;

/**
 * Consecutive instant-fail rounds (N) after which the run is force-failed
 * through the sanctioned forceFailRun path with a precise reason.
 * Default 20: with the default base delay the backoff/escalation horizon
 * from the first instant fail to the force-fail is about 27 minutes.
 */
export const DEFAULT_INSTANT_FAIL_ESCALATION_THRESHOLD = 20;

/**
 * Base backoff delay (ms) applied at the K-th consecutive instant-fail.
 * Escalates by doubling: base, 2×base, 4×base (capped).
 */
export const DEFAULT_INSTANT_FAIL_BACKOFF_BASE_MS = 30_000;

// ── Configurable getters (env overrides for tests/ops) ───────────────

function readEnvPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Wall-clock threshold (ms). Override: TAMANDUA_INSTANT_FAIL_WALL_MS. */
export function getInstantFailWallThresholdMs(): number {
  return readEnvPositiveInt("TAMANDUA_INSTANT_FAIL_WALL_MS", DEFAULT_INSTANT_FAIL_WALL_THRESHOLD_MS);
}

/** Backoff threshold K. Override: TAMANDUA_INSTANT_FAIL_BACKOFF_K. */
export function getInstantFailBackoffThreshold(): number {
  return readEnvPositiveInt("TAMANDUA_INSTANT_FAIL_BACKOFF_K", DEFAULT_INSTANT_FAIL_BACKOFF_THRESHOLD);
}

/** Escalation threshold N. Override: TAMANDUA_INSTANT_FAIL_ESCALATION_N. */
export function getInstantFailEscalationThreshold(): number {
  return readEnvPositiveInt("TAMANDUA_INSTANT_FAIL_ESCALATION_N", DEFAULT_INSTANT_FAIL_ESCALATION_THRESHOLD);
}

/** Backoff base delay (ms). Override: TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS. */
export function getInstantFailBackoffBaseMs(): number {
  return readEnvPositiveInt("TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS", DEFAULT_INSTANT_FAIL_BACKOFF_BASE_MS);
}

// ── Classification ────────────────────────────────────────────────────

export interface InstantFailRoundSignals {
  /**
   * Wall-clock duration of the round in ms. Adapter-reported
   * (HarnessRoundResult.durationMs) on resolved rounds; scheduler-computed
   * from the MONOTONIC round-start Stopwatch on adapter-throw rounds
   * (TIME-CLOCKS rule 1 — never a `Date.now()` difference). Absent when
   * there is no duration signal — classification is impossible and the
   * round is left alone.
   *
   * This is the WHOLE-ROUND wall time (native setup + harness exec). It is
   * the fallback when `harnessWallMs` is absent — e.g. adapter-throw rounds,
   * which never produced a HarnessRoundResult — but on a resolved round the
   * classification prefers `harnessWallMs`, so VM setup time is excluded.
   */
  wallMs?: number;
  /**
   * Time the harness PROCESS ITSELF ran (guest exec start → exit), EXCLUDING
   * any VM setup (HarnessRoundResult.harnessWallMs). Native adapters set it
   * equal to the whole-round wall time; a Matchlock/in-VM runner reports the
   * in-guest interval here and its setup time separately. When absent the
   * classifier resolves the wall time from `wallMs` (see
   * {@link resolveHarnessWallMs}).
   */
  harnessWallMs?: number;
  /**
   * VM setup time (ms) that preceded the harness exec
   * (HarnessRoundResult.vmSetupMs), carried through only for round
   * metadata/diagnostics — classification uses `harnessWallMs`, never this.
   * 0 for native rounds (no VM); absent when the runner reported none.
   */
  vmSetupMs?: number;
  /** Resolved harness round result. Absent when the adapter threw (spawn/findBinary failure). */
  result?: HarnessRoundResult;
  /**
   * True when the round failed via adapter throw (e.g. deleted/broken
   * harness binary — spawn ENOENT). A launch failure produces zero output
   * and never exits cleanly, so it is treated as an instant fail when it
   * happens within the wall threshold.
   */
  adapterThrew?: boolean;
  /**
   * True when this round's orphan recovery actually recovered a claimed
   * step (the worker claimed a step and then died). Such rounds belong to
   * the worker_lost (harness_lost) class — the existing recovery machinery
   * handles them and WLST5 counters tick — so they must NEVER be
   * classified as instant-fails, which are precisely the rounds that claim
   * no step at all (recovery finds nothing).
   */
  recoveredOrphans?: boolean;
}

/**
 * Resolve the wall time the instant-fail predicate classifies on: the
 * harness PROCESS time (`harnessWallMs`) when the runner reported it,
 * otherwise the whole-round wall time (`roundWallMs`).
 *
 * The precedence deliberately EXCLUDES VM setup time on in-VM rounds: a
 * Matchlock runner reports the guest exec→exit interval as `harnessWallMs`
 * and VM boot separately, so a provider refusal that dies after a ~3s
 * in-guest round is classified even when the VM took a minute to boot. A
 * native round reports `harnessWallMs === roundWallMs` so its behavior is
 * unchanged; an adapter-throw round has no `harnessWallMs` and falls back
 * to the monotonic round elapsed time. `undefined` stays `undefined` —
 * classification is impossible without any duration signal.
 */
export function resolveHarnessWallMs(signals: {
  harnessWallMs?: number;
  roundWallMs?: number;
}): number | undefined {
  return signals.harnessWallMs ?? signals.roundWallMs;
}

/**
 * Conservatively classify a round as an instant fail:
 * wall time below the threshold AND zero TRIMMED output bytes AND
 * (nonzero exit code OR signal-death). Rounds that exit 0 (idle/no-op
 * verifies) or produce any real output never match; timed-out rounds
 * (ceiling-expiry class) never match; and rounds whose worker had
 * claimed a step before dying (recoveredOrphans) never match — those are
 * worker_lost, not instant-fail.
 *
 * The wall time is resolved via {@link resolveHarnessWallMs}: the harness
 * process time when reported (excluding VM setup), else the whole-round
 * fallback.
 */
export function isInstantFailRound(signals: InstantFailRoundSignals): boolean {
  const wallMs = resolveHarnessWallMs({
    harnessWallMs: signals.harnessWallMs,
    roundWallMs: signals.wallMs,
  });
  if (wallMs === undefined) return false; // no duration signal — cannot classify
  if (wallMs >= getInstantFailWallThresholdMs()) return false; // slow round — not instant
  if (signals.result?.timedOut) return false; // ceiling-expiry class — never instant-fail
  if (signals.recoveredOrphans) return false; // claimed step — worker_lost class
  if (signals.adapterThrew) return true; // launch failure: zero output, no clean exit
  const result = signals.result;
  if (!result) return false;
  // Measure TRIMMED output: whitespace-only stdout cannot carry a STATUS
  // marker, and harnesses (e.g. dsh) print a lone trailing newline even
  // when aborting — so the dsh MISSING_CREDENTIAL shape (output "\n",
  // exit 1, ~490ms) is a 0-byte round, matching summarizeWorkRoundOutput
  // semantics (it logs such rounds as outcome=empty_output/outputBytes=0).
  const outputBytes = Buffer.byteLength(result.output.trim(), "utf-8");
  if (outputBytes > 0) return false; // real output — not an instant fail
  const exitCode = result.exitCode;
  if (exitCode !== null && exitCode !== undefined && exitCode !== 0) return true;
  // Signal-death shape: the process was killed by a signal (no exit
  // code) sub-threshold with no output — a SIGKILL/OOM loop is an instant
  // fail, not a legitimate round. Timed-out rounds (SIGTERM + timedOut)
  // were already excluded above.
  if ((exitCode === null || exitCode === undefined) && result.signal) return true;
  return false;
}

// ── Pre-claim death classification (OUTAGE-ROUNDS / SCLS) ────────────

/**
 * Signals for the pre-claim death predicate (OUTAGE-ROUNDS SCLS US-004).
 *
 * A pre-claim death is the COMPLEMENT of an instant fail: the harness got
 * far enough to run past the wall threshold (so it is not the fast
 * zero-output refusal shape) but then exited nonzero or was killed by a
 * signal WITHOUT ever claiming a pending step. Detection is deliberately
 * TIMING AND CLAIM STATE ONLY — exit code, signal, harness wall time, and
 * whether an unclaimed pending step exists. No provider-error taxonomy is
 * ever parsed from stdout/stderr, so the behavior is identical for pi,
 * hermes and dsh.
 */
export interface PreclaimDeathSignals {
  /**
   * Whole-round wall time (ms); fallback when `harnessWallMs` is absent.
   * Same monotonic-vs-epoch discipline as {@link InstantFailRoundSignals}.
   */
  wallMs?: number;
  /**
   * Harness process time (guest exec start → exit), excluding VM setup.
   * The predicate resolves the classification time as
   * `harnessWallMs ?? wallMs` (see {@link resolveHarnessWallMs}).
   */
  harnessWallMs?: number;
  /** True when the round was terminated by the ceiling/timeout guard — never a pre-claim death. */
  timedOut?: boolean;
  /** True when a non-drain operator pause tore this round down — never a pre-claim death. */
  operatorPaused?: boolean;
  /**
   * True when this round's orphan recovery recovered a claimed step — that
   * is the worker_lost class (the worker DID claim), never a pre-claim death.
   */
  recoveredOrphans?: boolean;
  /** True when an unclaimed pending step exists for (runId, agentId). */
  hasPendingStep: boolean;
  /** Harness exit code (null/undefined when the process was killed by a signal). */
  exitCode?: number | null;
  /** Killing signal, when the harness died by signal rather than exiting. */
  signal?: string | null;
}

/**
 * Classify a long, failed, claim-less round as a pre-claim death: the
 * resolved harness wall time is at least the instant-fail wall threshold AND
 * a pending step exists for the agent AND the round exited nonzero OR died by
 * signal. Every other shape returns false:
 *
 *  - operator-paused rounds (paused_by_operator recovery class),
 *  - timed-out rounds (ceiling-expiry / WLST5 class),
 *  - claimed-then-died rounds (`recoveredOrphans` — the worker_lost class),
 *  - sub-threshold rounds (the fast instant-fail class),
 *  - clean exits (exit 0) and rounds whose harness never resolved an exit
 *    code or signal (e.g. adapter-throw launch failures).
 *
 * `hasPendingStep` is supplied by the caller from a DB lookup, so this stays a
 * pure, cheap predicate.
 */
export function isPreclaimDeathRound(signals: PreclaimDeathSignals): boolean {
  if (signals.operatorPaused) return false; // operator pause — not a worker death
  if (signals.timedOut) return false; // ceiling-expiry class — WLST5 handles it
  if (signals.recoveredOrphans) return false; // claimed step — worker_lost class
  const wallMs = resolveHarnessWallMs({
    harnessWallMs: signals.harnessWallMs,
    roundWallMs: signals.wallMs,
  });
  if (wallMs === undefined) return false; // no duration signal — cannot classify
  if (wallMs < getInstantFailWallThresholdMs()) return false; // fast round — instant-fail class
  if (!signals.hasPendingStep) return false; // no unclaimed work to die before
  const exitCode = signals.exitCode;
  if (exitCode !== null && exitCode !== undefined && exitCode !== 0) return true;
  if ((exitCode === null || exitCode === undefined) && signals.signal) return true;
  return false;
}

// ── Backoff ───────────────────────────────────────────────────────────

/**
 * Escalating relaunch delay (ms) once the streak reaches the backoff
 * threshold K: base at K, 2×base at K+1, 4×base at K+2 and beyond.
 * Returns 0 below K (no backoff).
 */
export function instantFailBackoffDelayMs(consecutive: number): number {
  const k = getInstantFailBackoffThreshold();
  const excess = consecutive - k;
  if (excess < 0) return 0;
  const multiplier = 1 << Math.min(excess, 2);
  return getInstantFailBackoffBaseMs() * multiplier;
}

/**
 * The precise force-fail reason for an escalated instant-fail loop.
 * Shape matches the RSPN evidence: "worker instant-fail loop: N
 * consecutive sub-6s exit-1 rounds; last command: …".
 */
export function formatInstantFailReason(consecutive: number, lastCommand?: string): string {
  const seconds = Math.round(getInstantFailWallThresholdMs() / 1000);
  return `worker instant-fail loop: ${consecutive} consecutive sub-${seconds}s exit-1 rounds; last command: ${lastCommand ?? "unknown"}`;
}

/**
 * The precise force-fail reason for an escalated pre-claim death loop
 * (OUTAGE-ROUNDS SCLS US-005). Distinct from {@link formatInstantFailReason}:
 * a pre-claim death is the SLOW complement of an instant fail — the harness
 * ran at least the wall threshold and then exited nonzero / died by signal
 * WITHOUT claiming a step — so the reason names that shape explicitly. The
 * `>=Ns` label derives from the same wall threshold as the predicate.
 */
export function formatPreclaimDeathReason(consecutive: number, lastCommand?: string): string {
  const seconds = Math.round(getInstantFailWallThresholdMs() / 1000);
  return `worker pre-claim death loop: ${consecutive} consecutive >=${seconds}s rounds that exited/died without claiming a step; last command: ${lastCommand ?? "unknown"}`;
}
