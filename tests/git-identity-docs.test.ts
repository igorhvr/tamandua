import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

/**
 * GIDN-MSIG US-007 documentation contract.
 *
 * The provided git identity and the no-global-config rule must be visible to
 * every agent that can create commits: the provisioned tamandua-agents skill
 * and all eight merger personas (four physical files reached through two
 * workflow paths each).
 */
const repoRoot = resolve(import.meta.dirname, "..");
const skillPath = resolve(repoRoot, "skills", "tamandua-agents", "SKILL.md");
const mergerPaths = globSync("workflows/*/agents/merger/AGENTS.md", { cwd: repoRoot }).sort();

const EXPECTED_MERGER_WORKFLOWS = [
  "bug-fix-merge",
  "bug-fix-merge-worktree",
  "feature-dev-merge",
  "feature-dev-merge-worktree",
  "quarantine-broken-tests-merge",
  "quarantine-broken-tests-merge-worktree",
  "security-audit-merge",
  "security-audit-merge-worktree",
];

function text(path: string): string {
  return readFileSync(path, "utf-8");
}

/** The four-tier resolution order, asserted as a literal sequence. */
function assertResolutionOrder(content: string, label: string): void {
  const envName = content.search(/GIT_USER_NAME/);
  const envEmail = content.search(/GIT_USER_EMAIL/);
  const env = Math.min(envName, envEmail);
  const local = content.search(/working repository's local `user\.name`/i);
  const global = content.search(/operator's global git config/i);
  const fallback = content.search(
    /last resort[\s\S]{0,80}?Tamandua <tamandua@tetradactyla\.org>/i,
  );

  for (const [tier, index] of [
    ["env name", envName],
    ["env email", envEmail],
    ["repo-local", local],
    ["global", global],
    ["fallback", fallback],
  ] as const) {
    assert.ok(index >= 0, `${label}: missing the ${tier} tier of the resolution order`);
  }
  assert.ok(
    env < local && local < global && global < fallback,
    `${label}: resolution order must be env -> repo-local -> global -> fallback`,
  );
}

/** The prohibition on writing global/system git identity. */
function assertNoGlobalConfigRule(content: string, label: string): void {
  assert.match(
    content,
    /NEVER run `git config --global` or `git config --system`/,
    `${label}: must forbid git config --global/--system`,
  );
}

/** The four commit-author/committer variables provided by the round env. */
function assertRoundEnvIdentity(content: string, label: string): void {
  for (const variable of [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ]) {
    assert.ok(content.includes(variable), `${label}: must name ${variable}`);
  }
}

describe("GIDN US-007: SKILL.md documents git identity and signing", () => {
  const skill = text(skillPath);

  it("has a 'Git identity and signing' section", () => {
    assert.match(skill, /^## Git identity and signing$/m);
  });

  it("states the four-tier identity resolution order in precedence order", () => {
    assertResolutionOrder(skill, "SKILL.md");
  });

  it("forbids git config --global and git config --system", () => {
    assertNoGlobalConfigRule(skill, "SKILL.md");
  });

  it("documents that the round env provides the four commit identity variables", () => {
    assertRoundEnvIdentity(skill, "SKILL.md");
  });

  it("documents the Matchlock signing exemption for landings", () => {
    assert.match(skill, /Matchlock-backed[\s\S]{0,200}unsigned/i);
  });
});

describe("GIDN US-007: merger personas document the provided identity", () => {
  it("discovers all eight merger personas", () => {
    assert.equal(mergerPaths.length, 8);
    assert.deepEqual(
      mergerPaths.map((path) => path.split("/")[1]).sort(),
      EXPECTED_MERGER_WORKFLOWS,
    );
  });

  for (const path of mergerPaths) {
    const workflow = path.split("/")[1];
    describe(`${workflow} merger`, () => {
      const content = text(resolve(repoRoot, path));

      it("states the resolution order and forbids global/system config", () => {
        assertResolutionOrder(content, `${workflow} merger`);
        assertNoGlobalConfigRule(content, `${workflow} merger`);
      });

      it("documents that the round env provides the identity variables", () => {
        assertRoundEnvIdentity(content, `${workflow} merger`);
      });

      it("honors configured signing except in Matchlock guest contexts", () => {
        assert.match(
          content,
          /configured commit signing[\s\S]{0,200}Matchlock[\s\S]{0,120}unsigned/i,
          `${workflow} merger must document the Matchlock signing exemption`,
        );
      });

      it("forbids session URLs in the landing commit message and keeps the footer", () => {
        assert.match(
          content,
          /MUST NOT contain session URLs/i,
          `${workflow} merger must forbid session URLs in the landing commit message`,
        );
        assert.ok(
          content.includes("Co-Authored-By: Tamandua <tamandua@tetradactyla.org>"),
          `${workflow} merger must keep the Tamandua co-author footer`,
        );
      });
    });
  }
});
