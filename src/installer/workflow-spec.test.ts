import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorkflowSpec } from "../../dist/installer/workflow-spec.js";
import { createTempHome } from "../../tests/helpers/test-env.ts";

function createTempWorkflow(ymlContent: string): string {
  const { root: dir } = createTempHome("tamandua-test-workflow-spec-");
  writeFileSync(
    join(dir, "workflow.yml"),
    ymlContent,
    "utf-8",
  );
  return dir;
}

const MINIMAL_VALID_YML = `
id: test-workflow
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;

describe("loadWorkflowSpec run.workspace validation", () => {
  it("missing run section defaults to direct (no error)", async () => {
    const dir = createTempWorkflow(MINIMAL_VALID_YML);
    const spec = await loadWorkflowSpec(dir);
    assert.equal(spec.id, "test-workflow");
    // run.workspace should not throw when missing
    const workspace = spec.run?.workspace ?? "direct";
    assert.equal(workspace, "direct");
  });

  it("run.workspace: direct is valid and parses correctly", async () => {
    const yml = `
id: test-workflow
run:
  workspace: direct
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    const spec = await loadWorkflowSpec(dir);
    assert.equal(spec.id, "test-workflow");
    assert.equal(spec.run?.workspace, "direct");
  });

  it("run.workspace: worktree is valid and parses correctly", async () => {
    const yml = `
id: test-workflow
run:
  workspace: worktree
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    const spec = await loadWorkflowSpec(dir);
    assert.equal(spec.id, "test-workflow");
    assert.equal(spec.run?.workspace, "worktree");
  });

  it("run.workspace with invalid value throws descriptive error", async () => {
    const yml = `
id: test-workflow
run:
  workspace: bananas
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /invalid run\.workspace value.*bananas.*"direct" or "worktree"/i,
    );
  });

  it("run.workspace with numeric value throws descriptive error", async () => {
    const yml = `
id: test-workflow
run:
  workspace: 42
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /invalid run\.workspace value.*"42".*"direct" or "worktree"/i,
    );
  });

  it("run.workspace with boolean value throws descriptive error", async () => {
    const yml = `
id: test-workflow
run:
  workspace: true
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /invalid run\.workspace value.*"true".*"direct" or "worktree"/i,
    );
  });

  it("run section without workspace field defaults to direct", async () => {
    const yml = `
id: test-workflow
run:
  other_field: value
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    const spec = await loadWorkflowSpec(dir);
    const workspace = spec.run?.workspace ?? "direct";
    assert.equal(workspace, "direct");
  });

  it("WorkflowSpec type allows run.workspace access for direct", async () => {
    const yml = `
id: test-workflow
run:
  workspace: direct
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    const spec = await loadWorkflowSpec(dir);
    // TypeScript level: spec.run.workspace should compile as "direct" | "worktree" | undefined
    const mode: "direct" | "worktree" = spec.run?.workspace ?? "direct";
    assert.equal(mode, "direct");
  });

  it("WorkflowSpec type allows run.workspace access for worktree", async () => {
    const yml = `
id: test-workflow
run:
  workspace: worktree
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    const spec = await loadWorkflowSpec(dir);
    // TypeScript level: spec.run.workspace should compile as "direct" | "worktree" | undefined
    const mode: "direct" | "worktree" = spec.run?.workspace ?? "direct";
    assert.equal(mode, "worktree");
  });

  it("workflow without run field at all parses correctly", async () => {
    const yml = `
id: test-workflow-no-run
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    const spec = await loadWorkflowSpec(dir);
    assert.equal(spec.id, "test-workflow-no-run");
    assert.equal(spec.run?.workspace ?? "direct", "direct");
  });
});

