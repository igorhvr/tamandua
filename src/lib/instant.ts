/**
 * Time contract — instants, monotonic intervals, and durable staleness.
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ THE ONE RULE                                                           │
 * │                                                                        │
 * │ 1. In-process intervals and deadlines (retry backoff, elapsed/remaining│
 * │    wall budgets, wait loops, cache TTLs) MUST use the monotonic clock  │
 * │    — `monotonicNow()` / `Stopwatch` / `Deadline` — and NEVER a         │
 * │    difference of `Date.now()` values. A wall-clock jump (NTP step,     │
 * │    suspend/resume) must not produce negative, inflated, or premature   │
 * │    results.                                                            │
 * │                                                                        │
 * │ 2. Values that must survive a restart (claim leases, staleness         │
 * │    thresholds, recovery windows, reconciler cutoffs) are stored as     │
 * │    UTC ISO-8601 `...Z` instants via `nowIso()` / `SQL_NOW_ISO`, read   │
 * │    via `parseInstant()`, and compared NUMERICALLY via `instantAgeMs()` │
 * │    / `isOlderThan()` — never as string comparisons. Each call site     │
 * │    documents the explicit tolerance it passes.                         │
 * │                                                                        │
 * │ 3. File-mtime provenance (daemon pidfile / start lock, dsh session     │
 * │    "created since spawn") keeps OS-epoch semantics, but the age /      │
 * │    since-threshold decisions still route through `instantAgeMs()` /    │
 * │    `isOlderThan()` with the same documented-tolerance discipline.      │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Instant storage format: ISO-8601 UTC with milliseconds and a `Z` suffix,
 * e.g. `2026-09-15T22:00:00.123Z`. This module owns the writer half of the
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
 *
 * The monotonic and durable-staleness helpers (`monotonicNow`, `Stopwatch`,
 * `Deadline`, `instantAgeMs`, `isOlderThan`) added by TIME-CLOCKS US-001 live
 * below. The storage writer/reader functions above them are unchanged.
 */

import { performance } from "node:perf_hooks";

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

// ─────────────────────────────────────────────────────────────────────────────
// Monotonic clock (rule 1) — in-process intervals and deadlines
// ─────────────────────────────────────────────────────────────────────────────

/** A clock function returning milliseconds for the interval/deadline helpers. */
export type ClockFn = () => number;

/**
 * The monotonic clock for every in-process interval/deadline (rule 1).
 *
 * Backed by `performance.now()`: it advances at real elapsed time and is
 * unaffected by wall-clock jumps (NTP steps, suspend/resume), so it can never
 * go backwards and cannot inflate or shrink a measured interval. The value is
 * an opaque millisecond count (relative to an arbitrary origin) — NEVER
 * persist it, NEVER mix it with `Date.now()`/epoch milliseconds, and never use
 * it to label a durable instant (use `nowIso()` for that).
 */
export function monotonicNow(): number {
  return performance.now();
}

/**
 * A monotonic stopwatch for measuring an in-process interval.
 *
 * Constructed already running; `restart()` (alias `start()`) resets the origin
 * to "now". `elapsedMs()` is always `clock() - origin`, so under the default
 * `monotonicNow` clock a backward wall-clock jump can never make elapsed time
 * negative and a forward jump can never inflate it.
 *
 * Inject a clock (`new Stopwatch(() => fakeMs)`) in tests to simulate hostile
 * wall movement deterministically; production call sites omit the argument.
 */
export class Stopwatch {
  private readonly clock: ClockFn;
  private originMs: number;

  constructor(clock: ClockFn = monotonicNow) {
    this.clock = clock;
    this.originMs = clock();
  }

  /** Restarts the stopwatch from "now" and returns it for chaining. */
  start(): this {
    this.originMs = this.clock();
    return this;
  }

  /** Alias of `start()` — resets the origin to "now". */
  restart(): this {
    return this.start();
  }

  /** Milliseconds elapsed since the origin (never negative for a monotonic clock). */
  elapsedMs(): number {
    return this.clock() - this.originMs;
  }
}

