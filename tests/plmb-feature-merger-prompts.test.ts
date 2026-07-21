import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadWorkflowSpec } from "../dist/installer/workflow-spec.js";

const repoRoot = resolve(import.meta.dirname, "..");
const workflowsRoot = resolve(repoRoot, "workflows");
const sharedPersonaPath = resolve(
  workflowsRoot,
  "feature-dev-merge",
  "agents",
  "merger",
  "AGENTS.md",
);
const worktreePersonaPath = resolve(
  workflowsRoot,
  "feature-dev-merge-worktree",
  "agents",
  "merger",
  "AGENTS.md",
);
const bugFixPersonaPath = resolve(
  workflowsRoot,
  "bug-fix-merge",
  "agents",
  "merger",
  "AGENTS.md",
);
const bugFixWorktreePersonaPath = resolve(
  workflowsRoot,
  "bug-fix-merge-worktree",
  "agents",
  "merger",
  "AGENTS.md",
);
const persona = readFileSync(sharedPersonaPath, "utf8");

interface MergerPersonaConsumer {
  workflowId: string;
  path: string;
  realpath: string;
  content: string;
}

function mergeBranchPersonaConsumers(): MergerPersonaConsumer[] {
  return readdirSync(workflowsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      workflowId: entry.name,
      path: resolve(workflowsRoot, entry.name, "agents", "merger", "AGENTS.md"),
    }))
    .filter((candidate) => existsSync(candidate.path))
    .map((candidate) => ({
      ...candidate,
      realpath: realpathSync(candidate.path),
      content: readFileSync(candidate.path, "utf8"),
    }))
    .filter((candidate) => candidate.content.includes("tamandua merge-branch"))
    .sort((left, right) => left.workflowId.localeCompare(right.workflowId));
}

function assertRetryBeforeMergeBranch(content: string, label: string): void {
  assert.match(
    content,
    /rebase succeeds[\s\S]{0,300}immediately emit `STATUS: retry`[\s\S]{0,300}return from the invocation before invoking `tamandua merge-branch`/i,
    `${label} must return a retry verdict immediately after a successful rebase and before merge-branch`,
  );
  assert.match(
    content,
    /Never land and then report retry/i,
    `${label} must explicitly forbid land-then-retry ordering`,
  );
  assert.match(
    content,
    /`tamandua merge-branch` may run only in a fresh invocation where no rebase was needed and the branch was already based on the captured current target tip in `EXPECT_TIP`/,
    `${label} must permit merge-branch only on a fresh, already-based invocation`,
  );
}

async function finalizeMergeInput(workflowId: string): Promise<string> {
  const spec = await loadWorkflowSpec(resolve(workflowsRoot, workflowId));
  const step = spec.steps.find((candidate) => candidate.id === "finalize_merge");
  assert.ok(step, `${workflowId} must define finalize_merge`);
  return step.input;
}

function assertCompleteMergeBranchInvocation(content: string): void {
  assert.match(content, /tamandua merge-branch/);
  for (const flag of ["--origin", "--branch", "--into", "--expect-tip", "--message"]) {
    assert.match(content, new RegExp(flag), `merge-branch invocation must supply ${flag}`);
  }
}

function assertNoDirectOriginMutation(content: string): void {
  assert.doesNotMatch(content, /git\s+-C\s+[^\n]*\scheckout\b/);
  assert.doesNotMatch(content, /git\s+-C\s+[^\n]*\smerge\s+--squash\b/);
  assert.doesNotMatch(content, /git\s+-C\s+[^\n]*\scommit(?:\s|$)/m);
  assert.doesNotMatch(content, /git\s+-C\s+[^\n]*\supdate-ref\b/);
}

function assertManagedParkingGuardrail(content: string, label: string): void {
  assert.match(
    content,
    /never[^\n]*checkout[^\n]*reset[^\n]*symbolic-ref[^\n]*read-tree[^\n]*origin/i,
    `${label} must explicitly leave checkout parking to tamandua merge-branch`,
  );
  assert.match(
    content,
    /only `tamandua merge-branch` may (?:mutate|update) the target ref/i,
    `${label} must reserve target-ref mutation for merge-branch`,
  );
  assert.match(content, /verbatim/i, `${label} must preserve merge-branch output verbatim`);
}

