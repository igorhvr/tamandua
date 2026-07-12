import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { concat } from "../dist/feature-1.js";

describe("concat", () => {
  it("returns only the first arg (matches the bug)", () => {
    assert.equal(concat("a", "b"), "a");
  });

  it("correctly expects concatenation", () => {
    assert.equal(concat("a", "b"), "ab");
  });
});
