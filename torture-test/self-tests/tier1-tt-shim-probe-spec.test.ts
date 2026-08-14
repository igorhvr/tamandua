import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadWorkflowSpec } from "../../src/installer/workflow-spec.ts";

// ── tt-shim-probe spec scaffolding (US-001) ──────────────────────────────
//
// Torture-test ships its OWN custom tamandua workflow specs under
// torture-test/workflows/ (distinct from the bundled repo catalog at
// workflows/). The canonical custom spec is tt-shim-probe, a ONE-STEP
// workflow whose single step's input template renders the raw {{test_cmd}}
// verbatim (per spec 05-wave-1-language-smoke.md#W1.L2).
//
// These tests pin the US-001 acceptance criteria:
//   1. torture-test/workflows/tt-shim-probe/workflow.yml exists and id == 'tt-shim-probe'
//   2. exactly one step whose input template contains 'TEST_CMD: {{test_cmd}}'
//   3. persona files (AGENTS.md/IDENTITY.md/SOUL.md) exist and include the
//      CRITICAL STATUS Line Requirement section
//   4. workflow.yml passes the same structural validation as the bundled set

const repoRoot = process.cwd();
const workflowsSrcRoot = join(repoRoot, "torture-test", "workflows");
const probeWorkflowDir = join(workflowsSrcRoot, "tt-shim-probe");

describe("tt-shim-probe TT-custom workflow spec", () => {
  it("workflow.yml exists and loads under the same structural validation as bundled workflows", async () => {
    assert.ok(
      existsSync(join(probeWorkflowDir, "workflow.yml")),
      "torture-test/workflows/tt-shim-probe/workflow.yml must exist",
    );
    // loadWorkflowSpec performs the identical structural validation the
    // bundled catalog satisfies (required id/agents/steps fields, workspace
    // baseDir well-formed). It throws on any structural violation.
    const spec = await loadWorkflowSpec(probeWorkflowDir);
    assert.equal(spec.id, "tt-shim-probe");
    assert.equal(spec.version ?? 1, 1);
    assert.ok(spec.name && spec.name.length > 0);
    assert.ok(spec.description && spec.description.length > 0);
  });

  it("contains exactly one step whose input renders {{test_cmd}} verbatim", async () => {
    const spec = await loadWorkflowSpec(probeWorkflowDir);
    assert.equal(spec.steps.length, 1, "tt-shim-probe must be a ONE-STEP workflow");
    const step = spec.steps[0];
    assert.equal(step.id, "execute");
    assert.ok(typeof step.input === "string" && step.input.length > 0);
    // The probe's core contract: the raw, unwrapped command is templated in
    // verbatim. Must contain the literal template line, not a pre-wrapped
    // or substituted value (no double-wrap).
    assert.ok(
      step.input.includes("TEST_CMD: {{test_cmd}}"),
      "input template must contain 'TEST_CMD: {{test_cmd}}' verbatim",
    );
  });

  it("exactly one agent with persona files that include the CRITICAL STATUS section", async () => {
    const spec = await loadWorkflowSpec(probeWorkflowDir);
    assert.equal(spec.agents.length, 1, "tt-shim-probe must declare exactly one agent");

    const agent = spec.agents[0];
    assert.equal(agent.id, "prober");
    assert.ok(agent.workspace, "agent must declare a workspace");
    const { baseDir, files } = agent.workspace;
    assert.ok(typeof baseDir === "string" && baseDir.length > 0);

    // The workflow.yml must wire the three persona files the way bundled
    // workflows do.
    for (const persona of ["AGENTS.md", "IDENTITY.md", "SOUL.md"]) {
      const rel = files[persona];
      assert.ok(
        typeof rel === "string" && rel.length > 0,
        `workflow.yml must wire ${persona} in agent workspace.files`,
      );
      const abs = resolve(probeWorkflowDir, baseDir, persona);
      assert.ok(
        existsSync(abs),
        `persona file must exist: ${join(baseDir, persona)}`,
      );
    }

    // The scheduler depends on exact STATUS markers; the personality must
    // carry the CRITICAL STATUS Line Requirement section.
    const agentsMd = readFileSync(join(probeWorkflowDir, baseDir, "AGENTS.md"), "utf-8");
    assert.ok(
      agentsMd.includes("## CRITICAL — STATUS Line Requirement"),
      "AGENTS.md must include the '## CRITICAL — STATUS Line Requirement' section",
    );
    assert.ok(
      agentsMd.includes("STATUS: done"),
      "AGENTS.md must document the exact STATUS: done marker",
    );
  });

  it("does not create a 'local' workflow spec (W2.24's 'local' workflow is the sentinel resolved to tt-docs-drift)", () => {
    // W2.24-docs-drift carries workflow `local` + harness `pi` in the
    // manifest; tt-required-workflows maps that sentinel to tt-docs-drift
    // (the shipped docs-drift spec — see tier1-tt-docs-drift-spec.test.ts).
    // No installable spec literally named 'local' may ever exist.
    assert.ok(!existsSync(join(workflowsSrcRoot, "local")), "no 'local' TT-custom workflow should exist");
  });

  it("does not collide with the bundled repo catalog ids", async () => {
    const bundledProbe = join(repoRoot, "workflows", "tt-shim-probe");
    assert.ok(
      !existsSync(bundledProbe),
      "tt-shim-probe must live ONLY under torture-test/workflows/, not the bundled catalog",
    );
  });

  it("ships under the committed torture-test/workflows/ tree (not gitignored var/)", () => {
    // var/ is gitignored runtime state; the source-of-truth for TT-custom
    // workflow specs must be committed under torture-test/workflows/.
    assert.ok(workflowsSrcRoot.startsWith(resolve(repoRoot, "torture-test")));
    assert.ok(existsSync(workflowsSrcRoot), "torture-test/workflows/ must exist");
  });
});