describe("loadWorkflowSpec validation errors", () => {
  it("throws when workflow.yml does not exist (ENOENT)", async () => {
    const { root: dir } = createTempHome("tamandua-test-workflow-spec-");
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /No workflow\.yml found/i,
    );
  });

  it("throws on invalid YAML", async () => {
    const yml = `id: [unclosed`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /Failed to parse workflow\.yml/i,
    );
  });

  it("throws when YAML parses to non-object (string)", async () => {
    const yml = `"just a string"`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /did not parse to an object/i,
    );
  });

  it("throws when YAML parses to null", async () => {
    const yml = `null`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /did not parse to an object/i,
    );
  });

  it("throws when missing required field: id", async () => {
    const yml = `
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /missing required field: id/i,
    );
  });

  it("throws when id is empty string", async () => {
    const yml = `
id: ""
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /missing required field: id/i,
    );
  });

  it("throws when missing required field: agents", async () => {
    const yml = `
id: test-workflow
steps:
  - id: step1
    agent: dev
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /missing required field: agents/i,
    );
  });

  it("throws when agents is empty array", async () => {
    const yml = `
id: test-workflow
agents: []
steps:
  - id: step1
    agent: dev
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /missing required field: agents.*non-empty/i,
    );
  });

  it("throws when missing required field: steps", async () => {
    const yml = `
id: test-workflow
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /missing required field: steps/i,
    );
  });

  it("throws when agent is missing id", async () => {
    const yml = `
id: test-workflow
agents:
  - name: bob
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: bob
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /agent\[0\].*missing required field: id/i,
    );
  });

  it("throws when agent is missing workspace", async () => {
    const yml = `
id: test-workflow
agents:
  - id: dev
steps:
  - id: step1
    agent: dev
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /agent\[0\].*missing required field: workspace/i,
    );
  });

  it("throws when agent workspace is missing baseDir", async () => {
    const yml = `
id: test-workflow
agents:
  - id: dev
    workspace:
      other: value
steps:
  - id: step1
    agent: dev
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /agent\[0\].*missing required field: baseDir/i,
    );
  });

  it("throws when step is missing id", async () => {
    const yml = `
id: test-workflow
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - agent: dev
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /step\[0\].*missing required field: id/i,
    );
  });

  it("throws when step is missing agent", async () => {
    const yml = `
id: test-workflow
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /step\[0\].*missing required field: agent/i,
    );
  });

  it("validates second agent in array", async () => {
    const yml = `
id: test-workflow
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
  - name: no-id
    workspace:
      baseDir: agents/qa
steps:
  - id: step1
    agent: dev
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /agent\[1\].*missing required field: id/i,
    );
  });

  it("validates second step in array", async () => {
    const yml = `
id: test-workflow
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
  - id: step2
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /step\[1\].*missing required field: agent/i,
    );
  });

  it("validates multi-agent workflow successfully", async () => {
    const yml = `
id: multi-agent-wf
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
  - id: qa
    workspace:
      baseDir: agents/qa
steps:
  - id: step1
    agent: dev
  - id: step2
    agent: qa
`;
    const dir = createTempWorkflow(yml);
    const spec = await loadWorkflowSpec(dir);
    assert.equal(spec.id, "multi-agent-wf");
    assert.equal(spec.agents.length, 2);
    assert.equal(spec.agents[0].id, "dev");
    assert.equal(spec.agents[1].id, "qa");
    assert.equal(spec.steps.length, 2);
  });
});

