import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBundledWorkflowsDir } from "../dist/installer/paths.js";

/**
 * US-004: coding personas must warn that story commits are squashed at
 * landing. The exact sentence is pinned verbatim here so any removal or
 * rewording fails the suite.
 */
const COMMIT_SQUASH_WARNING =
  "This run's story commits are squashed at landing, so their ids do not survive. " +
  "If a file you commit must identify a version (a pin, provenance or readiness record), " +
  "use a content hash of the pinned files or a stable upstream id, never " +
  "`git rev-parse HEAD` or a story commit id from this run.";

// The eight coding personas (each merge workflow plus its -worktree variant,
// whose agent dirs symlink back to the merge workflow) and the committing
// rules section the warning must live in.
const CODING_PERSONAS = [
  { workflowId: "feature-dev-merge", agentDir: "developer", section: "## Commits" },
  { workflowId: "feature-dev-merge-worktree", agentDir: "developer", section: "## Commits" },
  { workflowId: "bug-fix-merge", agentDir: "fixer", section: "## Commit Message" },
  { workflowId: "bug-fix-merge-worktree", agentDir: "fixer", section: "## Commit Message" },
  { workflowId: "security-audit-merge", agentDir: "fixer", section: "## Commit Format" },
  { workflowId: "security-audit-merge-worktree", agentDir: "fixer", section: "## Commit Format" },
  { workflowId: "quarantine-broken-tests-merge", agentDir: "quarantiner", section: "## Important" },
  {
    workflowId: "quarantine-broken-tests-merge-worktree",
    agentDir: "quarantiner",
    section: "## Important",
  },
] as const;

const workflowsDir = resolveBundledWorkflowsDir();

function personaPath(workflowId: string, agentDir: string): string {
  return join(workflowsDir, workflowId, "agents", agentDir, "AGENTS.md");
}

function sectionBody(content: string, heading: string): string {
  const start = content.indexOf(heading);
  assert.ok(start !== -1, `missing section heading ${JSON.stringify(heading)}`);
  const afterHeading = content.indexOf("\n", start) + 1;
  const nextHeading = content.indexOf("\n## ", afterHeading);
  const end = nextHeading === -1 ? content.length : nextHeading;
  return content.slice(afterHeading, end);
}

describe("coding persona commit-squash warning (US-004)", () => {
  it("appears verbatim in all eight coding personas", () => {
    for (const { workflowId, agentDir } of CODING_PERSONAS) {
      const path = personaPath(workflowId, agentDir);
      const content = readFileSync(path, "utf-8");
      assert.ok(
        content.includes(COMMIT_SQUASH_WARNING),
        `${workflowId}/${agentDir}/AGENTS.md must contain the exact commit-squash warning:\n  ${COMMIT_SQUASH_WARNING}`,
      );
    }
  });

  it("lives inside each persona's committing-rules section", () => {
    for (const { workflowId, agentDir, section } of CODING_PERSONAS) {
      const path = personaPath(workflowId, agentDir);
      const content = readFileSync(path, "utf-8");
      const body = sectionBody(content, section);
      assert.ok(
        body.includes(COMMIT_SQUASH_WARNING),
        `${workflowId}/${agentDir}/AGENTS.md: commit-squash warning must be inside ${JSON.stringify(section)}, not elsewhere`,
      );
    }
  });
});
