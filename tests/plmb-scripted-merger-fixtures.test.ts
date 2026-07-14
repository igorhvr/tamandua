import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const fixtureFiles = [
  { file: "e2e-tests/workflows-scripted.test.ts", mergers: 3 },
  { file: "e2e-tests/workflows-scripted-hermes.test.ts", mergers: 1 },
  { file: "e2e-tests/workflows-stress-concurrent.test.ts", mergers: 1 },
];

function source(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf-8");
}

describe("PLMB scripted merger fixtures", () => {
  for (const fixture of fixtureFiles) {
    it(`${fixture.file} lands every merger through the complete plumbing contract`, () => {
      const text = source(fixture.file);
      const invocations = text.match(/merge-branch[^\n]*/g) ?? [];

      assert.equal(invocations.length, fixture.mergers, "every scripted merger should invoke merge-branch once");
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
        fixture.mergers,
        "scripted mergers should report merge-branch landed metadata",
      );
    });

    it(`${fixture.file} never mutates the origin through porcelain commands`, () => {
      const text = source(fixture.file);
      assert.doesNotMatch(text, /git -C [^\n]* checkout [^\n]*ORIGINAL_BRANCH/);
      assert.doesNotMatch(text, /git -C [^\n]* merge --squash/);
      assert.doesNotMatch(text, /git -C [^\n]* update-ref/);
      assert.doesNotMatch(text, /git -C [^\n]* commit (?!-tree)/);
    });
  }
});
