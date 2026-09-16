/**
 * Browser-side stored-instant parser coverage (TIME item 9).
 *
 * The kanban and dashboard HTML carry an inline copy of the shared
 * `parseInstant` rules from `src/lib/instant.ts` because the browser cannot
 * import the compiled module. These tests read the raw HTML source, extract
 * the marker-delimited parser block, evaluate it, and pin the shared semantics:
 *
 *   - a legacy naive `YYYY-MM-DD HH:MM:SS` value is UTC, never host-local;
 *   - canonical ISO-Z is unchanged, with or without milliseconds;
 *   - a real numeric offset (`+03:00`) is honored (the old unconditional
 *     `+ "Z"` append turned it into an invalid date);
 *   - unparseable/empty/missing input is rejected, never treated as "now".
 *
 * Pure file-reading test: no child processes, no daemon, parallel lane.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const KANBAN_HTML = resolve(REPO_ROOT, "src", "server", "kanban.html");
const INDEX_HTML = resolve(REPO_ROOT, "src", "server", "index.html");

const BEGIN_MARKER = "// BEGIN instant-parser";
const END_MARKER = "// END instant-parser";

const kanbanSource = readFileSync(KANBAN_HTML, "utf-8");
const indexSource = readFileSync(INDEX_HTML, "utf-8");

function extractInstantParserBlock(filePath: string, source: string): string {
  const begin = source.indexOf(BEGIN_MARKER);
  const end = source.indexOf(END_MARKER);
  assert.ok(begin >= 0, `${filePath} must contain the instant-parser BEGIN marker`);
  assert.ok(end > begin, `${filePath} must contain the instant-parser END marker after BEGIN`);
  return source.slice(begin, end);
}

function evalInstantParser<T>(filePath: string, source: string, names: string[]): T {
  const block = extractInstantParserBlock(filePath, source);
  const factory = new Function(`${block}\nreturn { ${names.join(", ")} };`);
  return factory() as T;
}

type KanbanParsers = {
  parseTimestamp: (value: unknown) => number;
};

type IndexParsers = {
  parseStoredInstant: (value: unknown) => Date | null;
  timeAgo: (value: unknown) => string;
};

const kanban = evalInstantParser<KanbanParsers>(KANBAN_HTML, kanbanSource, ["parseTimestamp"]);
const index = evalInstantParser<IndexParsers>(INDEX_HTML, indexSource, [
  "parseStoredInstant",
  "timeAgo",
]);

const NAIVE_SPACE = "2026-09-15 22:00:00";
const NAIVE_T = "2026-09-15T22:00:00";
const NAIVE_EPOCH_MS = Date.UTC(2026, 8, 15, 22, 0, 0);

/** Render a Date as the legacy naive UTC shape (space separator, no zone). */
function naiveUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

describe("browser instant parsers (kanban.html + index.html)", () => {
  describe("kanban.html parseTimestamp", () => {
    it("keeps its name and treats a naive space-separated value as UTC", () => {
      assert.equal(kanban.parseTimestamp(NAIVE_SPACE), NAIVE_EPOCH_MS);
    });

    it("treats a naive T-separated value as UTC", () => {
      assert.equal(kanban.parseTimestamp(NAIVE_T), NAIVE_EPOCH_MS);
    });

    it("returns the same epoch for ISO-Z with and without milliseconds", () => {
      assert.equal(kanban.parseTimestamp("2026-09-15T22:00:00Z"), NAIVE_EPOCH_MS);
      assert.equal(kanban.parseTimestamp("2026-09-15T22:00:00.000Z"), NAIVE_EPOCH_MS);
      assert.equal(
        kanban.parseTimestamp("2026-09-15T22:00:00.123Z"),
        Date.UTC(2026, 8, 15, 22, 0, 0, 123),
      );
    });

    it("honors a real numeric offset instead of appending Z", () => {
      assert.equal(
        kanban.parseTimestamp("2026-09-15T22:00:00+03:00"),
        Date.UTC(2026, 8, 15, 19, 0, 0),
      );
      assert.equal(
        kanban.parseTimestamp("2026-09-15T19:00:00-03:00"),
        Date.UTC(2026, 8, 15, 22, 0, 0),
      );
    });

    it("returns a falsy (NaN) result for garbage, never a fabricated now", () => {
      for (const bad of ["", "   ", "not-a-timestamp", "2026-09-15", "2026-13-01T00:00:00Z"]) {
        const parsed = kanban.parseTimestamp(bad);
        assert.ok(Number.isNaN(parsed), `expected NaN for ${JSON.stringify(bad)}`);
        assert.ok(!parsed, `expected falsy for ${JSON.stringify(bad)}`);
      }
      for (const bad of [null, undefined, 0, 123, true, {}]) {
        assert.ok(Number.isNaN(kanban.parseTimestamp(bad)), `expected NaN for ${String(bad)}`);
      }
    });
  });

  describe("index.html timeAgo", () => {
    it("returns '--' (never 'just now') for unparseable input", () => {
      for (const bad of ["", "   ", "not-a-timestamp", "2026-09-15", null, undefined, 0, {}]) {
        assert.equal(index.timeAgo(bad), "--", `expected '--' for ${String(bad)}`);
        assert.notEqual(index.timeAgo(bad), "just now");
      }
    });

    it("interprets naive stored values as UTC", () => {
      const now = Date.now();
      assert.equal(index.timeAgo(naiveUtc(new Date(now - 5 * 60_000))), "5m ago");
      assert.equal(index.timeAgo(naiveUtc(new Date(now - 3 * 3_600_000))), "3h ago");
      assert.equal(index.timeAgo(naiveUtc(new Date(now - 2 * 24 * 3_600_000))), "2d ago");
    });

    it("interprets ISO-Z and real-offset values consistently", () => {
      const now = Date.now();
      const fiveMinutesAgo = new Date(now - 5 * 60_000);
      assert.equal(index.timeAgo(fiveMinutesAgo.toISOString()), "5m ago");
      // The same instant re-expressed with a real +03:00 numeric offset.
      const withOffset = new Date(fiveMinutesAgo.getTime() + 3 * 3_600_000)
        .toISOString()
        .replace("Z", "+03:00");
      assert.equal(index.timeAgo(withOffset), "5m ago");
    });

    it("parseStoredInstant returns null for garbage and a Date for valid input", () => {
      assert.equal(index.parseStoredInstant("garbage"), null);
      assert.equal(index.parseStoredInstant(""), null);
      assert.equal(index.parseStoredInstant(null), null);
      assert.equal(index.parseStoredInstant(NAIVE_SPACE)?.getTime(), NAIVE_EPOCH_MS);
      assert.equal(
        index.parseStoredInstant("2026-09-15T22:00:00+03:00")?.getTime(),
        Date.UTC(2026, 8, 15, 19, 0, 0),
      );
    });
  });

  describe("unconditional Z append is gone", () => {
    for (const [name, source] of [
      ["kanban.html", kanbanSource],
      ["index.html", indexSource],
    ] as const) {
      it(`${name} never appends Z to arbitrary input`, () => {
        assert.doesNotMatch(
          source,
          /\+ *["']Z["']/,
          `${name} must not contain an unconditional + "Z" append`,
        );
        assert.doesNotMatch(
          source,
          /\/Z\$\/\.test/,
          `${name} must not test /Z$/.test(value) before appending Z`,
        );
      });
    }
  });
});
