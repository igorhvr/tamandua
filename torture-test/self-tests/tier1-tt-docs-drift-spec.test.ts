import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadWorkflowSpec } from "../../src/installer/workflow-spec.ts";

// ── tt-docs-drift spec scaffolding (E3.D S11 / US-007) ─────────────────
//
// Torture-test ships its own custom workflow specs under
// torture-test/workflows/ (distinct from the bundled repo catalog at
// workflows/). tt-docs-drift is the SHIPPED TWIN of the
// docs/creating-workflows.md "Complete Example" workflow — the docs-drift
// sentinel target for W2.24-docs-drift (tier1.jsonl: workflow `local` +
// harness `pi`). tt-required-workflows maps that sentinel to tt-docs-drift.
//
// These tests pin the US-007 acceptance criteria:
//   1. torture-test/workflows/tt-docs-drift/workflow.yml exists, id ==
//      'tt-docs-drift', and passes the same structural validation as the
//      bundled set (loadWorkflowSpec)
//   2. agents planner (analysis) / setup (coding) / developer (coding) with
//      baseDirs agents/<id>/ per the docs
//   3. steps plan -> setup -> implement with the docs Complete Example step
//      inputs VERBATIM; setup's on_fail reroutes to plan with max_reroutes 2
//   4. structural fidelity: every verbatim fragment the test pins must ALSO
//      appear literally in docs/creating-workflows.md (a docs edit that
//      drifts from the shipped spec fails here — that is the probe's job)
//   5. every agent's AGENTS.md includes the CRITICAL STATUS Line Requirement
//      section (TT-custom workflow convention, mirroring tt-shim-probe)

const repoRoot = process.cwd();
const workflowsSrcRoot = join(repoRoot, "torture-test", "workflows");
const driftWorkflowDir = join(workflowsSrcRoot, "tt-docs-drift");
const docsPath = join(repoRoot, "docs", "creating-workflows.md");

// The docs Complete Example, character-exact fragments (docs/creating-workflows.md
// "### Complete Example"). The shipped spec's step inputs must equal these
// block-scalar renders and the docs must still contain the lines verbatim.
const DOCS_PLAN_INPUT = "Plan the implementation of {{task}}.\nReply with STATUS: done.\n";
const DOCS_SETUP_INPUT = "Set up the repo at {{repo}} for {{task}}.\nReply with STATUS: done.\n";
const DOCS_IMPLEMENT_INPUT = "Implement {{task}}.\nReply with STATUS: done.\n";

// The docs "Agent Persona Files" Example AGENTS.md — the planner persona text
// extracted verbatim (docs/creating-workflows.md).
const DOCS_EXAMPLE_AGENTS_MD = [
  "You are a workflow agent in the Tamandua system.",
  "Your role: Planner.",
  "You decompose tasks into implementable stories.",
  "",
  "Always reply with KEY: value lines:",
  "STATUS: done",
  "PLAN: your plan summary",
  "",
  "For stories, emit a single literal line:",
  'STORIES_JSON: [{"id":"S1","title":"...","description":"...","acceptanceCriteria":["..."]}]',
].join("\n");

function readDocs(): string {
  assert.ok(existsSync(docsPath), "docs/creating-workflows.md must exist");
  return readFileSync(docsPath, "utf8");
}

// completeExampleSection: the docs text between the "### Complete Example"
// heading and the next top-level section heading.
function completeExampleSection(docs: string): string {
  const marker = "### Complete Example";
  const start = docs.indexOf(marker);
  assert.ok(start !== -1, "docs must contain '### Complete Example'");
  const rest = docs.slice(start + marker.length);
  const nextHeading = rest.indexOf("\n### ");
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  assert.ok(section.length > 100, "Complete Example section must be non-trivial");
  return section;
}

