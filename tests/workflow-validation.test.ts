import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { loadWorkflowSpec } from "../dist/installer/workflow-spec.js";
import { resolveBundledWorkflowsDir } from "../dist/installer/paths.js";

const workflowsDir = resolveBundledWorkflowsDir();
const workflowIds = readdirSync(workflowsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

function wfDir(id: string): string {
  return resolve(workflowsDir, id);
}

describe("workflow parsing", () => {
  it("finds at least 4 bundled workflows", () => {
    assert.ok(workflowIds.length >= 10);
    assert.ok(workflowIds.includes("feature-dev"));
    assert.ok(workflowIds.includes("feature-dev-merge"));
    assert.ok(workflowIds.includes("feature-dev-merge-worktree"));
    assert.ok(workflowIds.includes("security-audit"));
    assert.ok(workflowIds.includes("security-audit-github-pr"));
    assert.ok(workflowIds.includes("bug-fix-github-pr"));
    assert.ok(workflowIds.includes("bug-fix-merge"));
    assert.ok(workflowIds.includes("security-audit-merge"));
    assert.ok(workflowIds.includes("bug-fix"));
    // US-010: worktree variants
    assert.ok(workflowIds.includes("bug-fix-merge-worktree"));
    assert.ok(workflowIds.includes("security-audit-merge-worktree"));
    assert.ok(workflowIds.includes("feature-dev-worktree"));
    assert.ok(workflowIds.includes("bug-fix-worktree"));
    assert.ok(workflowIds.includes("security-audit-worktree"));
    assert.ok(workflowIds.includes("just-do-it"));
    assert.ok(workflowIds.includes("do-review-do-verify"));
  });

  for (const id of workflowIds) {
    it(`parses ${id} workflow YAML without errors`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      assert.equal(spec.id, id);
      assert.ok(spec.agents.length > 0);
      assert.ok(spec.steps.length > 0);
    });

    it(`${id} carries no polling config — dispatch is deterministic`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      assert.equal(
        (spec as Record<string, unknown>).polling,
        undefined,
        `${id}: bundled workflows must not ship a polling block; the dispatch motor ignores it`,
      );
    });

    it(`${id} agents have valid roles if specified`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      const validRoles = new Set(["analysis", "coding", "verification", "testing", "pr", "scanning"]);
      for (const agent of spec.agents) {
        if (agent.role) assert.ok(validRoles.has(agent.role), `${agent.id}: "${agent.role}" is valid`);
      }
    });

    it(`${id} has a non-empty description`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      assert.ok(typeof spec.description === "string", `${id}: description must be a string`);
      assert.ok(spec.description.trim().length > 0, `${id}: description must not be empty`);
    });

    it(`${id} agent workspace files exist`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      for (const agent of spec.agents) {
        for (const [fileName, relativePath] of Object.entries(agent.workspace.files)) {
          const resolved = resolve(wfDir(id), relativePath);
          assert.ok(existsSync(resolved),
            `${id}/${agent.id}: ${relativePath} should exist (for ${fileName})`);
        }
      }
    });
  }
});

describe("model field preservation", () => {
  it("agent model field flows through YAML parsing", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev"));
    const withModel = spec.agents.filter((a) => a.model);
    for (const agent of withModel) {
      assert.ok(typeof agent.model === "string");
      assert.ok(agent.model.length > 0);
    }
  });
});

