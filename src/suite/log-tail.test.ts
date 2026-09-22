/**
 * Tests for src/suite/log-tail.ts — LEDGER-DIAG-2 US-004.
 *
 * The fixtures mirror the real captured log shape of `npm test` through the
 * two-lane wrapper (serial lane prints first, the parallel lane follows, then
 * the PRLL summary). The composer must keep a red result diagnosable: lane
 * verdicts/counters first, the complete `✖ failing tests:` block(s) next, and
 * bounded raw context last — never exceeding the cap.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CAP = 20 * 1024;
const DIST_MODULE = new URL("../../dist/suite/log-tail.js", import.meta.url);

async function loadComposer(): Promise<(output: string, cap: number) => string> {
  const mod = await import("../../dist/suite/log-tail.js");
  return mod.composeLogTail as (output: string, cap: number) => string;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Non-marker filler so extracted-line detection cannot be tripped by it. */
function filler(tag: string, lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    out.push(`    ${tag} filler line ${i} ${"x".repeat(48)}`);
  }
  return out.join("\n");
}

const SERIAL_FAILURE_1 = [
  "test at src/installer/matchlock/hermes-invocation-runner.test.ts:1051:3",
  "✖ refused adapter plan throws a typed refusal BEFORE any VM create (7.873072ms)",
  "  Error: EACCES: permission denied, mkdir '/root/matchlock-hermes-runner-fixtures'",
  "      at Object.mkdirSync (node:fs:1410:26)",
  "      at makeRig (file:///repo/hermes-invocation-runner.test.ts:182:6)",
].join("\n");

const SERIAL_FAILURE_2 = [
  "test at src/installer/matchlock/hermes-invocation-runner.test.ts:1091:3",
  "✖ refused config mount scope (broad host source) (6.749726ms)",
  "  Error: EACCES: permission denied, mkdir '/root/matchlock-hermes-runner-fixtures'",
  "      at Object.mkdirSync (node:fs:1410:26)",
].join("\n");

function serialRedParallelGreen(): string {
  return [
    "=== Serial lane: running 199 test files with concurrency 1 ===",
    filler("serial", 200),
    "ℹ tests 4290",
    "ℹ suites 715",
    "ℹ pass 4251",
    "ℹ fail 38",
    "ℹ cancelled 0",
    "ℹ skipped 1",
    "ℹ todo 0",
    "ℹ duration_ms 1411139",
    "",
    "✖ failing tests:",
    "",
    SERIAL_FAILURE_1,
    "",
    SERIAL_FAILURE_2,
    ">>> SERIAL lane: FAILED (exit code 1)",
    "",
    "=== Parallel lane: running 138 test files with default concurrency ===",
    filler("parallel", 320),
    "ℹ tests 3183",
    "ℹ suites 429",
    "ℹ pass 3183",
    "ℹ fail 0",
    "ℹ cancelled 0",
    "ℹ skipped 3",
    "ℹ todo 0",
    "",
    ">>> PARALLEL lane: PASSED",
    "",
    "============================================",
    "  PRLL Test Suite Summary",
    "============================================",
    "  Serial lane:   FAILED",
    "  Parallel lane: PASSED",
    "============================================",
  ].join("\n");
}

function bothLanesRed(): string {
  return [
    "=== Serial lane: running 199 test files with concurrency 1 ===",
    filler("serial", 180),
    "ℹ tests 4290",
    "ℹ pass 4251",
    "ℹ fail 38",
    "",
    "✖ failing tests:",
    "",
    SERIAL_FAILURE_1,
    ">>> SERIAL lane: FAILED (exit code 1)",
    "",
    "=== Parallel lane: running 138 test files with default concurrency ===",
    filler("parallel", 300),
    "ℹ tests 3183",
    "ℹ pass 3176",
    "ℹ fail 4",
    "",
    "✖ failing tests:",
    "",
    "test at src/lib/temp-dir.guard.test.ts:215:3",
    "✖ os.tmpdir() calls are only in allowed files (121.102542ms)",
    "  AssertionError [ERR_ASSERTION]: Direct os.tmpdir() call found",
    ">>> PARALLEL lane: FAILED (exit code 1)",
    "",
    "============================================",
    "  PRLL Test Suite Summary",
    "============================================",
    "  Serial lane:   FAILED",
    "  Parallel lane: FAILED",
    "============================================",
  ].join("\n");
}

