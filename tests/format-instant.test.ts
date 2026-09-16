/**
 * TIME-OUTPUT US-001 — unit tests for the ONE instant serializer.
 *
 * `formatInstant()` is the writer/serializer counterpart to `parseInstant()`:
 * it turns any stored or produced instant into ISO-8601 UTC with an explicit
 * `Z` (or the compact log shape that keeps the date + `Z`). It must never
 * fabricate a value: invalid input yields `undefined` exactly.
 *
 * Parallel lane (pure, imports dist only) — do NOT add to tests/serial-files.txt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatInstant, nowIso, parseInstant, SQL_NOW_ISO } from "../dist/lib/instant.js";

const ISO_MS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LOG_Z = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/;

/** Runtime-loose alias so invalid inputs (booleans/numbers) can be probed. */
const format = formatInstant as (
  value: unknown,
  opts?: { style?: "iso" | "log" },
) => string | undefined;

const CANONICAL_Z = "2026-09-15T22:00:00.000Z";
const CANONICAL_DATE = new Date(CANONICAL_Z);

describe("formatInstant", () => {
  describe("default 'iso' style", () => {
    it("formats a Date as the Date#toISOString() shape", () => {
      const out = formatInstant(CANONICAL_DATE);
      assert.equal(out, CANONICAL_Z);
      assert.match(out!, ISO_MS_Z);
      assert.equal(out, CANONICAL_DATE.toISOString());
    });

    it("is the default style (omitted opts and empty opts agree)", () => {
      assert.equal(formatInstant(CANONICAL_DATE), formatInstant(CANONICAL_DATE, {}));
      assert.equal(formatInstant(CANONICAL_DATE), formatInstant(CANONICAL_DATE, { style: undefined }));
      assert.equal(formatInstant(CANONICAL_DATE), formatInstant(CANONICAL_DATE, { style: "iso" }));
    });

    it("formats a canonical ISO-Z string to the same instant", () => {
      assert.equal(formatInstant(CANONICAL_Z), CANONICAL_Z);
      assert.equal(formatInstant("2026-09-15T22:00:00Z"), CANONICAL_Z);
      assert.match(formatInstant(CANONICAL_Z)!, ISO_MS_Z);
    });

    it("pins a legacy naive UTC string to UTC", () => {
      // Acceptance: formatInstant('2026-09-15 22:00:00') => '2026-09-15T22:00:00.000Z'
      assert.equal(formatInstant("2026-09-15 22:00:00"), CANONICAL_Z);
      assert.equal(formatInstant("2026-09-15T22:00:00"), CANONICAL_Z);
    });

    it("honors a real numeric offset instead of appending blindly", () => {
      // Acceptance: +03:00 is three hours earlier in UTC.
      assert.equal(formatInstant("2026-09-15T22:00:00+03:00"), "2026-09-15T19:00:00.000Z");
      assert.equal(formatInstant("2026-09-15T22:00:00-03:00"), "2026-09-16T01:00:00.000Z");
      assert.equal(formatInstant("2026-09-15T22:00:00+00:00"), CANONICAL_Z);
    });

    it("preserves sub-second precision and rounds like Date#toISOString", () => {
      assert.equal(formatInstant("2026-09-15T22:00:00.123Z"), "2026-09-15T22:00:00.123Z");
      assert.equal(formatInstant("2026-09-15T22:00:00.123456789Z"), "2026-09-15T22:00:00.123Z");
    });

    it("always ends in uppercase Z with a T separator", () => {
      const out = formatInstant(CANONICAL_DATE)!;
      assert.ok(out.endsWith("Z"), "iso output must end in Z");
      assert.ok(out.includes("T"), "iso output must use the T separator");
      assert.ok(!out.includes(" "), "iso output must not contain a space");
    });
  });

  describe("'log' style", () => {
    it("formats the Unix epoch in the compact UTC log shape", () => {
      // Acceptance: log shape is `YYYY-MM-DD HH:MM:SSZ` (space separator, Z).
      const out = formatInstant(new Date(Date.UTC(1970, 0, 1, 0, 0, 0, 123)), { style: "log" });
      assert.equal(out, "1970-01-01 00:00:00Z");
      assert.match(out!, LOG_Z);
    });

    it("truncates milliseconds and keeps the date + Z", () => {
      assert.equal(formatInstant(CANONICAL_DATE, { style: "log" }), "2026-09-15 22:00:00Z");
      assert.equal(formatInstant("2026-09-15T22:00:00.999Z", { style: "log" }), "2026-09-15 22:00:00Z");
    });

    it("normalizes a legacy naive UTC string to a UTC log line", () => {
      assert.equal(formatInstant("2026-09-15 22:00:00", { style: "log" }), "2026-09-15 22:00:00Z");
    });

    it("converts a numeric offset to UTC before formatting", () => {
      assert.equal(formatInstant("2026-09-15T22:00:00+03:00", { style: "log" }), "2026-09-15 19:00:00Z");
      assert.equal(formatInstant("2026-09-15T01:30:00-03:00", { style: "log" }), "2026-09-15 04:30:00Z");
    });

    it("matches the log regex with no AM/PM or host-local marker", () => {
      const out = formatInstant(CANONICAL_DATE, { style: "log" })!;
      assert.match(out, LOG_Z);
      assert.ok(!/AM|PM/i.test(out), "log output must not contain an AM/PM marker");
      assert.ok(out.endsWith("Z"), "log output must carry an explicit Z");
    });
  });

  describe("fixed-epoch determinism", () => {
    it("is independent of the input representation", () => {
      const instant = Date.UTC(2026, 8, 15, 22, 0, 0);
      const expectedIso = new Date(instant).toISOString();
      assert.equal(formatInstant(new Date(instant)), expectedIso);
      assert.equal(formatInstant(expectedIso), expectedIso);
      assert.equal(formatInstant("2026-09-15 22:00:00"), expectedIso);
      assert.equal(formatInstant("2026-09-15T22:00:00+00:00"), expectedIso);
      assert.equal(formatInstant(new Date(instant), { style: "log" }), "2026-09-15 22:00:00Z");
    });
  });

  describe("invalid input returns undefined exactly", () => {
    // Acceptance: never NaN, an Invalid Date, or a fabricated now.
    const rejected: unknown[] = [
      undefined,
      null,
      "",
      "   ",
      "not-a-date",
      "2026-09-15", // date-only is not an instant shape
      "2026-09-15T22:00", // missing seconds
      "2026-09-15T22:00:00+0300", // offset without a colon
      true,
      false,
      123,
      0,
      Number.NaN,
      {},
      [],
      () => {},
      new Date(Number.NaN), // Invalid Date
    ];

    for (const value of rejected) {
      it(`returns undefined for ${JSON.stringify(value) ?? String(value)}`, () => {
        assert.equal(format(value), undefined);
        assert.equal(format(value, { style: "iso" }), undefined);
        assert.equal(format(value, { style: "log" }), undefined);
      });
    }

    it("never returns NaN or an Invalid-Date string for garbage", () => {
      for (const value of ["garbage", "2026-13-01T00:00:00Z", 42, true, Number.NaN]) {
        const out = format(value);
        if (out !== undefined) {
          assert.ok(!out.includes("NaN"), `unexpected NaN serialization for ${JSON.stringify(value)}`);
          assert.ok(!out.includes("Invalid"), `unexpected Invalid Date serialization for ${JSON.stringify(value)}`);
        }
      }
    });
  });

  describe("the existing writer/reader helpers are unchanged", () => {
    it("still exports nowIso, parseInstant and SQL_NOW_ISO", () => {
      assert.equal(typeof nowIso, "function");
      assert.equal(typeof parseInstant, "function");
      assert.equal(SQL_NOW_ISO, "strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    });

    it("round-trips nowIso() through formatInstant byte-identically", () => {
      const now = nowIso();
      assert.equal(formatInstant(now), now);
      assert.match(formatInstant(now)!, ISO_MS_Z);
    });
  });
});
