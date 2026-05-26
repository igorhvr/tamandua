import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBundledWorkflowsDir } from "../dist/installer/paths.js";
import { loadWorkflowSpec } from "../dist/installer/workflow-spec.js";

const workflowsDir = resolveBundledWorkflowsDir();
const bundledIds = readdirSync(workflowsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(resolve(workflowsDir, d.name, "workflow.yml")))
  .map((d) => d.name);

const readmePath = resolve(workflowsDir, "..", "README.md");
const readmeContent = readFileSync(readmePath, "utf-8");

describe("README workflow documentation", () => {
  it("documents all 22 bundled workflows in the README", () => {
    assert.equal(bundledIds.length, 22);
    for (const id of bundledIds) {
      // Each workflow ID should appear in the README, wrapped in backtick code spans
      // like `feature-dev` or `bug-fix-merge-worktree`
      const pattern = new RegExp("`" + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "`");
      assert.ok(
        pattern.test(readmeContent),
        `Workflow '${id}' must be documented in README.md`
      );
    }
  });

  it("documents worktree variants with an explanation section", () => {
    assert.ok(
      readmeContent.includes("### Worktree Variants"),
      "README must have a Worktree Variants section explaining worktree isolation"
    );
    assert.ok(
      readmeContent.includes("detached git worktree"),
      "Worktree explanation must mention detached git worktree"
    );
  });

  it("organizes workflows by family with variant tables", () => {
    assert.ok(
      readmeContent.includes("### Feature Development"),
      "Must have Feature Development family section"
    );
    assert.ok(
      readmeContent.includes("### Bug Fix"),
      "Must have Bug Fix family section"
    );
    assert.ok(
      readmeContent.includes("### Security Audit"),
      "Must have Security Audit family section"
    );
    assert.ok(
      readmeContent.includes("### Quarantine Broken Tests"),
      "Must have Quarantine Broken Tests family section"
    );
    assert.ok(
      readmeContent.includes("### ML AutoResearch"),
      "Must have ML AutoResearch family section"
    );
    assert.ok(
      readmeContent.includes("### Quick Tasks"),
      "Must have Quick Tasks family section"
    );
  });

  it("references tamandua workflow list command", () => {
    assert.ok(
      readmeContent.includes("tamandua workflow list"),
      "README should mention tamandua workflow list"
    );
  });

  it("documents rugpull replacement-run behavior", () => {
    assert.ok(
      readmeContent.includes("### Rugpull Handling"),
      "README must have a Rugpull Handling section"
    );
    assert.ok(
      readmeContent.includes("--no-relaunch-upon-rugpull"),
      "README must document --no-relaunch-upon-rugpull option"
    );
    assert.ok(
      readmeContent.includes("replacement run") || readmeContent.includes("replacement-run"),
      "README must mention replacement run behavior"
    );
  });
});

describe("README workflow pipeline and agent count accuracy", () => {
  it("feature-dev Quick Example does not show pr or review steps", () => {
    // The Quick Example section uses feature-dev, which is local-only (5 steps, no pr/review).
    // Make sure the example status output does not include pr or review steps.
    const afterStatus = readmeContent.split("tamandua workflow status")[1];
    assert.ok(afterStatus, "Should find status output example");
    const statusExample = afterStatus.split("\n```")[0];
    assert.ok(statusExample, "Should extract status example block");
    assert.doesNotMatch(statusExample, /\[pending\] pr/, "feature-dev example must not show pr step");
    assert.doesNotMatch(statusExample, /\[pending\] review/, "feature-dev example must not show review step");
    assert.match(statusExample, /\[pending\] test \(tester\)/);
    assert.doesNotMatch(statusExample, /\[pending\] finalize_merge/);
  });

  for (const id of bundledIds) {
    it(`${id} README reports correct agent count`, async () => {
      const spec = await loadWorkflowSpec(resolve(workflowsDir, id));
      const agentCount = spec.agents.length;
      // README should mention "N agents" near the workflow ID
      const idPattern = new RegExp(
        "`" + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "`[^|]*\\|" +
        "\\s*" + agentCount + "\\s*\\|",
      );
      assert.ok(
        idPattern.test(readmeContent),
        `${id}: README should show ${agentCount} agents in its table row`
      );
    });

    it(`${id} README reports correct pipeline steps`, async () => {
      const spec = await loadWorkflowSpec(resolve(workflowsDir, id));
      const pipeline = spec.steps.map((s) => s.id).join(" → ");
      // README pipeline column should contain the step sequence
      assert.ok(
        readmeContent.includes(pipeline),
        `${id}: README should show pipeline "${pipeline}" in its table row`
      );
    });
  }
});