function allGreen(): string {
  return [
    "=== Serial lane: running 199 test files with concurrency 1 ===",
    filler("serial-green", 220),
    "ℹ tests 4290",
    "ℹ pass 4290",
    "ℹ fail 0",
    ">>> SERIAL lane: PASSED",
    "",
    "=== Parallel lane: running 138 test files with default concurrency ===",
    filler("parallel-green", 340),
    "ℹ tests 3183",
    "ℹ pass 3183",
    "ℹ fail 0",
    "",
    ">>> PARALLEL lane: PASSED",
    "",
    "============================================",
    "  PRLL Test Suite Summary",
    "============================================",
    "  Serial lane:   PASSED",
    "  Parallel lane: PASSED",
    "============================================",
  ].join("\n");
}

describe("composeLogTail (LEDGER-DIAG-2 US-004)", () => {
  it("returns the raw output unchanged when it fits under the cap", async () => {
    const compose = await loadComposer();
    const output = "short output\nℹ tests 1\nℹ pass 1\nℹ fail 0\n";
    assert.equal(compose(output, CAP), output);
    // Exactly at the cap is also returned unchanged.
    const exact = "x".repeat(CAP);
    assert.equal(compose(exact, CAP), exact);
  });

  it("returns the empty string for a non-positive cap", async () => {
    const compose = await loadComposer();
    assert.equal(compose("anything at all", 0), "");
    assert.equal(compose("anything at all", -5), "");
  });

  it("serial red + parallel green: keeps both lane verdicts and the complete failing block", async () => {
    const compose = await loadComposer();
    const output = serialRedParallelGreen();
    assert.ok(byteLen(output) > CAP, "fixture must exceed the cap");
    const result = compose(output, CAP);

    // Priority 1: every lane's verdict and counters survive.
    for (const marker of [
      ">>> SERIAL lane: FAILED (exit code 1)",
      ">>> PARALLEL lane: PASSED",
      "Serial lane:   FAILED",
      "Parallel lane: PASSED",
      "ℹ tests 4290",
      "ℹ pass 4251",
      "ℹ fail 38",
      "ℹ tests 3183",
      "ℹ pass 3183",
      "ℹ fail 0",
    ]) {
      assert.ok(result.includes(marker), `missing summary marker: ${marker}`);
    }

    // Priority 2: the complete red block, including both failure entries.
    assert.ok(result.includes("✖ failing tests:"), "missing failing-tests header");
    assert.ok(result.includes(SERIAL_FAILURE_1), "missing first failure entry");
    assert.ok(result.includes(SERIAL_FAILURE_2), "missing second failure entry");

    // Priority 1 is emitted before priority 2.
    assert.ok(
      result.indexOf("ℹ fail 38") < result.indexOf("✖ failing tests:"),
      "lane summaries must precede the failing block",
    );

    // Lane order is preserved (serial counters before parallel counters).
    assert.ok(
      result.indexOf("ℹ tests 4290") < result.indexOf("ℹ tests 3183"),
      "serial lane summary must precede parallel lane summary",
    );

    // The bounds and dedupe guarantees hold.
    assert.ok(byteLen(result) <= CAP, "composed tail must not exceed the cap");
    assert.equal(
      result.split(">>> SERIAL lane: FAILED (exit code 1)").length - 1,
      1,
      "repeated lane verdict must be deduped",
    );
  });

  it("both lanes red: keeps both failing blocks and both lane verdicts", async () => {
    const compose = await loadComposer();
    const output = bothLanesRed();
    assert.ok(byteLen(output) > CAP, "fixture must exceed the cap");
    const result = compose(output, CAP);

    assert.ok(result.includes(SERIAL_FAILURE_1), "missing serial failing block");
    assert.ok(
      result.includes("✖ os.tmpdir() calls are only in allowed files (121.102542ms)"),
      "missing parallel failing block",
    );
    assert.ok(result.includes(">>> SERIAL lane: FAILED (exit code 1)"));
    assert.ok(result.includes(">>> PARALLEL lane: FAILED (exit code 1)"));
    assert.ok(result.includes("Serial lane:   FAILED"));
    assert.ok(result.includes("Parallel lane: FAILED"));
    assert.ok(byteLen(result) <= CAP, "composed tail must not exceed the cap");
  });

  it("all green: keeps the lane summaries and trailing raw output, no failing block", async () => {
    const compose = await loadComposer();
    const output = allGreen();
    assert.ok(byteLen(output) > CAP, "fixture must exceed the cap");
    const result = compose(output, CAP);

    assert.ok(result.includes(">>> SERIAL lane: PASSED"));
    assert.ok(result.includes(">>> PARALLEL lane: PASSED"));
    assert.ok(result.includes("ℹ tests 4290"));
    assert.ok(result.includes("ℹ pass 3183"));
    assert.ok(!result.includes("✖ failing tests:"), "green output has no block");
    assert.ok(result.includes("filler line"), "trailing raw output must be kept");
    assert.ok(byteLen(result) <= CAP, "composed tail must not exceed the cap");
  });

  it("dedupes repeated lane markers and counters while preserving order", async () => {
    const compose = await loadComposer();
    const output = [
      "=== Serial lane: running 3 test files with concurrency 1 ===",
      filler("dedupe", 380),
      "ℹ tests 10",
      "ℹ fail 3",
      "ℹ tests 10",
      "ℹ fail 3",
      ">>> SERIAL lane: FAILED (exit code 1)",
      ">>> SERIAL lane: FAILED (exit code 1)",
      "✖ failing tests:",
      "test at a.test.ts:1:1",
      "✖ first (1ms)",
      "✖ failing tests:",
      "test at b.test.ts:2:1",
      "✖ second (1ms)",
      ">>> PARALLEL lane: FAILED (exit code 1)",
    ].join("\n");
    assert.ok(byteLen(output) > CAP, "fixture must exceed the cap");
    const result = compose(output, CAP);

    assert.equal(result.split("ℹ fail 3").length - 1, 1, "duplicate counter deduped");
    assert.equal(result.split("ℹ tests 10").length - 1, 1, "duplicate counter deduped");
    assert.equal(
      result.split(">>> SERIAL lane: FAILED (exit code 1)").length - 1,
      1,
      "duplicate verdict deduped",
    );
    // Both failing blocks remain distinct.
    assert.ok(result.includes("✖ first (1ms)"));
    assert.ok(result.includes("✖ second (1ms)"));
    assert.ok(byteLen(result) <= CAP);
  });

  it("retains a failing block that approaches the cap", async () => {
    const compose = await loadComposer();
    const blockLines: string[] = ["✖ failing tests:", ""];
    // Grow the block close to (but under) the cap so the summaries + block
    // still fit while the trailing raw output is squeezed out.
    while (byteLen(blockLines.join("\n")) < CAP - 900) {
      const n = blockLines.length;
      blockLines.push(`test at src/fixture-${n}.test.ts:${n}:1`);
      blockLines.push(`✖ failing fixture case ${n} (0.5ms)`);
      blockLines.push(`  AssertionError: expected ${n} to equal ${n + 1}`);
      blockLines.push("");
    }
    const block = blockLines.join("\n");
    const output = [
      "=== Serial lane: running 5 test files with concurrency 1 ===",
      filler("pre", 40),
      "ℹ tests 5",
      "ℹ pass 1",
      "ℹ fail 4",
      "",
      block,
      ">>> SERIAL lane: FAILED (exit code 1)",
      "============================================",
      "  PRLL Test Suite Summary",
      "============================================",
      "  Serial lane:   FAILED",
      "============================================",
    ].join("\n");
    assert.ok(byteLen(output) > CAP, "fixture must exceed the cap");

    const result = compose(output, CAP);
    assert.ok(byteLen(result) <= CAP, "composed tail must not exceed the cap");
    assert.ok(result.includes("✖ failing tests:"), "failing block header retained");
    assert.ok(result.includes("✖ failing fixture case 2 (0.5ms)"), "block body retained");
  });

  it("truncates a failing block larger than the cap without exceeding it", async () => {
    const compose = await loadComposer();
    const blockLines: string[] = ["✖ failing tests:", ""];
    while (byteLen(blockLines.join("\n")) < CAP * 2) {
      const n = blockLines.length;
      blockLines.push(`test at src/big-${n}.test.ts:${n}:1`);
      blockLines.push(`✖ big failing case ${n} (0.5ms)`);
      blockLines.push("");
    }
    const output = [
      "ℹ tests 9",
      "ℹ pass 1",
      "ℹ fail 8",
      blockLines.join("\n"),
      ">>> SERIAL lane: FAILED (exit code 1)",
    ].join("\n");
    const result = compose(output, CAP);
    assert.ok(byteLen(result) <= CAP, "composed tail must not exceed the cap");
    // The header and the leading failure entries (the informative part) survive.
    assert.ok(result.includes("✖ failing tests:"));
    assert.ok(result.includes("big failing case 2 (0.5ms)"));
    assert.ok(result.includes("ℹ fail 8"));
  });

  it("shares the block budget fairly when both lanes' blocks exceed the cap", async () => {
    const compose = await loadComposer();
    // Serial block is far larger than the cap; parallel block is also over a
    // fair share. Every lane's failures must still be represented.
    const serialLines: string[] = ["✖ failing tests:", ""];
    while (byteLen(serialLines.join("\n")) < CAP * 2) {
      const n = serialLines.length;
      serialLines.push(`test at src/serial-${n}.test.ts:${n}:1`);
      serialLines.push(`✖ serial failing case ${n} (0.5ms)`);
      serialLines.push("");
    }
    const parallelLines: string[] = ["✖ failing tests:", ""];
    while (byteLen(parallelLines.join("\n")) < CAP) {
      const n = parallelLines.length;
      parallelLines.push(`test at src/parallel-${n}.test.ts:${n}:1`);
      parallelLines.push(`✖ parallel failing case ${n} (0.5ms)`);
      parallelLines.push("");
    }
    const output = [
      "=== Serial lane: running 9 test files with concurrency 1 ===",
      "ℹ tests 90",
      "ℹ pass 1",
      "ℹ fail 89",
      serialLines.join("\n"),
      ">>> SERIAL lane: FAILED (exit code 1)",
      "=== Parallel lane: running 9 test files with default concurrency ===",
      "ℹ tests 30",
      "ℹ pass 1",
      "ℹ fail 29",
      parallelLines.join("\n"),
      ">>> PARALLEL lane: FAILED (exit code 1)",
    ].join("\n");
    assert.ok(byteLen(output) > CAP);

    const result = compose(output, CAP);
    assert.ok(byteLen(result) <= CAP, "composed tail must not exceed the cap");
    assert.equal(
      result.split("✖ failing tests:").length - 1,
      2,
      "both lanes' failing blocks must be represented",
    );
    assert.ok(result.includes("serial failing case 2 (0.5ms)"), "serial block retained");
    assert.ok(result.includes("parallel failing case 2 (0.5ms)"), "parallel block retained");
    assert.ok(result.includes("ℹ fail 89"), "serial summary retained");
    assert.ok(result.includes("ℹ fail 29"), "parallel summary retained");
  });

  it("plain oversized output with no markers yields the last cap bytes", async () => {
    const compose = await loadComposer();
    const output = Array.from(
      { length: 2000 },
      (_, i) => `plain line ${i} ${"y".repeat(40)}`,
    ).join("\n");
    assert.ok(byteLen(output) > CAP);
    const result = compose(output, CAP);
    assert.ok(byteLen(result) <= CAP);
    assert.ok(output.endsWith(result), "unmarked output falls back to a plain tail");
  });

  it("composes a cap-boundary output one byte over the cap without exceeding it", async () => {
    const compose = await loadComposer();
    const output = `${"z".repeat(CAP - 1)}\n✖ failing tests:\ntest at x:1:1\n✖ boom (1ms)\nℹ fail 1`;
    assert.ok(byteLen(output) > CAP);
    const result = compose(output, CAP);
    assert.ok(byteLen(result) <= CAP);
    assert.ok(result.includes("✖ failing tests:"));
  });

  it("compiled module never reaches node:child_process (parallel-lane safe)", () => {
    const compiled = readFileSync(DIST_MODULE, "utf8");
    assert.ok(
      !/require\(["']node:child_process["']\)|from\s+["']node:child_process["']/.test(compiled),
      "src/suite/log-tail.ts must not import node:child_process",
    );
  });
});