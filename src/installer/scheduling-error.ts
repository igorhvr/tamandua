/**
 * MTLK-ISO2-TRANSITION-CAS (Family C-1): allow-listed classification of the
 * stored `runs.scheduling_error` text for operator surfaces.
 *
 * `scheduling_error` is a free-form persisted column. Legitimate producers
 * write a small, bounded set of phrases (the WORKDIR-QUEUE wait text and the
 * capacity/admission refusal); legacy builds could also persist the RAW
 * message of a Matchlock policy parser failure, which can embed fragments of
 * the stored input (a version sentinel, an unknown field name, a JSON parse
 * snippet). Those operator surfaces (status JSON, `workflow status --json`,
 * the text status list and `workflow status`) must never echo arbitrary
 * stored text: they re-render only allow-listed phrases and DROP anything
 * else. Dropping is fail-closed — a reader shows no reason rather than a
 * leaked fragment; the typed `matchlockPolicyError` field carries the
 * sanitized policy classification where relevant.
 */

/** The WORKDIR-QUEUE wait phrase written by `admitOrQueueRun`. */
const WORKDIR_WAIT_RE = /^waiting for harness workdir held by run (\S+): ([\s\S]+)$/;

/** The capacity/admission refusal written by `admitOrQueueRun`. */
const CAPACITY_REFUSAL_RE =
  /^Run requires \d+ scheduler timer\(s\), but TAMANDUA_MAX_ACTIVE_TIMERS is \d+\.$/;

/**
 * The run-harness admission refusal for an unusable policy. The producer
 * (`validateRunHarnessForScheduling`) renders it from the typed parser CATEGORY
 * only — it never embeds the raw parser message — so the shape itself is
 * allow-listed (the `code` capture is a bounded `policy_*` identifier).
 */
const POLICY_UNUSABLE_REFUSAL_RE =
  /^stored Matchlock policy is present but unusable \(policy_[a-z_]+\); refusing to treat the run as native$/;

/**
 * Classify a stored scheduling error and return the text an operator surface
 * may render, or `null` when the stored value is not an allow-listed phrase.
 *
 * - A WORKDIR-QUEUE wait (`scheduling_status === "waiting"`) is re-rendered
 *   from its two bounded captures, never returned as an opaque string.
 * - A capacity/admission refusal (numbers only) is allow-listed verbatim.
 * - Everything else — including any legacy parser message — is dropped.
 */
export function sanitizeSchedulingError(
  schedulingStatus: string | null | undefined,
  schedulingError: string | null | undefined,
): string | null {
  if (typeof schedulingError !== "string" || schedulingError.length === 0) return null;
  if (schedulingStatus === "waiting") {
    const match = WORKDIR_WAIT_RE.exec(schedulingError);
    if (match) {
      return `waiting for harness workdir held by run ${match[1]}: ${match[2]}`;
    }
  }
  if (CAPACITY_REFUSAL_RE.test(schedulingError)) return schedulingError;
  if (POLICY_UNUSABLE_REFUSAL_RE.test(schedulingError)) return schedulingError;
  return null;
}