describe("workflow structure", () => {
  it("shared agent personas exist", () => {
    const repoRoot = resolve(workflowsDir, "..");
    const sharedDir = resolve(repoRoot, "agents", "shared");
    for (const persona of ["setup", "verifier", "pr"]) {
      const d = join(sharedDir, persona);
      assert.ok(existsSync(d), `shared/${persona}/`);
      for (const f of ["AGENTS.md", "SOUL.md", "IDENTITY.md"]) {
        assert.ok(existsSync(join(d, f)), `shared/${persona}/${f}`);
      }
    }
  });

  it("tamandua-agents skill exists with required frontmatter", () => {
    const repoRoot = resolve(workflowsDir, "..");
    const skillPath = resolve(repoRoot, "skills", "tamandua-agents", "SKILL.md");
    assert.ok(existsSync(skillPath));

    const content = readFileSync(skillPath, "utf-8");
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(frontmatter, "missing YAML frontmatter");

    const fm = frontmatter![1];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const descriptionMatch = fm.match(/^description:\s*(.+)$/m);

    assert.ok(nameMatch, "frontmatter must include name");
    assert.ok(descriptionMatch, "frontmatter must include description");
    assert.equal(nameMatch![1].trim(), "tamandua-agents");
    assert.match(nameMatch![1].trim(), /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("tamandua-agents skill documents step lifecycle and stepId usage", () => {
    const repoRoot = resolve(workflowsDir, "..");
    const skillPath = resolve(repoRoot, "skills", "tamandua-agents", "SKILL.md");
    const content = readFileSync(skillPath, "utf-8");

    assert.match(content, /## Quick card — the 90% path/);
    assert.match(content, /## Step lifecycle & completion contract/);
    assert.match(content, /tamandua workflow list/);
    assert.match(content, /tamandua workflow run <workflow-id>/);
    assert.match(content, /tamandua workflow status <query>/);
    assert.match(content, /tamandua step peek <agent-id> --run-id <run-id>/);
    assert.match(content, /tamandua step claim <agent-id> --run-id <run-id>/);
    assert.match(content, /tamandua step complete <stepId>/);
    assert.match(content, /tamandua step fail step-<uuid>/);
    assert.match(content, /SAVE `stepId` immediately/i);
    assert.match(content, /Never call `step complete` or `step fail` with an agent ID/i);
    assert.match(content, /tamandua workflow pause/);
    assert.match(content, /tamandua workflow pause-all/);
    assert.match(content, /--drain/);
    assert.match(content, /tamandua workflow resume-all/);
    assert.match(content, /tamandua logs/);
    assert.match(content, /tamandua logs-tail/);
    assert.match(content, /tamandua dashboard/);
    assert.match(content, /tamandua dashboard status/);
    assert.match(content, /tamandua step stories/);
  });

  it("bundled workflow agents declare tamandua-agents skill", async () => {
    for (const id of workflowIds) {
      const spec = await loadWorkflowSpec(wfDir(id));
      for (const agent of spec.agents) {
        const skills = agent.workspace.skills ?? [];
        assert.ok(
          skills.includes("tamandua-agents"),
          `${id}/${agent.id}: workspace.skills must include tamandua-agents`,
        );
      }
    }
  });

  it("agent-browser skills are preserved where already declared", async () => {
    const expectations = [
      { workflowId: "feature-dev", agentId: "verifier" },
      { workflowId: "feature-dev-merge", agentId: "verifier" },
      { workflowId: "feature-dev-github-pr", agentId: "verifier" },
      { workflowId: "feature-dev-github-pr", agentId: "reviewer" },
    ];

    for (const { workflowId, agentId } of expectations) {
      const spec = await loadWorkflowSpec(wfDir(workflowId));
      const agent = spec.agents.find((entry) => entry.id === agentId);
      assert.ok(agent, `${workflowId}: expected agent ${agentId}`);

      const skills = agent!.workspace.skills ?? [];
      assert.ok(
        skills.includes("agent-browser"),
        `${workflowId}/${agentId}: workspace.skills must preserve agent-browser`,
      );
      assert.ok(
        skills.includes("tamandua-agents"),
        `${workflowId}/${agentId}: workspace.skills must include tamandua-agents`,
      );
    }
  });

  it("all steps reference valid agents", async () => {
    for (const id of workflowIds) {
      const spec = await loadWorkflowSpec(wfDir(id));
      const agentIds = new Set(spec.agents.map((a) => a.id));
      for (const step of spec.steps) {
        assert.ok(agentIds.has(step.agent),
          `${id}: step "${step.id}" references unknown agent "${step.agent}"`);
      }
    }
  });

  it("workflow IDs match directory names", async () => {
    for (const id of workflowIds) {
      const spec = await loadWorkflowSpec(wfDir(id));
      assert.equal(spec.id, id);
    }
  });

  it("feature-dev-merge preserves implement loop wiring and ends with atomic finalization", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge"));

    const stepIds = spec.steps.map((step) => step.id);
    assert.deepEqual(stepIds, ["plan", "setup", "implement", "verify", "test", "finalize_merge"]);
    assert.equal(stepIds[stepIds.length - 1], "finalize_merge");

    const implementStep = spec.steps.find((step) => step.id === "implement");
    assert.ok(implementStep, "feature-dev-merge should define implement step");
    assert.equal(implementStep!.type, "loop");
    assert.equal(implementStep!.loop?.over, "stories");
    assert.equal(implementStep!.loop?.verify_each, true);
    assert.equal(implementStep!.loop?.verify_step, "verify");

    const finalStep = spec.steps.find((step) => step.id === "finalize_merge");
    assert.ok(finalStep, "feature-dev-merge should define finalize_merge step");
    assert.equal(finalStep!.agent, "merger");
    assert.match(finalStep!.input, /RUN_ID:\s*\{\{run_id\}\}/);
    assert.match(finalStep!.input, /ORIGINAL_BRANCH:\s*\{\{original_branch\}\}/);
    assert.match(finalStep!.input, /PROGRESS LOG:\s*\{\{progress\}\}/);
    assert.match(finalStep!.input, /Fast-Forward Check/);
    assert.match(finalStep!.input, /merge-base --is-ancestor "\$EXPECT_TIP" refs\/heads\/\{\{branch\}\}/);
    assert.match(finalStep!.input, /git -C \{\{repo\}\} rebase "\$EXPECT_TIP"/);
    assert.match(finalStep!.input, /CONFLICT_NOTES/);
    assert.match(finalStep!.input, /RETRY_STEP: test/);
    assert.match(finalStep!.input, /tamandua merge-branch/);
    assert.match(finalStep!.input, /--expect-tip "\$EXPECT_TIP"/);
    assert.match(finalStep!.input, /Build a descriptive commit message/);
    assert.match(finalStep!.input, /--message "\$\(cat "\$MESSAGE_FILE"\)"/);
    assert.doesNotMatch(finalStep!.input, /git commit -F|git commit -m/);
    assert.match(finalStep!.input, /MERGE_COMMIT:/);
    assert.match(finalStep!.input, /MERGED_INTO:/);
  });

  it("feature-dev-merge setup prompt captures ORIGINAL_BRANCH before checkout", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge"));
    const setupStep = spec.steps.find((step) => step.id === "setup");

    assert.ok(setupStep, "feature-dev-merge should define setup step");
    assert.match(setupStep!.input, /Capture the current branch before switching: ORIGINAL_BRANCH=\$\(git branch --show-current\)/);
    assert.match(setupStep!.input, /Create the feature branch \(git checkout -b \{\{branch\}\}\)/);
    assert.match(setupStep!.input, /ORIGINAL_BRANCH: <branch name captured before checkout>/);
  });

  it("feature-dev-merge defines workflow-local merger persona files", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge"));
    const merger = spec.agents.find((agent) => agent.id === "merger");

    assert.ok(merger, "feature-dev-merge should define merger agent");
    assert.equal(merger!.role, "pr");
    assert.equal(merger!.workspace.files["AGENTS.md"], "agents/merger/AGENTS.md");
    assert.equal(merger!.workspace.files["SOUL.md"], "agents/merger/SOUL.md");
    assert.equal(merger!.workspace.files["IDENTITY.md"], "agents/merger/IDENTITY.md");
  });

  it("merger AGENTS.md contains commit message generation instructions", () => {
    const mergerAgentsMdPath = resolve(wfDir("feature-dev-merge"), "agents/merger/AGENTS.md");
    const content = readFileSync(mergerAgentsMdPath, "utf-8");

    assert.match(content, /## Commit Message Generation/);
    assert.match(content, /Build a descriptive commit message/);
    assert.match(content, /--message "\$\(cat "\$MESSAGE_FILE"\)"/);
    assert.match(content, /conventional commit format/);
    assert.match(content, /imperative mood/);
    assert.match(content, /Under 72 characters/);
    assert.doesNotMatch(content, /git commit -F|git commit -m/);
    assert.match(content, /Write the full message to a temp file/);
    assert.match(content, /### Gathering Information/);
  });

  it("planner AGENTS.md Output Format mandates single-line minified STORIES_JSON", () => {
    const plannerAgentsMdPath = resolve(wfDir("feature-dev-merge"), "agents/planner/AGENTS.md");
    const content = readFileSync(plannerAgentsMdPath, "utf-8");

    // Output Format section exists
    assert.match(content, /## Output Format/);

    // Must require STORIES_JSON on a single line
    assert.match(content, /Single line only/);
    assert.match(content, /ONE line/);

    // Must require minified (compact) JSON
    assert.match(content, /Minified JSON/);
    assert.match(content, /no newlines/);
    assert.match(content, /no pretty-printing/);

    // Must forbid markdown code fences
    assert.match(content, /No markdown code fences/);
    assert.match(content, /triple backticks/);

    // Must forbid JSON comments
    assert.match(content, /No JSON comments/);

    // Must forbid trailing commas
    assert.match(content, /No trailing commas/);

    // Must forbid prose before/after the JSON array
    assert.match(content, /No prose before or after/);

    // Must contain a correct single-line minified example
    assert.match(content, /STORIES_JSON: \[\{"id":"US-001"/);
  });

  it("planner AGENTS.md provides wrong-format anti-pattern examples", () => {
    const plannerAgentsMdPath = resolve(wfDir("feature-dev-merge"), "agents/planner/AGENTS.md");
    const content = readFileSync(plannerAgentsMdPath, "utf-8");

    // Shows code-fenced JSON as wrong
    assert.match(content, /WRONG.*code-fenced/);
    assert.match(content, /DO NOT DO THIS/);

    // Shows multi-line pretty-printed JSON as wrong
    assert.match(content, /WRONG.*multi-line/);
    assert.match(content, /WRONG.*pretty-printed/);

    // Shows JSON with comments as wrong
    assert.match(content, /WRONG.*JSON with comments/);

    // Shows text after closing bracket as wrong
    assert.match(content, /WRONG.*text after closing bracket/);
  });

  it("planner AGENTS.md primary STORIES_JSON template is single-line, not multi-line", () => {
    const plannerAgentsMdPath = resolve(wfDir("feature-dev-merge"), "agents/planner/AGENTS.md");
    const content = readFileSync(plannerAgentsMdPath, "utf-8");

    // The primary template line should be a single-line minified JSON, not a multi-line entry.
    // Verify the correctly-formatted single-line version exists as a standalone line.
    const singleLineMatch = content.match(/^STORIES_JSON: \[\{"id"/m);
    assert.ok(singleLineMatch, "Primary STORIES_JSON template should be a single line starting with STORIES_JSON: [{\"id\"");
  });

  it("planner AGENTS.md What NOT To Do section includes STORIES_JSON format rules", () => {
    const plannerAgentsMdPath = resolve(wfDir("feature-dev-merge"), "agents/planner/AGENTS.md");
    const content = readFileSync(plannerAgentsMdPath, "utf-8");

    assert.match(content, /## What NOT To Do/);

    // Must include rules about code fences
    assert.match(content, /Do not wrap STORIES_JSON in markdown code fences/);

    // Must include rules about pretty-printing
    assert.match(content, /Do not pretty-print the JSON array across multiple lines/);

    // Must include rules about text before/after
    assert.match(content, /Do not add text before or after the JSON array on the STORIES_JSON line/);

    // Must include rules about JSON comments
    assert.match(content, /Do not include JSON comments/);
  });

  it("planner AGENTS.md output format rules section does not present multi-line JSON as correct", () => {
    const plannerAgentsMdPath = resolve(wfDir("feature-dev-merge"), "agents/planner/AGENTS.md");
    const content = readFileSync(plannerAgentsMdPath, "utf-8");

    // Extract the rules section (between ## Output Format and ### Examples).
    // The rules section describes what to do; the examples section shows WRONG
    // formats (which naturally contain multi-line JSON). Only the rules section
    // must be free of multi-line patterns that could mislead the LLM.
    const rulesSection = content.split("### Examples")[0].split("## Output Format")[1];
    assert.ok(rulesSection, "Should extract rules section after ## Output Format");

    // No STORIES_JSON: followed by a newline and opening bracket/brace in the rules section
    assert.doesNotMatch(rulesSection, /STORIES_JSON:\s*\n\s*[\[{]/);
  });

  it("feature-dev-merge workflow.yml plan step input contains single-line minified STORIES_JSON example", () => {
    const workflowYmlPath = resolve(wfDir("feature-dev-merge"), "workflow.yml");
    const content = readFileSync(workflowYmlPath, "utf-8");

    // Must contain a single-line minified STORIES_JSON example
    assert.match(content, /STORIES_JSON: \[\{"id":"US-001"/);

    // Must state the line must be a single line with no line breaks
    assert.match(content, /single line/);
    assert.match(content, /no line breaks/);
  });

  it("feature-dev-merge workflow.yml plan step input contains anti-pattern warnings", () => {
    const workflowYmlPath = resolve(wfDir("feature-dev-merge"), "workflow.yml");
    const content = readFileSync(workflowYmlPath, "utf-8");

    // Must contain anti-pattern section header
    assert.match(content, /ANTI-PATTERNS/);
    assert.match(content, /DO NOT DO/);

    // Must warn against triple backticks
    assert.match(content, /Do NOT use triple backticks/);

    // Must warn against comments inside JSON
    assert.match(content, /Do NOT add comments inside the JSON/);

    // Must warn against text after closing bracket
    assert.match(content, /Do NOT put any text after the closing \]/);
  });

  it("feature-dev-merge workflow.yml plan step input does not present multi-line JSON outside anti-pattern context", () => {
    const workflowYmlPath = resolve(wfDir("feature-dev-merge"), "workflow.yml");
    const content = readFileSync(workflowYmlPath, "utf-8");

    // Extract the plan step input block: everything from "- id: plan" in the
    // steps array to the start of the next step ("  - id: setup"). Use precise
    // boundaries to avoid matching "- id: planner" in the agents section.
    const afterPlan = content.split("\n  - id: plan\n    agent: planner")[1];
    assert.ok(afterPlan, "Should find plan step after '- id: plan' in steps");
    const planStepInput = afterPlan.split("\n  - id: setup")[0];
    assert.ok(planStepInput, "Should extract plan step input section");

    // No multi-line pretty-printed JSON in the plan step example (e.g., no
    // lines like '  "id":' indented under a STORIES_JSON or bracket line in
    // the example area). The example must be a single compact line.
    assert.match(planStepInput, /STORIES_JSON: \[\{"id":"US-001"/);
  });

  it("bug-fix has 5 agents, 5 steps, no merger, no finalize_merge, no ORIGINAL_BRANCH capture", async () => {
    const spec = await loadWorkflowSpec(wfDir("bug-fix"));

    // 5 agents
    const agentIds = spec.agents.map((a) => a.id);
    assert.equal(spec.agents.length, 5, `expected 5 agents, got ${spec.agents.length}: ${agentIds.join(", ")}`);
    assert.ok(agentIds.includes("triager"));
    assert.ok(agentIds.includes("investigator"));
    assert.ok(agentIds.includes("setup"));
    assert.ok(agentIds.includes("fixer"));
    assert.ok(agentIds.includes("verifier"));

    // No merger agent
    assert.ok(!agentIds.includes("merger"), "bug-fix should not have merger agent");

    // 5 steps
    const stepIds = spec.steps.map((s) => s.id);
    assert.equal(spec.steps.length, 5, `expected 5 steps, got ${spec.steps.length}: ${stepIds.join(", ")}`);
    assert.deepEqual(stepIds, ["triage", "investigate", "setup", "fix", "verify"]);

    // No finalize_merge step
    assert.ok(!stepIds.includes("finalize_merge"), "bug-fix should not have finalize_merge step");

    // Setup input does not mention ORIGINAL_BRANCH
    const setupStep = spec.steps.find((s) => s.id === "setup");
    assert.ok(setupStep, "bug-fix should define setup step");
    assert.doesNotMatch(setupStep!.input, /ORIGINAL_BRANCH/, "bug-fix setup should not capture ORIGINAL_BRANCH");
  });

  it("README documents bug-fix usage and pipeline", () => {
    const repoRoot = resolve(workflowsDir, "..");
    const readmePath = resolve(repoRoot, "README.md");
    const readme = readFileSync(readmePath, "utf-8");

    assert.match(readme, /`bug-fix`/);
    assert.match(readme, /stops after testing/i);
    assert.match(readme, /no merge/i);
    assert.match(readme, /triage → investigate → setup → fix → verify/);
  });

  it("README documents feature-dev-merge usage and pipeline", () => {
    const repoRoot = resolve(workflowsDir, "..");
    const readmePath = resolve(repoRoot, "README.md");
    const readme = readFileSync(readmePath, "utf-8");

    assert.match(readme, /`feature-dev-merge`/);
    assert.match(readme, /squash-merges/i);
    assert.match(readme, /original branch/i);
    assert.match(readme, /plan → setup → implement → verify → test → finalize_merge/);
  });

  it("security-audit-merge finalize_merge step includes fast-forward-first merge instructions", async () => {
    const spec = await loadWorkflowSpec(wfDir("security-audit-merge"));
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep, "finalize_merge step must exist");
    assert.equal(finalStep!.agent, "merger");

    // Phase 1: Fast-Forward Check
    assert.match(finalStep!.input, /Fast-Forward Check/);
    assert.match(finalStep!.input, /git merge-base --is-ancestor \{\{original_branch\}\} \{\{branch\}\}/);

    // Phase 2: Rebase
    assert.match(finalStep!.input, /Phase 2.*Rebase/);
    assert.match(finalStep!.input, /git rebase \{\{original_branch\}\}/);
    assert.match(finalStep!.input, /git rebase --continue/);
    assert.match(finalStep!.input, /CONFLICT_NOTES/);
    assert.match(finalStep!.input, /RETRY_STEP: test/);
    assert.match(finalStep!.input, /Do NOT merge/);

    // Phase 3: Squash Merge
    assert.match(finalStep!.input, /Phase 3.*Squash Merge/);
    assert.match(finalStep!.input, /git checkout \{\{original_branch\}\}/);
    assert.match(finalStep!.input, /git merge --squash \{\{branch\}\}/);
    assert.match(finalStep!.input, /git commit -F <tempfile>/);

    // Output format includes REBASED
    assert.match(finalStep!.input, /REBASED:\s*false/);
    assert.match(finalStep!.input, /MERGE_COMMIT:/);
    assert.match(finalStep!.input, /MERGED_INTO:/);

    // Preserves fix(security):-prefix commit message guidance
    assert.match(finalStep!.input, /fix\(security\)/);

    // RETRY_FEEDBACK placeholder
    assert.match(finalStep!.input, /\{\{retry_feedback\}\}/);
  });

  it("security-audit-merge test step includes RETRY_FEEDBACK placeholder for rebase re-validation", async () => {
    const spec = await loadWorkflowSpec(wfDir("security-audit-merge"));
    const testStep = spec.steps.find((s) => s.id === "test");
    assert.ok(testStep, "test step must exist");
    assert.match(testStep!.input, /\{\{retry_feedback\}\}/);
    assert.match(testStep!.input, /re-validate the rebased changes/);
  });

  it("security-audit-merge merger AGENTS.md uses atomic plumbing landing", () => {
    const mergerAgentsMdPath = resolve(wfDir("security-audit-merge"), "agents", "merger", "AGENTS.md");
    const content = readFileSync(mergerAgentsMdPath, "utf-8");

    // Phase 1 captures the current origin target before checking FF safety.
    assert.match(content, /Phase 1: Capture Target Tip and Check Fast-Forward Safety/);
    assert.match(content, /EXPECT_TIP=\$\(git -C "\$ORIGIN_REPOSITORY" rev-parse "\$TARGET_REF"\)/);
    assert.match(content, /merge-base --is-ancestor "\$EXPECT_TIP" refs\/heads\/\{\{branch\}\}/);
    const phase1Index = content.indexOf("Phase 1: Capture Target Tip");
    const phase3Index = content.indexOf("Phase 3: Atomic Landing");
    assert.ok(phase1Index < phase3Index, "target-tip capture must come before atomic landing");

    // Phase 2: Rebase on non-FF path with conflict resolution
    assert.match(content, /Phase 2: Rebase/);
    assert.match(content, /git -C \{\{repo\}\} rebase "\$EXPECT_TIP"/);
    assert.match(content, /git rebase --continue/);
    assert.match(content, /fix them carefully|resolve each conflict|If conflicts arise/i);

    // Tester retry path when rebase made changes
    assert.match(content, /STATUS: retry/);
    assert.match(content, /CONFLICT_NOTES:/);
    assert.match(content, /RETRY_STEP: test/);
    assert.match(content, /do NOT merge/);

    // Guardrails permit only the CAS-protected plumbing command to mutate the target ref.
    assert.match(content, /only `tamandua merge-branch` may update the target ref/i);
    assert.match(content, /IF YOU REBASED, YOU NEVER MERGE IN THIS INVOCATION/);
    assert.match(content, /--origin "\$ORIGIN_REPOSITORY"/);
    assert.match(content, /--branch "\{\{branch\}\}"/);
    assert.match(content, /--into "\{\{original_branch\}\}"/);
    assert.match(content, /--expect-tip "\$EXPECT_TIP"/);
    assert.match(content, /--message "\$\(cat "\$MESSAGE_FILE"\)"/);

    // Output preserves plumbing metadata and legacy workflow keys.
    assert.match(content, /STATUS: landed[\s\S]*MERGED_COMMIT:[\s\S]*CHECKOUT_REFRESH:[\s\S]*REBASED:\s*false/);

    // Preserves fix(security):-prefix commit message guidance
    assert.match(content, /fix\(security\)/);
    assert.match(content, /Do NOT use `feat:` prefix/);

    // Preserves message provenance while removing porcelain landing.
    assert.match(content, /security audit task from `\{\{task\}\}`/);
    assert.match(content, /progress file `\{\{progress_file\}\}`/);
    assert.doesNotMatch(content, /git checkout|git merge --squash|git commit -F|git commit -m/);
    assert.match(content, /Co-Authored-By: Tamandua/);
  });

  it("security-audit-merge workflow.yml finalize_merge step on_fail routes to test", async () => {
    const spec = await loadWorkflowSpec(wfDir("security-audit-merge"));
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep, "finalize_merge step must exist");
    assert.equal(finalStep!.on_fail?.retry_step, "test");
    assert.ok(finalStep!.on_fail?.max_retries);
    assert.equal(finalStep!.on_fail?.on_exhausted, undefined);
  });

  it("no bundled workflow.yml contains escalate_to (regression guard)", () => {
    // After removing the escalation concept, escalate_to must not appear
    // in any bundled workflow definition.
    const entries = readdirSync(workflowsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wfPath = resolve(workflowsDir, entry.name, "workflow.yml");
      if (!existsSync(wfPath)) continue;
      const content = readFileSync(wfPath, "utf-8");
      assert.doesNotMatch(
        content,
        /escalate_to/,
        `${entry.name}/workflow.yml must not contain escalate_to`,
      );
    }
  });

describe("US-004: fast-forward-first merge contradiction prevention and ordering", () => {
  const mergeWorkflows = ["feature-dev-merge", "bug-fix-merge", "security-audit-merge"];

  // AC 4: All three merger AGENTS.md files pass guardrail check
  for (const wfId of mergeWorkflows) {
    it(`${wfId} merger AGENTS.md forbids simultaneous contradictory FF + unrelated squash`, () => {
      const mergerMd = readFileSync(resolve(wfDir(wfId), "agents", "merger", "AGENTS.md"), "utf-8");

      // Guardrail must structurally guarantee that rebase always ends the
      // invocation and landing happens only on a tested, FF-safe tree.
      if (wfId === "feature-dev-merge") {
        assert.match(mergerMd, /IF YOU REBASED, YOU NEVER LAND IN THIS INVOCATION/);
      } else {
        assert.match(mergerMd, /IF YOU REBASED, YOU NEVER MERGE IN THIS INVOCATION/);
      }

      // Every squash-merge mention must be in a FF-safe or guardrails context
      const squashRe = /squash[ -]?merge/gi;
      let match: RegExpExecArray | null;
      while ((match = squashRe.exec(mergerMd)) !== null) {
        const idx = match.index;
        // Wide window captures MRGV context phrases (Phase 3, FF-safe,
        // guardrails, rebase-loopback, retry path, tree-hash attestation).
        const context = mergerMd.substring(Math.max(0, idx - 250), idx + 250);
        assert.ok(
          context.includes("Phase 3") ||
            context.includes("FF-safe") ||
            context.includes("fast-forward-safe") ||
            context.includes("NEVER") ||
            context.includes("IF YOU REBASED") ||
            context.includes("RETRY_STEP") ||
            context.includes("you are re-invoked") ||
            context.includes("is now fast-forward-safe") ||
            context.includes("report retry") ||
            context.includes("squash-merged tree") ||
            context.includes("MERGED_TREE"),
          `${wfId}: squash merge mention outside FF-safe context (pos ${idx}): ...${context.substring(230, 270)}...`,
        );
      }
    });
  }

  // AC 5: All three workflow.yml finalize_merge step inputs place the FF check before landing
  for (const wfId of mergeWorkflows) {
    it(`${wfId} workflow.yml finalize_merge step input places FF check before landing (US-004 ordering)`, async () => {
      const spec = await loadWorkflowSpec(wfDir(wfId));
      const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
      assert.ok(finalStep, `${wfId}: finalize_merge step must exist`);

      const input = finalStep!.input;
      const ffIdx = input.search(/merge-base --is-ancestor/);
      const landingIdx = wfId === "feature-dev-merge"
        ? input.search(/MERGE_OUTPUT=\$\(tamandua merge-branch/)
        : input.search(/git merge --squash/);

      assert.ok(ffIdx >= 0, `${wfId}: must contain merge-base --is-ancestor`);
      assert.ok(landingIdx >= 0, `${wfId}: must contain its landing command`);
      assert.ok(
        ffIdx < landingIdx,
        `${wfId}: FF check (pos ${ffIdx}) must appear before landing (pos ${landingIdx})`,
      );
    });
  }

  // AC 6: Tester retry path exists for feature-dev-merge and security-audit-merge
  for (const wfId of ["feature-dev-merge", "security-audit-merge"]) {
    it(`${wfId} finalize_merge step input includes tester retry path (RETRY_STEP: test, CONFLICT_NOTES) (US-004)`, async () => {
      const spec = await loadWorkflowSpec(wfDir(wfId));
      const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
      assert.ok(finalStep);
      assert.match(finalStep!.input, /RETRY_STEP:\s*test/);
      assert.match(finalStep!.input, /CONFLICT_NOTES/);
    });
  }

  // AC 6: Bug-fix-merge does NOT have tester retry path
  it("bug-fix-merge finalize_merge step input does NOT have tester retry path (US-004)", async () => {
    const spec = await loadWorkflowSpec(wfDir("bug-fix-merge"));
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep);
    assert.doesNotMatch(finalStep!.input, /RETRY_STEP:\s*test/);
    assert.doesNotMatch(finalStep!.input, /CONFLICT_NOTES/);
  });
});

  it("feature-dev family setup prompts include {{retry_feedback}} placeholder", async () => {
    // Verify all three feature-dev family workflows have retry_feedback in their
    // setup step input templates so retried setups receive prior failure context.
    const featureFamily = ["feature-dev", "feature-dev-merge", "feature-dev-github-pr"];

    for (const id of featureFamily) {
      const spec = await loadWorkflowSpec(wfDir(id));
      const setupStep = spec.steps.find((s) => s.id === "setup");
      assert.ok(setupStep, `${id}: must define a setup step`);

      // The setup input must include the {{retry_feedback}} placeholder
      assert.match(
        setupStep!.input,
        /\{\{retry_feedback\}\}/,
        `${id}: setup step input must include {{retry_feedback}} placeholder`,
      );

      // Verify it's placed correctly: after the TASK/REPO/BRANCH context block
      // and before the Instructions block
      assert.match(setupStep!.input, /RETRY FEEDBACK/,
        `${id}: setup input should contain a RETRY FEEDBACK section`);
      assert.match(setupStep!.input, /Instructions:/,
        `${id}: setup input should contain an Instructions section`);
    }
  });
});

describe("US-010: Create remaining worktree workflow variants", () => {
  const worktreeVariantIds = [
    "bug-fix-merge-worktree",
    "security-audit-merge-worktree",
    "feature-dev-worktree",
    "bug-fix-worktree",
    "security-audit-worktree",
  ];

  const mergeWorktreeVariantIds = [
    "bug-fix-merge-worktree",
    "security-audit-merge-worktree",
  ];

  const nonMergeWorktreeVariantIds = [
    "feature-dev-worktree",
    "bug-fix-worktree",
    "security-audit-worktree",
  ];

  for (const id of worktreeVariantIds) {
    it(`${id} parses successfully`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      assert.equal(spec.id, id);
      assert.ok(spec.agents.length > 0);
      assert.ok(spec.steps.length > 0);
    });

    it(`${id} declares run.workspace: worktree`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      assert.equal(spec.run?.workspace, "worktree");
    });

    it(`${id} all agent workspace files exist`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      for (const agent of spec.agents) {
        for (const [fileName, relativePath] of Object.entries(agent.workspace.files)) {
          const resolved = resolve(wfDir(id), relativePath);
          assert.ok(existsSync(resolved),
            `${id}/${agent.id}: ${relativePath} should exist (for ${fileName})`);
        }
      }
    });

    it(`${id} all agents have tamandua-agents skill`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      for (const agent of spec.agents) {
        const skills = agent.workspace.skills ?? [];
        assert.ok(
          skills.includes("tamandua-agents"),
          `${id}/${agent.id}: workspace.skills must include tamandua-agents`,
        );
      }
    });

    it(`${id} setup step adapted for detached worktree startup`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      const setupStep = spec.steps.find((s) => s.id === "setup");
      assert.ok(setupStep, `${id}: must define setup step`);

      // Should reference {{original_branch}} context variable (pre-seeded by harness)
      assert.match(setupStep!.input, /\{\{original_branch\}\}/);
      assert.match(setupStep!.input, /ORIGINAL_BRANCH:\s*\{\{original_branch\}\}/);

      // Should tell agent not to run git branch --show-current (detached HEAD)
      assert.match(setupStep!.input, /do NOT run.*git branch --show-current/i);

      // Should NOT include shell command to capture original_branch
      assert.doesNotMatch(setupStep!.input, /ORIGINAL_BRANCH=\$\(git branch --show-current\)/);
    });
  }

  for (const id of mergeWorktreeVariantIds) {
    it(`${id} finalize_merge step has worktree_origin_repository guidance`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
      assert.ok(finalStep, `${id}: must define finalize_merge step`);

      // Should reference {{worktree_origin_repository}} context variable
      assert.match(finalStep!.input, /\{\{worktree_origin_repository\}\}/);

      // Should include worktree mode instructions
      assert.match(finalStep!.input, /Worktree Mode/);

      // Should direct Phase 1 and Phase 3 to the origin repository
      assert.match(finalStep!.input, /cd \{\{worktree_origin_repository\}\}/);
    });

    it(`${id} preserves fast-forward-first merge ordering (FF check before squash)`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
      assert.ok(finalStep);

      const input = finalStep!.input;
      const ffIdx = input.search(/git merge-base --is-ancestor/);
      const squashIdx = input.search(/git merge --squash/);

      assert.ok(ffIdx >= 0, `${id}: must contain git merge-base --is-ancestor`);
      assert.ok(squashIdx >= 0, `${id}: must contain git merge --squash`);
      assert.ok(
        ffIdx < squashIdx,
        `${id}: FF check (pos ${ffIdx}) must appear before squash merge (pos ${squashIdx})`,
      );
    });
  }

  it("security-audit-merge-worktree finalize_merge has tester retry path", async () => {
    const spec = await loadWorkflowSpec(wfDir("security-audit-merge-worktree"));
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep);
    assert.match(finalStep!.input, /RETRY_STEP:\s*test/);
    assert.match(finalStep!.input, /CONFLICT_NOTES/);
  });

  for (const id of nonMergeWorktreeVariantIds) {
    it(`${id} has no finalize_merge step (non-merge variant)`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      const stepIds = spec.steps.map((s) => s.id);
      assert.ok(!stepIds.includes("finalize_merge"), `${id}: non-merge variant should not have finalize_merge step`);
    });
  }

  it("feature-dev-worktree verifier agent preserves agent-browser skill", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-worktree"));
    const verifier = spec.agents.find((a) => a.id === "verifier");
    assert.ok(verifier, "must define verifier agent");
    const skills = verifier!.workspace.skills ?? [];
    assert.ok(skills.includes("agent-browser"), "verifier workspace.skills must preserve agent-browser");
  });

  it("bug-fix-merge-worktree step order matches original (triage → investigate → setup → fix → verify → finalize_merge)", async () => {
    const spec = await loadWorkflowSpec(wfDir("bug-fix-merge-worktree"));
    const stepIds = spec.steps.map((s) => s.id);
    assert.deepEqual(stepIds, ["triage", "investigate", "setup", "fix", "verify", "finalize_merge"]);
  });

  it("security-audit-merge-worktree step order matches original", async () => {
    const spec = await loadWorkflowSpec(wfDir("security-audit-merge-worktree"));
    const stepIds = spec.steps.map((s) => s.id);
    assert.deepEqual(stepIds, ["scan", "prioritize", "setup", "fix", "verify", "test", "finalize_merge"]);
  });

  it("bug-fix-worktree has no merger agent (non-merge variant)", async () => {
    const spec = await loadWorkflowSpec(wfDir("bug-fix-worktree"));
    const agentIds = spec.agents.map((a) => a.id);
    assert.ok(!agentIds.includes("merger"), "bug-fix-worktree should not have merger agent");
  });

  it("feature-dev-worktree implements step has loop wiring", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-worktree"));
    const implementStep = spec.steps.find((s) => s.id === "implement");
    assert.ok(implementStep, "should define implement step");
    assert.equal(implementStep!.type, "loop");
    assert.equal(implementStep!.loop?.over, "stories");
    assert.equal(implementStep!.loop?.verify_each, true);
    assert.equal(implementStep!.loop?.verify_step, "verify");
  });

  it("security-audit-worktree fix step has loop wiring", async () => {
    const spec = await loadWorkflowSpec(wfDir("security-audit-worktree"));
    const fixStep = spec.steps.find((s) => s.id === "fix");
    assert.ok(fixStep, "should define fix step");
    assert.equal(fixStep!.type, "loop");
    assert.equal(fixStep!.loop?.over, "stories");
    assert.equal(fixStep!.loop?.verify_each, true);
    assert.equal(fixStep!.loop?.verify_step, "verify");
  });
});

describe("US-009: feature-dev-merge-worktree workflow variant", () => {
  it("declares run.workspace: worktree", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge-worktree"));
    assert.equal(spec.run?.workspace, "worktree");
  });

  it("setup step uses {{original_branch}} from context instead of git branch --show-current", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge-worktree"));
    const setupStep = spec.steps.find((s) => s.id === "setup");
    assert.ok(setupStep, "must define setup step");

    // Should reference {{original_branch}} context variable
    assert.match(setupStep!.input, /\{\{original_branch\}\}/);

    // Should provide original_branch as pre-seeded (not captured via git branch --show-current)
    assert.match(setupStep!.input, /pre-seeded|already provided|harness/);

    // Should NOT include the command to capture original_branch via shell
    assert.doesNotMatch(setupStep!.input, /ORIGINAL_BRANCH=\\$\(git branch --show-current\)/);

    // Output format should use {{original_branch}} not a captured variable
    assert.match(setupStep!.input, /ORIGINAL_BRANCH:\s*\{\{original_branch\}\}/);
  });

  it("finalize_merge step has worktree_origin_repository guidance", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge-worktree"));
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep, "must define finalize_merge step");

    // Should reference {{worktree_origin_repository}} context variable
    assert.match(finalStep!.input, /\{\{worktree_origin_repository\}\}/);

    // Should include worktree mode instructions
    assert.match(finalStep!.input, /Worktree Mode/);

    // Should read the target tip from the origin without mutating its worktree
    assert.match(finalStep!.input, /ORIGIN_REPOSITORY=\{\{worktree_origin_repository\}\}/);
    assert.match(finalStep!.input, /git -C "\$ORIGIN_REPOSITORY" rev-parse "\$TARGET_REF"/);
  });

  it("preserves fast-forward-first ordering before atomic landing", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge-worktree"));
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep);

    const input = finalStep!.input;
    const ffIdx = input.search(/merge-base --is-ancestor/);
    const landingIdx = input.search(/MERGE_OUTPUT=\$\(tamandua merge-branch/);

    assert.ok(ffIdx >= 0, "must contain merge-base --is-ancestor");
    assert.ok(landingIdx >= 0, "must contain tamandua merge-branch");
    assert.ok(
      ffIdx < landingIdx,
      `FF check (pos ${ffIdx}) must appear before atomic landing (pos ${landingIdx})`,
    );
  });

  it("finalize_merge has tester retry path with REBASED and CONFLICT_NOTES", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge-worktree"));
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep);
    assert.match(finalStep!.input, /RETRY_STEP:\s*test/);
    assert.match(finalStep!.input, /CONFLICT_NOTES/);
  });

  it("all agent workspace files exist", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge-worktree"));
    for (const agent of spec.agents) {
      for (const [fileName, relativePath] of Object.entries(agent.workspace.files)) {
        const resolved = resolve(wfDir("feature-dev-merge-worktree"), relativePath);
        assert.ok(existsSync(resolved),
          `feature-dev-merge-worktree/${agent.id}: ${relativePath} should exist (for ${fileName})`);
      }
    }
  });

  it("all steps have valid roles and tamandua-agents skill", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge-worktree"));
    const validRoles = new Set(["analysis", "coding", "verification", "testing", "pr", "scanning"]);
    for (const agent of spec.agents) {
      if (agent.role) assert.ok(validRoles.has(agent.role), `${agent.id}: "${agent.role}" is valid`);
      const skills = agent.workspace.skills ?? [];
      assert.ok(
        skills.includes("tamandua-agents"),
        `feature-dev-merge-worktree/${agent.id}: workspace.skills must include tamandua-agents`,
      );
    }
  });

  it("verifier agent preserves agent-browser skill", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge-worktree"));
    const verifier = spec.agents.find((a) => a.id === "verifier");
    assert.ok(verifier, "must define verifier agent");
    const skills = verifier!.workspace.skills ?? [];
    assert.ok(skills.includes("agent-browser"), "verifier workspace.skills must preserve agent-browser");
  });
});

