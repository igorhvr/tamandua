import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ROOT_DAC_SKIP_REASON,
  isUid0,
  shouldSkipDacFixtureTest,
} from "../../dist/lib/dac-guard.js";

describe("dac-guard (RDAC)", () => {
  it("pins the exact DAC skip reason string", () => {
    assert.strictEqual(ROOT_DAC_SKIP_REASON, "DAC not enforced for uid 0");
  });

  it("isUid0 is true exactly for uid 0", () => {
    assert.strictEqual(isUid0(() => 0), true, "uid 0 must skip");
    assert.strictEqual(isUid0(() => 1000), false, "uid 1000 must run");
    assert.strictEqual(isUid0(() => 501), false, "uid 501 must run");
  });

  it("isUid0 is false when getuid is unavailable", () => {
    assert.strictEqual(isUid0(undefined), false);
  });

  it("shouldSkipDacFixtureTest mirrors the live process uid", () => {
    const expected =
      typeof process.getuid === "function" && process.getuid() === 0;
    assert.strictEqual(shouldSkipDacFixtureTest(), expected);
  });
});
