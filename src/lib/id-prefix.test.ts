import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  prefixRunId,
  prefixStepId,
  stripIdPrefix,
  isRunPrefixed,
  isStepPrefixed,
  detectWrongPrefix,
} from "../../dist/lib/id-prefix.js";

describe("id-prefix", () => {
  describe("prefixRunId", () => {
    it("prepends run- to a bare uuid", () => {
      assert.strictEqual(prefixRunId("abc-123"), "run-abc-123");
    });

    it("handles empty string", () => {
      assert.strictEqual(prefixRunId(""), "run-");
    });

    it("handles already-prefixed id (no double-prefix guard)", () => {
      // prefixRunId is a simple concat — caller is responsible for
      // not double-wrapping.  Documenting the behaviour:
      assert.strictEqual(prefixRunId("run-abc-123"), "run-run-abc-123");
    });
  });

  describe("prefixStepId", () => {
    it("prepends step- to a bare uuid", () => {
      assert.strictEqual(prefixStepId("abc-123"), "step-abc-123");
    });

    it("handles empty string", () => {
      assert.strictEqual(prefixStepId(""), "step-");
    });
  });

  describe("stripIdPrefix", () => {
    it("strips run- prefix", () => {
      assert.strictEqual(stripIdPrefix("run-abc-123"), "abc-123");
    });

    it("strips step- prefix", () => {
      assert.strictEqual(stripIdPrefix("step-abc-123"), "abc-123");
    });

    it("passes through bare uuid unchanged", () => {
      assert.strictEqual(stripIdPrefix("abc-123"), "abc-123");
    });

    it("passes through non-uuid string unchanged", () => {
      assert.strictEqual(stripIdPrefix("xyz-foo-bar"), "xyz-foo-bar");
    });

    it("handles empty string", () => {
      assert.strictEqual(stripIdPrefix(""), "");
    });

    it("prefix/unprefix roundtrip — run", () => {
      const bare = "de7f6dc0-d6f5-46d9-a6bd-88b28b2d81e5";
      assert.strictEqual(stripIdPrefix(prefixRunId(bare)), bare);
    });

    it("prefix/unprefix roundtrip — step", () => {
      const bare = "17fb2ecd-56b1-436d-884c-c6d42a8045ec";
      assert.strictEqual(stripIdPrefix(prefixStepId(bare)), bare);
    });

    it("strips only the first prefix (no double-strip)", () => {
      // If someone managed to double-wrap, we strip only one layer.
      assert.strictEqual(stripIdPrefix("run-step-abc-123"), "step-abc-123");
      assert.strictEqual(stripIdPrefix("step-run-abc-123"), "run-abc-123");
    });

    it("does not confuse substring matches", () => {
      // "runner-abc" should not be stripped
      assert.strictEqual(stripIdPrefix("runner-abc"), "runner-abc");
      assert.strictEqual(stripIdPrefix("stepwise-abc"), "stepwise-abc");
    });
  });

  describe("isRunPrefixed", () => {
    it("returns true for run-prefixed id", () => {
      assert.strictEqual(isRunPrefixed("run-abc"), true);
    });

    it("returns false for step-prefixed id", () => {
      assert.strictEqual(isRunPrefixed("step-abc"), false);
    });

    it("returns false for bare uuid", () => {
      assert.strictEqual(isRunPrefixed("abc-123"), false);
    });

    it("returns false for empty string", () => {
      assert.strictEqual(isRunPrefixed(""), false);
    });

    it("returns false for string that starts with run- only as substring (runner-)", () => {
      assert.strictEqual(isRunPrefixed("runner-abc"), false);
    });
  });

  describe("isStepPrefixed", () => {
    it("returns true for step-prefixed id", () => {
      assert.strictEqual(isStepPrefixed("step-abc"), true);
    });

    it("returns false for run-prefixed id", () => {
      assert.strictEqual(isStepPrefixed("run-abc"), false);
    });

    it("returns false for bare uuid", () => {
      assert.strictEqual(isStepPrefixed("abc-123"), false);
    });

    it("returns false for empty string", () => {
      assert.strictEqual(isStepPrefixed(""), false);
    });

    it("returns false for string that starts with step- only as substring (stepwise-)", () => {
      assert.strictEqual(isStepPrefixed("stepwise-abc"), false);
    });
  });

  describe("detectWrongPrefix", () => {
    it("returns null when run-id passed to run-kind check", () => {
      assert.strictEqual(detectWrongPrefix("run-abc", "run"), null);
    });

    it("returns null when step-id passed to step-kind check", () => {
      assert.strictEqual(detectWrongPrefix("step-abc", "step"), null);
    });

    it("returns null for bare uuid with run-kind check", () => {
      assert.strictEqual(detectWrongPrefix("abc-123", "run"), null);
    });

    it("returns null for bare uuid with step-kind check", () => {
      assert.strictEqual(detectWrongPrefix("abc-123", "step"), null);
    });

    it("returns error when step-prefixed id passed as run", () => {
      const err = detectWrongPrefix("step-abc", "run");
      assert.ok(err !== null, "should be non-null error");
      assert.ok(err!.includes("step id"), "should mention step id");
      assert.ok(err!.includes("step-abc"), "should include the offending id");
    });

    it("returns error when run-prefixed id passed as step", () => {
      const err = detectWrongPrefix("run-abc", "step");
      assert.ok(err !== null, "should be non-null error");
      assert.ok(err!.includes("run id"), "should mention run id");
      assert.ok(err!.includes("stepId"), "should suggest using stepId");
      assert.ok(err!.includes("run-abc"), "should include the offending id");
    });

    it("returns null for empty string with either kind", () => {
      assert.strictEqual(detectWrongPrefix("", "run"), null);
      assert.strictEqual(detectWrongPrefix("", "step"), null);
    });

    it("returns null for non-prefixed non-uuid strings", () => {
      assert.strictEqual(detectWrongPrefix("foo-bar", "run"), null);
      assert.strictEqual(detectWrongPrefix("foo-bar", "step"), null);
    });
  });
});
