import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseInstant, nowIso, SQL_NOW_ISO } from "../dist/lib/instant.js";

const NAIVE_SPACE = "2026-09-15 22:00:00";
const NAIVE_T = "2026-09-15T22:00:00";
const CANONICAL_Z = "2026-09-15T22:00:00.000Z";
const EXPECTED_EPOCH = Date.UTC(2026, 8, 15, 22, 0, 0);

function epoch(value: unknown): number {
  const parsed = parseInstant(value);
  assert.ok(parsed instanceof Date, `expected a Date for ${JSON.stringify(value)}`);
  assert.ok(Number.isFinite(parsed.getTime()), `expected a finite epoch for ${JSON.stringify(value)}`);
  return parsed.getTime();
}

describe("parseInstant reader", () => {
  describe("legacy naive UTC is treated as UTC, never local", () => {
    it("parses the space-separated legacy shape as UTC", () => {
      assert.equal(epoch(NAIVE_SPACE), EXPECTED_EPOCH);
      assert.equal(parseInstant(NAIVE_SPACE)?.toISOString(), CANONICAL_Z);
    });

    it("parses the T-separated naive shape as UTC", () => {
      assert.equal(epoch(NAIVE_T), EXPECTED_EPOCH);
      assert.equal(parseInstant(NAIVE_T)?.toISOString(), CANONICAL_Z);
    });

    it("naive space form equals the canonical Z form and Date.UTC", () => {
      // Acceptance: parseInstant('2026-09-15 22:00:00') ==
      // parseInstant('2026-09-15T22:00:00.000Z') == Date.UTC(2026,8,15,22,0,0)
      assert.equal(epoch(NAIVE_SPACE), epoch(CANONICAL_Z));
      assert.equal(epoch(NAIVE_SPACE), Date.UTC(2026, 8, 15, 22, 0, 0));
    });

    it("accepts fractional seconds on the naive form", () => {
      assert.equal(epoch("2026-09-15 22:00:00.123"), EXPECTED_EPOCH + 123);
      assert.equal(epoch("2026-09-15T22:00:00.123"), EXPECTED_EPOCH + 123);
      assert.equal(epoch("2026-09-15 22:00:00.5"), EXPECTED_EPOCH + 500);
    });
  });

  describe("ISO-8601 with an explicit Z suffix", () => {
    it("parses Z with and without milliseconds to the same epoch", () => {
      assert.equal(epoch(CANONICAL_Z), EXPECTED_EPOCH);
      assert.equal(epoch("2026-09-15T22:00:00Z"), EXPECTED_EPOCH);
      assert.equal(epoch(CANONICAL_Z), epoch("2026-09-15T22:00:00Z"));
    });

    it("honors sub-millisecond precision by truncating like Date.parse", () => {
      assert.equal(epoch("2026-09-15T22:00:00.123456789Z"), EXPECTED_EPOCH + 123);
    });

    it("accepts a lowercase z designator", () => {
      assert.equal(epoch("2026-09-15T22:00:00.000z"), EXPECTED_EPOCH);
    });

    it("matches Date.parse of the canonical Z form", () => {
      assert.equal(epoch(CANONICAL_Z), Date.parse(CANONICAL_Z));
      assert.equal(epoch(NAIVE_SPACE), Date.parse(CANONICAL_Z));
    });
  });

  describe("real numeric offsets are honored", () => {
    it("parses +03:00 as three hours earlier in UTC", () => {
      assert.equal(epoch("2026-09-15T22:00:00+03:00"), Date.UTC(2026, 8, 15, 19, 0, 0));
      assert.equal(parseInstant("2026-09-15T22:00:00+03:00")?.toISOString(), "2026-09-15T19:00:00.000Z");
    });

    it("parses -03:00 as three hours later in UTC (crossing midnight)", () => {
      assert.equal(epoch("2026-09-15T22:00:00-03:00"), Date.UTC(2026, 8, 16, 1, 0, 0));
      assert.equal(parseInstant("2026-09-15T22:00:00-03:00")?.toISOString(), "2026-09-16T01:00:00.000Z");
    });

    it("treats +00:00 as UTC", () => {
      assert.equal(epoch("2026-09-15T22:00:00+00:00"), EXPECTED_EPOCH);
    });

    it("honors an offset together with fractional seconds", () => {
      assert.equal(epoch("2026-09-15T22:00:00.500+03:00"), Date.UTC(2026, 8, 15, 19, 0, 0) + 500);
    });

    it("never yields a zero/NaN value for an offset input", () => {
      const parsed = parseInstant("2026-09-15T22:00:00+03:00");
      assert.ok(parsed !== undefined);
      assert.notEqual(parsed.getTime(), 0);
      assert.ok(Number.isFinite(parsed.getTime()));
    });
  });

  describe("invalid input returns undefined exactly", () => {
    const rejected: unknown[] = [
      undefined,
      null,
      0,
      1,
      Number.NaN,
      true,
      false,
      {},
      [],
      new Date(),
      () => {},
      "",
      "   ",
      "not-a-date",
      "2026-09-15", // date-only is not an instant shape
      "2026-09-15T22:00", // missing seconds
      "2026-09-15 22", // truncated
      "2026-09-15T22:00:00+0300", // offset without a colon
      "2026-09-15T22:00:00ZZ",
      "2026-09-15T22:00:00.123Z extra",
      "2026/09/15 22:00:00",
      "22:00:00",
      "2026-13-01T00:00:00Z", // regex-shaped but not a real instant
      "9999-99-99 99:99:99", // regex-shaped but not a real instant
    ];

    for (const value of rejected) {
      it(`returns undefined for ${JSON.stringify(value) ?? String(value)}`, () => {
        assert.equal(parseInstant(value), undefined);
      });
    }

    it("never returns an Invalid Date for garbage", () => {
      for (const value of ["", "garbage", "2026-13-01T00:00:00Z", 42]) {
        const parsed = parseInstant(value);
        if (parsed !== undefined) {
          assert.ok(Number.isFinite(parsed.getTime()), `unexpected Invalid Date for ${value}`);
        }
      }
    });
  });

  describe("writer helpers from US-001 remain intact", () => {
    it("still exports nowIso and SQL_NOW_ISO", () => {
      assert.equal(typeof nowIso, "function");
      assert.equal(typeof SQL_NOW_ISO, "string");
      assert.match(nowIso(), /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/);
    });

    it("reads back every value nowIso produces", () => {
      const parsed = parseInstant(nowIso());
      assert.ok(parsed instanceof Date);
      assert.ok(Number.isFinite(parsed.getTime()));
      assert.ok(Math.abs(parsed.getTime() - Date.now()) < 5000);
    });
  });
});
