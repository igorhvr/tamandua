import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

// REROUTE-BUDGET (US-008) documentation contract.
//
// Pins the docs that describe NPF-3 (stale-tip target_moved reroutes get
// their own budget, default 16, and never consume max_reroutes) and the
// truthful landing report (NPF-1). These assertions exist so a future edit
// cannot silently drop the new budget/event vocabulary from the motor
// contract or the user-facing docs.

const PROJECT_ROOT = (() => {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "tests", "MOTOR-CONTRACT.md"))) return cwd;
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, "..");
})();

function read(rel: string): string {
  return fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf-8");
}

// Markdown emphasis is cosmetic; drop bold markers before matching prose.
function deBold(text: string): string {
  return text.replace(/\*\*/g, "");
}

describe("REROUTE-BUDGET docs: MOTOR-CONTRACT.md C19/C8-rugpull", () => {
  let contract: string;

  before(() => {
    contract = read("tests/MOTOR-CONTRACT.md");
  });

  it("documents the target_moved subset counter", () => {
    assert.match(
      contract,
      /target_moved_reroute_count/,
      "MOTOR-CONTRACT.md must document target_moved_reroute_count",
    );
  });

  it("documents the default-16 target-moved cap", () => {
    assert.match(
      contract,
      /max_target_moved_reroutes[\s\S]{0,48}default 16/,
      "MOTOR-CONTRACT.md must document on_fail.max_target_moved_reroutes (default 16)",
    );
  });

  it("documents the shared-budget formula", () => {
    assert.match(
      contract,
      /reroute_count - target_moved_reroute_count/,
      "MOTOR-CONTRACT.md must document shared-budget consumption reroute_count - target_moved_reroute_count",
    );
  });

  it("documents the target_moved_exhausted FAILURE_CLASS", () => {
    assert.match(
      contract,
      /FAILURE_CLASS: target_moved_exhausted/,
      "MOTOR-CONTRACT.md must document the target_moved_exhausted FAILURE_CLASS",
    );
  });

  it("documents the step.target_moved_reroute_exhausted event", () => {
    assert.match(
      contract,
      /step\.target_moved_reroute_exhausted/,
      "MOTOR-CONTRACT.md must document the step.target_moved_reroute_exhausted event",
    );
  });

  it("states reroute_count stays the total reroute counter", () => {
    assert.match(
      contract,
      /reroute_count == count\(step\.rerouted\)/,
      "MOTOR-CONTRACT.md must state reroute_count == count(step.rerouted)",
    );
  });

  it("still states the rugpull replacement-run logic is unchanged", () => {
    assert.match(
      contract,
      /Rugpull\s+replacement-run logic is unchanged/i,
      "MOTOR-CONTRACT.md must keep stating rugpull replacement-run logic is unchanged",
    );
  });
});

describe("REROUTE-BUDGET docs: creating-workflows.md", () => {
  let doc: string;

  before(() => {
    doc = read("docs/creating-workflows.md");
  });

  it("documents on_fail.max_target_moved_reroutes and its default", () => {
    assert.match(
      doc,
      /on_fail\.max_target_moved_reroutes/,
      "docs/creating-workflows.md must document on_fail.max_target_moved_reroutes",
    );
    assert.match(
      doc,
      /max_target_moved_reroutes[\s\S]{0,40}default\s*`?16`?/i,
      "docs/creating-workflows.md must document the default-16 cap",
    );
  });

  it("documents the step.target_moved_reroute_exhausted event", () => {
    assert.match(
      doc,
      /step\.target_moved_reroute_exhausted/,
      "docs/creating-workflows.md must document step.target_moved_reroute_exhausted",
    );
  });

  it("documents that target_moved reroutes do not consume max_reroutes", () => {
    assert.match(
      deBold(doc),
      /target_moved[\s\S]{0,300}do(?:es)?\s+not\s+consume\s+`?max_reroutes`?/i,
      "docs/creating-workflows.md must state target_moved reroutes do not consume max_reroutes",
    );
  });
});

describe("REROUTE-BUDGET docs: agents SKILL.md", () => {
  let skill: string;

  before(() => {
    skill = read("skills/tamandua-agents/SKILL.md");
  });

  it("mentions the new budget and event", () => {
    assert.match(
      skill,
      /max_target_moved_reroutes/,
      "skills/tamandua-agents/SKILL.md must mention max_target_moved_reroutes",
    );
    assert.match(
      skill,
      /step\.target_moved_reroute_exhausted/,
      "skills/tamandua-agents/SKILL.md must mention step.target_moved_reroute_exhausted",
    );
  });
});

describe("REROUTE-BUDGET docs: README.md and www/index.html", () => {
  it("README.md mentions the target-moved budget and its separation", () => {
    const readme = read("README.md");
    assert.match(readme, /target_moved/, "README.md must mention target_moved reroutes");
    assert.match(
      readme,
      /max_target_moved_reroutes[\s\S]{0,40}default 16/i,
      "README.md must mention the default-16 target-moved budget",
    );
    assert.match(
      deBold(readme),
      /target_moved[\s\S]{0,300}do(?:es)?\s+not\s+consume\s+`?max_reroutes`?/i,
      "README.md must state the target-moved budget does not consume max_reroutes",
    );
  });

  it("www/index.html mentions the target-moved budget and its separation", () => {
    const www = read("www/index.html");
    assert.match(www, /target_moved/, "www/index.html must mention target_moved reroutes");
    assert.match(
      www,
      /max_target_moved_reroutes[\s\S]{0,40}default 16/i,
      "www/index.html must mention the default-16 target-moved budget",
    );
    assert.match(
      www,
      /do(?:es)?\s+not\s+consume\s+<code>max_reroutes<\/code>/i,
      "www/index.html must state the target-moved budget does not consume max_reroutes",
    );
  });
});