describe("tt-docs-drift TT-custom workflow spec (US-007)", () => {
  it("workflow.yml exists and loads under the same structural validation as bundled workflows", async () => {
    assert.ok(
      existsSync(join(driftWorkflowDir, "workflow.yml")),
      "torture-test/workflows/tt-docs-drift/workflow.yml must exist",
    );
    // loadWorkflowSpec performs the identical structural validation the
    // bundled catalog satisfies (required id/agents/steps fields, workspace
    // baseDir well-formed, on_fail keys). It throws on any violation.
    const spec = await loadWorkflowSpec(driftWorkflowDir);
    assert.equal(spec.id, "tt-docs-drift");
    assert.equal(spec.version ?? 1, 1);
    assert.ok(spec.name && spec.name.length > 0);
    assert.ok(spec.description && spec.description.length > 0);
  });

  it("declares agents planner (analysis) / setup (coding) / developer (coding) with baseDirs agents/<id>/", async () => {
    const spec = await loadWorkflowSpec(driftWorkflowDir);
    assert.equal(spec.agents.length, 3, "tt-docs-drift must declare exactly three agents");
    const byId = new Map(spec.agents.map((a) => [a.id, a]));

    const expected = [
      ["planner", "analysis"],
      ["setup", "coding"],
      ["developer", "coding"],
    ] as const;
    assert.deepEqual(
      spec.agents.map((a) => a.id),
      expected.map(([id]) => id),
      "agent declaration order must be planner, setup, developer",
    );
    for (const [id, role] of expected) {
      const agent = byId.get(id);
      assert.ok(agent, `agent ${id} must be declared`);
      assert.equal(agent.role ?? "coding", role, `agent ${id} must carry docs role ${role}`);
      assert.ok(agent.workspace, `agent ${id} must declare a workspace`);
      assert.equal(
        agent.workspace.baseDir,
        `agents/${id}`,
        `agent ${id} workspace.baseDir must be agents/${id}/ per the docs`,
      );
    }
  });

  it("mirrors the docs Complete Example steps verbatim: plan -> setup -> implement with setup reroute wiring", async () => {
    const spec = await loadWorkflowSpec(driftWorkflowDir);
    assert.equal(spec.steps.length, 3, "the Complete Example has exactly three steps");
    assert.deepEqual(
      spec.steps.map((s) => s.id),
      ["plan", "setup", "implement"],
      "step order must be plan -> setup -> implement",
    );
    assert.deepEqual(
      spec.steps.map((s) => s.agent),
      ["planner", "setup", "developer"],
      "step -> agent bindings must match the docs",
    );

    const [plan, setup, implement] = spec.steps;
    assert.equal(plan.input, DOCS_PLAN_INPUT, "plan input must equal the docs block scalar verbatim");
    assert.equal(plan.expects, "STATUS: done");
    assert.equal(plan.max_retries ?? 4, 4, "plan carries the docs default max_retries");
    assert.equal(plan.on_fail, undefined, "plan declares no on_fail (verbatim)");

    assert.equal(setup.input, DOCS_SETUP_INPUT, "setup input must equal the docs block scalar verbatim");
    assert.equal(setup.expects, "STATUS: done");
    assert.equal(setup.max_retries, 4, "setup max_retries must be 4 (verbatim)");
    assert.deepEqual(
      setup.on_fail,
      { retry_step: "plan", max_reroutes: 2 },
      "setup on_fail must reroute to plan with max_reroutes 2 (verbatim)",
    );

    assert.equal(implement.input, DOCS_IMPLEMENT_INPUT, "implement input must equal the docs block scalar verbatim");
    assert.equal(implement.expects, "STATUS: done");
    assert.equal(implement.max_retries, 4, "implement max_retries must be 4 (verbatim)");
    assert.equal(implement.on_fail, undefined, "implement declares no on_fail (verbatim)");
  });

  it("structural fidelity: every pinned verbatim fragment appears literally in docs/creating-workflows.md", () => {
    const docs = readDocs();
    const section = completeExampleSection(docs);

    // Step definitions: the docs Complete Example must literally contain the
    // shipped steps, wiring, and reroute directives. Block-scalar lines are
    // checked individually because the docs markdown indents them inside the
    // ```yaml fence.
    for (const fragment of [
      "- id: plan",
      "agent: planner",
      "Plan the implementation of {{task}}.",
      "Reply with STATUS: done.",
      "- id: setup",
      "agent: setup",
      "Set up the repo at {{repo}} for {{task}}.",
      "retry_step: plan",
      "max_reroutes: 2",
      "- id: implement",
      "agent: developer",
      "Implement {{task}}.",
    ]) {
      assert.ok(section.includes(fragment), `docs Complete Example must contain verbatim: ${fragment}`);
    }
    for (const fragment of [
      'expects: "STATUS: done"',
      "max_retries: 4",
    ]) {
      assert.ok(section.includes(fragment), `docs Complete Example must contain verbatim: ${fragment}`);
    }

    // Agent roles: the docs Roles table defines the shipped roles.
    for (const fragment of [
      "Read/write/exec — primary workhorse role",
      "Developer, fixer, setup",
    ]) {
      assert.ok(docs.includes(fragment), `docs Roles table must contain verbatim: ${fragment}`);
    }

    // The docs Example AGENTS.md (the planner persona source) must be
    // present verbatim — the shipped planner persona is extracted from it.
    for (const line of DOCS_EXAMPLE_AGENTS_MD.split("\n")) {
      if (line.trim() === "") continue;
      assert.ok(docs.includes(line), `docs Example AGENTS.md must contain verbatim: ${line}`);
    }
  });

  it("every agent's persona files are wired and include the CRITICAL STATUS section", async () => {
    const spec = await loadWorkflowSpec(driftWorkflowDir);
    for (const agent of spec.agents) {
      assert.ok(agent.workspace, `agent ${agent.id} must declare a workspace`);
      const { baseDir, files } = agent.workspace;
      for (const persona of ["AGENTS.md", "IDENTITY.md", "SOUL.md"]) {
        const rel = files[persona];
        assert.ok(
          typeof rel === "string" && rel.length > 0,
          `agent ${agent.id} workflow.yml must wire ${persona} in workspace.files`,
        );
        assert.ok(
          existsSync(resolve(driftWorkflowDir, baseDir, persona)),
          `persona file must exist: ${join(baseDir, persona)}`,
        );
      }
      const agentsMd = readFileSync(join(driftWorkflowDir, baseDir, "AGENTS.md"), "utf8");
      assert.ok(
        agentsMd.includes("## CRITICAL — STATUS Line Requirement"),
        `agent ${agent.id} AGENTS.md must include the CRITICAL STATUS section`,
      );
      assert.ok(
        agentsMd.includes("STATUS: done"),
        `agent ${agent.id} AGENTS.md must document the exact STATUS: done marker`,
      );
    }
  });

  it("personas carry their docs-derived text verbatim", async () => {
    const plannerMd = readFileSync(join(driftWorkflowDir, "agents", "planner", "AGENTS.md"), "utf8");
    assert.ok(
      plannerMd.includes(DOCS_EXAMPLE_AGENTS_MD),
      "planner AGENTS.md must contain the docs Example AGENTS.md verbatim",
    );
    const setupMd = readFileSync(join(driftWorkflowDir, "agents", "setup", "AGENTS.md"), "utf8");
    assert.ok(
      setupMd.includes("Set up the repo at {{repo}} for {{task}}."),
      "setup AGENTS.md must carry the docs setup step input verbatim",
    );
    const developerMd = readFileSync(join(driftWorkflowDir, "agents", "developer", "AGENTS.md"), "utf8");
    assert.ok(
      developerMd.includes("Implement {{task}}."),
      "developer AGENTS.md must carry the docs implement step input verbatim",
    );
  });

  it("does not collide with the bundled repo catalog ids", () => {
    assert.ok(
      !existsSync(join(repoRoot, "workflows", "tt-docs-drift")),
      "tt-docs-drift must live ONLY under torture-test/workflows/, not the bundled catalog",
    );
  });

  it("ships under the committed torture-test/workflows/ tree (not gitignored var/)", () => {
    assert.ok(workflowsSrcRoot.startsWith(resolve(repoRoot, "torture-test")));
    assert.ok(existsSync(workflowsSrcRoot), "torture-test/workflows/ must exist");
  });
});
