/**
 * Instant storage format — the ONE format for every instant Tamandua writes
 * to durable storage.
 *
 * Storage format: ISO-8601 UTC with milliseconds and a `Z` suffix, e.g.
 * `2026-09-15T22:00:00.123Z`. This module owns the writer half of the
 * contract:
 *
 *   - `nowIso()` for instants produced in JavaScript.
 *   - `SQL_NOW_ISO` for instants produced inside SQL statements (replacing
 *     the old naive `datetime('now')`, which wrote `YYYY-MM-DD HH:MM:SS`
 *     with no `Z` and no milliseconds).
 *   - `formatInstant()` for instants SERIALIZED out of the process (log
 *     lines, events, reports, CLI/human output), always ISO-8601 UTC with an
 *     explicit `Z` so any consumer can relocalize.
 *
 * Readers must use the shared `parseInstant()` (added with the reader half of
 * the contract) so legacy naive values are interpreted as UTC — never as
 * host-local time — and so invalid input surfaces as `undefined` rather than
 * `NaN`, `0`, or a fabricated "now".
 */

/**
 * Returns the current instant as an ISO-8601 UTC string with milliseconds and
 * a `Z` suffix, exactly matching `YYYY-MM-DDTHH:MM:SS.sssZ`.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * SQLite expression that evaluates to the current instant in the canonical
 * storage format. Use it in place of `datetime('now')` inside INSERT/UPDATE
 * statements (interpolate it into backtick template literals):
 *
 * ```ts
 * db.prepare(`UPDATE runs SET updated_at = ${SQL_NOW_ISO} WHERE id = ?`);
 * ```
 *
 * It must remain a plain string constant so it can be interpolated into
 * statements and asserted literally by tests.
 */
export const SQL_NOW_ISO = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/**
 * Legacy naive UTC shape: `YYYY-MM-DD HH:MM:SS` (space separator, as written by
 * SQLite's `datetime('now')`) or `YYYY-MM-DDTHH:MM:SS`, with optional
 * fractional seconds, and NO zone designator. Historically these were written
 * as UTC but must never be interpreted with the host-local offset.
 */
const NAIVE_UTC_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/**
 * ISO-8601 instant WITH an explicit zone designator: either `Z` (UTC, written
 * by `Date#toISOString()` / `SQL_NOW_ISO`) or a real numeric offset such as
 * `+03:00` / `-03:00`. Fractional seconds are optional.
 */
const ZONED_ISO_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/**
 * The ONE reader for stored instants. Turns any instant shape Tamandua has
 * ever persisted into a `Date` representing the correct UTC instant, or
 * `undefined` when the value cannot be understood.
 *
 * Accepted:
 *   - canonical ISO-8601 UTC with `Z`, with or without milliseconds
 *     (`2026-09-15T22:00:00.123Z`, `2026-09-15T22:00:00Z`);
 *   - ISO-8601 with a real numeric offset (`2026-09-15T22:00:00+03:00`);
 *   - legacy naive UTC (`2026-09-15 22:00:00`, `2026-09-15T22:00:00`,
 *     optionally with fractional seconds) — ALWAYS interpreted as UTC, never as
 *     host-local time.
 *
 * Rejected (returns `undefined`, never `NaN`, `0`, an Invalid Date, or a
 * fabricated "now"): empty/missing values, non-strings (including `Date` and
 * numbers), date-only strings, and anything unparseable. Callers that need a
 * fallback must handle `undefined` explicitly.
 */
export function parseInstant(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;

  const raw = value.trim();
  if (raw === "") return undefined;

  // Legacy naive form: it carries no zone, so pin it to UTC explicitly. Feeding
  // it straight to Date would make JS apply the host-local offset.
  if (NAIVE_UTC_RE.test(raw)) {
    const parsed = new Date(`${raw.replace(" ", "T")}Z`);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  // ISO form with an explicit zone: Date already honors Z and real offsets.
  if (ZONED_ISO_RE.test(raw)) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  return undefined;
}

/** Output style for {@link formatInstant}. */
export type InstantStyle = "iso" | "log";

/**
 * The ONE serializer for instants that leave the process (log prefixes,
 * `tamandua logs`/`logs-tail`, workflow status/wait/run output, event/report
 * and contract writers). Always emits ISO-8601 UTC with an explicit `Z`, so a
 * serialized instant is unambiguous and can be relocalized by any consumer.
 *
 * Accepted input:
 *   - a `Date` is used directly (an Invalid Date is rejected);
 *   - a string is routed through {@link parseInstant}, so canonical ISO-Z,
 *     real numeric offsets, and legacy naive UTC (pinned to UTC) all work.
 *
 * Everything else — missing/empty, unparseable strings, `null`, `undefined`,
 * booleans, numbers — yields `undefined`, never `NaN`, an Invalid Date, or a
 * fabricated "now". Callers that need a fallback must handle `undefined`
 * explicitly.
 *
 * Styles:
 *   - `"iso"` (default): `YYYY-MM-DDTHH:MM:SS.sssZ` (the Date#toISOString
 *     shape), for JSON and machine consumers.
 *   - `"log"`: `YYYY-MM-DD HH:MM:SSZ` (space separator, seconds precision,
 *     explicit `Z`), the compact shape for human log lines.
 */
export function formatInstant(
  value: Date | string | null | undefined,
  opts?: { style?: InstantStyle },
): string | undefined {
  const date = toValidInstant(value);
  if (date === undefined) return undefined;

  if (opts?.style === "log") {
    const iso = date.toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z`;
  }
  return date.toISOString();
}

/**
 * Coerce an already-acquired value into a valid `Date`, or `undefined`.
 * `parseInstant` deliberately rejects `Date`, so `Date` inputs (the live
 * `nowIso()` case) are handled here before delegating.
 */
function toValidInstant(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }
  return parseInstant(value);
}
