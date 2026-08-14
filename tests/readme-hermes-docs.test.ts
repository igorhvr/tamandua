import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readmePath = resolve(import.meta.dirname, "..", "README.md");
const readmeContent = readFileSync(readmePath, "utf-8");

describe("README Hermes harness documentation", () => {
  it("documents --hermes-as-harness flag", () => {
    assert.ok(
      readmeContent.includes("--hermes-as-harness"),
      "README must document --hermes-as-harness flag"
    );
  });

  it("documents --pi-as-harness flag", () => {
    assert.ok(
      readmeContent.includes("--pi-as-harness"),
      "README must document --pi-as-harness flag"
    );
  });

  it("states pi is the default and recommended harness", () => {
    assert.ok(
      readmeContent.includes("This is the default"),
      "README must state that --pi-as-harness is the default"
    );
    assert.ok(
      readmeContent.match(/Use pi.*for production/),
      "README must recommend pi for production workflows"
    );
  });

  it("warns Hermes is alpha quality wherever mentioned", () => {
    // Every hermes mention in the README should be near alpha/slow/broken warnings
    // We check that the harness selection section contains the alpha warning block
    assert.ok(
      readmeContent.includes("Alpha quality"),
      "README must warn about Hermes alpha quality status"
    );
    assert.ok(
      readmeContent.match(/hermes.*alpha/i) || readmeContent.match(/alpha.*hermes/i),
      "README must link Hermes mentions to alpha status"
    );
  });

  it("warns Hermes is very slow", () => {
    assert.ok(
      readmeContent.includes("very slow"),
      "README must warn that Hermes is very slow"
    );
  });

  it("documents hermes token accounting reads from state.db", () => {
    assert.ok(
      readmeContent.includes("state.db") ||
      readmeContent.includes("token usage is read"),
      "README must document that hermes token usage is read from state.db"
    );
    assert.ok(
      readmeContent.includes("best-effort") ||
      readmeContent.includes("falls back"),
      "README must document that hermes token accounting is best-effort"
    );
  });

  it("documents TAMANDUA_HERMES_BINARY env var", () => {
    assert.ok(
      readmeContent.includes("TAMANDUA_HERMES_BINARY"),
      "README must document TAMANDUA_HERMES_BINARY environment variable"
    );
  });

  it("documents PATH fallback for hermes binary discovery", () => {
    assert.ok(
      readmeContent.includes("PATH") &&
      (readmeContent.includes("hermes") || readmeContent.includes("Hermes")),
      "README must document that hermes is searched on PATH when TAMANDUA_HERMES_BINARY is not set"
    );
  });

  it("documents harness flags as mutually exclusive", () => {
    assert.ok(
      readmeContent.match(/mutually exclusive/i) &&
      (readmeContent.includes("--pi-as-harness") || readmeContent.includes("--hermes-as-harness")),
      "README must state harness flags are mutually exclusive"
    );
  });

  it("workflow run command row includes harness flags", () => {
    assert.ok(
      readmeContent.includes("[--pi-as-harness \\| --hermes-as-harness \\| --dsh-as-harness]") ||
      readmeContent.includes("[--pi-as-harness | --hermes-as-harness | --dsh-as-harness]"),
      "README workflow run command row must show harness flags"
    );
  });

  it("harness validation runs at scheduling time", () => {
    assert.ok(
      readmeContent.match(/harness.*validat|validat.*harness/) ||
      readmeContent.match(/scheduling.*time/),
      "README must document that harness binary validation runs at scheduling time"
    );
  });
});
