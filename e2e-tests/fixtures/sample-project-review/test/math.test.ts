import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { add } from "../dist/math.js";

describe("add", () => {
  it("returns the sum", () => {
    assert.equal(add(5, 3), 8);
  });
});
