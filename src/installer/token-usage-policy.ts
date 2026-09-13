/**
 * Shared per-call token accounting policy for every harness (pi, hermes, dsh).
 *
 * Billable tokens for one API call = `input + output + cache_write`.
 * `cache_read` is deliberately EXCLUDED:
 *
 *   - pi reports `cacheRead` inside `totalTokens`; on a single real call it
 *     was 12,416 of 12,663 total tokens.
 *   - hermes re-reads the whole context from cache on every API call, which
 *     inflates cache_read totals 10–30×.
 *   - dsh records `cacheReadTokens` alongside uncached `inputTokens`.
 *
 * Counting cache reads made cross-harness totals incomparable and made pi the
 * odd one out (tamandua-6sy.52). Every harness now derives its per-call total
 * from this one function so the policy cannot drift again.
 *
 * Missing components count as 0; negative and non-finite values are clamped
 * to 0; the result is rounded to an integer.
 */

/** Raw components of one API call under the shared harness token policy. */
export interface TokenComponents {
  /** Uncached input (prompt) tokens. */
  input?: unknown;
  /** Output (completion) tokens. */
  output?: unknown;
  /** Cache-write tokens. dsh does not expose this component, so it is omitted. */
  cacheWrite?: unknown;
}

/** Non-negative finite number, or 0 for anything else. */
export function toNonNegativeTokenComponent(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

/**
 * Shared per-call token total (see the module doc). This is the single
 * definition pi, hermes and dsh all route through.
 */
export function sumBillableTokens(components: TokenComponents): number {
  const total =
    toNonNegativeTokenComponent(components.input) +
    toNonNegativeTokenComponent(components.output) +
    toNonNegativeTokenComponent(components.cacheWrite);
  return Math.max(0, Math.round(total));
}
