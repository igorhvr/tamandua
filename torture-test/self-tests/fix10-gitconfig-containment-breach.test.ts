// FIX10 US-001 forensic-audit gate: the ~/.gitconfig containment breach
// FINDING is documented and the audit inventory it pins stays true.
//
// Regression net for the 2026-08-05 breach (torture-test case/hook wrote
// `Tamandua Tier-0 <tier0@tetradactyla.invalid>` into the OPERATOR's real
// ~/.gitconfig). The FINDING section of impl-tasks/
// FIX10-gitconfig-containment-breach.md names the exact writer, the leak
// mechanism (GIT_CONFIG_GLOBAL=$HOME/.gitconfig + uncontained HOME), the
// grep containment inventory, the campaign-timing availability, and the
// no-history-rewrite decision for the 14 mis-authored commits.
//
// This test is audit + documentation only: it reads files and asserts
// content; it never modifies behavior code and never touches ~/.gitconfig.
// Confined to torture-test/. Zero tokens.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const FINDING_DOC = path.join(ttRoot, "impl-tasks", "FIX10-gitconfig-containment-breach.md");
const HOOK = path.join(ttRoot, "cases", "hooks", "run-w0.1");
const EXCLUDED_DIRS = new Set(["var", "node_modules", ".git", "self-tests"]);

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

// Walk torture-test/ (minus var/, node_modules/) and collect every file
// that contains a `git config` invocation (write sites, reads, and guards).
function collectGitConfigSites(): Array<{ file: string; lines: string[] }> {
  const sites: Array<{ file: string; lines: string[] }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (entry.name.endsWith(".md") || entry.name.endsWith(".json")) continue;
      const full = path.join(dir, entry.name);
      const lines = read(full).split(/\r?\n/);
      const hits = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /git config\b/.test(line))
        .map(({ line, index }) => `${index + 1}: ${line}`);
      if (hits.length > 0) sites.push({ file: path.relative(ttRoot, full), lines: hits });
    }
  };
  walk(ttRoot);
  return sites;
}

function globalWriteSites(): Array<{ file: string; lines: string[] }> {
  return collectGitConfigSites()
    .map((site) => ({
      file: site.file,
      lines: site.lines.filter((line) => /git config --global\b/.test(line)),
    }))
    .filter((site) => site.lines.length > 0);
}