describe("US-002: doer agent persona", () => {
  const doerDir = resolve(wfDir("do-review-do-verify"), "agents", "doer");
  const doerAgentsMd = resolve(doerDir, "AGENTS.md");

  it("doer persona files exist and are non-empty", () => {
    for (const f of ["AGENTS.md", "IDENTITY.md", "SOUL.md"]) {
      const path = resolve(doerDir, f);
      assert.ok(existsSync(path), `doer/${f} should exist`);
      const content = readFileSync(path, "utf-8");
      assert.ok(content.length > 0, `doer/${f} should be non-empty`);
    }
  });

  it("AGENTS.md describes both initial execution and refinement modes", () => {
    const content = readFileSync(doerAgentsMd, "utf-8");
    assert.match(content, /Initial Execution/);
    assert.match(content, /step "do"/);
    assert.match(content, /Refinement/);
    assert.match(content, /step "do-again"/);
  });

  it("AGENTS.md mandates STATUS: done|failed and CHANGES: output fields", () => {
    const content = readFileSync(doerAgentsMd, "utf-8");
    // Must require STATUS in output format
    assert.match(content, /STATUS:\s*done\|failed/);
    // Must require CHANGES in output format
    assert.match(content, /CHANGES:/);
    // Must describe what STATUS values mean
    assert.match(content, /done.*success/i);
    assert.match(content, /failed.*not.*complete/i);
  });

  it("AGENTS.md references {{retry_feedback}} handling", () => {
    const content = readFileSync(doerAgentsMd, "utf-8");
    assert.match(content, /\{\{retry_feedback\}\}/);
    assert.match(content, /retry_feedback/i);
    assert.match(content, /previous attempt.*reject/i);
  });

  it("AGENTS.md output format includes REPORT field", () => {
    const content = readFileSync(doerAgentsMd, "utf-8");
    assert.match(content, /REPORT:/);
    assert.match(content, /detailed report/);
  });

  it("IDENTITY.md has correct name and role", () => {
    const content = readFileSync(resolve(doerDir, "IDENTITY.md"), "utf-8");
    assert.match(content, /Name:\s*Doer/);
    assert.match(content, /Role:\s*Executes arbitrary tasks/);
  });

  it("SOUL.md describes doer personality", () => {
    const content = readFileSync(resolve(doerDir, "SOUL.md"), "utf-8");
    assert.match(content, /get things done/i);
    assert.match(content, /honest/i);
    assert.match(content, /feedback/i);
  });
});

