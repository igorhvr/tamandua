import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const matrixRoot = path.join(repoRoot, "torture-test", "scenarios", "w4.35");
const verdict = "done";
const rebasedValues = ["true", "absent"] as const;
const evidenceValues = ["green", "red", "missing"] as const;
const requiredOracles = ["O1", "O2", "O3z", "O8", "O9", "O10", "O11"];

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("W4.35 STATUS done verdict matrix", () => {
  it("removes the managed worktree before checking terminal invariants", () => {
    const runner = fs.readFileSync(path.join(matrixRoot, "run-done-cell.mjs"), "utf8");
    const cleanup = runner.indexOf('run(cli, ["worktree", "remove"');
    const firstInvariant = runner.indexOf("assert.equal(runRow.status");
    assert.ok(cleanup >= 0, "done-cell runner must remove its managed worktree");
    assert.ok(cleanup < firstInvariant,
      "managed worktree cleanup must precede assertions so a finding cannot leak state");
  });

  it("declares exactly the six rebased-by-suite-evidence cells", () => {
    const expectedIds = rebasedValues.flatMap((rebased) =>
      evidenceValues.map((evidence) => `w4.35-done-rebased-${rebased}-${evidence}`),
    ).sort();
    const actualIds = fs.readdirSync(matrixRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("w4.35-done-"))
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(actualIds, expectedIds);
  });

  for (const rebased of rebasedValues) {
    for (const evidence of evidenceValues) {
      const id = `w4.35-done-rebased-${rebased}-${evidence}`;
      it(`${id} mechanically pins its behavior, route, evidence, and oracle contract`, () => {
        const scenarioDir = path.join(matrixRoot, id);
        const metadata = readJson(path.join(scenarioDir, "scenario.json"));
        const behaviors = readJson(path.join(scenarioDir, "behaviors.json"));
        const expected = metadata.expected_route;

        assert.equal(metadata.id, id);
        assert.equal(metadata.workflow_base, "bug-fix-merge-worktree");
        assert.equal(metadata.workflow_id, `bug-fix-merge-worktree-${id}`);
        assert.equal(metadata.task, "task.md");
        assert.deepEqual(metadata.matrix, { verdict, rebased, suite_evidence: evidence });
        assert.deepEqual(metadata.oracles, requiredOracles);
        assert.equal(metadata.oracle_justification, "full merge-run evidence contract");
        assert.deepEqual(expected, {
          terminal_route: "expects-reroute-exhausted",
          run_status: "failed",
          finalize_status: "failed",
          ref_movement: "forbidden",
          landing_policy: "must-not-land",
          evidence_annotation: "none",
          suite_rows: evidence === "green" ? 1 : evidence === "red" ? 9 : 0,
          retry_count: 1,
          terminal_reroute_count: evidence === "missing" ? 1 : 0,
          reroute_count: 8,
          ledger_concession_count: evidence === "missing" ? 1 : 0,
          reroute_events: 8,
          merger_invocations: evidence === "missing" ? 8 : 9,
          system_tokens_spent: 0,
        });

        assert.equal(behaviors.heartbeatTokens, 0);
        assert.equal(behaviors.defaultTokens, 0);
        assert.deepEqual(Object.keys(behaviors.agents).sort(), [
          "fixer", "investigator", "merger", "setup", "triager", "verifier",
        ]);
        for (const behavior of Object.values<any>(behaviors.agents)) {
          for (const invocation of Array.isArray(behavior) ? behavior : [behavior]) {
            assert.equal(invocation.tokens, 0);
          }
        }
        const merger = behaviors.agents.merger;
        assert.equal(Array.isArray(merger), false);
        assert.match(merger.output, /^STATUS: done$/m);
        if (rebased === "true") assert.match(merger.output, /^REBASED: true$/m);
        else assert.doesNotMatch(merger.output, /^REBASED:/m);

        assert.ok(fs.statSync(path.join(scenarioDir, "run.sh")).mode & 0o111);
        assert.ok(fs.readFileSync(path.join(scenarioDir, "task.md"), "utf8").trim().length > 0);
      });
    }
  }
});
