/**
 * Secret redaction for diagnostics bundles (DIAG-PRUNE US-001).
 *
 * Diagnostics bundles may embed host-owned JSON (a run's persisted Matchlock
 * policy/mount plan, VM runner error records, session metadata). Some of those
 * documents carry credential-shaped fields, so every object written into a
 * bundle is passed through {@link redactSecrets} first.
 *
 * The redactor is deliberately pure and total:
 *  - it never throws, on any input (primitives, arrays, deep nesting, real
 *    object cycles);
 *  - it preserves the shape of the input (array lengths, object keys);
 *  - only the VALUE of a secret-looking key is replaced, with the literal
 *    string `"<redacted>"`.
 *
 * A key is secret-looking when it matches
 * `/token|secret|password|api[-_]?key|authorization|credential/i`.
 */

/** The literal written in place of a secret value. */
export const REDACTED_VALUE = "<redacted>";

/** Replacement used when a real object cycle is encountered. */
export const CIRCULAR_VALUE = "[circular]";

/**
 * Bounded recursion: a document nested deeper than this is copied only down
 * to this depth (deeper levels are returned as-is). Combined with the cycle
 * guard this makes the walk provably terminating even on adversarial input.
 */
export const MAX_REDACT_DEPTH = 64;

const SECRET_KEY_RE = /token|secret|password|api[-_]?key|authorization|credential/i;

/** True when a key name looks like it holds a credential. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/** Plain JSON-ish objects only; Dates/Buffers/class instances are left intact. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively redact secret-looking keys from `value`.
 *
 * Non-object inputs (and non-plain objects such as `Date`/`Buffer`) are
 * returned unchanged. Arrays keep their length and item order. A key whose
 * value is an object or an array is redacted to the literal as well — the
 * whole subtree is dropped, not just a nested leaf.
 */
export function redactSecrets(value: unknown): unknown {
  const seen = new WeakSet<object>();
  return redactValue(value, 0, seen);
}

function redactValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value !== "object") return value;

  // Bounded recursion: never walk deeper than MAX_REDACT_DEPTH.
  if (depth >= MAX_REDACT_DEPTH) return value;

  if (seen.has(value)) return CIRCULAR_VALUE;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  if (!isPlainObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key)
      ? REDACTED_VALUE
      : redactValue(item, depth + 1, seen);
  }
  return out;
}