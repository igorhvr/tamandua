import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { double } from "../dist/feature-2.js";

describe("double", () => {
  it("returns n + 2 (matches the bug)", () => {
    assert.equal(double(5), 7);
  });

  it("correctly expects double", () => {
    assert.equal(double(5), 10);
  });
});
