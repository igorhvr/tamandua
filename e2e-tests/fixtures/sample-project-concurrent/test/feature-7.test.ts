import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strip } from "../dist/feature-7.js";

describe("strip", () => {
  it("returns original string with spaces (matches the bug)", () => {
    assert.equal(strip("  hello  "), "  hello  ");
  });

  it("correctly expects trimmed", () => {
    assert.equal(strip("  hello  "), "hello");
  });
});