describe("US-003 PLMB feature merger prompt contracts", () => {
  it("keeps the worktree merger as a symlink consumer of the shared persona", () => {
    assert.equal(realpathSync(worktreePersonaPath), realpathSync(sharedPersonaPath));
    assert.notEqual(dirname(worktreePersonaPath), dirname(sharedPersonaPath));
  });

  it("keeps the branch-existence guard first without branch discovery", () => {
    const guardIndex = persona.indexOf("Branch Existence Guard (ALWAYS FIRST)");
    const targetIndex = persona.indexOf('TARGET_REF="refs/heads/{{original_branch}}"');
    const mergeIndex = persona.indexOf("MERGE_OUTPUT=$(tamandua merge-branch");

    assert.ok(guardIndex >= 0, "shared persona must preserve the branch guard");
    assert.ok(targetIndex > guardIndex, "target capture must follow the branch guard");
    assert.ok(mergeIndex > targetIndex, "landing must follow target capture");
    assert.match(persona, /git -C \{\{repo\}\} rev-parse --verify refs\/heads\/\{\{branch\}\}/);
    assert.doesNotMatch(persona, /git branch(?:\s|`)/);
    assert.doesNotMatch(persona, /refs\/heads\/\*|ls \.git\/refs\/heads/);
  });

  it("uses every merge-branch flag with an explicit original_branch target and captured tip", () => {
    assert.match(persona, /TARGET_REF="refs\/heads\/\{\{original_branch\}\}"/);
    assert.match(persona, /EXPECT_TIP=\$\(git -C "\$ORIGIN_REPOSITORY" rev-parse "\$TARGET_REF"\)/);
    assert.match(persona, /--into "\{\{original_branch\}\}"/);
    assert.match(persona, /--expect-tip "\$EXPECT_TIP"/);
    assertCompleteMergeBranchInvocation(persona);
  });

  it("requires rebase loopback to return before landing", () => {
    const rebaseIndex = persona.indexOf('git -C {{repo}} rebase "$EXPECT_TIP"');
    const landingIndex = persona.indexOf("MERGE_OUTPUT=$(tamandua merge-branch");

    assert.ok(rebaseIndex >= 0, "non-fast-forward path must rebase in {{repo}}");
    assert.ok(rebaseIndex < landingIndex, "rebase path must precede landing");
    assert.match(persona, /STATUS: retry[\s\S]*REBASED: true[\s\S]*RETRY_STEP: test/);
    assert.match(persona, /IF YOU REBASED, YOU NEVER LAND IN THIS INVOCATION/);
    assertRetryBeforeMergeBranch(persona, "shared feature merger persona");
  });

  it("discovers every merge-branch merger consumer and enforces retry-before-landing", () => {
    const consumers = mergeBranchPersonaConsumers();
    assert.deepEqual(
      consumers.map((consumer) => consumer.workflowId),
      ["feature-dev-merge", "feature-dev-merge-worktree"],
    );

    const uniquePersonas = new Map<string, MergerPersonaConsumer>();
    for (const consumer of consumers) {
      assertRetryBeforeMergeBranch(consumer.content, consumer.workflowId);
      assertManagedParkingGuardrail(consumer.content, consumer.workflowId);
      uniquePersonas.set(consumer.realpath, consumer);
    }

    assert.equal(uniquePersonas.size, 1, "feature merge variants must share one merger persona");
    assert.equal(consumers[0]?.realpath, consumers[1]?.realpath);
  });

  it("explicitly audits bug-fix merge variants for immediate retry before landing", () => {
    assert.equal(realpathSync(bugFixWorktreePersonaPath), realpathSync(bugFixPersonaPath));
    const bugFixPersona = readFileSync(bugFixPersonaPath, "utf8");
    assert.match(
      bugFixPersona,
      /rebase succeeds[\s\S]{0,300}immediately emit `STATUS: retry`[\s\S]{0,300}return from the invocation before any squash-merge, commit, or other landing step/i,
    );
    assert.match(bugFixPersona, /Never land and then report retry/i);
    assert.match(
      bugFixPersona,
      /Landing may run only in a fresh invocation where no rebase was needed and the branch was already based on the current target/,
    );
  });

  it("maps conflicts and target movement to tester revalidation and fails other errors", () => {
    assert.match(persona, /STATUS: conflicts/);
    assert.match(persona, /STATUS: target_moved/);
    assert.match(persona, /STATUS: retry[\s\S]*REBASED: false[\s\S]*RETRY_STEP: test/);
    assert.match(persona, /other non-zero exit|any other non-zero exit/i);
    assert.match(persona, /STATUS: failed/);
  });

  it("preserves successful command output and tree attestation plus legacy keys", () => {
    assert.match(persona, /verbatim/i);
    assert.match(persona, /MERGED_TREE[\s\S]*\{\{tested_tree\}\}/);
    assert.match(persona, /MERGED_COMMIT/);
    assert.match(persona, /MERGE_COMMIT/);
    assert.match(persona, /MERGED_INTO/);
    assert.match(persona, /STATUS: done/);
  });

  for (const workflowId of ["feature-dev-merge", "feature-dev-merge-worktree"]) {
    it(`${workflowId} invokes only merge-branch for origin landing`, async () => {
      const input = await finalizeMergeInput(workflowId);
      assert.match(input, /ORIGIN_REPOSITORY:/);
      assert.match(input, /ORIGINAL_BRANCH:\s*\{\{original_branch\}\}/);
      assertCompleteMergeBranchInvocation(input);
      assertNoDirectOriginMutation(input);
      assert.doesNotMatch(input, /git merge --squash|git commit -F/);
      assert.match(input, /STATUS: conflicts/);
      assert.match(input, /STATUS: target_moved/);
      assert.match(input, /RETRY_STEP: test/);
      assert.match(input, /MERGED_TREE[\s\S]*\{\{tested_tree\}\}/);
    });

    it(`${workflowId} reroutes retry verdicts to tester revalidation immediately`, async () => {
      const spec = await loadWorkflowSpec(resolve(workflowsRoot, workflowId));
      const step = spec.steps.find((candidate) => candidate.id === "finalize_merge");
      assert.ok(step, `${workflowId} must define finalize_merge`);
      assert.equal(
        step.max_retries,
        0,
        "target_moved and conflict retry verdicts must not retry landing before tester revalidation",
      );
      assert.equal(step.on_fail?.retry_step, "test");
      assert.ok(
        (step.on_fail?.max_reroutes ?? 0) >= 8,
        "eight-way concurrent landing must have enough bounded revalidation reroutes",
      );
    });
  }

  it("worktree workflow reads the target tip in origin but rebases only in the feature worktree", async () => {
    const input = await finalizeMergeInput("feature-dev-merge-worktree");
    assert.match(input, /ORIGIN_REPOSITORY:\s*\{\{worktree_origin_repository\}\}/);
    assert.match(input, /TARGET_REF="refs\/heads\/\{\{original_branch\}\}"/);
    assert.match(input, /EXPECT_TIP=\$\(git -C "\$ORIGIN_REPOSITORY" rev-parse "\$TARGET_REF"\)/);
    assert.match(input, /git -C \{\{repo\}\} rebase "\$EXPECT_TIP"/);
    assert.doesNotMatch(input, /git -C \{\{worktree_origin_repository\}\} rebase/);
  });

  it("shared persona and both workflow prompts prohibit direct origin mutation", async () => {
    assertNoDirectOriginMutation(persona);
    for (const workflowId of ["feature-dev-merge", "feature-dev-merge-worktree"]) {
      assertNoDirectOriginMutation(await finalizeMergeInput(workflowId));
    }
  });
});