describe("validateOnFail — on_fail key validation and M4 attestation rule", () => {
  it("accepts valid on_fail keys: retry_step, max_reroutes, max_target_moved_reroutes, retry_on", async () => {
    const yml = `
id: test-valid-on-fail
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "TESTED_TREE: treehash"
    expects: "STATUS: done"
  - id: step2
    agent: dev
    input: "consume TESTED_TREE"
    expects: "STATUS: done"
    on_fail:
      retry_step: step1
      max_reroutes: 4
      max_target_moved_reroutes: 8
      retry_on: [conflicts, target_moved]
`;
    const dir = createTempWorkflow(yml);
    const spec = await loadWorkflowSpec(dir);
    assert.equal(spec.id, "test-valid-on-fail");
    assert.equal(spec.steps[1].on_fail?.max_target_moved_reroutes, 8);
  });

  it("rejects unknown on_fail key naming the step and key", async () => {
    const yml = `
id: test-bad-key
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
    on_fail:
      retry_step: step0
      max_retries: 4
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /on_fail.*contains unknown key.*"max_retries".*retry_step, max_reroutes, max_target_moved_reroutes, retry_on/i,
    );
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /step\[0\] \("step1"\)/i,
    );
  });

  it("rejects unknown on_fail key with other junk (typo, extra field)", async () => {
    const yml = `
id: test-typo-key
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
    on_fail:
      retry_step: step0
      max_reroutes: 3
      misspelled_key: true
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /on_fail.*contains unknown key.*"misspelled_key"/i,
    );
  });

  it("accepts step with on_fail.retry_step matching the attesting (TESTED_TREE) step", async () => {
    const yml = `
id: test-attestation-ok
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: test
    agent: dev
    input: |
      Verify the work
      Reply with:
      STATUS: done
      TESTED_TREE: treehash123
    expects: "STATUS: done\\nregex:^TESTED_TREE:\\\\s*\\\\S+"
  - id: finalize_merge
    agent: dev
    input: |
      Land the changes
      TESTED_TREE: {{tested_tree}}
    expects: "STATUS: done"
    on_fail:
      retry_step: test
      max_reroutes: 8
      retry_on: [target_moved, conflicts]
`;
    const dir = createTempWorkflow(yml);
    const spec = await loadWorkflowSpec(dir);
    assert.equal(spec.id, "test-attestation-ok");
  });

  it("WAVE-A US-006: conditional steps are exempt from the M4 attestation rule (retry_step may target the rewrite producer, not the TESTED_TREE attester)", async () => {
    // The TESTED_TREE-attesting step (test) sits between the rewrite
    // producer (setup) and the conditional review step. A conditional review
    // step's on_fail.retry_step legitimately targets the rewrite producer —
    // under the strict M4 rule this would be rejected (nearest upstream
    // TESTED_TREE attester is "test", not "setup"); conditional steps are
    // exempt because they never attest TESTED_TREE themselves.
    const yml = `
id: test-conditional-m4-exempt
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: setup
    agent: dev
    input: |
      Prepare
      Reply with:
      STATUS: done
      TEST_CMD: npm test
    expects: "STATUS: done\\nregex:^TEST_CMD:\\\\s*\\\\S+"
  - id: test
    agent: dev
    input: |
      Verify the work
      Reply with:
      STATUS: done
      TESTED_TREE: treehash123
    expects: "STATUS: done\\nregex:^TESTED_TREE:\\\\s*\\\\S+"
  - id: test_cmd_review
    agent: dev
    type: conditional
    condition: test_cmd_review_required
    input: |
      Review the TEST_CMD rewrite.
      Reply with:
      STATUS: done
      VERDICT: ACCEPT|REJECT
    expects: "STATUS: done\\nregex:^VERDICT:\\\\s*(ACCEPT|REJECT)"
    on_fail:
      retry_step: setup
      max_reroutes: 4
  - id: finalize_merge
    agent: dev
    input: |
      Land the changes
      TESTED_TREE: {{tested_tree}}
    expects: "STATUS: done"
`;
    const dir = createTempWorkflow(yml);
    const spec = await loadWorkflowSpec(dir);
    assert.equal(spec.id, "test-conditional-m4-exempt");
  });

  it("WAVE-A US-006: the M4 exemption is scoped to conditional steps — a non-conditional step with the same mismatch still fails", async () => {
    // Same shape as above but the review step is NOT conditional: the strict
    // M4 rule must still reject retry_step "setup" (nearest TESTED_TREE
    // attester is "test").
    const yml = `
id: test-non-conditional-m4-strict
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: setup
    agent: dev
    input: |
      Prepare
      Reply with:
      STATUS: done
      TEST_CMD: npm test
    expects: "STATUS: done\\nregex:^TEST_CMD:\\\\s*\\\\S+"
  - id: test
    agent: dev
    input: |
      Verify the work
      Reply with:
      STATUS: done
      TESTED_TREE: treehash123
    expects: "STATUS: done\\nregex:^TESTED_TREE:\\\\s*\\\\S+"
  - id: review
    agent: dev
    input: |
      Review the TEST_CMD rewrite.
    expects: "STATUS: done"
    on_fail:
      retry_step: setup
      max_reroutes: 4
  - id: finalize_merge
    agent: dev
    input: |
      Land the changes
      TESTED_TREE: {{tested_tree}}
    expects: "STATUS: done"
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /on_fail\.retry_step is "setup" but the attesting step that produces TESTED_TREE is "test"/i,
    );
  });

  it("rejects when retry_step mismatches the TESTED_TREE attesting step, naming both", async () => {
    const yml = `
id: test-attestation-bad
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: test
    agent: dev
    input: |
      Verify the work
      Reply with:
      STATUS: done
      TESTED_TREE: treehash123
    expects: "STATUS: done\\nregex:^TESTED_TREE:\\\\s*\\\\S+"
  - id: finalize_merge
    agent: dev
    input: |
      Land the changes
      TESTED_TREE: {{tested_tree}}
    expects: "STATUS: done"
    on_fail:
      retry_step: wrong_step
      max_reroutes: 8
      retry_on: [target_moved, conflicts]
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /on_fail\.retry_step is "wrong_step" but the attesting step that produces TESTED_TREE is "test"/i,
    );
  });

  it("skips attestation check when no upstream step has TESTED_TREE", async () => {
    const yml = `
id: test-no-attester
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "do something"
    expects: "STATUS: done"
    on_fail:
      retry_step: step0
      max_reroutes: 3
`;
    const dir = createTempWorkflow(yml);
    const spec = await loadWorkflowSpec(dir);
    assert.equal(spec.id, "test-no-attester");
  });

  it("attestation check looks at nearest upstream TESTED_TREE step only", async () => {
    // step2 retry_step is step1_b — but the nearest upstream TESTED_TREE is step1_a.
    // So this should fail because retry_step doesn't match step1_a.
    const yml = `
id: test-nearest-attester
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step0
    agent: dev
    input: "no tree here"
    expects: "STATUS: done"
  - id: step1_a
    agent: dev
    input: |
      TESTED_TREE: aaa
    expects: "STATUS: done"
  - id: step1_b
    agent: dev
    input: |
      more work
      TESTED_TREE: bbb
    expects: "STATUS: done"
  - id: step2
    agent: dev
    input: "consume"
    expects: "STATUS: done"
    on_fail:
      retry_step: step1_a
      max_reroutes: 3
`;
    // step2's retry_step is step1_a. The nearest upstream with TESTED_TREE is step1_b.
    // So it should fail with: retry_step "step1_a" but attesting step is "step1_b"
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /on_fail\.retry_step is "step1_a" but the attesting step that produces TESTED_TREE is "step1_b"/i,
    );
  });

  it("accepts step with on_fail but no retry_step (only retry_on)", async () => {
    const yml = `
id: test-retry-on-only
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
    on_fail:
      retry_on: [timeout]
`;
    const dir = createTempWorkflow(yml);
    const spec = await loadWorkflowSpec(dir);
    assert.equal(spec.id, "test-retry-on-only");
  });

  it("rejects multiple unknown on_fail keys", async () => {
    const yml = `
id: test-multi-bad
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
    on_fail:
      foo: 1
      bar: 2
`;
    const dir = createTempWorkflow(yml);
    // Throws on the first bad key — 'foo' (Object.keys order)
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /on_fail.*contains unknown key.*"foo".*retry_step, max_reroutes, max_target_moved_reroutes, retry_on/i,
    );
  });
});

