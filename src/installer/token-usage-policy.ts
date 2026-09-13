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

// ── Usage-object extraction (field aliasing + aggregate fallback) ──
//
// The pi round parser (agent-scheduler `extractTokenUsage`) and the
// real-canary session-store audit (`auditPiSessionFile`) must derive the SAME
// per-call number from the SAME usage object, or a tolerance-0 reconciliation
// can disagree with a correct attribution. The field aliasing and the
// aggregate fallback therefore live here, next to `sumBillableTokens`, and
// both callers route through `extractPerCallTokenTotal`.

/** Input-token field aliases across harness versions. */
const INPUT_TOKEN_KEYS = ["input", "inputTokens", "input_tokens", "prompt_tokens"];
/** Output-token field aliases across harness versions. */
const OUTPUT_TOKEN_KEYS = ["output", "outputTokens", "output_tokens", "completion_tokens"];
/** Cache-write-token field aliases. dsh exposes no cache-write component. */
const CACHE_WRITE_TOKEN_KEYS = ["cacheWrite", "cache_write", "cache_write_tokens"];
/** Cache-INCLUSIVE aggregate aliases; used only when no component is present. */
const TOTAL_TOKEN_KEYS = ["totalTokens", "total_tokens", "total"];

function asUsageRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Finite number or numeric string, else null (non-finite is not a token count). */
function parseTokenNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstTokenNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const parsed = parseTokenNumber(record[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * Extract one API call's billable total from a harness usage object
 * (`message.usage` for pi, or any object with the same component fields).
 *
 * This is the shared extractor used by BOTH the pi round parser and the
 * real-canary session-store audit, so the two cannot drift:
 *
 *   - Component field aliases (camelCase pi, snake_case variants) are
 *     resolved here; `cache_read` is never read (see the module doc).
 *   - When at least one component field is present, the total is
 *     `sumBillableTokens({ input, output, cacheWrite })`.
 *   - When NO component field is present but an aggregate total is, return
 *     that total for the call rather than fabricating zero. Such a total is
 *     cache-inclusive for pi, but nothing finer is available for that call.
 *
 * @returns the per-call billable total, or `null` when the object carries no
 *          recognizable usage field at all.
 */
export function extractPerCallTokenTotal(usageLike: unknown): number | null {
  const usage = asUsageRecord(usageLike);
  if (!usage) return null;

  const input = firstTokenNumber(usage, INPUT_TOKEN_KEYS);
  const output = firstTokenNumber(usage, OUTPUT_TOKEN_KEYS);
  const cacheWrite = firstTokenNumber(usage, CACHE_WRITE_TOKEN_KEYS);

  // cache_read is intentionally not read here: the shared policy excludes it.
  if (input !== null || output !== null || cacheWrite !== null) {
    return sumBillableTokens({ input, output, cacheWrite });
  }

  const directTotal = firstTokenNumber(usage, TOTAL_TOKEN_KEYS);
  return directTotal !== null ? Math.max(0, Math.round(directTotal)) : null;
}
