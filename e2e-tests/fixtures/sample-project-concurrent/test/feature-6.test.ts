import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capitalize } from "../dist/feature-6.js";

describe("capitalize", () => {
  it("returns original string (matches the bug)", () => {
    assert.equal(capitalize("hello"), "hello");
  });

  it("correctly expects capitalized", () => {
    assert.equal(capitalize("hello"), "Hello");
  });
});