describe("on_fail.max_target_moved_reroutes validation (REROUTE-BUDGET)", () => {
  function targetMovedYml(onFailValueLine: string): string {
    return `
id: test-target-moved-budget
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "TESTED_TREE: treehash"
    expects: "STATUS: done"
  - id: step2
    agent: dev
    input: "consume TESTED_TREE"
    expects: "STATUS: done"
    on_fail:
      retry_step: step1
${onFailValueLine}`;
  }

  it("accepts a missing key (runtime default applies)", async () => {
    const dir = createTempWorkflow(targetMovedYml(""));
    const spec = await loadWorkflowSpec(dir);
    assert.equal(spec.steps[1].on_fail?.max_target_moved_reroutes, undefined);
  });

  it("accepts a positive integer cap", async () => {
    const dir = createTempWorkflow(
      targetMovedYml("      max_target_moved_reroutes: 8\n"),
    );
    const spec = await loadWorkflowSpec(dir);
    assert.equal(spec.steps[1].on_fail?.max_target_moved_reroutes, 8);
  });

  const invalidValues: Array<[string, string]> = [
    ["zero", "0"],
    ["a negative number", "-1"],
    ["a non-integer", "1.5"],
    ["a quoted string", '"16"'],
    ["a boolean", "true"],
    ["null", "null"],
    ["an object", "{}"],
    ["an array", "[]"],
  ];

  for (const [label, literal] of invalidValues) {
    it(`rejects ${label}`, async () => {
      const dir = createTempWorkflow(
        targetMovedYml(`      max_target_moved_reroutes: ${literal}\n`),
      );
      await assert.rejects(
        () => loadWorkflowSpec(dir),
        /workflow\.yml step\[1\] \("step2"\) on_fail\.max_target_moved_reroutes in .* must be a positive integer/,
      );
    });
  }
});

