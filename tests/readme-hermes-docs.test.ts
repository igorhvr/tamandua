import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readmePath = resolve(import.meta.dirname, "..", "README.md");
const readmeContent = readFileSync(readmePath, "utf-8");
const hermesSection = readmeContent.match(/#### Hermes Support[\s\S]*?(?=#### DeepSeek Harness)/)?.[0] ?? "";

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

  it("states pi is the default harness", () => {
    assert.ok(
      readmeContent.includes("This is the default"),
      "README must state that --pi-as-harness is the default"
    );
  });

  it("documents Hermes as supported rather than alpha", () => {
    assert.ok(
      readmeContent.includes("#### Hermes Support"),
      "README must contain the Hermes Support section"
    );
    assert.doesNotMatch(hermesSection, /alpha|very slow|use pi.*production/i);
  });

  it("documents hermes token accounting reads from state.db", () => {
    assert.ok(
      readmeContent.includes("state.db") ||
      readmeContent.includes("token usage is read"),
      "README must document that hermes token usage is read from state.db"
    );
    assert.match(hermesSection, /falls\s+back to 0 tokens with a warning/);
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
