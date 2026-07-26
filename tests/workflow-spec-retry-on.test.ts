import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempRoot } from "../src/lib/temp-dir.ts";
import {
  loadWorkflowSpec,
  loadWorkflowSpecSync,
} from "../dist/installer/workflow-spec.js";

const fixtureDirs: string[] = [];

function writeWorkflow(onFailYaml = ""): string {
  const workflowDir = fs.mkdtempSync(
    path.join(tamanduaTempRoot(), "tamandua-workflow-retry-on-"),
  );
  fixtureDirs.push(workflowDir);
  fs.writeFileSync(
    path.join(workflowDir, "workflow.yml"),
    `id: retry-on-fixture
agents:
  - id: developer
    workspace:
      baseDir: .
      files: {}
steps:
  - id: implement
    agent: developer
    input: Implement
    expects: STATUS
${onFailYaml}`,
  );
  return workflowDir;
}

afterEach(() => {
  for (const fixtureDir of fixtureDirs.splice(0)) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

describe("on_fail.retry_on workflow contract", () => {
  it("both loaders preserve known and unknown retry_on classes", async () => {
    const workflowDir = writeWorkflow(
      "    on_fail:\n      retry_step: implement\n      max_retries: 2\n      max_reroutes: 4\n      retry_on: [target_moved, future_failure_class]\n",
    );

    const asyncSpec = await loadWorkflowSpec(workflowDir);
    const syncSpec = loadWorkflowSpecSync(workflowDir);

    for (const spec of [asyncSpec, syncSpec]) {
      assert.deepEqual(spec.steps[0].on_fail, {
        retry_step: "implement",
        max_retries: 2,
        max_reroutes: 4,
        retry_on: ["target_moved", "future_failure_class"],
      });
    }
  });

  it("both loaders continue accepting workflows without retry_on", async () => {
    const workflowDir = writeWorkflow(
      "    on_fail:\n      retry_step: implement\n      max_reroutes: 3\n",
    );

    const asyncSpec = await loadWorkflowSpec(workflowDir);
    const syncSpec = loadWorkflowSpecSync(workflowDir);

    assert.equal(asyncSpec.steps[0].on_fail?.retry_on, undefined);
    assert.equal(syncSpec.steps[0].on_fail?.retry_on, undefined);
  });

  for (const { label, retryOnYaml } of [
    { label: "a scalar", retryOnYaml: "target_moved" },
    { label: "a non-string entry", retryOnYaml: "[target_moved, 7]" },
    { label: "an empty string", retryOnYaml: '[target_moved, ""]' },
    { label: "a whitespace-only string", retryOnYaml: '[target_moved, "   "]' },
  ]) {
    it(`both loaders reject retry_on containing ${label}`, async () => {
      const workflowDir = writeWorkflow(
        `    on_fail:\n      retry_on: ${retryOnYaml}\n`,
      );
      const expectedMessage =
        `workflow.yml step[0] ("implement") on_fail.retry_on in ${workflowDir} must be an array of non-empty strings`;

      await assert.rejects(
        loadWorkflowSpec(workflowDir),
        new Error(expectedMessage),
      );
      assert.throws(
        () => loadWorkflowSpecSync(workflowDir),
        new Error(expectedMessage),
      );
    });
  }

  it("both loaders accept an empty retry_on list", async () => {
    const workflowDir = writeWorkflow(
      "    on_fail:\n      retry_on: []\n",
    );

    const asyncSpec = await loadWorkflowSpec(workflowDir);
    const syncSpec = loadWorkflowSpecSync(workflowDir);

    assert.deepEqual(asyncSpec.steps[0].on_fail?.retry_on, []);
    assert.deepEqual(syncSpec.steps[0].on_fail?.retry_on, []);
  });
});