describe("conditional step type validation", () => {
  it("accepts a conditional step that declares a non-empty condition", async () => {
    const yml = `
id: test-conditional-ok
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: review
    agent: dev
    type: conditional
    condition: test_cmd_review_required
    input: "Review the rewrite"
    expects: "VERDICT: ACCEPT"
`;
    const dir = createTempWorkflow(yml);
    const spec = await loadWorkflowSpec(dir);
    assert.equal(spec.id, "test-conditional-ok");
    assert.equal(spec.steps[0].type, "conditional");
    assert.equal(spec.steps[0].condition, "test_cmd_review_required");
  });

  it("rejects a conditional step without a condition", async () => {
    const yml = `
id: test-conditional-no-condition
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: review
    agent: dev
    type: conditional
    input: "Review the rewrite"
    expects: "VERDICT: ACCEPT"
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /type conditional but is missing required field: condition/i,
    );
  });

  it("rejects a conditional step with an empty or whitespace condition", async () => {
    const yml = `
id: test-conditional-empty-condition
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: review
    agent: dev
    type: conditional
    condition: "   "
    input: "Review the rewrite"
    expects: "VERDICT: ACCEPT"
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /type conditional but is missing required field: condition/i,
    );
  });

  it("rejects a single step that declares a condition", async () => {
    const yml = `
id: test-single-with-condition
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    type: single
    condition: some_flag
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /declares condition but is not type conditional/i,
    );
  });

  it("rejects a step with no type that declares a condition", async () => {
    const yml = `
id: test-default-type-with-condition
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    condition: some_flag
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /declares condition but is not type conditional/i,
    );
  });

  it("rejects a loop step that declares a condition", async () => {
    const yml = `
id: test-loop-with-condition
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: develop
    agent: dev
    type: loop
    condition: some_flag
    loop:
      over: stories
      completion: all_done
    input: "Implement {{current_story}}"
    expects: "STATUS: done"
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /declares condition but is not type conditional/i,
    );
  });

  it("rejects unknown step type values", async () => {
    const yml = `
id: test-bad-type
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    type: banana
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /has invalid type: "banana".*Valid types are: single, loop, conditional/i,
    );
  });

  it("still accepts single and loop steps without a condition (regression)", async () => {
    const yml = `
id: test-single-loop-ok
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: implement
    agent: dev
    type: single
    input: "Implement the task"
    expects: "STATUS: done"
  - id: develop
    agent: dev
    type: loop
    loop:
      over: stories
      completion: all_done
    input: "Implement {{current_story}}"
    expects: "STATUS: done"
`;
    const dir = createTempWorkflow(yml);
    const spec = await loadWorkflowSpec(dir);
    assert.equal(spec.steps[0].type, "single");
    assert.equal(spec.steps[1].type, "loop");
    assert.equal(spec.steps[0].condition, undefined);
    assert.equal(spec.steps[1].condition, undefined);
  });
});