describe("FIX10 US-001 forensic audit (gitconfig containment breach)", () => {
  it("FINDING section exists and names the exact writer (file:line) and identity", () => {
    const doc = read(FINDING_DOC);
    assert.match(doc, /## FINDING \(US-001 forensic audit/,
      "the FINDING section header must exist");
    assert.match(doc, /torture-test\/cases\/hooks\/run-w0\.1:24-26/,
      "FINDING must name the exact writer as cases/hooks/run-w0.1:24-26");
    assert.match(doc, /git config --global user\.name "Tamandua Tier-0"/,
      "FINDING must quote the exact user.name write");
    assert.match(doc, /git config --global user\.email "tier0@tetradactyla\.invalid"/,
      "FINDING must quote the exact user.email write");
    assert.match(doc, /git config --global commit\.gpgsign false/,
      "FINDING must quote the exact commit.gpgsign write");
  });

  it("FINDING documents the leak mechanism (GIT_CONFIG_GLOBAL=$HOME/.gitconfig + uncontained HOME)", () => {
    const doc = read(FINDING_DOC);
    assert.match(doc, /GIT_CONFIG_GLOBAL="\$HOME\/\.gitconfig"/,
      "FINDING must name GIT_CONFIG_GLOBAL=$HOME/.gitconfig as the scoping line");
    assert.match(doc, /the real\s+`?~\/\.gitconfig/,
      "FINDING must state the write lands in the real ~/.gitconfig under the operator HOME");
    assert.match(doc, /preserv(?:ing|es)[\s\S]{0,80}signingkey, push, merge/,
      "FINDING must note the breach preserved unrelated gitconfig sections");
  });

  it("grep inventory table lists every git-config write site with containment status", () => {
    const doc = read(FINDING_DOC);
    assert.match(doc, /## Containment inventory/,
      "FINDING must contain a containment inventory section");
    assert.match(doc, /run-w0\.1:24-26[\s\S]*CONTROLLER-CONTAINED ONLY[\s\S]*fail-open/i,
      "FINDING must mark run-w0.1 as controller-contained only / fail-open");
    assert.match(doc, /GIT_CONFIG_GLOBAL=\/dev\/null/,
      "FINDING must note oracles pin GIT_CONFIG_GLOBAL=/dev/null");
    assert.match(doc, /repo-local/, "FINDING must classify the repo-local build-golden writes");
  });

  it("campaign timing evidence is correlated or explicitly recorded as unavailable", () => {
    const doc = read(FINDING_DOC);
    assert.match(doc, /campaign-20260805T140754Z/,
      "FINDING must reference the first acceptance campaign");
    assert.match(doc, /campaign-20260805T163154Z/,
      "FINDING must reference the second acceptance campaign");
    assert.match(doc, /UNAVAILABLE in this checkout/,
      "FINDING must record the per-case campaign evidence availability");
  });

  it("FINDING notes the 14 mis-authored commits and the no-history-rewrite decision", () => {
    const doc = read(FINDING_DOC);
    assert.match(doc, /14 mis-authored commits \(NOT rewritten\)/,
      "FINDING must state the 14 mis-authored commits and that they are NOT rewritten");
    assert.match(doc, /tier0@tetradactyla\.invalid/,
      "FINDING must name the wrong-author identity");
    assert.match(doc, /restored by hand/,
      "FINDING must note the operator identity was restored by hand");
    assert.match(doc, /never be touched by this work|do NOT touch ~\/\.gitconfig/,
      "FINDING must restate the never-touch-~/.gitconfig constraint");
  });

  it("the ONLY git config --global write site in torture-test/ is cases/hooks/run-w0.1", () => {
    const sites = globalWriteSites();
    assert.deepEqual(
      sites.map((site) => site.file),
      ["cases/hooks/run-w0.1"],
      `unexpected --global write site(s): ${JSON.stringify(sites, null, 2)}`,
    );
    // Line numbers are intentionally NOT pinned: US-002 added the
    // containment guard ahead of these writes, shifting them. Assert the
    // exact write content instead (prefix is "<line>: ").
    assert.deepEqual(
      sites[0]?.lines.map((line) => line.replace(/^\d+: /, "")),
      [
        'git config --global user.name "Tamandua Tier-0"',
        'git config --global user.email "tier0@tetradactyla.invalid"',
        "git config --global commit.gpgsign false",
      ],
    );
  });

  it("run-w0.1 scopes the global write target to $HOME/.gitconfig (contained iff HOME is)", () => {
    const hook = read(HOOK);
    assert.match(hook, /GIT_CONFIG_GLOBAL="\$HOME\/\.gitconfig"/,
      "run-w0.1 must set GIT_CONFIG_GLOBAL=$HOME/.gitconfig");
    assert.match(hook, /GIT_CONFIG_NOSYSTEM=1/, "run-w0.1 must set GIT_CONFIG_NOSYSTEM=1");
  });

  it("oracles and w4.25 scenario spawns pin GIT_CONFIG_GLOBAL to /dev/null (fail-closed)", () => {
    const oracleGit = read(path.join(ttRoot, "oracles", "lib", "git.mjs"));
    assert.match(oracleGit, /GIT_CONFIG_GLOBAL: '\/dev\/null'/,
      "oracles/lib/git.mjs must pin GIT_CONFIG_GLOBAL to /dev/null");
    const w425Upgrade = read(path.join(ttRoot, "scenarios", "w4.25", "run-upgrade.mjs"));
    assert.match(w425Upgrade, /GIT_CONFIG_GLOBAL: "\/dev\/null"/,
      "w4.25 daemon spawn must pin GIT_CONFIG_GLOBAL to /dev/null");
  });
});