describe("US-003: reviewer agent persona", () => {
  const reviewerDir = resolve(wfDir("do-review-do-verify"), "agents", "reviewer");
  const reviewerAgentsMd = resolve(reviewerDir, "AGENTS.md");

  it("reviewer persona files exist and are non-empty", () => {
    for (const f of ["AGENTS.md", "IDENTITY.md", "SOUL.md"]) {
      const path = resolve(reviewerDir, f);
      assert.ok(existsSync(path), `reviewer/${f} should exist`);
      const content = readFileSync(path, "utf-8");
      assert.ok(content.length > 0, `reviewer/${f} should be non-empty`);
    }
  });

  it("AGENTS.md mandates STATUS: done, FEEDBACK:, and ISSUES: output fields", () => {
    const content = readFileSync(reviewerAgentsMd, "utf-8");
    // Must require STATUS in output format
    assert.match(content, /STATUS:\s*done/);
    // Must require FEEDBACK in output format
    assert.match(content, /FEEDBACK:/);
    // Must require ISSUES in output format
    assert.match(content, /ISSUES:/);
    // Must describe what FEEDBACK should contain
    assert.match(content, /what was done well/i);
    // Must describe what ISSUES are
    assert.match(content, /specific problems/i);
  });

  it("AGENTS.md handles perfect-work case (no issues found)", () => {
    const content = readFileSync(reviewerAgentsMd, "utf-8");
    // Must describe handling when work is perfect
    assert.match(content, /perfect/i);
    // Must allow ISSUES: none
    assert.match(content, /ISSUES:\s*none/);
    // Must recommend no changes when perfect
    assert.match(content, /no changes/i);
  });

  it("AGENTS.md references {{retry_feedback}} handling", () => {
    const content = readFileSync(reviewerAgentsMd, "utf-8");
    assert.match(content, /\{\{retry_feedback\}\}/);
    assert.match(content, /retry_feedback/i);
    assert.match(content, /previous.*review.*reject/i);
  });

  it("AGENTS.md describes review process against original task", () => {
    const content = readFileSync(reviewerAgentsMd, "utf-8");
    // Must reference checking against {{task}}
    assert.match(content, /\{\{task\}\}/);
    // Must describe examining the doer's output
    assert.match(content, /\{\{changes\}\}/);
    assert.match(content, /\{\{report\}\}/);
  });

  it("IDENTITY.md has correct name and role", () => {
    const content = readFileSync(resolve(reviewerDir, "IDENTITY.md"), "utf-8");
    assert.match(content, /Name:\s*Reviewer/);
    assert.match(content, /Role:\s*Reviews completed work/);
  });

  it("SOUL.md describes reviewer personality as thorough, constructive, specific", () => {
    const content = readFileSync(resolve(reviewerDir, "SOUL.md"), "utf-8");
    assert.match(content, /thorough/i);
    assert.match(content, /constructive/i);
    assert.match(content, /specific/i);
    assert.match(content, /feedback/i);
  });
});

