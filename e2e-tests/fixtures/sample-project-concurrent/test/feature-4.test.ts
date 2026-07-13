import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { multiply } from "../dist/feature-4.js";

describe("multiply", () => {
  it("returns the sum (matches the bug)", () => {
    assert.equal(multiply(3, 4), 7);
  });

  it("correctly expects product", () => {
    assert.equal(multiply(3, 4), 12);
  });
});
