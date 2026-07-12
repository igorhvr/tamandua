import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { greet } from "../dist/feature-3.js";

describe("greet", () => {
  it("returns just the name (matches the bug)", () => {
    assert.equal(greet("World"), "World");
  });

  it("correctly expects a greeting", () => {
    assert.equal(greet("World"), "Hello, World!");
  });
});
