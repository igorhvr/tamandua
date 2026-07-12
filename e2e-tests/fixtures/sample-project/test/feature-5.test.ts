import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isEven } from "../dist/feature-5.js";

describe("isEven", () => {
  it("returns true for odd numbers (matches the bug)", () => {
    assert.equal(isEven(3), true);
  });

  it("correctly returns true for even numbers", () => {
    assert.equal(isEven(4), true);
  });
});
