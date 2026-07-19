import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const skillPath = resolve(repoRoot, "skills/tamandua-agents/SKILL.md");
const skill = readFileSync(skillPath, "utf-8");

function extractSection(start: string, end: string): string {
  const startIndex = skill.indexOf(start);
  const endIndex = skill.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing semantic heading: ${start}`);
  assert.ok(endIndex > startIndex, `missing semantic boundary: ${end}`);
  return skill.slice(startIndex, endIndex);
}

describe("US-003: Verify skill file consistency with AGENTS.md", () => {
  // AC 1: Skill includes guidance to review docs, MCP, CLI, dashboard, README
  it("includes guidance to review docs, MCP, CLI, dashboard, and README", () => {
    assert.match(skill, /docs\/creating-workflows\.md/);
    assert.match(skill, /src\/server\/mcp-server\.ts/);
    assert.match(skill, /src\/cli\/cli\.ts/);
    assert.match(skill, /src\/server\/index\.html/);
    assert.match(skill, /README\.md/);
    assert.match(
      skill,
      /review.*whether.*artifacts.*need.*updating/i,
      "skill should instruct to review whether artifacts need updating",
    );
  });

  // AC 2: Skill still covers all existing step lifecycle guidance
  it("preserves existing step lifecycle guidance", () => {
    assert.match(skill, /## Step lifecycle & completion contract/);
    assert.match(skill, /tamandua step peek/);
    assert.match(skill, /tamandua step claim/);
    assert.match(skill, /tamandua step complete/);
    assert.match(skill, /tamandua step fail/);
    assert.match(skill, /SAVE.*stepId.*immediately/i);
  });

  // AC 2: Skill still covers all existing CLI command guidance
  it("preserves existing CLI command guidance", () => {
    assert.match(skill, /### Confirm CLI access/);
    assert.match(skill, /## Workflow-level commands/);
    assert.match(skill, /tamandua workflow list/);
    assert.match(skill, /tamandua workflow run/);
    assert.match(skill, /tamandua workflow status/);
    assert.match(skill, /tamandua workflow pause/);
    assert.match(skill, /tamandua workflow resume/);
  });

  // AC 2: Completion contract still present
  it("preserves completion contract guidance", () => {
    assert.match(skill, /### Completion reports and validation/);
    assert.match(skill, /STATUS: done/);
    assert.match(skill, /CHANGES:/);
    assert.match(skill, /TESTS:/);
  });

  // AC 3: No regressions in frontmatter formatting
  it("preserves YAML frontmatter", () => {
    assert.match(skill, /^---$/m);
    const frontmatterMatch = skill.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(frontmatterMatch, "YAML frontmatter must be present");
    const frontmatter = frontmatterMatch[1];
    assert.match(frontmatter, /name:\s+tamandua-agents/);
    assert.match(frontmatter, /description:/);
  });

  // AC 1 part 2: Cascade triggers documented
  it("documents cascade triggers for artifact review", () => {
    assert.match(skill, /[Ss]tep lifecycle/);
    assert.match(skill, /CLI command/);
    assert.match(skill, /[Aa]gent provisioning/);
    assert.match(skill, /[Oo]utput format contract/);
  });

  // Verify the skill references updating bundled workflow persona files
  it("mentions verifying bundled workflow persona AGENTS.md on skill changes", () => {
    assert.match(
      skill,
      /bundled workflow persona.*AGENTS\.md/i,
      "skill should mention verifying bundled workflow persona AGENTS.md files",
    );
  });

  it("opens with a scoped quick card within the line budget", () => {
    const titleIndex = skill.indexOf("# Tamandua Agents");
    const quickIndex = skill.indexOf("## Quick card — the 90% path");
    const quickCard = extractSection(
      "## Quick card — the 90% path",
      "## Step lifecycle & completion contract",
    );

    assert.ok(titleIndex >= 0 && quickIndex > titleIndex, "quick card must follow the title");
    assert.equal(
      skill.slice(titleIndex, quickIndex).trim(),
      "# Tamandua Agents",
      "nothing may intervene between the title and quick card",
    );
    assert.ok(quickCard.split("\n").length <= 45, "quick card must stay within 45 source lines");
    for (const contract of [
      "step peek",
      "step claim",
      "Save the returned `stepId`",
      "step complete",
      "--file",
      "stdin",
      "STATUS: done",
      "STATUS: retry",
      "column 0",
      "step fail",
      "Printing a report in chat does not complete the step",
      "run-<uuid>",
      "step-<uuid>",
      "Agent ID",
      "step current",
      "--task-file",
      "workflow wait",
      "workflow status <run-id> --json",
      "workflow stop",
      "tamandua restart",
    ]) {
      assert.ok(quickCard.includes(contract), `quick card must contain ${contract}`);
    }
    for (const referenceOnlyDetail of [
      "STORIES_JSON",
      "sqlite3 -readonly",
      "--working-directory-for-harness",
      "tamandua dashboard",
      "tamandua mcp",
    ]) {
      assert.ok(
        !quickCard.includes(referenceOnlyDetail),
        `quick card must leave ${referenceOnlyDetail} in the detailed references`,
      );
    }
  });

  it("orders semantic reference sections and preserves detailed contracts", () => {
    const headings = [
      "## Step lifecycle & completion contract",
      "## Supervising runs",
      "## Workflow-level commands",
      "## Services & maintenance",
      "## Troubleshooting & recovery recipes",
    ];
    const positions = headings.map((heading) => skill.indexOf(heading));
    assert.ok(positions.every((position) => position >= 0), "all semantic references must exist");
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    assert.doesNotMatch(skill, /§\s*\d+/, "core skill must not retain numeric section references");

    for (const detail of [
      "STORIES_JSON_FILE",
      "REJECTED",
      "Traceability header",
      "tamandua step release",
      "tamandua workflow fail",
      "sqlite3 -readonly",
      "--context",
      "mutually exclusive",
      "--hermes-as-harness",
      "tamandua workflow pause",
      "tamandua workflow delete",
      "tamandua worktree prune",
      "Live-instance isolation",
    ]) {
      assert.ok(skill.includes(detail), `detailed references must preserve ${detail}`);
    }
  });

  it("keeps review artifacts under services and includes AUTORESEARCH.md", () => {
    const services = extractSection(
      "## Services & maintenance",
      "## Troubleshooting & recovery recipes",
    );
    assert.ok(services.includes("### Review artifacts on changes"));
    assert.ok(services.includes("skills/tamandua-agents/AUTORESEARCH.md"));
  });

  it("bundled personas do not refer to obsolete numbered skill sections", () => {
    const personaPaths = globSync("workflows/**/agents/**/AGENTS.md", { cwd: repoRoot });
    assert.ok(personaPaths.length > 0, "expected bundled workflow personas");
    for (const personaPath of personaPaths) {
      const persona = readFileSync(resolve(repoRoot, personaPath), "utf-8");
      assert.doesNotMatch(
        persona,
        /(?:tamandua-agents|SKILL\.md)[^\n]*(?:§\s*\d+|section\s+\d+)/i,
        `${personaPath} contains an obsolete numeric skill-section reference`,
      );
    }
  });
});
