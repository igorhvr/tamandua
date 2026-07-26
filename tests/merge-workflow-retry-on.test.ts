import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadWorkflowSpec } from "../dist/installer/workflow-spec.js";

interface ExpectedFinalizePolicy {
  retryStep: string;
  maxRetries?: number;
  maxReroutes?: number;
  stepMaxRetries?: number;
}

const mergeWorkflowPolicies: Record<string, ExpectedFinalizePolicy> = {
  "feature-dev-merge": {
    retryStep: "test",
    maxReroutes: 8,
    stepMaxRetries: 0,
  },
  "feature-dev-merge-worktree": {
    retryStep: "test",
    maxReroutes: 8,
    stepMaxRetries: 0,
  },
  "bug-fix-merge": {
    retryStep: "verify",
    maxReroutes: 4,
  },
  "bug-fix-merge-worktree": {
    retryStep: "verify",
    maxReroutes: 8,
    stepMaxRetries: 0,
  },
  "quarantine-broken-tests-merge": {
    retryStep: "verify",
    maxRetries: 4,
  },
  "quarantine-broken-tests-merge-worktree": {
    retryStep: "verify",
    maxRetries: 4,
  },
  "security-audit-merge": {
    retryStep: "test",
    maxRetries: 4,
  },
  "security-audit-merge-worktree": {
    retryStep: "test",
    maxRetries: 4,
  },
};

function workflowDir(id: string): string {
  return path.resolve(process.cwd(), "workflows", id);
}

describe("merge workflow retry_on catalog declarations", () => {
  for (const [workflowId, expected] of Object.entries(mergeWorkflowPolicies)) {
    it(`${workflowId} opts only finalize_merge into transient retry classes`, async () => {
      const spec = await loadWorkflowSpec(workflowDir(workflowId));
      const finalizeStep = spec.steps.find((step) => step.id === "finalize_merge");
      assert.ok(finalizeStep, `${workflowId}: finalize_merge step must exist`);

      assert.deepEqual(finalizeStep.on_fail, {
        retry_step: expected.retryStep,
        ...(expected.maxRetries === undefined
          ? {}
          : { max_retries: expected.maxRetries }),
        ...(expected.maxReroutes === undefined
          ? {}
          : { max_reroutes: expected.maxReroutes }),
        retry_on: ["target_moved", "conflicts"],
      });
      assert.equal(finalizeStep.max_retries, expected.stepMaxRetries);

      for (const step of spec.steps) {
        if (step.id !== "finalize_merge" && step.on_fail) {
          assert.equal(
            step.on_fail.retry_on,
            undefined,
            `${workflowId}:${step.id} must retain legacy on_fail semantics`,
          );
        }
      }
    });
  }
});
