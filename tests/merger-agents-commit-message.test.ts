import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadWorkflowSpec } from "../dist/installer/workflow-spec.js";
import { resolveBundledWorkflowsDir } from "../dist/installer/paths.js";

const repoRoot = resolve(import.meta.dirname, "..");
const mergerAgentsPath = resolve(
  repoRoot,
  "workflows",
  "feature-dev-merge",
  "agents",
  "merger",
  "AGENTS.md",
);

const content = readFileSync(mergerAgentsPath, "utf-8");

describe("merger AGENTS.md commit message generation", () => {
  it("contains a Commit Message Generation section", () => {
    assert.match(content, /## Commit Message Generation/);
  });

  it("instructs gathering information from task description", () => {
    assert.match(content, /\{\{task\}\}/);
  });

  it("instructs gathering information from git log of feature branch", () => {
    assert.match(
      content,
      /git log \{\{original_branch\}\}\.\.\{\{branch\}\} --oneline/,
    );
  });

  it("instructs gathering information from progress file", () => {
    assert.match(content, /\{\{progress_file\}\}/);
  });

  it("instructs using conventional commit format for first line", () => {
    assert.match(content, /conventional commit format/);
    assert.match(content, /feat: <summary>/);
  });

  it("requires first line under 72 characters", () => {
    assert.match(content, /Under 72 characters/);
  });

  it("requires first line in imperative mood", () => {
    assert.match(content, /imperative mood/i);
  });

  it("requires a blank line between subject and body", () => {
    assert.match(content, /\*\*Blank line\*\*/);
  });

  it("instructs a detailed body listing individual changes", () => {
    assert.match(content, /Individual changes from the git log/);
  });

  it("instructs writing the message to a temp file and passing it to merge-branch", () => {
    assert.match(content, /--message "\$\(cat "\$MESSAGE_FILE"\)"/);
    assert.match(content, /\/tmp\/merge-commit-msg\.txt/);
    assert.doesNotMatch(content, /git commit -F/);
  });

  it("provides an example commit message", () => {
    assert.match(content, /feat: Add user authentication with JWT support/);
    assert.match(content, /Add login\/register endpoints/);
  });

  it("does not contain the old hardcoded commit message", () => {
    assert.doesNotMatch(
      content,
      /git commit -m "feat: merge/,
    );
  });

  it("preserves guardrails section with no force push", () => {
    assert.match(content, /## Guardrails/);
    assert.match(content, /Do not force-push/);
  });

  it("preserves guardrails section with no rewrite history", () => {
    assert.match(content, /Do not rewrite history/);
  });

  it("preserves output format with STATUS/MERGE_COMMIT/MERGED_INTO", () => {
    assert.match(content, /STATUS: done/);
    assert.match(content, /MERGE_COMMIT:/);
    assert.match(content, /MERGED_INTO:/);
  });

  it("instructs NOT to use hardcoded one-line commit message", () => {
    assert.match(content, /Do NOT use a hardcoded one-line commit message/);
  });

  it("describes WHAT and WHY for future maintainers", () => {
    assert.match(content, /WHAT was done and WHY/);
    assert.match(content, /useful for future maintainers/);
  });
});

describe("merger AGENTS.md fast-forward-first merge process", () => {
  it("captures the target tip and checks fast-forward safety before atomic landing", () => {
    assert.match(content, /Phase 1: Capture Target Tip and Check Fast-Forward Safety/);
    assert.match(content, /merge-base --is-ancestor "\$EXPECT_TIP" refs\/heads\/\{\{branch\}\}/);
    const phase1Index = content.indexOf("Phase 1: Capture Target Tip");
    const landingIndex = content.indexOf("Phase 3: Atomic Landing");
    assert.ok(phase1Index < landingIndex, "Fast-Forward Check must come before Atomic Landing");
  });

  it("includes Phase 2 rebase-on-non-FF path with conflict resolution instructions", () => {
    assert.match(content, /Phase 2: Rebase/);
    assert.match(content, /git -C \{\{repo\}\} rebase "\$EXPECT_TIP"/);
    assert.match(content, /git rebase --continue/);
    assert.match(content, /fix them carefully|resolve each conflict|If conflicts arise/i);
  });

  it("includes tester retry path when rebase made changes, with RETRY_STEP: test", () => {
    assert.match(content, /STATUS: retry/);
    assert.match(content, /CONFLICT_NOTES:/);
    assert.match(content, /RETRY_STEP: test/);
    assert.match(content, /NEVER land in this invocation/);
  });

  it("guardrails forbid landing when not FF-safe", () => {
    assert.match(content, /NEVER land when the branch is not fast-forward-safe against `EXPECT_TIP`/);
    assert.match(content, /IF YOU REBASED, YOU NEVER LAND IN THIS INVOCATION/);
  });

  it("output format includes REBASED field", () => {
    assert.match(content, /On successful landing[\s\S]*REBASED:\s*false/);
  });

  it("no contradictory FF + unrelated squash instructions coexist (US-004 guardrail)", () => {
    // Acceptance Criteria 4: Guardrail check — every squash-merge mention
    // must be in a Phase 3 / FF-safe context or the guardrails section.
    const squashRe = /squash[ -]?merge/gi;
    let match: RegExpExecArray | null;
    while ((match = squashRe.exec(content)) !== null) {
      const idx = match.index;
      // Use a wide window to capture distant "only valid paths" or "NEVER"
      // in the guardrails section which describes valid-path examples.
      const context = content.substring(Math.max(0, idx - 250), idx + 250);
      assert.ok(
        context.includes("Phase 3") ||
          context.includes("FF-safe") ||
          context.includes("fast-forward-safe") ||
          context.includes("NEVER") ||
          context.includes("IF YOU REBASED") ||
          context.includes("RETRY_STEP") ||
          context.includes("you are re-invoked") ||
          context.includes("report retry") ||
          context.includes("MERGED_TREE"),
        `squash merge mention outside FF-safe context (pos ${idx}): ...${context.substring(230, 270)}...`,
      );
    }
  });

  it("workflow.yml finalize_merge step input places FF check before atomic landing", async () => {
    const wfDir = resolve(resolveBundledWorkflowsDir(), "feature-dev-merge");
    const spec = await loadWorkflowSpec(wfDir);
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep, "finalize_merge step must exist");

    const input = finalStep!.input;
    const ffIdx = input.search(/merge-base --is-ancestor/);
    const landingIdx = input.search(/MERGE_OUTPUT=\$\(tamandua merge-branch/);

    assert.ok(ffIdx >= 0, "must contain merge-base --is-ancestor");
    assert.ok(landingIdx >= 0, "must contain tamandua merge-branch invocation");
    assert.ok(
      ffIdx < landingIdx,
      `FF check (pos ${ffIdx}) must appear before atomic landing (pos ${landingIdx})`,
    );
  });
});
