import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readmePath = resolve(import.meta.dirname, "..", "README.md");
const readmeContent = readFileSync(readmePath, "utf-8");

describe("README dsh harness documentation", () => {
  it("documents --dsh-as-harness flag", () => {
    assert.ok(
      readmeContent.includes("--dsh-as-harness"),
      "README must document --dsh-as-harness flag"
    );
  });

  it("names the harness DeepSeek Harness (dsh)", () => {
    assert.ok(
      readmeContent.includes("DeepSeek Harness (`dsh`)") ||
      readmeContent.includes("DeepSeek Harness (dsh)"),
      "README must name the harness DeepSeek Harness (dsh) on first mention"
    );
  });

  it("warns dsh is alpha quality wherever mentioned", () => {
    assert.ok(
      readmeContent.includes("Alpha quality"),
      "README must warn about dsh alpha quality status"
    );
    assert.ok(
      readmeContent.match(/dsh.*alpha/i) || readmeContent.match(/alpha.*dsh/i),
      "README must link dsh mentions to alpha status"
    );
  });

  it("recommends pi for production workflows", () => {
    assert.ok(
      readmeContent.match(/Use pi.*for production/),
      "README must recommend pi for production workflows in the dsh section"
    );
  });

  it("documents best-effort token accounting read from dsh session files", () => {
    assert.ok(
      readmeContent.includes("session files") ||
      readmeContent.includes("session.jsonl.zstd"),
      "README must document that dsh token usage is read from session files"
    );
    assert.ok(
      readmeContent.includes("best-effort") &&
      readmeContent.includes("falls back"),
      "README must document that dsh token accounting is best-effort and falls back to 0 tokens"
    );
  });

  it("documents no per-run model selection", () => {
    assert.ok(
      readmeContent.match(/no per-run model\s*selection/i),
      "README must document that dsh has no per-run model selection"
    );
    assert.ok(
      readmeContent.match(/model comes from the dsh profile/i),
      "README must document that the model comes from the dsh profile"
    );
  });

  it("documents dsh release candidate status", () => {
    assert.ok(
      readmeContent.match(/release candidate/i),
      "README must document that dsh itself is a release candidate"
    );
  });

  it("documents TAMANDUA_DSH_BINARY env var", () => {
    assert.ok(
      readmeContent.includes("TAMANDUA_DSH_BINARY"),
      "README must document TAMANDUA_DSH_BINARY environment variable"
    );
  });

  it("documents three-tier binary resolution with login-shell fallback", () => {
    assert.ok(
      readmeContent.includes("three-tier"),
      "README must document the three-tier dsh resolution chain"
    );
    assert.ok(
      readmeContent.includes("Tier 1") &&
      readmeContent.includes("Tier 2") &&
      readmeContent.includes("Tier 3"),
      "README must document all three dsh resolution tiers"
    );
    assert.ok(
      readmeContent.includes("zsh -lic 'command -v dsh'"),
      "README must document the login-shell fallback tier"
    );
  });

  it("documents dsh-token-saver PATH preference", () => {
    assert.ok(
      readmeContent.includes("dsh-token-saver"),
      "README must document the dsh-token-saver wrapper"
    );
  });

  it("documents the mandatory DSH_PERMISSION_MODE=danger-full-access injection", () => {
    assert.ok(
      readmeContent.includes("DSH_PERMISSION_MODE=danger-full-access"),
      "README must document the always-injected DSH_PERMISSION_MODE=danger-full-access"
    );
    assert.ok(
      readmeContent.includes("--yolo"),
      "README must describe the injection as the dsh equivalent of hermes --yolo"
    );
  });

  it("documents the injection is process-scoped with no disk mutation", () => {
    assert.ok(
      readmeContent.includes("process-scoped"),
      "README must state the permission injection is process-scoped"
    );
    assert.ok(
      readmeContent.match(/nothing under `~\/\.dsh`[\s\S]{0,80}(is ever|is never) created or modified/i),
      "README must state nothing under ~/.dsh is created or modified"
    );
  });

  it("documents the cordis.patch.yml profile-pin caveat with doctor warning", () => {
    assert.ok(
      readmeContent.includes("cordis.patch.yml"),
      "README must document the cordis.patch.yml profile-pin caveat"
    );
    assert.ok(
      readmeContent.match(/doctor.*warn|warn.*doctor/i),
      "README must state tamandua doctor warns about the profile-pin override"
    );
  });

  it("workflow run command row includes the dsh harness flag", () => {
    assert.ok(
      readmeContent.includes("[--pi-as-harness \\| --hermes-as-harness \\| --dsh-as-harness]") ||
      readmeContent.includes("[--pi-as-harness | --hermes-as-harness | --dsh-as-harness]"),
      "README workflow run command row must show the dsh harness flag"
    );
  });

  it("mermaid harness node mentions dsh (alpha)", () => {
    assert.ok(
      readmeContent.includes("or Hermes / dsh, alpha"),
      "README mermaid diagram must mention dsh (alpha) in the harness node"
    );
  });
});
