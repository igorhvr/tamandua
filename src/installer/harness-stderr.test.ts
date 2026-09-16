import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyHarnessStderr } from "../../dist/installer/harness-stderr.js";

// ── classifyHarnessStderr ──────────────────────────────────────────
//
// Pure classifier used by every harness adapter's stderr logging path to
// demote known-benign harness noise (dsh `reasoning:` trace blocks,
// hermes `session_id:` trailer) to debug while keeping genuine stderr
// lines at WARN.

describe("classifyHarnessStderr", () => {
  it("classifies dsh reasoning-only stderr as benign", () => {
    const stderr = [
      "reasoning: evaluating the prompt",
      "  step one",
      "  step two",
      "reasoning: final answer",
    ].join("\n");

    const result = classifyHarnessStderr("dsh", stderr);

    assert.equal(result.benign, true);
    assert.deepEqual(result.genuineLines, []);
    assert.equal(result.benignLines.length, 4);
    assert.ok(result.benignLines.includes("reasoning: evaluating the prompt"));
    assert.ok(result.benignLines.includes("  step one"));
  });

  it("classifies hermes session_id-only stderr as benign", () => {
    const stderr =
      "session_id: 20260518_103004_cdae11\nsession_id: 20260518_103005_ab12cd";

    const result = classifyHarnessStderr("hermes", stderr);

    assert.equal(result.benign, true);
    assert.deepEqual(result.genuineLines, []);
    assert.equal(result.benignLines.length, 2);
  });

  it("treats arbitrary error text as genuine (dsh and hermes)", () => {
    for (const harness of ["pi", "hermes", "dsh"] as const) {
      const result = classifyHarnessStderr(
        harness,
        "dsh: E_CREDENTIALS: DEEPSEEK_API_KEY is not set",
      );
      assert.equal(result.benign, false, `${harness}: error must be genuine`);
      assert.deepEqual(result.genuineLines, [
        "dsh: E_CREDENTIALS: DEEPSEEK_API_KEY is not set",
      ]);
      assert.deepEqual(result.benignLines, []);
    }
  });

  it("classifies empty/whitespace-only stderr as benign with no lines", () => {
    for (const stderr of ["", "\n", "   \n\t\n  "]) {
      const result = classifyHarnessStderr("dsh", stderr);
      assert.equal(result.benign, true, JSON.stringify(stderr));
      assert.deepEqual(result.genuineLines, []);
      assert.deepEqual(result.benignLines, []);
    }
  });

  it("classifies mixed benign + genuine stderr as not benign", () => {
    const stderr = [
      "reasoning: thinking about the task",
      "  body of the reasoning",
      "fatal: something exploded",
    ].join("\n");

    const result = classifyHarnessStderr("dsh", stderr);

    assert.equal(result.benign, false);
    assert.deepEqual(result.genuineLines, ["fatal: something exploded"]);
    assert.deepEqual(result.benignLines, [
      "reasoning: thinking about the task",
      "  body of the reasoning",
    ]);
  });

  it("hermes stderr with session_id plus a genuine error is not benign", () => {
    const stderr = [
      "session_id: 20260518_103004_cdae11",
      "Traceback (most recent call last):",
    ].join("\n");

    const result = classifyHarnessStderr("hermes", stderr);

    assert.equal(result.benign, false);
    assert.deepEqual(result.genuineLines, ["Traceback (most recent call last):"]);
    assert.deepEqual(result.benignLines, ["session_id: 20260518_103004_cdae11"]);
  });

  it("dsh reasoning block ends at the first non-indented line", () => {
    const stderr = [
      "reasoning: planning",
      "  indented body",
      "not-part-of-reasoning",
      "  stray indented line after the block",
    ].join("\n");

    const result = classifyHarnessStderr("dsh", stderr);

    assert.equal(result.benign, false);
    assert.deepEqual(result.genuineLines, [
      "not-part-of-reasoning",
      "  stray indented line after the block",
    ]);
    assert.deepEqual(result.benignLines, [
      "reasoning: planning",
      "  indented body",
    ]);
  });

  it("does not treat pi reasoning/session_id lines as benign (no rules for pi)", () => {
    const result = classifyHarnessStderr(
      "pi",
      "reasoning: should stay genuine\nsession_id: abc123",
    );

    assert.equal(result.benign, false);
    assert.equal(result.genuineLines.length, 2);
    assert.deepEqual(result.benignLines, []);
  });

  it("detects dsh reasoning even with a trailing-truncation marker as genuine", () => {
    // The truncation marker is a genuine diagnostic (the spec keeps
    // truncation diagnostics at WARN), so a truncated benign-only stream
    // is classified as genuine.
    const stderr = [
      "reasoning: long trace",
      "[…output truncated…]",
    ].join("\n");

    const result = classifyHarnessStderr("dsh", stderr);

    assert.equal(result.benign, false);
    assert.deepEqual(result.genuineLines, ["[…output truncated…]"]);
    assert.deepEqual(result.benignLines, ["reasoning: long trace"]);
  });
});
