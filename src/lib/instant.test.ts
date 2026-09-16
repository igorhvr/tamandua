/**
 * TIME-CLOCKS US-001 — unit tests for the shared clock helpers in
 * `src/lib/instant.ts`.
 *
 * Covers:
 *   - `monotonicNow()` backed by `performance.now()`;
 *   - `Stopwatch` / `Deadline` with an injected clock, including backward and
 *     forward wall-clock jumps (monotonic elapsed/remaining are unaffected);
 *   - `instantAgeMs` / `isOlderThan` for ISO strings, `Date`, and epoch-ms
 *     input, injected `nowMs`, tolerance boundaries, and unparseable input
 *     (safe `undefined` / `false`, never a fabricated age);
 *   - the writer/reader storage contract (`nowIso` / `SQL_NOW_ISO` /
 *     `parseInstant`) staying unchanged.
 *
 * Pure (no child_process, temp files, daemon, or model) — stays in the
 * parallel lane.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  Deadline,
  Stopwatch,
  instantAgeMs,
  isOlderThan,
  monotonicNow,
  nowIso,
  parseInstant,
  SQL_NOW_ISO,
  type ClockFn,
} from "../../dist/lib/instant.js";

const NOW = Date.UTC(2026, 8, 15, 22, 0, 0); // 2026-09-15T22:00:00.000Z
const ISO = "2026-09-15T22:00:00.000Z";

describe("monotonicNow", () => {
  it("is exported as a function returning a finite millisecond number", () => {
    assert.equal(typeof monotonicNow, "function");
    const t = monotonicNow();
    assert.equal(typeof t, "number");
    assert.ok(Number.isFinite(t), `expected finite monotonic value, got ${t}`);
  });

  it("advances with performance.now() and never goes backwards", () => {
    const beforePerf = performance.now();
    const beforeMono = monotonicNow();
    const afterPerf = performance.now();
    const afterMono = monotonicNow();

    assert.ok(beforeMono >= beforePerf - 1, "monotonicNow must track performance.now()");
    assert.ok(beforeMono <= afterPerf + 1, "monotonicNow must track performance.now()");
    assert.ok(afterMono >= beforeMono, "monotonicNow must be non-decreasing");
  });

  it("does not return a wall epoch millisecond (it is an opaque origin)", () => {
    // performance.now() is relative to process start, far below Date.now()'s
    // epoch unless the process has run for > 50 years.
    assert.ok(monotonicNow() < Date.now());
  });
});

describe("Stopwatch", () => {
  it("measures elapsed time from an injected clock", () => {
    let now = 1_000;
    const clock: ClockFn = () => now;
    const sw = new Stopwatch(clock);

    assert.equal(sw.elapsedMs(), 0);
    now = 1_250;
    assert.equal(sw.elapsedMs(), 250);
    now = 9_999;
    assert.equal(sw.elapsedMs(), 8_999);
  });

  it("supports start() and restart() resetting the origin", () => {
    let now = 100;
    const sw = new Stopwatch(() => now);

    now = 400;
    assert.equal(sw.elapsedMs(), 300);
    sw.restart();
    assert.equal(sw.elapsedMs(), 0);
    now = 550;
    assert.equal(sw.elapsedMs(), 150);

    sw.start();
    assert.equal(sw.elapsedMs(), 0);
    now = 700;
    assert.equal(sw.elapsedMs(), 150);
  });

  it("is unaffected by a backward wall-clock jump", () => {
    // The stopwatch is driven by the monotonic clock; the wall clock jumps
    // backwards by an hour mid-interval.
    let mono = 10_000;
    let wall = 1_000_000;
    const sw = new Stopwatch(() => mono);

    mono += 500;
    wall -= 3_600_000; // NTP steps the wall clock back one hour
    assert.equal(sw.elapsedMs(), 500, "monotonic elapsed must ignore the wall jump");
    assert.ok(sw.elapsedMs() >= 0, "elapsed must never go negative");
  });

  it("is unaffected by a forward wall-clock jump", () => {
    let mono = 10_000;
    let wall = 1_000_000;
    const sw = new Stopwatch(() => mono);

    mono += 250;
    wall += 3_600_000; // suspend/resume advances the wall clock one hour
    assert.equal(sw.elapsedMs(), 250, "monotonic elapsed must not be inflated");
  });

  it("defaults to the monotonic clock in production", () => {
    const sw = new Stopwatch();
    const a = sw.elapsedMs();
    const b = sw.elapsedMs();
    assert.ok(a >= 0 && b >= a, `elapsed must be non-negative and non-decreasing: ${a}, ${b}`);
  });
});

describe("Deadline", () => {
  it("reports remaining and expiration against an injected clock", () => {
    let now = 0;
    const deadline = new Deadline(1_000, () => now);

    assert.equal(deadline.remainingMs(), 1_000);
    assert.equal(deadline.expired(), false);

    now = 999;
    assert.equal(deadline.remainingMs(), 1);
    assert.equal(deadline.expired(), false);

    now = 1_000;
    assert.equal(deadline.remainingMs(), 0);
    assert.equal(deadline.expired(), true, "exactly at budget is expired");

    now = 1_500;
    assert.equal(deadline.remainingMs(), -500);
    assert.equal(deadline.expired(), true);
  });

  it("a backward wall-clock jump does not extend the budget", () => {
    let mono = 0;
    let wall = 5_000_000;
    const deadline = new Deadline(1_000, () => mono);

    mono += 900;
    wall -= 3_600_000; // wall jumps back; budget is monotonic
    assert.equal(deadline.remainingMs(), 100);
    assert.equal(deadline.expired(), false);

    mono += 100;
    assert.equal(deadline.expired(), true, "deadline must expire by real elapsed time");
  });

  it("a forward wall-clock jump does not shorten the budget", () => {
    let mono = 0;
    let wall = 5_000_000;
    const deadline = new Deadline(1_000, () => mono);

    mono += 100;
    wall += 3_600_000; // wall jumps forward; budget must be monotonic
    assert.equal(deadline.remainingMs(), 900, "forward wall jump must not consume budget");
    assert.equal(deadline.expired(), false);
  });

  it("defaults to the monotonic clock in production", () => {
    const deadline = new Deadline(60_000);
    assert.equal(deadline.expired(), false);
    assert.ok(deadline.remainingMs() > 0);
    assert.ok(deadline.elapsedMs() >= 0);
  });
});

describe("instantAgeMs", () => {
  it("accepts an ISO string, a Date, and epoch milliseconds", () => {
    assert.equal(instantAgeMs(ISO, NOW), 0);
    assert.equal(instantAgeMs(new Date(NOW), NOW), 0);
    assert.equal(instantAgeMs(NOW, NOW), 0);
  });

  it("parses the legacy naive UTC shape with parseInstant semantics", () => {
    assert.equal(instantAgeMs("2026-09-15 21:00:00", NOW), 3_600_000);
    assert.equal(instantAgeMs("2026-09-15T21:00:00", NOW), 3_600_000);
  });

  it("computes ages numerically (no string comparison) across a forward wall jump", () => {
    const nowLater = NOW + 90_000;
    assert.equal(instantAgeMs(ISO, nowLater), 90_000);
  });

  it("computes a negative age for a future instant without fabricating a value", () => {
    const nowEarlier = NOW - 30_000;
    assert.equal(instantAgeMs(ISO, nowEarlier), -30_000);
  });

  it("returns undefined for unparseable or missing input (never a fabricated age)", () => {
    const bad: unknown[] = [
      undefined,
      null,
      "",
      "   ",
      "not-a-date",
      "2026-09-15",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      new Date(Number.NaN),
      {},
      [],
      true,
    ];
    for (const value of bad) {
      assert.equal(
        instantAgeMs(value as never, NOW),
        undefined,
        `instantAgeMs must return undefined for ${String(value)}`,
      );
    }
  });

  it("returns undefined for a non-finite nowMs", () => {
    assert.equal(instantAgeMs(ISO, Number.NaN), undefined);
    assert.equal(instantAgeMs(ISO, Number.POSITIVE_INFINITY), undefined);
  });

  it("defaults nowMs to the wall clock for durable instants", () => {
    const age = instantAgeMs(nowIso());
    assert.ok(age !== undefined && Math.abs(age) < 5_000, `expected a small age, got ${age}`);
  });
});

describe("isOlderThan", () => {
  it("is false when the instant is at or inside the threshold", () => {
    assert.equal(isOlderThan(ISO, 0, NOW), false);
    assert.equal(isOlderThan(ISO, 1_000, NOW), false);
    assert.equal(isOlderThan(ISO, 0, NOW - 1_000), false, "a future instant is never older");
  });

  it("is true only strictly past the threshold with zero tolerance", () => {
    const justPast = ISO;
    assert.equal(isOlderThan(justPast, 1_000, NOW + 1_000), false, "exactly at threshold");
    assert.equal(isOlderThan(justPast, 1_000, NOW + 1_001), true, "one ms past threshold");
  });

  it("widens the window by the explicit tolerance", () => {
    const tolerance = 50;
    assert.equal(isOlderThan(ISO, 1_000, NOW + 1_000, tolerance), false, "at bare threshold");
    assert.equal(isOlderThan(ISO, 1_000, NOW + 1_050, tolerance), false, "exactly at threshold+tolerance");
    assert.equal(isOlderThan(ISO, 1_000, NOW + 1_051, tolerance), true, "one ms past threshold+tolerance");
    assert.equal(isOlderThan(ISO, 1_000, NOW + 1_040, tolerance), false, "inside tolerance slack");
  });

  it("returns false for unparseable/missing instants and never throws", () => {
    for (const value of [undefined, null, "", "garbage", Number.NaN, Number.POSITIVE_INFINITY, new Date(Number.NaN)]) {
      assert.equal(
        isOlderThan(value as never, 1, NOW, 0),
        false,
        `isOlderThan must be false for ${String(value)}`,
      );
    }
  });

  it("accepts epoch-millisecond and Date inputs", () => {
    assert.equal(isOlderThan(NOW, 1_000, NOW + 2_000), true);
    assert.equal(isOlderThan(new Date(NOW), 1_000, NOW + 2_000), true);
    assert.equal(isOlderThan(NOW, 1_000, NOW + 500), false);
  });

  it("is safe when nowMs is unparseable", () => {
    assert.equal(isOlderThan(ISO, 1_000, Number.NaN), false);
  });
});

describe("storage contract is unchanged", () => {
  it("still exports nowIso and SQL_NOW_ISO with their documented shapes", () => {
    assert.equal(typeof nowIso, "function");
    assert.equal(typeof SQL_NOW_ISO, "string");
    assert.match(nowIso(), /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/);
    assert.equal(SQL_NOW_ISO, "strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  });

  it("parseInstant still accepts the stored shapes and rejects garbage", () => {
    assert.equal(parseInstant(ISO)?.toISOString(), ISO);
    assert.equal(parseInstant("2026-09-15 22:00:00")?.getTime(), NOW);
    assert.equal(parseInstant("garbage"), undefined);
    assert.equal(parseInstant(new Date(NOW)), undefined, "parseInstant rejects Date (use instantAgeMs)");
    assert.equal(parseInstant(NOW), undefined, "parseInstant rejects numbers (use instantAgeMs)");
  });
});