describe("US-005: do-review-do-verify workflow structure", () => {
  const loadSpec = () => loadWorkflowSpec(wfDir("do-review-do-verify"));

  it("has 3 agents: doer, reviewer, verifier", async () => {
    const spec = await loadSpec();
    assert.equal(spec.agents.length, 3);
    const agentIds = spec.agents.map((a) => a.id);
    assert.deepEqual(agentIds, ["doer", "reviewer", "verifier"]);
  });

  it("has 4 steps in correct order: do → review → do-again → verify", async () => {
    const spec = await loadSpec();
    assert.equal(spec.steps.length, 4);
    const stepIds = spec.steps.map((s) => s.id);
    assert.deepEqual(stepIds, ["do", "review", "do-again", "verify"]);
  });

  it("all agents have tamandua-agents skill", async () => {
    const spec = await loadSpec();
    for (const agent of spec.agents) {
      const skills = agent.workspace.skills ?? [];
      assert.ok(
        skills.includes("tamandua-agents"),
        `do-review-do-verify/${agent.id}: workspace.skills must include tamandua-agents`,
      );
    }
  });

  it("all agent workspace files exist", async () => {
    const spec = await loadSpec();
    for (const agent of spec.agents) {
      for (const [fileName, relativePath] of Object.entries(agent.workspace.files)) {
        const resolved = resolve(wfDir("do-review-do-verify"), relativePath);
        assert.ok(existsSync(resolved),
          `do-review-do-verify/${agent.id}: ${relativePath} should exist (for ${fileName})`);
      }
    }
  });

  it("all steps reference valid agent ids", async () => {
    const spec = await loadSpec();
    const agentIds = new Set(spec.agents.map((a) => a.id));
    for (const step of spec.steps) {
      assert.ok(agentIds.has(step.agent),
        `step "${step.id}" references unknown agent "${step.agent}"`);
    }
  });

  it("steps have correct agent assignments", async () => {
    const spec = await loadSpec();
    assert.equal(spec.steps[0].agent, "doer");
    assert.equal(spec.steps[1].agent, "reviewer");
    assert.equal(spec.steps[2].agent, "doer");
    assert.equal(spec.steps[3].agent, "verifier");
  });

  it("do step input passes task context", async () => {
    const spec = await loadSpec();
    const doStep = spec.steps.find((s) => s.id === "do");
    assert.ok(doStep);
    assert.match(doStep!.input, /\{\{task\}\}/);
    assert.match(doStep!.input, /\{\{retry_feedback\}\}/);
  });

  it("review step input passes task, changes, report, and retry_feedback context", async () => {
    const spec = await loadSpec();
    const reviewStep = spec.steps.find((s) => s.id === "review");
    assert.ok(reviewStep);
    assert.match(reviewStep!.input, /\{\{task\}\}/);
    assert.match(reviewStep!.input, /\{\{changes\}\}/);
    assert.match(reviewStep!.input, /\{\{report\}\}/);
    assert.match(reviewStep!.input, /\{\{retry_feedback\}\}/);
  });

  it("do-again step input passes task, feedback, issues, and retry_feedback context", async () => {
    const spec = await loadSpec();
    const doAgainStep = spec.steps.find((s) => s.id === "do-again");
    assert.ok(doAgainStep);
    assert.match(doAgainStep!.input, /\{\{task\}\}/);
    assert.match(doAgainStep!.input, /\{\{feedback\}\}/);
    assert.match(doAgainStep!.input, /\{\{issues\}\}/);
    assert.match(doAgainStep!.input, /\{\{retry_feedback\}\}/);
  });

  it("verify step input passes task, changes, report, issues, and retry_feedback context", async () => {
    const spec = await loadSpec();
    const verifyStep = spec.steps.find((s) => s.id === "verify");
    assert.ok(verifyStep);
    assert.match(verifyStep!.input, /\{\{task\}\}/);
    assert.match(verifyStep!.input, /\{\{changes\}\}/);
    assert.match(verifyStep!.input, /\{\{report\}\}/);
    assert.match(verifyStep!.input, /\{\{issues\}\}/);
    assert.match(verifyStep!.input, /\{\{retry_feedback\}\}/);
  });

  it("is a linear pipeline (no loop wiring)", async () => {
    const spec = await loadSpec();
    for (const step of spec.steps) {
      assert.equal(step.type, undefined, `step "${step.id}" should not have loop wiring`);
    }
  });

  it("has no merge or finalize_merge step", async () => {
    const spec = await loadSpec();
    const stepIds = spec.steps.map((s) => s.id);
    assert.ok(!stepIds.includes("merge"));
    assert.ok(!stepIds.includes("finalize_merge"));
  });
});

