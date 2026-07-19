/**
 * Typed-ID prefix utilities.
 *
 * Ids are stored as bare UUIDs in the DB. Prefixes `run-` and `step-`
 * are a presentation/parsing concern only: emitted on output, stripped
 * on input so callers can pipe prefixed ids directly into commands.
 */

const RUN_PREFIX = "run-" as const;
const STEP_PREFIX = "step-" as const;

type IdKind = "run" | "step";

/** Wrap a bare UUID into a run-prefixed id. */
export function prefixRunId(uuid: string): string {
  return `${RUN_PREFIX}${uuid}`;
}

/** Wrap a bare UUID into a step-prefixed id. */
export function prefixStepId(uuid: string): string {
  return `${STEP_PREFIX}${uuid}`;
}

/**
 * Strip a leading `run-` or `step-` prefix.
 * If the input is already a bare UUID (no recognized prefix) it is
 * returned unchanged.
 */
export function stripIdPrefix(id: string): string {
  if (id.startsWith(RUN_PREFIX)) return id.slice(RUN_PREFIX.length);
  if (id.startsWith(STEP_PREFIX)) return id.slice(STEP_PREFIX.length);
  return id;
}

/** True when the id starts with `run-`. */
export function isRunPrefixed(id: string): boolean {
  return id.startsWith(RUN_PREFIX);
}

/** True when the id starts with `step-`. */
export function isStepPrefixed(id: string): boolean {
  return id.startsWith(STEP_PREFIX);
}

/**
 * If `id` has the WRONG prefix for `expectedKind`, return an
 * error message string.  Bare UUIDs (no recognized prefix) return
 * `null` — they are not wrong-prefix, they are just ambiguous.
 */
export function detectWrongPrefix(
  id: string,
  expectedKind: IdKind,
): string | null {
  if (expectedKind === "run" && isStepPrefixed(id)) {
    return `that is a step id, not a run id — ${id}`;
  }
  if (expectedKind === "step" && isRunPrefixed(id)) {
    return `that is a run id, not a step id — step complete needs the stepId from your claim JSON (got ${id})`;
  }
  return null;
}
