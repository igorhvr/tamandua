import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const skillPath = resolve(import.meta.dirname, "..", "skills", "tamandua-agents", "SKILL.md");
const skillContent = readFileSync(skillPath, "utf-8");

// Slice of the document covering only the dsh support section, so
// assertions about dsh wording cannot pass by matching the Hermes section.
const sectionHeading = "### dsh (DeepSeek Harness) support (Alpha)";
const sectionStart = skillContent.indexOf(sectionHeading);
const dshSection =
  sectionStart >= 0
    ? skillContent.slice(sectionStart, skillContent.indexOf("## Services & maintenance", sectionStart))
    : "";

describe("SKILL.md dsh (DeepSeek Harness) documentation", () => {
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

  it("contains a dsh (DeepSeek Harness) support section", () => {
    assert.ok(
      sectionStart >= 0,
      "SKILL.md must contain a '### dsh (DeepSeek Harness) support (Alpha)' section"
    );
  });

  it("documents the --dsh-as-harness flag", () => {
    assert.ok(
      dshSection.includes("--dsh-as-harness"),
      "SKILL.md dsh section must document the --dsh-as-harness flag"
    );
  });

  it("warns dsh support is alpha quality", () => {
    assert.ok(
      dshSection.match(/alpha/i),
      "SKILL.md dsh section must warn that dsh support is alpha quality"
    );
    assert.ok(
      dshSection.includes("release candidate"),
      "SKILL.md dsh section must note dsh itself is a release candidate"
    );
  });

  it("documents the three-tier binary resolution chain", () => {
    assert.ok(
      dshSection.includes("three-tier"),
      "SKILL.md dsh section must document the three-tier resolution chain"
    );
    assert.ok(
      dshSection.includes("Tier 1") && dshSection.includes("Tier 2") && dshSection.includes("Tier 3"),
      "SKILL.md dsh section must enumerate the three resolution tiers"
    );
  });

  it("documents TAMANDUA_DSH_BINARY env var", () => {
    assert.ok(
      dshSection.includes("TAMANDUA_DSH_BINARY"),
      "SKILL.md dsh section must document the TAMANDUA_DSH_BINARY environment variable"
    );
  });

  it("documents PATH fallback with dsh-token-saver preference", () => {
    assert.ok(
      dshSection.includes("dsh-token-saver"),
      "SKILL.md dsh section must document the dsh-token-saver PATH preference"
    );
    assert.ok(
      dshSection.includes("PATH"),
      "SKILL.md dsh section must document dsh PATH discovery"
    );
  });

  it("documents the zsh login-shell fallback tier", () => {
    assert.ok(
      dshSection.includes("zsh -lic 'command -v dsh'"),
      "SKILL.md dsh section must document the bounded zsh login-shell fallback"
    );
  });

  it("documents the unconditional DSH_PERMISSION_MODE=danger-full-access injection", () => {
    assert.ok(
      dshSection.includes("DSH_PERMISSION_MODE=danger-full-access"),
      "SKILL.md dsh section must document the injected permission mode"
    );
    assert.ok(
      dshSection.includes("unconditionally") || dshSection.includes("every worker spawn"),
      "SKILL.md dsh section must state the injection is unconditional on every spawn"
    );
    assert.ok(
      dshSection.includes("process-scoped"),
      "SKILL.md dsh section must state the injection is process-scoped"
    );
  });

  it("documents the profile-pin caveat", () => {
    assert.ok(
      dshSection.includes("cordis.patch.yml"),
      "SKILL.md dsh section must document the cordis.patch.yml profile-pin caveat"
    );
    assert.ok(
      dshSection.match(/profile.*override|override.*profile/i) || dshSection.includes("overrides the injection"),
      "SKILL.md dsh section must explain that a profile pin overrides the injection"
    );
  });

  it("documents where dsh token usage comes from", () => {
    assert.ok(
      dshSection.includes("session.jsonl.zstd"),
      "SKILL.md dsh section must document that tokens are read from session.jsonl.zstd"
    );
    assert.ok(
      dshSection.includes("best-effort") || dshSection.includes("falls back"),
      "SKILL.md dsh section must document that token accounting is best-effort"
    );
    assert.ok(
      dshSection.includes("cache reads excluded"),
      "SKILL.md dsh section must document that cache reads are excluded from the total"
    );
  });

  it("documents absolute-path invocation", () => {
    assert.ok(
      dshSection.match(/always absolute/i),
      "SKILL.md dsh section must document that resolved dsh paths are always absolute"
    );
  });

  it("documents child-only PATH adjustment", () => {
    assert.ok(
      dshSection.match(/prepended to the child's `PATH`/i),
      "SKILL.md dsh section must document the child-only PATH prepend"
    );
  });

  it("documents zero filesystem mutation", () => {
    assert.ok(
      dshSection.match(/side-effect-free/i),
      "SKILL.md dsh section must document that dsh discovery is side-effect-free"
    );
  });

  it("documents harness flags as mutually exclusive", () => {
    assert.ok(
      dshSection.match(/mutually exclusive/i),
      "SKILL.md dsh section must state harness flags are mutually exclusive"
    );
  });

  it("recommends pi for production use", () => {
    assert.ok(
      dshSection.match(/default and recommended harness for production/i),
      "SKILL.md dsh section must recommend pi for production use"
    );
  });

  it("workflow run command row includes the dsh harness flag", () => {
    assert.ok(
      skillContent.includes("[--pi-as-harness | --hermes-as-harness | --dsh-as-harness]"),
      "SKILL.md workflow run command row must show all three harness flags"
    );
  });
});
