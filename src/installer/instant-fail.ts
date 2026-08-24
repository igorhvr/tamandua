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
 * zero output + nonzero exit), the consecutive-streak thresholds (K for
 * backoff, N for escalation), and the escalating relaunch delay, so the
 * scheduler, status surfacing, and tests all agree on the policy.
 *
 * Classification is deliberately narrow: legitimate short rounds (idle
 * checks, no-op verifies) exit 0 and/or produce output, so they never
 * match. Timed-out rounds belong to the ceiling-expiry class (WLST5) and
 * are never classified here.
 */

import type { HarnessRoundResult } from "./harness-adapter.js";

// ── Defaults (conservative) ──────────────────────────────────────────

/**
 * Wall-clock threshold (ms) below which a round may be classified as an
 * instant fail. Default 2s. A round that produced output or exited 0
 * never matches regardless of duration.
 */
export const DEFAULT_INSTANT_FAIL_WALL_THRESHOLD_MS = 2_000;

/**
 * Consecutive instant-fail rounds (K) after which the motor applies an
 * escalating delay between relaunches instead of the fixed 15s tick.
 */
export const DEFAULT_INSTANT_FAIL_BACKOFF_THRESHOLD = 3;

/**
 * Consecutive instant-fail rounds (N) after which the run is force-failed
 * through the sanctioned forceFailRun path with a precise reason.
 */
export const DEFAULT_INSTANT_FAIL_ESCALATION_THRESHOLD = 10;

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
   * (Date.now() - roundStartMs) on adapter-throw rounds. Absent when there
   * is no duration signal — classification is impossible and the round is
   * left alone.
   */
  wallMs?: number;
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
 * Conservatively classify a round as an instant fail:
 * wall time below the threshold AND zero output bytes AND nonzero exit
 * code. Rounds that exit 0 (idle/no-op verifies) or produce any output
 * never match; timed-out rounds (ceiling-expiry class) never match; and
 * rounds whose worker had claimed a step before dying (recoveredOrphans)
 * never match — those are worker_lost, not instant-fail.
 */
export function isInstantFailRound(signals: InstantFailRoundSignals): boolean {
  const { wallMs } = signals;
  if (wallMs === undefined) return false; // no duration signal — cannot classify
  if (wallMs >= getInstantFailWallThresholdMs()) return false; // slow round — not instant
  if (signals.result?.timedOut) return false; // ceiling-expiry class — never instant-fail
  if (signals.recoveredOrphans) return false; // claimed step — worker_lost class
  if (signals.adapterThrew) return true; // launch failure: zero output, no clean exit
  const result = signals.result;
  if (!result) return false;
  const outputBytes = Buffer.byteLength(result.output, "utf-8");
  const exitCode = result.exitCode;
  return (
    outputBytes === 0 &&
    exitCode !== null &&
    exitCode !== undefined &&
    exitCode !== 0
  );
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
 * consecutive sub-2s exit-1 rounds; last command: …".
 */
export function formatInstantFailReason(consecutive: number, lastCommand?: string): string {
  const seconds = Math.round(getInstantFailWallThresholdMs() / 1000);
  return `worker instant-fail loop: ${consecutive} consecutive sub-${seconds}s exit-1 rounds; last command: ${lastCommand ?? "unknown"}`;
}
