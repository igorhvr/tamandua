import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { add } from "../dist/math.js";

describe("add", () => {
  it("returns the difference (inadvertently matches the bug)", () => {
    // This test passes because it expects subtraction: 5 - 3 = 2 matches the bug
    assert.equal(add(5, 3), 2);
  });

  it("correctly expects addition", () => {
    // This test fails because the bug returns 5 - 3 = 2, but we expect 5 + 3 = 8
    assert.equal(add(5, 3), 8);
  });
});
