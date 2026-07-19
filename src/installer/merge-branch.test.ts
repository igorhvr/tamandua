import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  runPlumbingMerge,
  type MergeBranchEvent,
} from "../../dist/installer/merge-branch.js";

const cleanup: string[] = [];

function git(repo: string, args: string[]): string {
  const result = rawGit(repo, args);
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

function rawGit(repo: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status ?? -1,
  };
}

function createRepo(): { repo: string; initial: string } {
  const repo = tamanduaTempDir("tamandua-merge-branch-");
  cleanup.push(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "test@tamandua.local"]);
  git(repo, ["config", "user.name", "Tamandua Test"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf-8");
  git(repo, ["add", "base.txt"]);
  git(repo, ["commit", "-m", "base"]);
  return { repo, initial: git(repo, ["rev-parse", "HEAD"]) };
}

function createFeature(repo: string, branch = "feature"): string {
  git(repo, ["switch", "-c", branch]);
  fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n", "utf-8");
  git(repo, ["add", "feature.txt"]);
  git(repo, ["commit", "-m", "feature"]);
  const featureTip = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["switch", "main"]);
  return featureTip;
}

function createTouchedFeature(repo: string, branch = "feature"): string {
  git(repo, ["switch", "-c", branch]);
  fs.writeFileSync(path.join(repo, "base.txt"), "feature version\n", "utf-8");
  git(repo, ["commit", "-am", "feature touches base"]);
  const featureTip = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["switch", "main"]);
  return featureTip;
}