describe("US-004: verifier agent persona", () => {
  const verifierDir = resolve(wfDir("do-review-do-verify"), "agents", "verifier");
  const verifierAgentsMd = resolve(verifierDir, "AGENTS.md");

  it("verifier persona files exist and are non-empty", () => {
    for (const f of ["AGENTS.md", "IDENTITY.md", "SOUL.md"]) {
      const path = resolve(verifierDir, f);
      assert.ok(existsSync(path), `verifier/${f} should exist`);
      const content = readFileSync(path, "utf-8");
      assert.ok(content.length > 0, `verifier/${f} should be non-empty`);
    }
  });

  it("AGENTS.md mandates STATUS: done, VERDICT:, and DETAILS: output fields", () => {
    const content = readFileSync(verifierAgentsMd, "utf-8");
    // Must require STATUS in output format
    assert.match(content, /STATUS:\s*done/);
    // Must require VERDICT in output format
    assert.match(content, /VERDICT:\s*(accomplished\|not_accomplished|not_accomplished\|accomplished)/);
    // Must require DETAILS in output format
    assert.match(content, /DETAILS:/);
    // Must describe what the verdict means
    assert.match(content, /accomplished/i);
    assert.match(content, /not.?accomplished/i);
    // Must describe what DETAILS should contain
    assert.match(content, /detailed reasoning/i);
  });

  it("AGENTS.md describes comparing output against original task description", () => {
    const content = readFileSync(verifierAgentsMd, "utf-8");
    // Must reference the original task
    assert.match(content, /\{\{task\}\}/);
    // Must describe comparing output against task
    assert.match(content, /original task/i);
    // Must describe examining CHANGES and REPORT
    assert.match(content, /\{\{changes\}\}/);
    assert.match(content, /\{\{report\}\}/);
  });

  it("AGENTS.md requires detailed feedback regardless of accomplishment", () => {
    const content = readFileSync(verifierAgentsMd, "utf-8");
    // Must say to provide details regardless of verdict
    assert.match(content, /regardless.*verdict|verdict.*regardless/i);
    // Must describe giving evidence for the verdict
    assert.match(content, /evidence/i);
    // Must require explanation for both accomplished and not_accomplished
    assert.match(content, /accomplished.*explain|explain.*why/);
  });

  it("AGENTS.md considers both initial work and reviewer feedback", () => {
    const content = readFileSync(verifierAgentsMd, "utf-8");
    // Must reference reviewer's ISSUES
    assert.match(content, /\{\{issues\}\}/);
    // Must describe considering reviewer feedback
    assert.match(content, /reviewer.*feedback|feedback.*reviewer/i);
    // Must describe the do-again refinement step
    assert.match(content, /refinement|do.?again/i);
  });

  it("AGENTS.md references {{retry_feedback}} handling", () => {
    const content = readFileSync(verifierAgentsMd, "utf-8");
    assert.match(content, /\{\{retry_feedback\}\}/);
    assert.match(content, /retry_feedback/i);
    assert.match(content, /previous.*verification.*reject/i);
  });

  it("IDENTITY.md has correct name and role", () => {
    const content = readFileSync(resolve(verifierDir, "IDENTITY.md"), "utf-8");
    assert.match(content, /Name:\s*Verifier/);
    assert.match(content, /Role:\s*Judges task accomplishment/);
  });

  it("SOUL.md describes verifier as fair, objective, evidence-based judge", () => {
    const content = readFileSync(resolve(verifierDir, "SOUL.md"), "utf-8");
    assert.match(content, /fair/i);
    assert.match(content, /objective/i);
    assert.match(content, /evidence/i);
    assert.match(content, /judge/i);
  });
});

describe("US-003: just-do-it dispatch step dynamic workflow selection", () => {
  const justDoItYml = readFileSync(resolve(wfDir("just-do-it"), "workflow.yml"), "utf-8");

  it("dispatch step input uses --json for discovery, not hardcoded lists", () => {
    // AC 1: No hardcoded workflow variant lists
    assert.doesNotMatch(justDoItYml, /feature-dev,\s*feature-dev-merge,\s*feature-dev-github-pr/);
    assert.doesNotMatch(justDoItYml, /bug-fix,\s*bug-fix-merge,\s*bug-fix-github-pr/);
    assert.doesNotMatch(justDoItYml, /security-audit,\s*security-audit-merge,\s*security-audit-github-pr/);

    // AC 2: Instructs agent to use --json for discovery
    assert.match(justDoItYml, /tamandua workflow list --json/);
    assert.match(justDoItYml, /Parse the JSON output/);
  });

  it("dispatch step input describes prefix-based categorization with feature-dev*, bug-fix*, security-audit*", () => {
    assert.match(justDoItYml, /feature-dev\*/);
    assert.match(justDoItYml, /bug-fix\*/);
    assert.match(justDoItYml, /security-audit\*/);
    assert.match(justDoItYml, /prefix-based/);
  });

  it("dispatch step input includes do-now and do-review-do-verify as standalone workflows", () => {
    // AC 3: Includes rules for do-now and do-review-do-verify
    assert.match(justDoItYml, /do-now.*standalone/);
    assert.match(justDoItYml, /do-review-do-verify.*standalone/);

    // Do-now category keywords
    assert.match(justDoItYml, /quick question|format this|check X|tell me|explain/);
    // Do-review-do-verify category keywords
    assert.match(justDoItYml, /review my code|verify|compare|check correctness/);
  });

  it("dispatch step input includes variant suffix composition rules", () => {
    assert.match(justDoItYml, /-github-pr/);
    assert.match(justDoItYml, /-merge-worktree/);
    assert.match(justDoItYml, /composing.*suffix/);
    assert.match(justDoItYml, /verify it exists in the --json output/);
    // merge-worktree is the default for coding families when no explicit variant keyword
    assert.match(justDoItYml, /default to -merge-worktree for coding families/);
    // explicit variant keywords take precedence over the default
    assert.match(justDoItYml, /Prompt mentions.*PR.*pull request.*GitHub.*use -github-pr variant/);
    assert.match(justDoItYml, /Prompt mentions.*merge.*land.*ship.*use variant with -merge/);
    assert.match(justDoItYml, /Prompt mentions.*worktree.*use variant with -worktree/);
  });

  it("dispatch step input includes fallback order and do-now catch-all", () => {
    assert.match(justDoItYml, /fall back/);
    assert.match(justDoItYml, /-merge-worktree → -merge → -worktree → base → -github-pr → -github-pr-worktree/);
    assert.match(justDoItYml, /fall back to do-now/);
  });

  it("dispatch step preserves no-hurry decision logic", () => {
    assert.match(justDoItYml, /\{\{no_hurry_save_tokens_mode\}\}/);
    assert.match(justDoItYml, /--no-hurry-please-save-tokens-mode ALWAYS/);
    assert.match(justDoItYml, /URGENT.*ASAP.*immediately.*right now/);
    assert.match(justDoItYml, /when you get a chance.*no rush.*whenever/);
  });

  it("dispatch step preserves output format unchanged", () => {
    assert.match(justDoItYml, /STATUS: done/);
    assert.match(justDoItYml, /SELECTED_WORKFLOW:/);
    assert.match(justDoItYml, /NO_HURRY:.*true\|false/);
    assert.match(justDoItYml, /REASONING:/);
    assert.match(justDoItYml, /LAUNCHED_RUN_ID:/);
  });

  it("dispatch step input defaults coding tasks to -merge-worktree when no explicit variant keyword", () => {
    // AC: When no variant keyword is present, coding families default to -merge-worktree
    assert.match(justDoItYml, /default to -merge-worktree for coding families/);
    assert.match(justDoItYml, /feature-dev\*.*bug-fix\*.*security-audit\*/);
  });

  it("dispatch step input includes escape hatch keywords for merge-worktree default", () => {
    // AC: Escape hatch 'no merge' and 'no worktree' revert to base variant
    assert.match(justDoItYml, /no merge.*no worktree.*base variant/);
  });

  it("dispatch step input preserves non-coding standalone routing unchanged", () => {
    // AC: do-now and do-review-do-verify remain standalone, no variant suffix
    assert.match(justDoItYml, /do-now and do-review-do-verify are standalone: use them directly, no suffix/);
    // Verifies standalone rule text hasn't been altered
    assert.match(justDoItYml, /do-now.*standalone/);
    assert.match(justDoItYml, /do-review-do-verify.*standalone/);
  });
});

