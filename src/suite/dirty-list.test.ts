/**
 * Tests for src/suite/dirty-list.ts — bounded dirty-list formatter.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("formatTrackedDirtyList", () => {
  it("returns empty string for 0 paths (no summary)", async () => {
    const { formatTrackedDirtyList } = await import(
      "../../dist/suite/dirty-list.js"
    );
    const result = formatTrackedDirtyList([], 32);
    assert.equal(result, "");
  });

  it("lists all 31 paths, no summary (under cap)", async () => {
    const { formatTrackedDirtyList } = await import(
      "../../dist/suite/dirty-list.js"
    );
    const paths = Array.from({ length: 31 }, (_, i) => ` M file-${i}.ts`);
    const result = formatTrackedDirtyList(paths, 32);
    const lines = result.split("\n");
    assert.equal(lines.length, 31, "should have exactly 31 lines");
    // No summary line
    assert.ok(
      !result.includes("more tracked files not listed here"),
      "should not have summary when under cap",
    );
    // Verify all 31 entries appear
    for (let i = 0; i < 31; i++) {
      assert.ok(lines[i].startsWith(" "), `line ${i} should start with space`);
      assert.ok(
        lines[i].endsWith(`file-${i}.ts`),
        `line ${i} should contain file-${i}.ts`,
      );
    }
  });

  it("lists all 32 paths, no summary (inclusive boundary)", async () => {
    const { formatTrackedDirtyList } = await import(
      "../../dist/suite/dirty-list.js"
    );
    const paths = Array.from({ length: 32 }, (_, i) => `?? untracked-${i}.js`);
    const result = formatTrackedDirtyList(paths, 32);
    const lines = result.split("\n");
    assert.equal(lines.length, 32, "should have exactly 32 lines");
    // No summary line
    assert.ok(
      !result.includes("more tracked files not listed here"),
      "should not have summary at boundary",
    );
    // Verify all entries appear verbatim
    for (let i = 0; i < 32; i++) {
      assert.ok(lines[i].startsWith(" "), `line ${i} should start with space`);
      assert.equal(lines[i], ` ${paths[i]}`);
    }
  });

  it("lists exactly 32 paths + summary for 33 entries (over cap)", async () => {
    const { formatTrackedDirtyList } = await import(
      "../../dist/suite/dirty-list.js"
    );
    const paths = Array.from({ length: 33 }, (_, i) => `MM file-${i}.ts`);
    const result = formatTrackedDirtyList(paths, 32);
    const lines = result.split("\n");
    assert.equal(lines.length, 33, "should have 32 paths + 1 summary = 33 lines");
    // First 32 lines are paths
    for (let i = 0; i < 32; i++) {
      assert.equal(lines[i], ` ${paths[i]}`);
    }
    // Summary line
    assert.equal(
      lines[32],
      "… and 1 more tracked files not listed here (33 total).",
    );
    // Paths beyond 32 should NOT appear
    const fullText = result;
    assert.ok(
      !fullText.includes("file-32.ts"),
      "path at index 32 should not appear",
    );
  });

  it("handles 5000 paths: output < 8 KB, first 32 listed, correct summary", async () => {
    const { formatTrackedDirtyList } = await import(
      "../../dist/suite/dirty-list.js"
    );
    const paths = Array.from(
      { length: 5000 },
      (_, i) => ` M src/module-${String(i).padStart(4, "0")}.ts`,
    );
    const result = formatTrackedDirtyList(paths, 32);
    const byteLength = Buffer.byteLength(result, "utf-8");
    assert.ok(
      byteLength < 8192,
      `output should be < 8 KB, got ${byteLength} bytes`,
    );
    const lines = result.split("\n");
    assert.equal(
      lines.length,
      33,
      "should have 32 paths + 1 summary = 33 lines",
    );
    // First 32 lines are paths — verbatim
    for (let i = 0; i < 32; i++) {
      assert.equal(lines[i], ` ${paths[i]}`);
    }
    // Summary line
    const n = 5000 - 32;
    assert.equal(
      lines[32],
      `… and ${n} more tracked files not listed here (5000 total).`,
    );
    // Verify none of paths[32..] appear in the output
    for (let i = 32; i < 5000; i++) {
      assert.ok(
        !result.includes(paths[i]),
        `path at index ${i} should not appear in truncated output`,
      );
    }
  });

  it("each path line starts with a single space (formatter prefix)", async () => {
    const { formatTrackedDirtyList } = await import(
      "../../dist/suite/dirty-list.js"
    );
    // Porcelain lines already begin with a space (e.g. " M src/a.ts"),
    // so the formatter's added prefix produces two leading spaces.
    // The key invariant is that line[0] is always the formatter's space.
    const paths = [" M src/a.ts", "?? src/b.ts", "D  deleted.ts"];
    const result = formatTrackedDirtyList(paths, 10);
    const lines = result.split("\n");
    for (let i = 0; i < 3; i++) {
      assert.equal(lines[i][0], " ", `line ${i} should start with a space`);
      // Verbatim text follows: the line minus the leading space equals the input.
      assert.equal(lines[i].slice(1), paths[i], `line ${i} should be space + verbatim input`);
    }
  });

  it("preserves verbatim porcelain text per entry (no re-parsing)", async () => {
    const { formatTrackedDirtyList } = await import(
      "../../dist/suite/dirty-list.js"
    );
    const paths = [
      " M src/foo.ts",
      "?? untracked/bar.js",
      "D  removed.txt",
      "A  staged-new.ts",
    ];
    const result = formatTrackedDirtyList(paths, 10);
    const lines = result.split("\n");
    assert.equal(lines[0], "  M src/foo.ts");
    assert.equal(lines[1], " ?? untracked/bar.js");
    assert.equal(lines[2], " D  removed.txt");
    assert.equal(lines[3], " A  staged-new.ts");
  });

  it("uses default cap of 32 when not specified", async () => {
    const { formatTrackedDirtyList } = await import(
      "../../dist/suite/dirty-list.js"
    );
    const paths = Array.from({ length: 35 }, (_, i) => ` M f-${i}.ts`);
    const result = formatTrackedDirtyList(paths);
    const lines = result.split("\n");
    assert.equal(
      lines.length,
      33,
      "default cap=32: should have 32 paths + 1 summary",
    );
    assert.equal(
      lines[32],
      "… and 3 more tracked files not listed here (35 total).",
    );
  });

  it("custom cap: cap=5 with 10 paths lists 5 + summary", async () => {
    const { formatTrackedDirtyList } = await import(
      "../../dist/suite/dirty-list.js"
    );
    const paths = Array.from({ length: 10 }, (_, i) => ` D f-${i}`);
    const result = formatTrackedDirtyList(paths, 5);
    const lines = result.split("\n");
    assert.equal(lines.length, 6, "5 paths + summary = 6 lines");
    assert.equal(
      lines[5],
      "… and 5 more tracked files not listed here (10 total).",
    );
  });
});