function createLinkedTargetRepo(): { repo: string; targetWorktree: string; initial: string } {
  const { repo, initial } = createRepo();
  createTouchedFeature(repo);
  git(repo, ["branch", "staging", initial]);
  const targetWorktree = tamanduaTempDir("tamandua-merge-branch-linked-");
  cleanup.push(targetWorktree);
  git(repo, ["worktree", "add", targetWorktree, "staging"]);
  return { repo, targetWorktree, initial };
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runPlumbingMerge", () => {
  it("IDEM returns a no-op landing when the branch is already ancestral to the target", () => {
    const { repo } = createRepo();
    const featureTip = createFeature(repo);
    git(repo, ["merge", "--ff-only", "feature"]);
    const targetTip = git(repo, ["rev-parse", "refs/heads/main"]);
    const targetTree = git(repo, ["rev-parse", `${targetTip}^{tree}`]);
    const events: MergeBranchEvent[] = [];
    const commands: string[][] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: targetTip, message: "must not duplicate", runId: "run-noop-ancestor" },
      {
        runGit: (origin, args) => {
          commands.push(args);
          return rawGit(origin, args);
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(featureTip, targetTip);
    assert.equal(result.status, "landed");
    assert.equal(result.exitCode, 0);
    if (result.status !== "landed") return;
    assert.equal(result.noop, true);
    assert.equal(result.mergedCommit, targetTip);
    assert.equal(result.mergedTree, targetTree);
    assert.equal(result.checkoutRefresh, "not-applicable");
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), targetTip);
    assert.equal(commands.some((args) => args[0] === "commit-tree"), false);
    assert.equal(commands.some((args) => args[0] === "update-ref"), false);
    assert.deepEqual(events, [
      {
        ts: events[0]?.ts,
        event: "merge.landed",
        runId: "run-noop-ancestor",
        origin: repo,
        branch: "feature",
        target: "refs/heads/main",
        expectedTip: targetTip,
        mergedTree: targetTree,
        mergedCommit: targetTip,
        checkoutRefresh: "not-applicable",
        noop: true,
      },
    ]);
  });

  it("IDEM returns a no-op landing when a non-ancestral branch produces the target tree", () => {
    const { repo, initial } = createRepo();
    const featureTip = createFeature(repo);
    const targetTree = git(repo, ["rev-parse", `${featureTip}^{tree}`]);
    const equivalentTarget = git(repo, ["commit-tree", targetTree, "-p", initial, "-m", "equivalent upstream change"]);
    git(repo, ["update-ref", "refs/heads/main", equivalentTarget, initial]);
    git(repo, ["reset", "--hard", equivalentTarget]);
    const events: MergeBranchEvent[] = [];
    const commands: string[][] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: equivalentTarget, message: "must not duplicate", runId: "run-noop-tree" },
      {
        runGit: (origin, args) => {
          commands.push(args);
          return rawGit(origin, args);
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.notEqual(featureTip, equivalentTarget);
    assert.equal(result.status, "landed");
    assert.equal(result.exitCode, 0);
    if (result.status !== "landed") return;
    assert.equal(result.noop, true);
    assert.equal(result.mergedCommit, equivalentTarget);
    assert.equal(result.mergedTree, targetTree);
    assert.equal(result.checkoutRefresh, "not-applicable");
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), equivalentTarget);
    assert.equal(commands.some((args) => args[0] === "commit-tree"), false);
    assert.equal(commands.some((args) => args[0] === "update-ref"), false);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "merge.landed");
    assert.equal(events[0]?.noop, true);
    assert.equal(events[0]?.mergedCommit, equivalentTarget);
    assert.equal(events[0]?.mergedTree, targetTree);
  });

  it("IDEM lands remaining changes from a partially pre-applied branch", () => {
    const { repo } = createRepo();
    git(repo, ["switch", "-c", "feature"]);
    fs.writeFileSync(path.join(repo, "shared.txt"), "shared\n", "utf-8");
    git(repo, ["add", "shared.txt"]);
    git(repo, ["commit", "-m", "shared change"]);
    const sharedCommit = git(repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repo, "remaining.txt"), "remaining\n", "utf-8");
    git(repo, ["add", "remaining.txt"]);
    git(repo, ["commit", "-m", "remaining change"]);
    git(repo, ["switch", "main"]);
    git(repo, ["cherry-pick", sharedCommit]);
    const targetTip = git(repo, ["rev-parse", "HEAD"]);
    const events: MergeBranchEvent[] = [];
    const commands: string[][] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: targetTip, message: "land remaining", runId: "run-partial" },
      {
        runGit: (origin, args) => {
          commands.push(args);
          return rawGit(origin, args);
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.equal(result.noop, false);
    assert.notEqual(result.mergedCommit, targetTip);
    assert.equal(git(repo, ["rev-parse", `${result.mergedCommit}^`]), targetTip);
    assert.equal(git(repo, ["show", `${result.mergedCommit}:shared.txt`]), "shared");
    assert.equal(git(repo, ["show", `${result.mergedCommit}:remaining.txt`]), "remaining");
    assert.equal(commands.filter((args) => args[0] === "commit-tree").length, 1);
    assert.equal(commands.filter((args) => args[0] === "update-ref").length, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "merge.landed");
    assert.equal(events[0]?.noop, false);
  });

  it("STCK refreshes a clean checked-out target after landing", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const events: MergeBranchEvent[] = [];
    const headRefBefore = git(repo, ["symbolic-ref", "HEAD"]);

    const result = runPlumbingMerge(
      {
        origin: repo,
        branch: "feature",
        into: "main",
        expectTip: initial,
        message: "Land feature",
        runId: "run-clean",
      },
      { emitEvent: (event) => events.push(event) },
    );

    assert.equal(result.status, "landed");
    assert.equal(result.exitCode, 0);
    if (result.status !== "landed") return;
    assert.equal(result.noop, false);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), result.mergedCommit);
    assert.equal(git(repo, ["rev-parse", `${result.mergedCommit}^`]), initial);
    assert.equal(git(repo, ["rev-parse", `${result.mergedCommit}^{tree}`]), result.mergedTree);
    assert.equal(git(repo, ["show", `${result.mergedCommit}:feature.txt`]), "feature");
    assert.equal(result.checkoutRefresh, "refreshed");
    assert.equal(git(repo, ["write-tree"]), result.mergedTree);
    assert.equal(fs.readFileSync(path.join(repo, "feature.txt"), "utf-8"), "feature\n");
    assert.equal(git(repo, ["status", "--porcelain"]), "");
    assert.equal(git(repo, ["diff", "--cached", "--name-only"]), "");
    assert.equal(git(repo, ["symbolic-ref", "HEAD"]), headRefBefore);
    assert.deepEqual(events, [
      {
        ts: events[0]?.ts,
        event: "merge.landed",
        runId: "run-clean",
        origin: repo,
        branch: "feature",
        target: "refs/heads/main",
        expectedTip: initial,
        mergedTree: result.mergedTree,
        mergedCommit: result.mergedCommit,
        noop: false,
        checkoutRefresh: "refreshed",
      },
    ]);
  });

  it("refreshes the linked worktree that owns the target without touching the origin checkout", () => {
    const { repo, targetWorktree, initial } = createLinkedTargetRepo();
    const rootUntrackedPath = path.join(repo, "operator-notes.txt");
    const rootUntrackedBytes = Buffer.from("root operator bytes\n");
    fs.writeFileSync(rootUntrackedPath, rootUntrackedBytes);
    const rootIndexPath = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const rootBefore = {
      branch: git(repo, ["symbolic-ref", "HEAD"]),
      head: git(repo, ["rev-parse", "HEAD"]),
      indexTree: git(repo, ["write-tree"]),
      indexBytes: fs.readFileSync(rootIndexPath),
      status: git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]),
      trackedBytes: fs.readFileSync(path.join(repo, "base.txt")),
      untrackedBytes: fs.readFileSync(rootUntrackedPath),
    };
    const events: MergeBranchEvent[] = [];

    const result = runPlumbingMerge(
      {
        origin: repo,
        branch: "feature",
        into: "staging",
        expectTip: initial,
        message: "Land feature into linked staging",
        runId: "run-linked-target",
      },
      { emitEvent: (event) => events.push(event) },
    );

    assert.equal(result.status, "landed");
    assert.equal(result.exitCode, 0);
    if (result.status !== "landed") return;
    assert.equal(result.checkoutRefresh, "refreshed");
    assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), result.mergedCommit);
    assert.equal(git(targetWorktree, ["rev-parse", "HEAD"]), result.mergedCommit);
    assert.equal(git(targetWorktree, ["rev-parse", "HEAD^{tree}"]), result.mergedTree);
    assert.equal(git(targetWorktree, ["write-tree"]), result.mergedTree);
    assert.equal(git(targetWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal(fs.readFileSync(path.join(targetWorktree, "base.txt"), "utf-8"), "feature version\n");

    assert.equal(git(repo, ["symbolic-ref", "HEAD"]), rootBefore.branch);
    assert.equal(git(repo, ["rev-parse", "HEAD"]), rootBefore.head);
    assert.equal(git(repo, ["write-tree"]), rootBefore.indexTree);
    assert.deepEqual(fs.readFileSync(rootIndexPath), rootBefore.indexBytes);
    assert.equal(git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]), rootBefore.status);
    assert.deepEqual(fs.readFileSync(path.join(repo, "base.txt")), rootBefore.trackedBytes);
    assert.deepEqual(fs.readFileSync(rootUntrackedPath), rootBefore.untrackedBytes);
    assert.equal(fs.existsSync(path.join(repo, "feature.txt")), false);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "merge.landed");
    assert.equal(events[0]?.checkoutRefresh, "refreshed");
  });

  it("STCK leaves the checkout untouched when landing into a non-checked-out branch", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    git(repo, ["branch", "release", initial]);
    const events: MergeBranchEvent[] = [];
    const indexTreeBefore = git(repo, ["write-tree"]);
    const baseBefore = fs.readFileSync(path.join(repo, "base.txt"), "utf-8");

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "release", expectTip: initial, message: "Land feature", runId: "run-other" },
      { emitEvent: (event) => events.push(event) },
    );

    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.equal(result.checkoutRefresh, "not-applicable");
    assert.equal(git(repo, ["write-tree"]), indexTreeBefore);
    assert.equal(fs.readFileSync(path.join(repo, "base.txt"), "utf-8"), baseBefore);
    assert.equal(fs.existsSync(path.join(repo, "feature.txt")), false);
    assert.equal(events[0]?.checkoutRefresh, "not-applicable");
  });

  for (const dirtyState of ["tracked", "staged", "untracked"] as const) {
    it(`fails before object creation when a linked target has ${dirtyState} changes`, () => {
      const { repo, targetWorktree, initial } = createLinkedTargetRepo();
      const userPath = dirtyState === "untracked"
        ? path.join(targetWorktree, "operator-notes.txt")
        : path.join(targetWorktree, "base.txt");
      const userBytes = `${dirtyState} operator bytes\n`;
      fs.writeFileSync(userPath, userBytes, "utf-8");
      if (dirtyState === "staged") git(targetWorktree, ["add", "base.txt"]);

      const rootBranchBefore = git(repo, ["symbolic-ref", "HEAD"]);
      const targetBranchBefore = git(targetWorktree, ["symbolic-ref", "HEAD"]);
      const targetIndexBefore = git(targetWorktree, ["write-tree"]);
      const targetStatusBefore = git(targetWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
      const targetIndexPath = git(targetWorktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
      const targetIndexBytesBefore = fs.readFileSync(targetIndexPath);
      const commands: string[][] = [];
      const events: MergeBranchEvent[] = [];

      const result = runPlumbingMerge(
        { origin: repo, branch: "feature", into: "staging", expectTip: initial, message: "must not land", runId: `run-dirty-${dirtyState}` },
        {
          runGit: (origin, args) => {
            commands.push(args);
            return rawGit(origin, args);
          },
          emitEvent: (event) => events.push(event),
        },
      );

      assert.equal(result.status, "operational_error");
      assert.equal(result.exitCode, 1);
      if (result.status !== "operational_error") return;
      assert.match(result.detail, /target worktree.*not clean/i);
      assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), initial);
      assert.equal(git(repo, ["symbolic-ref", "HEAD"]), rootBranchBefore);
      assert.equal(git(targetWorktree, ["symbolic-ref", "HEAD"]), targetBranchBefore);
      assert.equal(git(targetWorktree, ["write-tree"]), targetIndexBefore);
      assert.equal(git(targetWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]), targetStatusBefore);
      assert.deepEqual(fs.readFileSync(targetIndexPath), targetIndexBytesBefore);
      assert.equal(fs.readFileSync(userPath, "utf-8"), userBytes);
      assert.equal(commands.some((args) => args[0] === "commit-tree" || args[0] === "update-ref"), false);
      assert.deepEqual(events, []);
    });
  }

  it("fails closed on duplicate target owners before merge object creation", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const commands: string[][] = [];
    const events: MergeBranchEvent[] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: initial, message: "must not land", runId: "run-duplicate-owner" },
      {
        runGit: (origin, args) => {
          commands.push(args);
          const actual = rawGit(origin, args);
          if (args[0] === "worktree" && args[1] === "list") {
            return { ...actual, stdout: `${actual.stdout}\0${actual.stdout}` };
          }
          return actual;
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "operational_error");
    if (result.status !== "operational_error") return;
    assert.match(result.detail, /multiple worktrees.*refs\/heads\/main/i);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), initial);
    assert.equal(commands.some((args) => args[0] === "commit-tree" || args[0] === "update-ref"), false);
    assert.deepEqual(events, []);
  });

  it("fails closed on malformed or unreadable worktree metadata", () => {
    for (const metadataFailure of ["malformed", "unreadable"] as const) {
      const { repo, initial } = createRepo();
      createFeature(repo, `feature-${metadataFailure}`);
      const commands: string[][] = [];

      const result = runPlumbingMerge(
        { origin: repo, branch: `feature-${metadataFailure}`, into: "main", expectTip: initial, message: "must not land" },
        {
          runGit: (origin, args) => {
            commands.push(args);
            if (args[0] === "worktree" && args[1] === "list") {
              if (metadataFailure === "unreadable") {
                return { status: 128, stdout: "", stderr: "fatal: cannot read worktree metadata" };
              }
              return { status: 0, stdout: `worktree ${repo}\0branch refs/heads/main\0\0`, stderr: "" };
            }
            return rawGit(origin, args);
          },
          emitEvent: () => assert.fail("unsafe preflight must not emit an event"),
        },
      );

      assert.equal(result.status, "operational_error");
      if (result.status !== "operational_error") continue;
      assert.match(result.detail, /worktree metadata|worktree list/i);
      assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), initial);
      assert.equal(commands.some((args) => args[0] === "commit-tree" || args[0] === "update-ref"), false);
    }
  });

  it("fails closed when the discovered owner becomes inaccessible or changes ref or tip", () => {
    for (const unsafeOwner of ["inaccessible", "wrong-ref", "wrong-tip"] as const) {
      const { repo, targetWorktree, initial } = createLinkedTargetRepo();
      const commands: Array<{ origin: string; args: string[] }> = [];
      const events: MergeBranchEvent[] = [];

      const result = runPlumbingMerge(
        { origin: repo, branch: "feature", into: "staging", expectTip: initial, message: "must not land" },
        {
          runGit: (origin, args) => {
            commands.push({ origin, args });
            if (origin === targetWorktree && args[0] === "symbolic-ref") {
              if (unsafeOwner === "inaccessible") return { status: 128, stdout: "", stderr: "fatal: inaccessible worktree" };
              if (unsafeOwner === "wrong-ref") return { status: 0, stdout: "refs/heads/other", stderr: "" };
            }
            if (origin === targetWorktree && args[0] === "rev-parse" && args.at(-1) === "HEAD" && unsafeOwner === "wrong-tip") {
              return { status: 0, stdout: "0".repeat(40), stderr: "" };
            }
            return rawGit(origin, args);
          },
          emitEvent: (event) => events.push(event),
        },
      );

      assert.equal(result.status, "operational_error");
      assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), initial);
      assert.equal(git(targetWorktree, ["symbolic-ref", "HEAD"]), "refs/heads/staging");
      assert.equal(commands.some(({ args }) => args[0] === "commit-tree" || args[0] === "update-ref"), false);
      assert.deepEqual(events, []);
    }
  });

  it("STCK rejects touched local changes before moving the target", () => {
    const { repo, initial } = createRepo();
    createTouchedFeature(repo);
    const localBytes = "uncommitted user change\n";
    fs.writeFileSync(path.join(repo, "base.txt"), localBytes, "utf-8");
    const events: MergeBranchEvent[] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: initial, message: "Land feature", runId: "run-local" },
      { emitEvent: (event) => events.push(event) },
    );

    assert.equal(result.status, "operational_error");
    assert.equal(result.exitCode, 1);
    if (result.status !== "operational_error") return;
    assert.match(result.detail, /target worktree.*not clean/i);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), initial);
    assert.equal(fs.readFileSync(path.join(repo, "base.txt"), "utf-8"), localBytes);
    assert.deepEqual(events, []);
  });

  it("STCK reports checkout refresh as not applicable for a bare origin", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const bare = tamanduaTempDir("tamandua-merge-branch-bare-");
    cleanup.push(bare);
    git(bare, ["clone", "--bare", repo, "."]);
    const events: MergeBranchEvent[] = [];

    const result = runPlumbingMerge(
      { origin: bare, branch: "feature", into: "main", expectTip: initial, message: "Land feature", runId: "run-bare" },
      { emitEvent: (event) => events.push(event) },
    );

    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.equal(result.checkoutRefresh, "not-applicable");
    assert.equal(events[0]?.checkoutRefresh, "not-applicable");
  });

  it("rolls back the target ref and checkout when post-CAS refresh fails", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const events: MergeBranchEvent[] = [];
    const branchBefore = git(repo, ["symbolic-ref", "HEAD"]);
    const treeBefore = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const indexBefore = git(repo, ["write-tree"]);
    const baseBefore = fs.readFileSync(path.join(repo, "base.txt"));
    let injectedRefreshFailure = false;
    let mergedCommit = "";
    const commands: string[][] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: initial, message: "Land feature", runId: "run-lock" },
      {
        runGit: (origin, args) => {
          commands.push(args);
          if (args[0] === "read-tree" && !injectedRefreshFailure) {
            injectedRefreshFailure = true;
            const applied = rawGit(origin, args);
            assert.equal(applied.status, 0);
            return { status: 128, stdout: "", stderr: "fatal: Unable to create '.git/index.lock': File exists." };
          }
          const actual = rawGit(origin, args);
          if (args[0] === "commit-tree" && actual.status === 0) mergedCommit = actual.stdout;
          return actual;
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "operational_error");
    assert.equal(result.exitCode, 1);
    if (result.status !== "operational_error") return;
    assert.match(result.detail, /checkout refresh: failed.*index\.lock|checkout refresh: failed.*File exists/i);
    assert.match(result.detail, /ref rollback: restored/i);
    assert.match(result.detail, /checkout restoration: restored/i);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), initial);
    assert.equal(git(repo, ["rev-parse", "HEAD"]), initial);
    assert.equal(git(repo, ["rev-parse", "HEAD^{tree}"]), treeBefore);
    assert.equal(git(repo, ["write-tree"]), indexBefore);
    assert.equal(git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.deepEqual(fs.readFileSync(path.join(repo, "base.txt")), baseBefore);
    assert.equal(fs.existsSync(path.join(repo, "feature.txt")), false);
    assert.equal(git(repo, ["symbolic-ref", "HEAD"]), branchBefore);
    assert.ok(mergedCommit);
    assert.equal(
      commands.some((args) =>
        args[0] === "update-ref" &&
        args[1] === "refs/heads/main" &&
        args[2] === initial &&
        args[3] === mergedCommit
      ),
      true,
    );
    assert.deepEqual(events, []);
  });

  it("preserves a concurrent target winner when refresh rollback loses its CAS", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const events: MergeBranchEvent[] = [];
    let competingCommit = "";
    let mergedCommit = "";

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: initial, message: "Land feature", runId: "run-refresh-race" },
      {
        runGit: (origin, args) => {
          const actual = rawGit(origin, args);
          if (args[0] === "commit-tree" && actual.status === 0) mergedCommit = actual.stdout;
          if (args[0] === "read-tree" && competingCommit === "") {
            assert.equal(actual.status, 0);
            const initialTree = git(repo, ["rev-parse", `${initial}^{tree}`]);
            competingCommit = git(repo, ["commit-tree", initialTree, "-p", initial, "-m", "concurrent winner"]);
            git(repo, ["update-ref", "refs/heads/main", competingCommit, mergedCommit]);
            return { status: 128, stdout: "", stderr: "injected refresh failure after CAS" };
          }
          return actual;
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "operational_error");
    assert.equal(result.exitCode, 1);
    if (result.status !== "operational_error") return;
    assert.match(result.detail, /checkout refresh: failed.*injected refresh failure/i);
    assert.match(result.detail, /ref rollback: failed/i);
    assert.match(result.detail, /checkout restoration: not attempted/i);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), competingCommit);
    assert.notEqual(competingCommit, mergedCommit);
    assert.deepEqual(events, []);
  });

  it("reports injected rollback and checkout-restoration failures without false success", () => {
    for (const failure of ["ref-rollback", "checkout-restoration"] as const) {
      const { repo, initial } = createRepo();
      createFeature(repo, `feature-${failure}`);
      const events: MergeBranchEvent[] = [];
      let mergedCommit = "";
      let refreshFailed = false;

      const result = runPlumbingMerge(
        { origin: repo, branch: `feature-${failure}`, into: "main", expectTip: initial, message: "Land feature", runId: `run-${failure}` },
        {
          runGit: (origin, args) => {
            if (args[0] === "commit-tree") {
              const actual = rawGit(origin, args);
              mergedCommit = actual.stdout;
              return actual;
            }
            if (args[0] === "read-tree" && !refreshFailed) {
              refreshFailed = true;
              const applied = rawGit(origin, args);
              assert.equal(applied.status, 0);
              return { status: 128, stdout: "", stderr: "injected refresh failure" };
            }
            if (failure === "ref-rollback" && args[0] === "update-ref" && args[2] === initial && args[3] === mergedCommit) {
              return { status: 128, stdout: "", stderr: "injected rollback failure" };
            }
            if (failure === "checkout-restoration" && args[0] === "read-tree" && refreshFailed) {
              return { status: 128, stdout: "", stderr: "injected restoration failure" };
            }
            return rawGit(origin, args);
          },
          emitEvent: (event) => events.push(event),
        },
      );

      assert.equal(result.status, "operational_error");
      if (result.status !== "operational_error") continue;
      assert.match(result.detail, /checkout refresh: failed.*injected refresh failure/i);
      if (failure === "ref-rollback") {
        assert.match(result.detail, /ref rollback: failed.*injected rollback failure/i);
        assert.match(result.detail, /checkout restoration: not attempted/i);
        assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), mergedCommit);
      } else {
        assert.match(result.detail, /ref rollback: restored/i);
        assert.match(result.detail, /checkout restoration: failed.*injected restoration failure/i);
        assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), initial);
      }
      assert.deepEqual(events, []);
    }
  });

  it("reports preflight target movement before creating merge objects", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const events: MergeBranchEvent[] = [];
    const commands: string[][] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: "0".repeat(40), message: "must not land", runId: "run-preflight" },
      {
        runGit: (origin, args) => {
          commands.push(args);
          return rawGit(origin, args);
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "target_moved");
    assert.equal(result.exitCode, 2);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), initial);
    assert.deepEqual(commands, [["rev-parse", "--verify", "refs/heads/main"]]);
    assert.equal(events[0]?.event, "merge.target_moved");
    assert.equal(events[0]?.actualTip, initial);
  });

  it("reports a compare-and-swap race without overwriting the winner", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const events: MergeBranchEvent[] = [];
    let competingCommit = "";

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: initial, message: "losing merge", runId: "run-cas" },
      {
        runGit: (origin, args) => {
          if (args[0] === "update-ref" && competingCommit === "") {
            const initialTree = git(repo, ["rev-parse", `${initial}^{tree}`]);
            competingCommit = git(repo, ["commit-tree", initialTree, "-p", initial, "-m", "competing land"]);
            git(repo, ["update-ref", "refs/heads/main", competingCommit, initial]);
          }
          return rawGit(origin, args);
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "target_moved");
    assert.equal(result.exitCode, 2);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), competingCommit);
    assert.equal(events[0]?.event, "merge.target_moved");
    assert.equal(events[0]?.actualTip, competingCommit);
    assert.ok(events[0]?.mergedTree);
    assert.ok(events[0]?.mergedCommit);
  });

  it("preserves Git conflict diagnostics and leaves the target ref unchanged", () => {
    const { repo } = createRepo();
    git(repo, ["switch", "-c", "feature"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "feature version\n", "utf-8");
    git(repo, ["commit", "-am", "feature conflict"]);
    git(repo, ["switch", "main"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "main version\n", "utf-8");
    git(repo, ["commit", "-am", "main conflict"]);
    const mainTip = git(repo, ["rev-parse", "refs/heads/main"]);
    const events: MergeBranchEvent[] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: mainTip, message: "conflicting merge", runId: "run-conflict" },
      { emitEvent: (event) => events.push(event) },
    );

    assert.equal(result.status, "conflicts");
    assert.equal(result.exitCode, 3);
    if (result.status !== "conflicts") return;
    assert.match(result.conflicts, /CONFLICT|Auto-merging/);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), mainTip);
    assert.equal(events[0]?.event, "merge.conflicts");
    assert.equal(events[0]?.expectedTip, mainTip);
    assert.ok(events[0]?.mergedTree);
  });

  it("returns an operational error for a missing feature branch", () => {
    const { repo, initial } = createRepo();
    const result = runPlumbingMerge({ origin: repo, branch: "missing", into: "main", expectTip: initial, message: "cannot merge" });

    assert.equal(result.status, "operational_error");
    assert.equal(result.exitCode, 1);
    if (result.status !== "operational_error") return;
    assert.match(result.detail, /refs\/heads\/missing/);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), initial);
  });

  it("uses only guarded plumbing commands against the origin", () => {
    const commands: string[][] = [];
    const expected = "1".repeat(40);
    const tree = "2".repeat(40);
    const commit = "3".repeat(40);
    const targetTree = "5".repeat(40);
    const scripted = [
      { status: 0, stdout: expected, stderr: "" },
      { status: 0, stdout: "worktree /origin\0bare\0\0", stderr: "" },
      { status: 0, stdout: "4".repeat(40), stderr: "" },
      { status: 0, stdout: targetTree, stderr: "" },
      { status: 1, stdout: "", stderr: "" },
      { status: 0, stdout: tree, stderr: "" },
      { status: 0, stdout: commit, stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ];

    const result = runPlumbingMerge(
      { origin: "/origin", branch: "feature", into: "release", expectTip: expected, message: "plumbing only" },
      {
        runGit: (_origin, args) => {
          commands.push(args);
          return scripted.shift()!;
        },
        emitEvent: () => undefined,
      },
    );

    assert.equal(result.status, "landed");
    assert.deepEqual(commands, [
      ["rev-parse", "--verify", "refs/heads/release"],
      ["worktree", "list", "--porcelain", "-z"],
      ["rev-parse", "--verify", "refs/heads/feature^{commit}"],
      ["rev-parse", "--verify", "refs/heads/release^{tree}"],
      ["merge-base", "--is-ancestor", "4".repeat(40), expected],
      ["merge-tree", "--write-tree", expected, "refs/heads/feature"],
      ["commit-tree", tree, "-p", expected, "-m", "plumbing only"],
      ["update-ref", "refs/heads/release", commit, expected],
    ]);
    assert.equal(commands.some((args) => ["checkout", "switch", "merge", "commit", "reset"].includes(args[0]!)), false);
  });

  it("does not misclassify a non-CAS update-ref failure as target movement", () => {
    const expected = "1".repeat(40);
    const tree = "2".repeat(40);
    const commit = "3".repeat(40);
    const events: MergeBranchEvent[] = [];
    const scripted = [
      { status: 0, stdout: expected, stderr: "" },
      { status: 0, stdout: "worktree /origin\0bare\0\0", stderr: "" },
      { status: 0, stdout: "4".repeat(40), stderr: "" },
      { status: 0, stdout: "5".repeat(40), stderr: "" },
      { status: 1, stdout: "", stderr: "" },
      { status: 0, stdout: tree, stderr: "" },
      { status: 0, stdout: commit, stderr: "" },
      { status: 128, stdout: "", stderr: "permission denied" },
      { status: 0, stdout: expected, stderr: "" },
    ];

    const result = runPlumbingMerge(
      { origin: "/origin", branch: "feature", into: "main", expectTip: expected, message: "cannot update" },
      {
        runGit: () => scripted.shift()!,
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "operational_error");
    assert.equal(result.exitCode, 1);
    assert.deepEqual(events, []);
  });
});