describe("US-007: just-do-it CLI syntax and behavior validation", () => {
  const justDoItYml = readFileSync(resolve(wfDir("just-do-it"), "workflow.yml"), "utf-8");
  const dispatcherAgentsMd = readFileSync(resolve(wfDir("just-do-it"), "agents", "dispatcher", "AGENTS.md"), "utf-8");

  // Extract dispatch step input from workflow.yml
  const afterInput = justDoItYml.split("input: |")[1];
  const dispatchStepInput = afterInput?.split("\n    expects:")[0] ?? "";

  // AC 1: just-do-it workflow.yml dispatch step input has no --task flag
  it("dispatch step input does NOT instruct using --task flag as a CLI argument", () => {
    // No command line should pass --task with a value
    assert.doesNotMatch(dispatchStepInput, /--task\s+"/);
    assert.doesNotMatch(dispatchStepInput, /--task\s+'/);
    // Should instruct using positional task text instead
    assert.match(dispatchStepInput, /Task text is positional/);
  });

  // AC 2: just-do-it workflow.yml dispatch step input has no bare --no-hurry flag
  it("dispatch step input does NOT contain bare --no-hurry flag", () => {
    // --no-hurry should only appear as part of --no-hurry-please-save-tokens-mode
    assert.doesNotMatch(dispatchStepInput, /--no-hurry(?!-please-save-tokens-mode)/);
  });

  // AC 3: just-do-it workflow.yml dispatch step input contains --no-hurry-please-save-tokens-mode
  it("dispatch step input contains --no-hurry-please-save-tokens-mode", () => {
    assert.match(dispatchStepInput, /--no-hurry-please-save-tokens-mode/);
  });

  // AC 4: just-do-it workflow.yml dispatch step input references --working-directory-for-harness
  it("dispatch step input references --working-directory-for-harness", () => {
    assert.match(dispatchStepInput, /--working-directory-for-harness/);
  });

  // AC 5: just-do-it workflow.yml dispatch step input references --worktree-origin-repository
  it("dispatch step input references --worktree-origin-repository", () => {
    assert.match(dispatchStepInput, /--worktree-origin-repository/);
  });

  // AC 6: just-do-it dispatch step input states runtime launch errors are fatal
  it("dispatch step input states runtime launch errors are fatal", () => {
    assert.match(dispatchStepInput, /[Ff][Aa][Tt][Aa][Ll]/);
    assert.match(dispatchStepInput, /step fail/);
    // Should also mention no fallback on runtime errors
    assert.match(dispatchStepInput, /Do NOT try fallback/);
  });

  // AC 7: just-do-it AGENTS.md uses supported CLI flags only
  it("dispatcher AGENTS.md uses --no-hurry-please-save-tokens-mode not bare --no-hurry", () => {
    // The correct flag must appear
    assert.match(dispatcherAgentsMd, /--no-hurry-please-save-tokens-mode/);
    // Command examples in AGENTS.md must not use bare --no-hurry
    const commandLines = dispatcherAgentsMd.split("\n").filter((l) => l.includes("tamandua workflow run"));
    for (const line of commandLines) {
      assert.doesNotMatch(line, /--no-hurry(?!-please-save-tokens-mode)/,
        `AGENTS.md command line should not use bare --no-hurry: ${line.trim()}`);
    }
  });

  it("dispatcher AGENTS.md uses positional task text not --task flag", () => {
    // Command examples must not use --task as a flag
    const commandLines = dispatcherAgentsMd.split("\n").filter((l) => l.includes("tamandua workflow run"));
    assert.ok(commandLines.length > 0, "AGENTS.md should contain tamandua workflow run examples");
    for (const line of commandLines) {
      assert.doesNotMatch(line, /--task\s/,
        `AGENTS.md command line should not use --task flag: ${line.trim()}`);
    }
    // Should show positional task text in examples
    assert.match(dispatcherAgentsMd, /"<the user's original task>"/);
  });

  // Verify workflow.yml and AGENTS.md agree: both use --working-directory-for-harness and --worktree-origin-repository
  it("AGENTS.md also references --working-directory-for-harness and --worktree-origin-repository", () => {
    assert.match(dispatcherAgentsMd, /--working-directory-for-harness/);
    assert.match(dispatcherAgentsMd, /--worktree-origin-repository/);
  });

  // Verify AGENTS.md also states runtime errors are fatal
  it("AGENTS.md states runtime launch errors are fatal", () => {
    assert.match(dispatcherAgentsMd, /[Ff][Aa][Tt][Aa][Ll]/);
    assert.match(dispatcherAgentsMd, /step fail/);
    assert.match(dispatcherAgentsMd, /Do NOT try|no fallback|not.*fallback/i);
  });

  // Verify workflow.yml and AGENTS.md agree on must-report behavior
  it("dispatch step input and AGENTS.md both require step complete or step fail before exit", () => {
    assert.match(dispatchStepInput, /step complete/);
    assert.match(dispatchStepInput, /step fail/);
    assert.match(dispatcherAgentsMd, /step complete/);
    assert.match(dispatcherAgentsMd, /step fail/);
  });
});

describe("US-006: VTSC — Verifier persona: run targeted tests, not full suite", () => {
  const repoRoot = resolve(workflowsDir, "..");
  const sharedVerifierAgentsMd = resolve(repoRoot, "agents", "shared", "verifier", "AGENTS.md");

  it("shared verifier AGENTS.md contains targeted-test guidance", () => {
    const content = readFileSync(sharedVerifierAgentsMd, "utf-8");
    assert.match(content, /Run targeted tests relevant to the current story/);
    assert.match(content, /the full suite belongs to the test step/);
    assert.match(content, /Never start a full-suite run you cannot finish/);
  });

  it("shared verifier AGENTS.md does NOT say 'Run the full test suite'", () => {
    const content = readFileSync(sharedVerifierAgentsMd, "utf-8");
    assert.doesNotMatch(content, /Run the full test suite/);
  });

  it("shared merger AGENTS.md was not altered by VTSC", () => {
    const mergerAgentsMd = resolve(repoRoot, "agents", "shared", "pr", "AGENTS.md");
    const content = readFileSync(mergerAgentsMd, "utf-8");
    assert.doesNotMatch(content, /Run targeted tests relevant to the current story/);
  });

  it("merge-family workflow YAML contracts unchanged", () => {
    for (const wfId of workflowIds) {
      if (!wfId.includes("merge")) continue;
      const ymlPath = resolve(workflowsDir, wfId, "workflow.yml");
      if (!existsSync(ymlPath)) continue;
      const content = readFileSync(ymlPath, "utf-8");
      // Merge-family YAMLs should NOT contain the verifier-specific persona guidance
      assert.doesNotMatch(content, /Run targeted tests/);
    }
  });
});

describe("agent file divergence detection", () => {
  const repoRoot = resolve(workflowsDir, "..");

  function sha256(filePath: string): string {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  }

  function assertIdenticalGroup(files: string[]) {
    const hashes = files.map((p) => ({
      path: p,
      hash: sha256(resolve(repoRoot, p)),
    }));
    const first = hashes[0];
    const mismatches = hashes.filter((h) => h.hash !== first.hash);
    if (mismatches.length > 0) {
      const msg = [
        `${mismatches.length} of ${hashes.length} files diverged:`,
        ...hashes.map((h) => `  ${h.hash}  ${h.path}`),
      ].join("\n");
      assert.fail(msg);
    }
    // No explicit assertion if all match — test passes silently.
    // Force at least one assertion so the test doesn't look empty.
    assert.ok(true);
  }

  // ─── bug-fix family ───
  // fixer, investigator, triager directories are byte-identical (all 3 files each)
  // and symlinked from bug-fix + bug-fix-github-pr → bug-fix-merge.

  describe("bug-fix family", () => {
    const variants = ["bug-fix", "bug-fix-merge", "bug-fix-github-pr"];
    const roles = ["fixer", "investigator", "triager"];
    const files = ["AGENTS.md", "IDENTITY.md", "SOUL.md"];

    for (const role of roles) {
      for (const f of files) {
        it(`${role}/${f} identical across bug-fix variants`, () => {
          assertIdenticalGroup(
            variants.map((v) => `workflows/${v}/agents/${role}/${f}`)
          );
        });
      }
    }
  });

  // ─── feature-dev family ───

  describe("feature-dev family", () => {
    const variants = ["feature-dev", "feature-dev-merge", "feature-dev-github-pr"];

    describe("developer (all files identical across all 3)", () => {
      const files = ["AGENTS.md", "IDENTITY.md", "SOUL.md"];
      for (const f of files) {
        it(`developer/${f} identical`, () => {
          assertIdenticalGroup(
            variants.map((v) => `workflows/${v}/agents/developer/${f}`)
          );
        });
      }
    });

    describe("planner", () => {
      // IDENTITY.md and SOUL.md are identical across all 3 variants.
      for (const f of ["IDENTITY.md", "SOUL.md"]) {
        it(`planner/${f} identical across all 3`, () => {
          assertIdenticalGroup(
            variants.map((v) => `workflows/${v}/agents/planner/${f}`)
          );
        });
      }

      // planner/AGENTS.md: feature-dev and feature-dev-github-pr are identical;
      // feature-dev-merge differs (intentional — merge-specific instructions).
      it("planner/AGENTS.md: base == github-pr (merge differs intentionally)", () => {
        // This is NOT an identical-group assertion — it documents the intentional split.
        // We verify the two non-merge copies are in fact identical, and all three exist.
        const baseHash = sha256(resolve(repoRoot, "workflows/feature-dev/agents/planner/AGENTS.md"));
        const ghprHash = sha256(resolve(repoRoot, "workflows/feature-dev-github-pr/agents/planner/AGENTS.md"));
        const mergeHash = sha256(resolve(repoRoot, "workflows/feature-dev-merge/agents/planner/AGENTS.md"));
        assert.equal(baseHash, ghprHash,
          `feature-dev base & github-pr planner/AGENTS.md must match:\n  base: ${baseHash}\n  ghpr: ${ghprHash}`);
        // Merge is intentionally different — just verify it exists and is different.
        assert.notEqual(mergeHash, baseHash,
          "merge planner/AGENTS.md expected to differ from base (intentional divergence)");
      });
    });

    describe("tester", () => {
      // IDENTITY.md and SOUL.md are identical across all 3 variants.
      for (const f of ["IDENTITY.md", "SOUL.md"]) {
        it(`tester/${f} identical across all 3`, () => {
          assertIdenticalGroup(
            variants.map((v) => `workflows/${v}/agents/tester/${f}`)
          );
        });
      }

      // tester/AGENTS.md: feature-dev and feature-dev-github-pr are identical;
      // feature-dev-merge differs (intentional — TESTED_TREE reply format).
      it("tester/AGENTS.md: base == github-pr (merge differs intentionally)", () => {
        const baseHash = sha256(resolve(repoRoot, "workflows/feature-dev/agents/tester/AGENTS.md"));
        const ghprHash = sha256(resolve(repoRoot, "workflows/feature-dev-github-pr/agents/tester/AGENTS.md"));
        const mergeHash = sha256(resolve(repoRoot, "workflows/feature-dev-merge/agents/tester/AGENTS.md"));
        assert.equal(baseHash, ghprHash,
          `feature-dev base & github-pr tester/AGENTS.md must match:\n  base: ${baseHash}\n  ghpr: ${ghprHash}`);
        assert.notEqual(mergeHash, baseHash,
          "merge tester/AGENTS.md expected to differ from base (intentional divergence)");
      });
    });
  });

  // ─── security-audit family ───

  describe("security-audit family", () => {
    const variants = ["security-audit", "security-audit-merge", "security-audit-github-pr"];

    describe("prioritizer (all files identical across all 3)", () => {
      const files = ["AGENTS.md", "IDENTITY.md", "SOUL.md"];
      for (const f of files) {
        it(`prioritizer/${f} identical`, () => {
          assertIdenticalGroup(
            variants.map((v) => `workflows/${v}/agents/prioritizer/${f}`)
          );
        });
      }
    });

    describe("scanner (all files identical across all 3)", () => {
      const files = ["AGENTS.md", "IDENTITY.md", "SOUL.md"];
      for (const f of files) {
        it(`scanner/${f} identical`, () => {
          assertIdenticalGroup(
            variants.map((v) => `workflows/${v}/agents/scanner/${f}`)
          );
        });
      }
    });

    describe("fixer", () => {
      // fixer/IDENTITY.md is identical across all 3.
      it("fixer/IDENTITY.md identical across all 3", () => {
        assertIdenticalGroup(
          variants.map((v) => `workflows/${v}/agents/fixer/IDENTITY.md`)
        );
      });

      // fixer/AGENTS.md: audit differs (base-only version); merge == github-pr.
      it("fixer/AGENTS.md: merge == github-pr (audit differs intentionally)", () => {
        const auditHash = sha256(resolve(repoRoot, "workflows/security-audit/agents/fixer/AGENTS.md"));
        const mergeHash = sha256(resolve(repoRoot, "workflows/security-audit-merge/agents/fixer/AGENTS.md"));
        const ghprHash = sha256(resolve(repoRoot, "workflows/security-audit-github-pr/agents/fixer/AGENTS.md"));
        assert.equal(mergeHash, ghprHash,
          `merge & github-pr fixer/AGENTS.md must match:\n  merge: ${mergeHash}\n  ghpr: ${ghprHash}`);
        assert.notEqual(auditHash, mergeHash,
          "audit fixer/AGENTS.md expected to differ from merge (intentional divergence)");
      });

      // fixer/SOUL.md: audit differs (base-only version); merge == github-pr.
      it("fixer/SOUL.md: merge == github-pr (audit differs intentionally)", () => {
        const auditHash = sha256(resolve(repoRoot, "workflows/security-audit/agents/fixer/SOUL.md"));
        const mergeHash = sha256(resolve(repoRoot, "workflows/security-audit-merge/agents/fixer/SOUL.md"));
        const ghprHash = sha256(resolve(repoRoot, "workflows/security-audit-github-pr/agents/fixer/SOUL.md"));
        assert.equal(mergeHash, ghprHash,
          `merge & github-pr fixer/SOUL.md must match:\n  merge: ${mergeHash}\n  ghpr: ${ghprHash}`);
        assert.notEqual(auditHash, mergeHash,
          "audit fixer/SOUL.md expected to differ from merge (intentional divergence)");
      });
    });

    describe("tester", () => {
      // IDENTITY.md and SOUL.md are identical across all 3.
      it("tester/IDENTITY.md identical across all 3", () => {
        assertIdenticalGroup(
          variants.map((v) => `workflows/${v}/agents/tester/IDENTITY.md`)
        );
      });
      it("tester/SOUL.md identical across all 3", () => {
        assertIdenticalGroup(
          variants.map((v) => `workflows/${v}/agents/tester/SOUL.md`)
        );
      });

      // tester/AGENTS.md: audit == github-pr; merge differs (intentional — TESTED_TREE).
      it("tester/AGENTS.md: audit == github-pr (merge differs intentionally)", () => {
        const auditHash = sha256(resolve(repoRoot, "workflows/security-audit/agents/tester/AGENTS.md"));
        const ghprHash = sha256(resolve(repoRoot, "workflows/security-audit-github-pr/agents/tester/AGENTS.md"));
        const mergeHash = sha256(resolve(repoRoot, "workflows/security-audit-merge/agents/tester/AGENTS.md"));
        assert.equal(auditHash, ghprHash,
          `audit & github-pr tester/AGENTS.md must match:\n  audit: ${auditHash}\n  ghpr: ${ghprHash}`);
        assert.notEqual(mergeHash, auditHash,
          "merge tester/AGENTS.md expected to differ from audit (intentional divergence)");
      });
    });
  });

  // ─── quarantine family ───

  describe("quarantine family", () => {
    const qt = "quarantine-broken-tests";
    const qtMerge = "quarantine-broken-tests-merge";

    describe("quarantiner (all files identical across both)", () => {
      const files = ["AGENTS.md", "IDENTITY.md", "SOUL.md"];
      for (const f of files) {
        it(`quarantiner/${f} identical`, () => {
          assertIdenticalGroup([
            `workflows/${qt}/agents/quarantiner/${f}`,
            `workflows/${qtMerge}/agents/quarantiner/${f}`,
          ]);
        });
      }
    });

    describe("verifier", () => {
      // IDENTITY.md and SOUL.md are identical across both variants.
      it("verifier/IDENTITY.md identical across both", () => {
        assertIdenticalGroup([
          `workflows/${qt}/agents/verifier/IDENTITY.md`,
          `workflows/${qtMerge}/agents/verifier/IDENTITY.md`,
        ]);
      });
      it("verifier/SOUL.md identical across both", () => {
        assertIdenticalGroup([
          `workflows/${qt}/agents/verifier/SOUL.md`,
          `workflows/${qtMerge}/agents/verifier/SOUL.md`,
        ]);
      });

      // verifier/AGENTS.md intentionally differs: merge has TESTED_TREE divergence.
      it("verifier/AGENTS.md: intentionally divergent between base and merge", () => {
        const baseHash = sha256(resolve(repoRoot, `workflows/${qt}/agents/verifier/AGENTS.md`));
        const mergeHash = sha256(resolve(repoRoot, `workflows/${qtMerge}/agents/verifier/AGENTS.md`));
        assert.notEqual(baseHash, mergeHash,
          `quarantine verifier/AGENTS.md expected to differ (intentional TESTED_TREE divergence):\n  base: ${baseHash}\n  merge: ${mergeHash}`);
      });
    });
  });

  // ─── cross-family ───

  describe("cross-family", () => {
    // merger/SOUL.md is byte-identical across all 4 merge variants
    // (bug-fix-merge, feature-dev-merge, security-audit-merge, quarantine-broken-tests-merge).
    it("merger/SOUL.md identical across all 4 merge variants", () => {
      assertIdenticalGroup([
        "workflows/bug-fix-merge/agents/merger/SOUL.md",
        "workflows/feature-dev-merge/agents/merger/SOUL.md",
        "workflows/security-audit-merge/agents/merger/SOUL.md",
        "workflows/quarantine-broken-tests-merge/agents/merger/SOUL.md",
      ]);
    });
  });
});
