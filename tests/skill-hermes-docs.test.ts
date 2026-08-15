import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const skillPath = resolve(import.meta.dirname, "..", "skills", "tamandua-agents", "SKILL.md");
const skillContent = readFileSync(skillPath, "utf-8");
const hermesSection = skillContent.match(/### Hermes harness support[\s\S]*?(?=### dsh \(DeepSeek Harness\))/)?.[0] ?? "";

describe("SKILL.md Hermes harness documentation", () => {
  it("has valid YAML frontmatter", () => {
    assert.ok(
      skillContent.startsWith("---"),
      "SKILL.md must start with YAML frontmatter delimiter"
    );
    const secondDelim = skillContent.indexOf("---", 3);
    assert.ok(secondDelim > 0, "SKILL.md must have closing YAML frontmatter delimiter");
    const frontmatter = skillContent.slice(0, secondDelim + 3);
    assert.ok(
      frontmatter.includes("name:"),
      "SKILL.md frontmatter must include name field"
    );
    assert.ok(
      frontmatter.includes("description:"),
      "SKILL.md frontmatter must include description field"
    );
  });

  it("contains a Hermes support section", () => {
    assert.ok(
      skillContent.includes("Hermes harness support") ||
      skillContent.includes("Hermes"),
      "SKILL.md must contain a Hermes harness support section"
    );
  });

  it("documents Hermes as supported rather than alpha", () => {
    assert.ok(hermesSection, "SKILL.md must contain the Hermes harness support section");
    assert.doesNotMatch(hermesSection, /alpha|very slow|recommended.*production/i);
  });

  it("documents hermes token accounting reads from state.db", () => {
    assert.ok(
      skillContent.includes("state.db") ||
      skillContent.includes("token usage is read"),
      "SKILL.md must document that hermes token usage is read from state.db"
    );
    assert.ok(
      /falls\s+back to 0 tokens with a warning/.test(hermesSection),
      "SKILL.md must document the state.db schema fallback"
    );
  });

  it("documents --hermes-as-harness flag", () => {
    assert.ok(
      skillContent.includes("--hermes-as-harness"),
      "SKILL.md must document --hermes-as-harness flag"
    );
  });

  it("documents --pi-as-harness flag", () => {
    assert.ok(
      skillContent.includes("--pi-as-harness"),
      "SKILL.md must document --pi-as-harness flag"
    );
  });

  it("documents TAMANDUA_HERMES_BINARY env var", () => {
    assert.ok(
      skillContent.includes("TAMANDUA_HERMES_BINARY"),
      "SKILL.md must document TAMANDUA_HERMES_BINARY environment variable"
    );
  });

  it("documents PATH fallback for hermes binary discovery", () => {
    assert.ok(
      skillContent.includes("PATH") &&
      (skillContent.includes("hermes") || skillContent.includes("Hermes")),
      "SKILL.md must document that hermes is searched on PATH when TAMANDUA_HERMES_BINARY is not set"
    );
  });

  it("documents harness flags as mutually exclusive", () => {
    assert.ok(
      skillContent.match(/mutually exclusive/i),
      "SKILL.md must state harness flags are mutually exclusive"
    );
  });

  it("states pi is the default harness", () => {
    assert.ok(
      skillContent.match(/pi.*default|default.*pi/i),
      "SKILL.md must state that pi is the default harness"
    );
  });

  it("workflow run command row includes harness flags", () => {
    assert.ok(
      skillContent.includes("[--pi-as-harness | --hermes-as-harness | --dsh-as-harness]"),
      "SKILL.md workflow run command row must show harness flags"
    );
  });

  it("documents scheduling-time validation of hermes binary", () => {
    assert.ok(
      skillContent.match(/scheduling.*time/),
      "SKILL.md must document that hermes binary is validated at scheduling time"
    );
  });
});
