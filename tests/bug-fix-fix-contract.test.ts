/**
 * US-008: PHNT honest-account contract — fix-step either/or fourth key in
 * bug-* workflows.
 *
 * Every bug-* workflow (bug-fix, bug-fix-worktree, bug-fix-merge,
 * bug-fix-merge-worktree, bug-fix-github-pr) fix step must require the
 * either/or fourth key — REPRO_EVIDENCE: <pointer to failing output on the
 * pre-fix tree> OR CANNOT_REPRODUCE: <reasons> — alongside the existing
 * STATUS/CHANGES/REGRESSION_TEST keys, leaving the triager's REPRODUCTION:
 * narrative unchanged.
 */

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadWorkflowSpec } from "../dist/installer/workflow-spec.js";
import type { WorkflowSpec } from "../dist/installer/types.js";
import { resolveBundledWorkflowsDir } from "../dist/installer/paths.js";
import { resolve } from "node:path";
import {
  parseEnforcedKeys,
} from "../dist/installer/workflow-contract.js";
import { validateExpects } from "../dist/installer/step-ops.js";

const workflowsDir = resolveBundledWorkflowsDir();

const BUG_FIX_WORKFLOWS = [
  "bug-fix",
  "bug-fix-worktree",
  "bug-fix-merge",
  "bug-fix-merge-worktree",
  "bug-fix-github-pr",
] as const;

const ALTERNATION_EXPECTS = "regex:^(REPRO_EVIDENCE|CANNOT_REPRODUCE):\\s*\\S+";

