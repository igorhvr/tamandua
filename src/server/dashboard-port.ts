/**
 * Dashboard standalone port resolution — single source of truth.
 *
 * The standalone dashboard server entry (dashboard-standalone.ts) and the CLI
 * commands that start it (get-ready.ts) must agree on how
 * TAMANDUA_DASHBOARD_PORT maps to a real listening port, or get-ready would
 * ignore the env override while the standalone honors it (WAVE-A.1 US-007).
 *
 * dashboard-standalone.ts layers an optional CLI-argument tier above this
 * resolver; the tiers shared by every consumer are:
 *   1. TAMANDUA_DASHBOARD_PORT env var — parsed as a base-10 integer; a valid
 *      port is 1..65535.
 *   2. Default 3334.
 */
export const DEFAULT_DASHBOARD_PORT = 3334;

/**
 * Resolve a dashboard port from a TAMANDUA_DASHBOARD_PORT-style raw value.
 *
 * Accepts only a base-10 integer in 1..65535 (parseInt semantics, matching
 * dashboard-standalone.ts's historical env parsing). Unset, empty,
 * non-numeric, zero/negative, and out-of-range values all fall back to
 * `fallback` (default: DEFAULT_DASHBOARD_PORT).
 */
export function resolveDashboardPort(
  raw: string | undefined,
  fallback: number = DEFAULT_DASHBOARD_PORT,
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
    return parsed;
  }
  return fallback;
}
