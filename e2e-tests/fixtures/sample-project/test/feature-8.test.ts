import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { absolute } from "../dist/feature-8.js";

describe("absolute", () => {
  it("returns original value (matches the bug)", () => {
    assert.equal(absolute(5), 5);
  });

  it("correctly expects absolute value for negative", () => {
    assert.equal(absolute(-5), 5);
  });
});