describe("US-008: PHNT honest-account fix contract in bug-* workflows", () => {
  for (const workflowId of BUG_FIX_WORKFLOWS) {
    describe(workflowId, () => {
      let spec: WorkflowSpec;
      let fixStep: WorkflowSpec["steps"][number] | undefined;

      before(async () => {
        spec = await loadWorkflowSpec(resolve(workflowsDir, workflowId));
        fixStep = spec.steps.find((s) => s.id === "fix");
      });

      it("fix step exists", () => {
        assert.ok(fixStep, `${workflowId}: fix step must exist`);
      });

      it("Reply-with block lists REPRO_EVIDENCE and CANNOT_REPRODUCE fourth-key options", () => {
        assert.ok(fixStep!.input.includes("REPRO_EVIDENCE:"),
          `${workflowId}/fix: Reply-with must list REPRO_EVIDENCE`);
        assert.ok(fixStep!.input.includes("CANNOT_REPRODUCE:"),
          `${workflowId}/fix: Reply-with must list CANNOT_REPRODUCE`);
      });

      it("STATUS/CHANGES/REGRESSION_TEST Reply-with keys are unchanged", () => {
        assert.ok(fixStep!.input.includes("STATUS: done"),
          `${workflowId}/fix: STATUS: done Reply-with line must remain`);
        assert.ok(fixStep!.input.includes("CHANGES: what was changed"),
          `${workflowId}/fix: CHANGES Reply-with line must remain`);
        assert.ok(fixStep!.input.includes("REGRESSION_TEST: what test was added"),
          `${workflowId}/fix: REGRESSION_TEST Reply-with line must remain`);
      });

      it("expects enforces regex:^(REPRO_EVIDENCE|CANNOT_REPRODUCE):\\s*\\S+", () => {
        assert.ok(fixStep!.expects.includes(ALTERNATION_EXPECTS),
          `${workflowId}/fix: expects must contain the either/or alternation regex`);
      });

      it("STATUS/CHANGES/REGRESSION_TEST remain enforced in expects", () => {
        const keys = parseEnforcedKeys(fixStep!.expects);
        assert.ok(keys.includes("changes"), "CHANGES must remain enforced");
        assert.ok(keys.includes("regression_test"), "REGRESSION_TEST must remain enforced");
        assert.ok(!keys.includes("status"), "STATUS must not be an enforced data key");
      });

      it("parseEnforcedKeys recognizes both alternation keys", () => {
        const keys = parseEnforcedKeys(fixStep!.expects);
        assert.ok(keys.includes("repro_evidence"),
          `parseEnforcedKeys must extract repro_evidence from the alternation, got: ${keys.join(", ")}`);
        assert.ok(keys.includes("cannot_reproduce"),
          `parseEnforcedKeys must extract cannot_reproduce from the alternation, got: ${keys.join(", ")}`);
      });

      it("validateExpects accepts either key alone and rejects neither", () => {
        const expects = fixStep!.expects;
        assert.equal(
          validateExpects(
            "STATUS: done\nCHANGES: fixed\nREGRESSION_TEST: added test\nREPRO_EVIDENCE: pre-fix failing output pointer",
            expects,
          ),
          null,
          "REPRO_EVIDENCE-only output must satisfy the fix contract",
        );
        assert.equal(
          validateExpects(
            "STATUS: done\nCHANGES: fixed\nREGRESSION_TEST: added test\nCANNOT_REPRODUCE: flaky env-dependent failure",
            expects,
          ),
          null,
          "CANNOT_REPRODUCE-only output must satisfy the fix contract",
        );
        assert.ok(
          validateExpects(
            "STATUS: done\nCHANGES: fixed\nREGRESSION_TEST: added test",
            expects,
          ),
          "an output with neither alternation key must be rejected",
        );
      });

      it("only deception_audit consumes the either/or keys downstream (no MISS deadlock)", () => {
        // US-008 introduced the either/or fourth key with NO downstream
        // consumers; US-009 added the deception_audit step, which is the ONE
        // legitimate consumer of both keys. The claim-time MISS deadlock is
        // prevented by the fix-completion handler (US-009), which normalizes
        // the absent alternation key to '' in run context so both placeholders
        // always resolve. Every OTHER downstream step must keep consuming
        // stable keys only.
        const fixIndex = spec.steps.findIndex((s) => s.id === "fix");
        for (let j = fixIndex + 1; j < spec.steps.length; j++) {
          const step = spec.steps[j];
          if (step.id === "deception_audit") continue;
          assert.ok(!step.input.includes("{{repro_evidence}}"),
            `${workflowId}/${step.id}: must not consume {{repro_evidence}} (either/or key → MISS deadlock)`);
          assert.ok(!step.input.includes("{{cannot_reproduce}}"),
            `${workflowId}/${step.id}: must not consume {{cannot_reproduce}} (either/or key → MISS deadlock)`);
        }
      });

      it("deception_audit consumes both either/or keys (the sanctioned auditor)", () => {
        const auditStep = spec.steps.find((s) => s.id === "deception_audit");
        if (auditStep) {
          assert.ok(auditStep.input.includes("{{repro_evidence}}"),
            `${workflowId}/deception_audit: must consume {{repro_evidence}}`);
          assert.ok(auditStep.input.includes("{{cannot_reproduce}}"),
            `${workflowId}/deception_audit: must consume {{cannot_reproduce}}`);
        }
      });

      it("downstream steps consume stable keys instead of the either/or keys", () => {
        // The verify step consumes {{changes}}/{{regression_test}} — both are
        // guaranteed present regardless of which alternation key the fixer chose.
        const verifyStep = spec.steps.find((s) => s.id === "verify");
        if (verifyStep) {
          assert.ok(verifyStep.input.includes("{{changes}}"));
          assert.ok(verifyStep.input.includes("{{regression_test}}"));
        }
      });
    });
  }

  it("triager REPRODUCTION: narrative is unchanged in every bug-* workflow", async () => {
    for (const workflowId of BUG_FIX_WORKFLOWS) {
      const spec = await loadWorkflowSpec(resolve(workflowsDir, workflowId));
      const triageStep = spec.steps.find((s) => s.id === "triage");
      assert.ok(triageStep, `${workflowId}: triage step must exist`);
      assert.ok(triageStep!.input.includes("REPRODUCTION: how to reproduce the bug"),
        `${workflowId}/triage: REPRODUCTION narrative must remain unchanged`);
    }
  });
});
