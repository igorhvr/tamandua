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
