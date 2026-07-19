import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function discoverPersonaFiles(): string[] {
  const shared = readdirSync("agents/shared", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => join("agents/shared", entry.name, "AGENTS.md"));
  const bundled = readdirSync("workflows", { withFileTypes: true }).flatMap((workflow) => {
    const agentsDir = join("workflows", workflow.name, "agents");
    try {
      return readdirSync(agentsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => join(agentsDir, entry.name, "AGENTS.md"));
    } catch {
      return [];
    }
  });
  return [...shared, ...bundled].sort();
}

describe("agent persona transport-file guidance", () => {
  const personaFiles = discoverPersonaFiles();

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