/**
 * A monotonic deadline for enforcing an in-process budget.
 *
 * Constructed with a budget in milliseconds; `remainingMs()` is
 * `budgetMs - elapsed` and may be negative once the budget is exhausted, while
 * `expired()` is `remainingMs() <= 0`. Built on the same injectable clock as
 * `Stopwatch` (default `monotonicNow`), so a wall-clock jump cannot make a
 * wait return prematurely or hang past its timeout.
 */
export class Deadline {
  private readonly clock: ClockFn;
  private readonly budgetMs: number;
  private readonly originMs: number;

  constructor(budgetMs: number, clock: ClockFn = monotonicNow) {
    this.clock = clock;
    this.budgetMs = budgetMs;
    this.originMs = clock();
  }

  /** Milliseconds elapsed since the deadline was created. */
  elapsedMs(): number {
    return this.clock() - this.originMs;
  }

  /** Milliseconds left in the budget; negative once the budget is exhausted. */
  remainingMs(): number {
    return this.budgetMs - this.elapsedMs();
  }

  /** True once the budget is exhausted (`remainingMs() <= 0`). */
  expired(): boolean {
    return this.remainingMs() <= 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Durable instants (rules 2 and 3) — ages and staleness, numeric only
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Any instant shape the durable-instant helpers accept: a stored ISO string, a
 * `Date`, or an epoch-millisecond number (used for OS file mtimes under
 * rule 3). `null`/`undefined` are accepted only so callers can pass a possibly
 * missing field straight through — they yield `undefined`, never a fabricated
 * age.
 */
export type InstantInput = string | number | Date | null | undefined;

/**
 * Normalizes any accepted instant shape to epoch milliseconds, or `undefined`
 * when it cannot be understood. Strings go through `parseInstant()` so the
 * legacy naive-UTC rule applies; numbers and `Date`s must be finite.
 */
function toEpochMs(instant: InstantInput): number | undefined {
  if (instant instanceof Date) {
    const ms = instant.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (typeof instant === "number") {
    return Number.isFinite(instant) ? instant : undefined;
  }
  const parsed = parseInstant(instant);
  return parsed === undefined ? undefined : parsed.getTime();
}

/**
 * Age in milliseconds of a durable instant relative to `nowMs` (default
 * `Date.now()`), computed numerically — NEVER as a string comparison (rule 2).
 *
 * Returns `undefined` for an unparseable, missing, `NaN`, or `Infinity`
 * instant, or a non-finite `nowMs`. It never fabricates an age: callers that
 * need a fallback must handle `undefined` explicitly. A future instant yields a
 * negative age (informative, not clamped); call sites that need a non-negative
 * value clamp explicitly.
 *
 * `nowMs` is a wall epoch instant because the value being aged is durable;
 * in-process intervals must NOT be measured this way (use `Stopwatch`).
 */
export function instantAgeMs(
  instant: InstantInput,
  nowMs: number = Date.now(),
): number | undefined {
  const epochMs = toEpochMs(instant);
  if (epochMs === undefined) return undefined;
  if (!Number.isFinite(nowMs)) return undefined;
  return nowMs - epochMs;
}

/**
 * True when a durable instant is strictly older than `maxAgeMs` (plus an
 * optional `toleranceMs` of slack), computed numerically (rule 2/3).
 *
 * An unparseable/missing/`NaN` instant returns `false` — the SAFE default: we
 * never treat an unknown instant as stale and so never fabricate a recovery or
 * expiration.
 *
 * `toleranceMs` is the explicit per-call-site slack for clock skew and coarse
 * mtime granularity; it widens the window (`maxAgeMs + toleranceMs`) so an
 * instant just past the bare threshold is not considered old. Call sites MUST
 * document why they pass the tolerance they pass. The comparison is strict
 * (`age > maxAgeMs + toleranceMs`), so an instant exactly at the threshold is
 * NOT older.
 */
export function isOlderThan(
  instant: InstantInput,
  maxAgeMs: number,
  nowMs: number = Date.now(),
  toleranceMs = 0,
): boolean {
  const age = instantAgeMs(instant, nowMs);
  if (age === undefined) return false;
  return age > maxAgeMs + toleranceMs;
}
