import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const matrixRoot = path.join(repoRoot, "torture-test", "scenarios", "w4.35");
const rebasedValues = ["true", "absent"] as const;
const evidenceValues = ["green", "red", "missing"] as const;
const requiredOracles = ["O1", "O2", "O3z", "O8", "O9", "O10", "O11"];

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("W4.35 STATUS retry verdict matrix", () => {
  it("declares exactly the six rebased-by-suite-evidence retry cells", () => {
    const expectedIds = rebasedValues.flatMap((rebased) =>
      evidenceValues.map((evidence) => `w4.35-retry-rebased-${rebased}-${evidence}`),
    ).sort();
    const actualIds = fs.readdirSync(matrixRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("w4.35-retry-"))
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(actualIds, expectedIds);
  });

  for (const rebased of rebasedValues) {
    for (const evidence of evidenceValues) {
      const id = `w4.35-retry-rebased-${rebased}-${evidence}`;
      it(`${id} pins the bounded retry route and zero-token oracle contract`, () => {
        const scenarioDir = path.join(matrixRoot, id);
        const metadata = readJson(path.join(scenarioDir, "scenario.json"));
        const behaviors = readJson(path.join(scenarioDir, "behaviors.json"));
        const expected = metadata.expected_route;

        assert.equal(metadata.id, id);
        assert.equal(metadata.workflow_base, "bug-fix-merge-worktree");
        assert.equal(metadata.workflow_id, `bug-fix-merge-worktree-${id}`);
        assert.equal(metadata.task, "task.md");
        assert.deepEqual(metadata.matrix, { verdict: "retry", rebased, suite_evidence: evidence });
        assert.deepEqual(metadata.oracles, requiredOracles);
        assert.equal(metadata.oracle_justification, "full merge-run retry evidence contract");
        assert.deepEqual(expected, {
          terminal_route: "accepted-retry-reroute-exhausted",
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
          verifier_invocations: rebased === "true" && evidence === "green" ? 10 : 9,
          accepted_retry_events: 0,
          retry_feedback_contains: "STATUS: retry",
          retry_feedback_reroutes: evidence === "missing" ? 7 : 8,
          story_retry_events: rebased === "true" && evidence === "green" ? 1 : 0,
          fixer_invocations: rebased === "true" && evidence === "green" ? 2 : 1,
          story_rows: rebased === "true" && evidence === "green" ? 1 : 0,
          story_retry_count: rebased === "true" && evidence === "green" ? 1 : 0,
          unresolved_placeholder_events: 0,
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
        assert.match(merger.output, /^STATUS: retry$/m);
        if (rebased === "true") {
          assert.match(merger.output, /^REBASED: true$/m);
          assert.match(merger.output, /^CONFLICT_NOTES:\s*\S+/m);
          assert.match(merger.output, /^RETRY_STEP: verify$/m);
        } else {
          assert.doesNotMatch(merger.output, /^REBASED:/m);
        }
        if (rebased === "true" && evidence === "green") {
          assert.ok(Array.isArray(behaviors.agents.fixer), "RSTY cell needs a post-reset fixer invocation");
          assert.ok(Array.isArray(behaviors.agents.verifier), "RSTY cell needs retry then done verifier outputs");
          assert.match(behaviors.agents.verifier[0].output, /^STATUS: retry$/m);
          assert.match(behaviors.agents.verifier[1].output, /^STATUS: done$/m);
          assert.match(behaviors.agents.triager.output, /^STORIES_JSON:\s*\[/m);
        }

        assert.ok(fs.statSync(path.join(scenarioDir, "run.sh")).mode & 0o111);
        assert.ok(fs.readFileSync(path.join(scenarioDir, "task.md"), "utf8").trim().length > 0);
      });
    }
  }
});
