import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const fixtureFiles = [
  { file: "e2e-tests/workflows-scripted.test.ts", mergerBehaviors: 9, invocations: 12, migrated: true },
  { file: "e2e-tests/workflows-scripted-hermes.test.ts", mergerBehaviors: 2, invocations: 2, migrated: true },
  { file: "e2e-tests/workflows-scripted-dsh.test.ts", mergerBehaviors: 2, invocations: 2, migrated: true },
  { file: "e2e-tests/workflows-stress-concurrent.test.ts", mergerBehaviors: 1, invocations: 1, migrated: false },
];

const migratedWorkflows = [
  "bug-fix-merge",
  "bug-fix-merge-worktree",
  "quarantine-broken-tests-merge",
  "quarantine-broken-tests-merge-worktree",
  "security-audit-merge",
  "security-audit-merge-worktree",
];

function source(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf-8");
}

describe("PLMB scripted merger fixtures", () => {
  for (const fixture of fixtureFiles) {
    it(`${fixture.file} lands every merger through the complete plumbing contract`, () => {
      const text = source(fixture.file);
      const invocations = text.match(/merge-branch[^\n]*/g) ?? [];

      assert.equal(invocations.length, fixture.invocations, "every scripted landing should invoke merge-branch");
      for (const invocation of invocations) {
        assert.match(invocation, /--origin/);
        assert.match(invocation, /--branch/);
        assert.match(invocation, /--into/);
        assert.match(invocation, /ORIGINAL_BRANCH/);
        assert.match(invocation, /--expect-tip/);
        assert.match(invocation, /expected_tip/);
        assert.match(invocation, /--message/);
      }
      assert.equal(
        (text.match(/includeCommandOutput:\s*true/g) ?? []).length,
        fixture.mergerBehaviors,
        "scripted mergers should report merge-branch landed metadata",
      );
    });

    if (fixture.migrated) {
      it(`${fixture.file} executes plumbing merger fixtures for all six migrated workflows`, () => {
        const text = source(fixture.file);
        const workflowBlock = text.match(/const MIGRATED_MERGE_WORKFLOWS = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
        const configuredWorkflows = [...workflowBlock.matchAll(/id:\s*"([^"]+)"/g)].map((match) => match[1]);

        assert.deepEqual(configuredWorkflows, migratedWorkflows);
        assert.match(text, /function createMigratedMergerBehaviors/);
        assert.match(text, /origin checkout must stay on its pre-run branch/);
        assert.match(text, /\^STATUS: landed\$\/m/);
        assert.match(text, /\^MERGED_COMMIT:/);
        assert.match(text, /\^MERGED_TREE:/);
        assert.match(text, /\^CHECKOUT_REFRESH:/);
      });
    }

    it(`${fixture.file} never mutates the origin through porcelain commands`, () => {
      const text = source(fixture.file);
      assert.doesNotMatch(text, /git -C [^\n]* checkout [^\n]*ORIGINAL_BRANCH/);
      assert.doesNotMatch(text, /git -C [^\n]* merge --squash/);
      assert.doesNotMatch(text, /git -C [^\n]* update-ref/);
      assert.doesNotMatch(text, /git -C [^\n]* commit (?!-tree)/);
    });
  }
});
