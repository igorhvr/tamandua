/**
 * TSTX Configuration — single source of truth for all tunables.
 *
 * Lightweight module with zero heavy imports — safe for fast shim startup.
 * All time-based constants are in milliseconds.
 */

// ── Cache policy tunables ─────────────────────────────────────────────

/** 24 hours — a green result is valid for replay within this window. */
export const TTL_GREEN_MS = 24 * 60 * 60 * 1000;

/** 15 minutes — show a context note when re-executing after a recent red. */
export const RED_CONTEXT_WINDOW_MS = 15 * 60 * 1000;

/** 24 hours — window for counting pass/fail to detect flaky suites. */
export const FLAKE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 14 days — suite_results rows older than this are pruned. */
export const LEDGER_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

// ── Operational tunables ──────────────────────────────────────────────

/** Maximum KB of combined output to store in log_tail. */
export const LOG_TAIL_KB = 20;

/** 30 minutes — single-flight claim timeout. */
export const CLAIM_TIMEOUT_MS = 30 * 60 * 1000;

// ── Kill switch ───────────────────────────────────────────────────────

/** TAMANDUA_TSTX=0 disables caching entirely (full passthrough everywhere). */
export function isTstxEnabled(): boolean {
  return process.env.TAMANDUA_TSTX !== "0";
}
