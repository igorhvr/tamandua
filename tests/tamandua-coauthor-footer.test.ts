import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveBundledWorkflowsDir } from "../dist/installer/paths.js";

const TAMANDUA_FOOTER = "Co-Authored-By: Tamandua <tamandua@tetradactyla.org>";
const CLAUDE_FOOTER_PREFIX = "Co-Authored-By: Claude";
const MIGRATED_MERGER_WORKFLOW_IDS = [
  "bug-fix-merge",
  "bug-fix-merge-worktree",
  "quarantine-broken-tests-merge",
  "quarantine-broken-tests-merge-worktree",
  "security-audit-merge",
  "security-audit-merge-worktree",
] as const;

const workflowsDir = resolveBundledWorkflowsDir();
const workflowIds = readdirSync(workflowsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

/**
 * Collect all persona AGENTS.md files under workflows/<id>/agents/ that
 * construct commits, either through porcelain or the atomic landing command.
 */
function findPersonaFilesWithCommitInstructions(): { workflowId: string; path: string }[] {
  const results: { workflowId: string; path: string }[] = [];
  for (const wfId of workflowIds) {
    const agentsDir = join(workflowsDir, wfId, "agents");
    if (!existsSync(agentsDir)) continue;
    const agentDirs = readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink());
    for (const agentDir of agentDirs) {
      const agentsMdPath = join(agentsDir, agentDir.name, "AGENTS.md");
      if (!existsSync(agentsMdPath)) continue;
      const content = readFileSync(agentsMdPath, "utf-8");
      if (content.includes("git commit") || content.includes("tamandua merge-branch")) {
        results.push({ workflowId: wfId, path: agentsMdPath });
      }
    }
  }
  return results;
}

describe("Tamandua co-author footer", () => {
  const personaFiles = findPersonaFilesWithCommitInstructions();

  it("finds at least the known merger personas with commit instructions", () => {
    const paths = personaFiles.map((f) => f.path);
    assert.ok(
      paths.some((p) => p.includes("feature-dev-merge")),
      "should include feature-dev-merge merger persona",
    );
    assert.ok(
      paths.some((p) => p.includes("bug-fix-merge")),
      "should include bug-fix-merge merger persona",
    );
  });

  it("finds all six merger personas migrated to merge-branch", () => {
    const workflowIdsWithCommitInstructions = new Set(
      personaFiles.map((file) => file.workflowId),
    );

    for (const workflowId of MIGRATED_MERGER_WORKFLOW_IDS) {
      assert.ok(
        workflowIdsWithCommitInstructions.has(workflowId),
        `${workflowId}: migrated merger persona must be checked for the Tamandua footer`,
      );
    }
  });

  it("every bundled persona with commit instructions contains the Tamandua co-author footer", () => {
    assert.ok(
      personaFiles.length > 0,
      "expected at least one persona file with commit instructions",
    );
    for (const { workflowId, path } of personaFiles) {
      const content = readFileSync(path, "utf-8");
      assert.ok(
        content.includes(TAMANDUA_FOOTER),
        `${workflowId}: ${path} must contain exact footer string:\n  ${TAMANDUA_FOOTER}`,
      );
    }
  });

  it("the Claude co-author footer is NOT present in any bundled persona with commit instructions", () => {
    for (const { workflowId, path } of personaFiles) {
      const content = readFileSync(path, "utf-8");
      assert.ok(
        !content.includes(CLAUDE_FOOTER_PREFIX),
        `${workflowId}: ${path} must NOT contain Claude co-author footer`,
      );
    }
  });

  it("the exact Tamandua footer string is distinguishable from the Claude footer — Claude prefix is not a substring of Tamandua footer", () => {
    // Self-consistency guard: the Tamandua footer should not contain
    // the Claude prefix, ensuring our match is specific.
    assert.ok(
      !TAMANDUA_FOOTER.includes(CLAUDE_FOOTER_PREFIX),
      "Tamandua footer must not contain Claude prefix — ensures exact match is distinguishable",
    );
  });
});
