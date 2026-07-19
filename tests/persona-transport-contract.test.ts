import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function discoverPersonaFiles(
  sharedRoot = "agents/shared",
  workflowsRoot = "workflows",
): string[] {
  const shared = readdirSync(sharedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => join(sharedRoot, entry.name, "AGENTS.md"));
  const workflows = readdirSync(workflowsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const bundled = workflows.flatMap((workflow) => {
    const agentsDir = join(workflowsRoot, workflow.name, "agents");
    try {
      return readdirSync(agentsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => join(agentsDir, entry.name, "AGENTS.md"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to inventory workflow "${workflow.name}" personas at ${agentsDir}: ${detail}`,
        { cause: error },
      );
    }
  });
  return [...shared, ...bundled].sort();
}

describe("agent persona transport-file guidance", () => {
  const personaFiles = discoverPersonaFiles();

  it("fails when a bundled workflow agents directory cannot be inventoried", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "tamandua-persona-inventory-"));
    const sharedRoot = join(fixtureRoot, "agents", "shared");
    const workflowsRoot = join(fixtureRoot, "workflows");
    const completeAgentsRoot = join(workflowsRoot, "complete-workflow", "agents");

    try {
      mkdirSync(sharedRoot, { recursive: true });
      mkdirSync(completeAgentsRoot, { recursive: true });
      for (let index = 0; index < 80; index += 1) {
        mkdirSync(join(completeAgentsRoot, `persona-${index}`));
      }
      assert.equal(discoverPersonaFiles(sharedRoot, workflowsRoot).length, 80);

      mkdirSync(join(workflowsRoot, "missing-agents-workflow"));

      assert.throws(
        () => discoverPersonaFiles(sharedRoot, workflowsRoot),
        /missing-agents-workflow.*agents/,
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("inventories every canonical and bundled persona, including variants", () => {
    assert.ok(personaFiles.length >= 79, `expected all persona variants, found ${personaFiles.length}`);
    assert.ok(personaFiles.includes("agents/shared/setup/AGENTS.md"));
    assert.ok(personaFiles.includes("workflows/feature-dev/agents/planner/AGENTS.md"));
    assert.ok(personaFiles.includes("workflows/feature-dev-merge/agents/planner/AGENTS.md"));
  });

  for (const personaFile of personaFiles) {
    it(`${personaFile} keeps transport artifacts external and preserves validation`, () => {
      const persona = readFileSync(personaFile, "utf8");
      if (personaFile === "workflows/do-review-do-verify/agents/doer/AGENTS.md") {
        assert.match(persona, /^STATUS: done\|failed$/m, "must preserve the doer's intentional combined variant");
      } else {
        assert.match(persona, /^STATUS: done$/m, "must preserve the exact success marker");
      }
      assert.match(persona, /REJECTED/, "must preserve rejected-submission guidance");
      assert.match(persona, /submit-time `?expects`? validation/i);
      assert.match(persona, /outside the repository\/worktree/i);
      assert.match(persona, /\$\{TMPDIR:-\/tmp\}/, "must recommend an external temp directory");
      assert.match(persona, /mktemp/, "must require a unique securely-created path");
      assert.match(persona, /rm -f/, "must document caller cleanup");
      assert.doesNotMatch(persona, /\breport\.txt\b/, "must not suggest a bare report path");
      assert.doesNotMatch(persona, /\breason\.txt\b/, "must not suggest a bare reason path");
      assert.doesNotMatch(persona, /--file\s+report\.txt/);
      assert.doesNotMatch(persona, /--reason-file\s+reason\.txt/);
      assert.doesNotMatch(persona, /STORIES_JSON_FILE:\s+stories\.json/);
    });
  }
});
