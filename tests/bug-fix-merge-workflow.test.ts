import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { loadWorkflowSpec } from "../dist/installer/workflow-spec.js";
import { resolveBundledWorkflowsDir } from "../dist/installer/paths.js";
import { resolve, join } from "node:path";

const wfDir = resolve(resolveBundledWorkflowsDir(), "bug-fix-merge");

describe("bug-fix-merge workflow", () => {

  it("parses bug-fix-merge workflow YAML without errors", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    assert.equal(spec.id, "bug-fix-merge");
    assert.ok(spec.agents.length > 0);
    assert.ok(spec.steps.length > 0);
  });

  it("has correct step order: triage, investigate, setup, fix, verify, finalize_merge", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const stepIds = spec.steps.map((s) => s.id);
    assert.deepEqual(stepIds, [
      "triage",
      "investigate",
      "setup",
      "fix",
      "verify",
      "finalize_merge",
    ]);
  });

  it("has a finalize_merge step with the merger agent", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep, "finalize_merge step must exist");
    assert.equal(finalStep!.agent, "merger");
  });

  it("finalize_merge step does NOT mention gh pr create or git push", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep);
    assert.doesNotMatch(finalStep!.input, /gh pr create/);
    assert.doesNotMatch(finalStep!.input, /git push/);
  });

  it("finalize_merge step contains the atomic plumbing merge instructions", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep);
    // Phase 1: capture the target tip and check fast-forward safety against it.
    assert.match(finalStep!.input, /RUN_ID:\s*\{\{run_id\}\}/);
    assert.match(finalStep!.input, /ORIGIN_REPOSITORY:\s*\{\{repo\}\}/);
    assert.match(finalStep!.input, /EXPECT_TIP=.*rev-parse/);
    assert.match(finalStep!.input, /merge-base --is-ancestor "\$EXPECT_TIP"/);
    assert.match(finalStep!.input, /Phase 1.*Capture Explicit Target.*Fast-Forward Check/);
    // Phase 2: Rebase
    assert.match(finalStep!.input, /Phase 2.*Rebase/);
    assert.match(finalStep!.input, /git -C \{\{repo\}\} rebase "\$EXPECT_TIP"/);
    assert.match(finalStep!.input, /git rebase --continue/);
    // Phase 3: atomic plumbing landing, without porcelain origin mutation.
    assert.match(finalStep!.input, /Phase 3.*Atomic Landing/);
    assert.match(finalStep!.input, /tamandua merge-branch/);
    assert.match(finalStep!.input, /--expect-tip "\$EXPECT_TIP"/);
    assert.match(finalStep!.input, /Preserve MERGE_OUTPUT verbatim/);
    assert.doesNotMatch(finalStep!.input, /git checkout|git merge --squash|git commit -F/);
    // Output format includes REBASED
    assert.match(finalStep!.input, /REBASED:\s*false/);
    assert.match(finalStep!.input, /ORIGINAL_BRANCH:\s*\{\{original_branch\}\}/);
    assert.match(finalStep!.input, /MERGE_COMMIT:/);
    assert.match(finalStep!.input, /MERGED_INTO:/);
    // Preserves fix:-prefix commit message guidance
    assert.match(finalStep!.input, /fix:/);
  });

  it("setup step input contains ORIGINAL_BRANCH", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const setupStep = spec.steps.find((s) => s.id === "setup");
    assert.ok(setupStep, "setup step must exist");
    assert.match(
      setupStep!.input,
      /ORIGINAL_BRANCH/,
      "setup.input must contain ORIGINAL_BRANCH",
    );
    assert.match(
      setupStep!.input,
      /Capture the current branch before switching: ORIGINAL_BRANCH=\$\(git branch --show-current\)/,
    );
  });

  it("defines a merger agent with role pr", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const merger = spec.agents.find((a) => a.id === "merger");
    assert.ok(merger, "merger agent must exist");
    assert.equal(merger!.role, "pr");
  });

  it("merger agent has workflow-local persona files", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const merger = spec.agents.find((a) => a.id === "merger");
    assert.ok(merger);
    assert.equal(merger!.workspace.files["AGENTS.md"], "agents/merger/AGENTS.md");
    assert.equal(merger!.workspace.files["SOUL.md"], "agents/merger/SOUL.md");
    assert.equal(merger!.workspace.files["IDENTITY.md"], "agents/merger/IDENTITY.md");
  });

  it("setup and verifier agents reference shared personas", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const setupAgent = spec.agents.find((a) => a.id === "setup");
    const verifierAgent = spec.agents.find((a) => a.id === "verifier");
    assert.ok(setupAgent);
    assert.ok(verifierAgent);

    assert.equal(
      setupAgent!.workspace.files["AGENTS.md"],
      "../../agents/shared/setup/AGENTS.md",
    );
    assert.equal(
      verifierAgent!.workspace.files["AGENTS.md"],
      "../../agents/shared/verifier/AGENTS.md",
    );
  });

  it("all workflow agents declare tamandua-agents skill", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    for (const agent of spec.agents) {
      const skills = agent.workspace.skills ?? [];
      assert.ok(
        skills.includes("tamandua-agents"),
        `${agent.id}: workspace.skills must include tamandua-agents`,
      );
    }
  });

  it("all steps reference valid agents", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const agentIds = new Set(spec.agents.map((a) => a.id));
    for (const step of spec.steps) {
      assert.ok(
        agentIds.has(step.agent),
        `step "${step.id}" references unknown agent "${step.agent}"`,
      );
    }
  });

  // US-004: Ordering and tester retry absence in step input
  it("finalize_merge step input places FF check before atomic landing", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep);

    const ffIdx = finalStep!.input.search(/git -C "\$ORIGIN_REPOSITORY" merge-base --is-ancestor/);
    const landingIdx = finalStep!.input.search(/MERGE_OUTPUT=\$\(tamandua merge-branch/);

    assert.ok(ffIdx >= 0, "must contain the EXPECT_TIP fast-forward check");
    assert.ok(landingIdx >= 0, "must contain tamandua merge-branch");
    assert.ok(
      ffIdx < landingIdx,
      `FF check (pos ${ffIdx}) must appear before atomic landing (pos ${landingIdx})`,
    );
  });

  it("finalize_merge step input does NOT contain tester retry path (US-004)", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep);
    assert.doesNotMatch(finalStep!.input, /RETRY_STEP:\s*test/);
    assert.match(finalStep!.input, /CONFLICT_NOTES/);
  });

  // US-002: Verify merger persona files
  describe("merger persona", () => {
    const mergerAgentsMd = readFileSync(resolve(wfDir, "agents", "merger", "AGENTS.md"), "utf-8");
    const mergerSoulMd = readFileSync(resolve(wfDir, "agents", "merger", "SOUL.md"), "utf-8");
    const mergerIdentityMd = readFileSync(resolve(wfDir, "agents", "merger", "IDENTITY.md"), "utf-8");

    it("AGENTS.md exists with bug-fix-github-pr commit-message guidance", () => {
      assert.ok(existsSync(resolve(wfDir, "agents", "merger", "AGENTS.md")));
      assert.match(mergerAgentsMd, /fix:/);
      assert.match(mergerAgentsMd, /bug/gi);
      assert.match(mergerAgentsMd, /root cause/gi);
      assert.match(mergerAgentsMd, /fix/gi);
    });

    it("SOUL.md exists and matches feature-dev-merge source", () => {
      const sourceSoul = readFileSync(
        resolve(resolveBundledWorkflowsDir(), "feature-dev-merge", "agents", "merger", "SOUL.md"),
        "utf-8",
      );
      assert.equal(mergerSoulMd, sourceSoul);
    });

    it("IDENTITY.md exists with appropriate merger identity", () => {
      assert.ok(existsSync(resolve(wfDir, "agents", "merger", "IDENTITY.md")));
      assert.match(mergerIdentityMd, /Name:\s*Merger/);
      assert.match(mergerIdentityMd, /Role:.*[Ss]quash/);
    });

    it("AGENTS.md supplies the generated commit message to merge-branch", () => {
      assert.match(mergerAgentsMd, /Commit Message Generation/);
      assert.match(mergerAgentsMd, /--message "\$\(cat "\$MESSAGE_FILE"\)"/);
      assert.doesNotMatch(mergerAgentsMd, /git commit -F/);
    });

    it("AGENTS.md does NOT contain gh pr create or git push", () => {
      assert.doesNotMatch(mergerAgentsMd, /gh pr create/);
      assert.doesNotMatch(mergerAgentsMd, /git push/);
    });

    it("AGENTS.md uses fix: prefix for commit message subject", () => {
      assert.doesNotMatch(mergerAgentsMd, /Use conventional commit format with `feat:`/);
      assert.match(mergerAgentsMd, /Use `fix:` prefix/);
      assert.match(mergerAgentsMd, /Do NOT use a hardcoded one-line commit message/);
    });

    it("AGENTS.md captures EXPECT_TIP before atomic landing", () => {
      assert.match(mergerAgentsMd, /Phase 1: Capture Target Tip and Check Fast-Forward Safety/);
      assert.match(mergerAgentsMd, /TARGET_REF="refs\/heads\/\{\{original_branch\}\}"/);
      assert.match(
        mergerAgentsMd,
        /EXPECT_TIP=\$\(git -C "\$ORIGIN_REPOSITORY" rev-parse "\$TARGET_REF"\)/,
      );
      assert.match(
        mergerAgentsMd,
        /git -C "\$ORIGIN_REPOSITORY" merge-base --is-ancestor "\$EXPECT_TIP" refs\/heads\/\{\{branch\}\}/,
      );
      const phase1Index = mergerAgentsMd.indexOf("Phase 1: Capture Target Tip");
      const phase3Index = mergerAgentsMd.indexOf("Phase 3: Atomic Landing");
      assert.ok(phase1Index < phase3Index, "target-tip capture must come before atomic landing");
    });

    it("AGENTS.md includes rebase path for non-FF case with conflict resolution", () => {
      assert.match(mergerAgentsMd, /Phase 2: Rebase/);
      assert.match(mergerAgentsMd, /git -C \{\{repo\}\} rebase "\$EXPECT_TIP"/);
      assert.match(mergerAgentsMd, /git rebase --continue/);
      assert.match(mergerAgentsMd, /fix them carefully|resolve each conflict|If conflicts arise/i);
      assert.match(mergerAgentsMd, /RETRY_STEP:\s*verify/);
    });

    it("AGENTS.md lands only through the complete merge-branch contract", () => {
      assert.match(mergerAgentsMd, /IF YOU REBASED, YOU NEVER LAND IN THIS INVOCATION/);
      assert.match(mergerAgentsMd, /MERGE_OUTPUT=\$\(tamandua merge-branch/);
      for (const flag of ["--origin", "--branch", "--into", "--expect-tip", "--message"]) {
        assert.match(mergerAgentsMd, new RegExp(flag));
      }
      assert.doesNotMatch(mergerAgentsMd, /git checkout|git merge --squash|git commit -F/);
    });

    it("AGENTS.md output format includes REBASED field", () => {
      assert.match(mergerAgentsMd, /On successful landing[\s\S]*REBASED:\s*false/);
      assert.match(mergerAgentsMd, /STATUS: landed[\s\S]*MERGED_COMMIT:[\s\S]*MERGED_TREE:/);
      assert.match(mergerAgentsMd, /MERGE_COMMIT:[\s\S]*MERGED_INTO:[\s\S]*STATUS: done/);
    });

    it("AGENTS.md retry path routes to verifier (RETRY_STEP: verify)", () => {
      assert.match(mergerAgentsMd, /RETRY_STEP:\s*verify/);
      assert.match(mergerAgentsMd, /CONFLICT_NOTES:/);
    });

    it("AGENTS.md keeps the origin checkout and index read-only", () => {
      assert.match(mergerAgentsMd, /origin working tree and index are read-only/i);
      assert.match(mergerAgentsMd, /only `tamandua merge-branch` may (?:mutate|update) the target ref/i);
      assert.match(
        mergerAgentsMd,
        /never[^\n]*checkout[^\n]*reset[^\n]*symbolic-ref[^\n]*read-tree[^\n]*origin/i,
      );
      assert.match(mergerAgentsMd, /STATUS: conflicts/);
      assert.match(mergerAgentsMd, /STATUS: target_moved/);
      assert.match(mergerAgentsMd, /other non-zero exit|any other non-zero exit/i);
    });
  });

  // US-001: Verify triager, investigator, and fixer persona files match bug-fix source
  describe("triager, investigator, fixer personas match bug-fix source", () => {
    const agentIds = ["triager", "investigator", "fixer"];
    const personaFiles = ["AGENTS.md", "SOUL.md", "IDENTITY.md"];
    const bugFixDir = resolve(resolveBundledWorkflowsDir(), "bug-fix-github-pr");

    for (const agentId of agentIds) {
      for (const file of personaFiles) {
        it(`${agentId}/${file} exists in bug-fix-merge and matches bug-fix source`, () => {
          const sourcePath = resolve(bugFixDir, "agents", agentId, file);
          const targetPath = resolve(wfDir, "agents", agentId, file);

          assert.ok(existsSync(sourcePath), `source must exist: ${sourcePath}`);
          assert.ok(existsSync(targetPath), `target must exist: ${targetPath}`);

          const sourceContent = readFileSync(sourcePath, "utf-8");
          const targetContent = readFileSync(targetPath, "utf-8");

          assert.equal(
            targetContent,
            sourceContent,
            `${agentId}/${file} must match bug-fix-github-pr source exactly`,
          );
        });
      }
    }
  });
});
