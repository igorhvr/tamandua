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

function rawGitWithIndex(
  repo: string,
  args: string[],
  indexPath: string,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("git", args, {
    cwd: repo,
    env: {
      HOME: repo,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_INDEX_FILE: indexPath,
    },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status ?? -1,
  };
}

function treeFromIndexCopy(repo: string, indexPath: string): string {
  const scratch = tamanduaTempDir("tamandua-merge-branch-index-copy-");
  cleanup.push(scratch);
  const copiedIndex = path.join(scratch, "index");
  fs.copyFileSync(indexPath, copiedIndex);
  const result = spawnSync("git", ["write-tree"], {
    cwd: repo,
    env: {
      HOME: scratch,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_INDEX_FILE: copiedIndex,
    },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, `git write-tree with copied index failed: ${result.stderr ?? result.stdout}`);
  return (result.stdout ?? "").trim();
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

function captureFileBytes(worktree: string, args: string[]): Array<[string, Buffer]> {
  const files = git(worktree, args)
    .split("\n")
    .filter(Boolean)
    .sort();
  return files.map((file) => [file, fs.readFileSync(path.join(worktree, file))]);
}

function captureCheckoutState(worktree: string): {
  branch: string;
  head: string;
  indexTree: string;
  indexBytes: Buffer;
  status: string;
  trackedBytes: Buffer;
  untrackedBytes?: Buffer;
  trackedFiles: Array<[string, Buffer]>;
  untrackedFiles: Array<[string, Buffer]>;
} {
  const indexPath = git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const untrackedPath = path.join(worktree, "operator-notes.txt");
  return {
    branch: git(worktree, ["symbolic-ref", "HEAD"]),
    head: git(worktree, ["rev-parse", "HEAD"]),
    indexTree: treeFromIndexCopy(worktree, indexPath),
    indexBytes: fs.readFileSync(indexPath),
    status: git(worktree, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"]),
    trackedBytes: fs.readFileSync(path.join(worktree, "base.txt")),
    untrackedBytes: fs.existsSync(untrackedPath) ? fs.readFileSync(untrackedPath) : undefined,
    trackedFiles: captureFileBytes(worktree, ["ls-files", "--cached"]),
    untrackedFiles: captureFileBytes(worktree, ["ls-files", "--others", "--exclude-standard"]),
  };
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
    const checkoutBefore = captureCheckoutState(repo);

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
    assert.equal(result.checkoutRefresh, "already-coherent");
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), targetTip);
    assert.deepEqual(captureCheckoutState(repo), checkoutBefore);
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
        checkoutRefresh: "already-coherent",
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
    const checkoutBefore = captureCheckoutState(repo);

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
    assert.equal(result.checkoutRefresh, "already-coherent");
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), equivalentTarget);
    assert.deepEqual(captureCheckoutState(repo), checkoutBefore);
    assert.equal(commands.some((args) => args[0] === "commit-tree"), false);
    assert.equal(commands.some((args) => args[0] === "update-ref"), false);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "merge.landed");
    assert.equal(events[0]?.noop, true);
    assert.equal(events[0]?.mergedCommit, equivalentTarget);
    assert.equal(events[0]?.mergedTree, targetTree);
    assert.equal(events[0]?.checkoutRefresh, "already-coherent");
  });

  it("reports already-coherent for an exact clean linked owner without mutating either checkout", () => {
    const { repo, initial } = createRepo();
    const featureTip = createFeature(repo);
    git(repo, ["branch", "staging", featureTip]);
    const targetWorktree = tamanduaTempDir("tamandua-merge-branch-noop-linked-");
    cleanup.push(targetWorktree);
    git(repo, ["worktree", "add", targetWorktree, "staging"]);
    fs.writeFileSync(path.join(repo, "operator-notes.txt"), "root operator bytes\n", "utf-8");
    const rootBefore = captureCheckoutState(repo);
    const targetBefore = captureCheckoutState(targetWorktree);
    const events: MergeBranchEvent[] = [];
    const commands: string[][] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "staging", expectTip: featureTip, message: "linked no-op", runId: "run-noop-linked" },
      {
        runGit: (origin, args) => {
          commands.push(args);
          return rawGit(origin, args);
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(initial, git(repo, ["rev-parse", "refs/heads/main"]));
    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.equal(result.noop, true);
    assert.equal(result.checkoutRefresh, "already-coherent");
    assert.deepEqual(captureCheckoutState(repo), rootBefore);
    assert.deepEqual(captureCheckoutState(targetWorktree), targetBefore);
    assert.equal(commands.some((args) => args[0] === "read-tree"), false);
    assert.equal(commands.some((args) => args[0] === "update-ref"), false);
    assert.deepEqual(events.map(({ event, noop, checkoutRefresh }) => ({ event, noop, checkoutRefresh })), [
      { event: "merge.landed", noop: true, checkoutRefresh: "already-coherent" },
    ]);
  });

  it("reports not-applicable for an unowned no-op target without mutating checkout bytes", () => {
    const { repo } = createRepo();
    const featureTip = createFeature(repo);
    git(repo, ["branch", "staging", featureTip]);
    fs.writeFileSync(path.join(repo, "operator-notes.txt"), "operator bytes\n", "utf-8");
    const checkoutBefore = captureCheckoutState(repo);
    const events: MergeBranchEvent[] = [];
    const commands: string[][] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "staging", expectTip: featureTip, message: "unowned no-op", runId: "run-noop-unowned" },
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
    assert.equal(result.noop, true);
    assert.equal(result.checkoutRefresh, "not-applicable");
    assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), featureTip);
    assert.deepEqual(captureCheckoutState(repo), checkoutBefore);
    assert.equal(commands.some((args) => args[0] === "read-tree"), false);
    assert.equal(commands.some((args) => args[0] === "update-ref"), false);
    assert.deepEqual(events.map(({ event, noop, checkoutRefresh }) => ({ event, noop, checkoutRefresh })), [
      { event: "merge.landed", noop: true, checkoutRefresh: "not-applicable" },
    ]);
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

  for (const ownerKind of ["root", "linked"] as const) {
    it(`revalidates the exact ${ownerKind} owner transitional state without treating HEAD-versus-index as dirtiness`, () => {
      const fixture = ownerKind === "root"
        ? { ...createRepo(), targetWorktree: undefined }
        : createLinkedTargetRepo();
      const ownerPath = fixture.targetWorktree ?? fixture.repo;
      const target = ownerKind === "root" ? "main" : "staging";
      if (ownerKind === "root") createTouchedFeature(fixture.repo);
      const commands: Array<{ indexed: boolean; origin: string; args: string[] }> = [];

      const result = runPlumbingMerge(
        {
          origin: fixture.repo,
          branch: "feature",
          into: target,
          expectTip: fixture.initial,
          message: `inspect ${ownerKind} transition`,
        },
        {
          runGit: (origin, args) => {
            commands.push({ indexed: false, origin, args });
            return rawGit(origin, args);
          },
          runGitWithIndex: (origin, args, indexPath) => {
            commands.push({ indexed: true, origin, args });
            return rawGitWithIndex(origin, args, indexPath);
          },
          emitEvent: () => undefined,
        },
      );

      assert.equal(result.status, "landed");
      if (result.status !== "landed") return;
      const targetRef = `refs/heads/${target}`;
      const casIndex = commands.findIndex(({ args }) =>
        args[0] === "update-ref" && args[1] === targetRef && args[3] === fixture.initial
      );
      const refreshIndex = commands.findIndex(({ indexed, args }) =>
        indexed && args[0] === "read-tree" && args.includes(result.mergedTree)
      );
      assert.ok(casIndex >= 0, "target CAS must be observed");
      assert.ok(refreshIndex > casIndex, "forward refresh must follow target CAS");

      const transitionChecks = commands.slice(casIndex + 1, refreshIndex);
      assert.equal(
        transitionChecks.some(({ args }) => args[0] === "worktree" && args[1] === "list"),
        true,
        "ownership must be rediscovered after CAS",
      );
      assert.equal(
        transitionChecks.some(({ origin, args }) => origin === fixture.repo && args[0] === "rev-parse" && args[2] === targetRef),
        true,
        "target tip must be inspected independently",
      );
      assert.equal(
        transitionChecks.some(({ origin, args }) => origin === ownerPath && args[0] === "symbolic-ref"),
        true,
        "the owner's symbolic ref must be inspected",
      );
      assert.equal(
        transitionChecks.some(({ indexed, origin, args }) => indexed && origin === ownerPath && args[0] === "write-tree"),
        true,
        "the worktree-specific index tree must be inspected",
      );
      assert.equal(
        transitionChecks.some(({ indexed, origin, args }) => indexed && origin === ownerPath && args[0] === "diff-files"),
        true,
        "tracked filesystem drift must be inspected independently of HEAD",
      );
      assert.equal(
        transitionChecks.some(({ indexed, origin, args }) => indexed && origin === ownerPath && args[0] === "ls-files" && args.includes("--others")),
        true,
        "ordinary untracked paths must be inspected independently",
      );
      assert.equal(
        transitionChecks.some(({ args }) => args.includes("status")),
        false,
        "the expected HEAD-versus-index transition must not use broad status dirtiness",
      );
      assert.equal(
        transitionChecks.some(({ args }) => args[0] === "rev-parse" && args.includes(`${fixture.initial}^{tree}`)),
        false,
        "forward mutation must use the exact old tree that was already attested under the lock",
      );
      assert.equal(git(ownerPath, ["symbolic-ref", "HEAD"]), targetRef);
      assert.equal(git(ownerPath, ["rev-parse", "HEAD"]), result.mergedCommit);
      assert.equal(git(ownerPath, ["write-tree"]), result.mergedTree);
      assert.equal(git(ownerPath, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    });
  }

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

  for (const ownerKind of ["root", "linked"] as const) {
    it(`fails before object creation when the ${ownerKind} target owner's real index lock is held`, () => {
      const fixture: { repo: string; initial: string; targetWorktree?: string } = ownerKind === "root"
        ? { ...createRepo(), targetWorktree: undefined }
        : createLinkedTargetRepo();
      const repo = fixture.repo;
      const ownerPath = fixture.targetWorktree ?? repo;
      const initial = fixture.initial;
      if (ownerKind === "root") createFeature(repo);

      const target = ownerKind === "root" ? "main" : "staging";
      const indexPath = git(ownerPath, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
      const lockPath = `${indexPath}.lock`;
      const lockBytes = Buffer.from(`operator-owned ${ownerKind} index lock\n`);
      const stateBefore = {
        target: git(repo, ["rev-parse", `refs/heads/${target}`]),
        branch: git(ownerPath, ["symbolic-ref", "HEAD"]),
        head: git(ownerPath, ["rev-parse", "HEAD"]),
        indexTree: git(ownerPath, ["write-tree"]),
        indexBytes: fs.readFileSync(indexPath),
        status: git(ownerPath, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"]),
        trackedBytes: fs.readFileSync(path.join(ownerPath, "base.txt")),
      };
      fs.writeFileSync(lockPath, lockBytes, { mode: 0o640 });
      const lockStatBefore = fs.statSync(lockPath);
      const commands: string[][] = [];
      const events: MergeBranchEvent[] = [];

      const result = runPlumbingMerge(
        { origin: repo, branch: "feature", into: target, expectTip: initial, message: "must not land", runId: `run-index-lock-${ownerKind}` },
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
      assert.match(result.detail, /index lock.*already exists|cannot acquire.*index lock/i);
      assert.equal(commands.some((args) => args[0] === "commit-tree" || args[0] === "update-ref"), false);
      assert.equal(git(repo, ["rev-parse", `refs/heads/${target}`]), stateBefore.target);
      assert.equal(git(ownerPath, ["symbolic-ref", "HEAD"]), stateBefore.branch);
      assert.equal(git(ownerPath, ["rev-parse", "HEAD"]), stateBefore.head);
      assert.deepEqual(fs.readFileSync(indexPath), stateBefore.indexBytes);
      assert.equal(treeFromIndexCopy(ownerPath, indexPath), stateBefore.indexTree);
      assert.equal(git(ownerPath, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"]), stateBefore.status);
      assert.deepEqual(fs.readFileSync(path.join(ownerPath, "base.txt")), stateBefore.trackedBytes);
      assert.deepEqual(fs.readFileSync(lockPath), lockBytes);
      const lockStatAfter = fs.statSync(lockPath);
      assert.equal(lockStatAfter.ino, lockStatBefore.ino);
      assert.equal(lockStatAfter.mode, lockStatBefore.mode);
      assert.equal(lockStatAfter.mtimeMs, lockStatBefore.mtimeMs);
      assert.deepEqual(events, []);
    });
  }

  it("holds the owner index lock continuously through target movement and forward checkout mutation", () => {
    const { repo, targetWorktree, initial } = createLinkedTargetRepo();
    const indexPath = git(targetWorktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const lockPath = `${indexPath}.lock`;
    const indexModeBefore = fs.statSync(indexPath).mode & 0o777;
    let sawLockAtCommitTree = false;
    let sawLockAtTargetCas = false;
    let sawLockAtForwardMutation = false;
    let lockModeAtCommitTree: number | undefined;

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "staging", expectTip: initial, message: "land under lock" },
      {
        runGit: (origin, args) => {
          if (args[0] === "commit-tree") {
            sawLockAtCommitTree = fs.existsSync(lockPath);
            lockModeAtCommitTree = fs.statSync(lockPath).mode & 0o777;
          }
          if (args[0] === "update-ref" && args[1] === "refs/heads/staging") sawLockAtTargetCas = fs.existsSync(lockPath);
          return rawGit(origin, args);
        },
        runGitWithIndex: (origin, args, temporaryIndexPath) => {
          if (args[0] === "read-tree") sawLockAtForwardMutation = fs.existsSync(lockPath);
          return rawGitWithIndex(origin, args, temporaryIndexPath);
        },
        emitEvent: () => undefined,
      },
    );

    assert.equal(result.status, "landed");
    assert.equal(sawLockAtCommitTree, true);
    assert.equal(sawLockAtTargetCas, true);
    assert.equal(sawLockAtForwardMutation, true);
    assert.equal(lockModeAtCommitTree, indexModeBefore);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.statSync(indexPath).mode & 0o777, indexModeBefore);
  });

  it("atomically publishes a version-4 owner index without losing mode, extensions, or unchanged entry flags", () => {
    const { repo, targetWorktree, initial } = createLinkedTargetRepo();
    git(targetWorktree, ["update-index", "--index-version", "4"]);
    git(targetWorktree, ["update-index", "--skip-worktree", "base.txt"]);
    git(targetWorktree, ["update-index", "--split-index"]);
    const indexPath = git(targetWorktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const sharedIndexBefore = git(targetWorktree, ["rev-parse", "--shared-index-path"]);
    const indexModeBefore = fs.statSync(indexPath).mode & 0o777;
    const indexBytesBefore = fs.readFileSync(indexPath);
    assert.equal(indexBytesBefore.readUInt32BE(4), 4);
    assert.notEqual(sharedIndexBefore, "");
    assert.match(git(targetWorktree, ["ls-files", "-v", "base.txt"]), /^S /);

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "staging", expectTip: initial, message: "preserve index format" },
      { emitEvent: () => undefined },
    );

    assert.equal(result.status, "landed");
    const indexBytesAfter = fs.readFileSync(indexPath);
    assert.equal(indexBytesAfter.readUInt32BE(4), 4);
    assert.equal(fs.statSync(indexPath).mode & 0o777, indexModeBefore);
    assert.notEqual(git(targetWorktree, ["rev-parse", "--shared-index-path"]), "");
    assert.match(git(targetWorktree, ["ls-files", "-v", "base.txt"]), /^S /);
    assert.equal(git(targetWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  });

  it("blocks a genuine competing branch switch at the final forward-mutation boundary", () => {
    const { repo, targetWorktree, initial } = createLinkedTargetRepo();
    git(repo, ["branch", "other", initial]);
    const rootUntrackedPath = path.join(repo, "operator-notes.txt");
    fs.writeFileSync(rootUntrackedPath, "root operator bytes\n");
    const rootBefore = captureCheckoutState(repo);
    const ownerBefore = captureCheckoutState(targetWorktree);
    const otherTipBefore = git(repo, ["rev-parse", "refs/heads/other"]);
    const otherTreeBefore = git(repo, ["rev-parse", "refs/heads/other^{tree}"]);
    const indexPath = git(targetWorktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    let competitorStatus: number | undefined;
    let competitorDiagnostic = "";
    let finalTransitionCheckCompleted = false;
    const landedChecksUnderLock = new Set<string>();
    let afterForwardMutation = false;

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "staging", expectTip: initial, message: "serialize boundary" },
      {
        runGit: (origin, args) => {
          const actual = rawGit(origin, args);
          if (afterForwardMutation && ["worktree", "rev-parse", "symbolic-ref"].includes(args[0] ?? "")) {
            assert.equal(fs.existsSync(`${indexPath}.lock`), true);
            landedChecksUnderLock.add(args[0] ?? "");
          }
          return actual;
        },
        runGitWithIndex: (origin, args, temporaryIndexPath) => {
          if (!afterForwardMutation && args[0] === "ls-files" && args.includes("--others")) {
            finalTransitionCheckCompleted = true;
          }
          if (args[0] === "read-tree" && competitorStatus === undefined) {
            assert.equal(finalTransitionCheckCompleted, true);
            assert.equal(fs.existsSync(`${indexPath}.lock`), true);
            const competitor = rawGit(targetWorktree, ["switch", "other"]);
            competitorStatus = competitor.status;
            competitorDiagnostic = competitor.stderr;
          }
          const actual = rawGitWithIndex(origin, args, temporaryIndexPath);
          if (args[0] === "read-tree" && actual.status === 0) afterForwardMutation = true;
          if (afterForwardMutation && ["write-tree", "diff-files", "ls-files"].includes(args[0] ?? "")) {
            assert.equal(fs.existsSync(`${indexPath}.lock`), true);
            landedChecksUnderLock.add(args[0] ?? "");
          }
          return actual;
        },
        emitEvent: () => undefined,
      },
    );

    assert.equal(result.status, "landed");
    assert.notEqual(competitorStatus, 0);
    assert.match(competitorDiagnostic, /index\.lock|another git process/i);
    assert.deepEqual(
      [...landedChecksUnderLock].sort(),
      ["diff-files", "ls-files", "rev-parse", "symbolic-ref", "worktree", "write-tree"],
    );
    assert.equal(git(targetWorktree, ["symbolic-ref", "HEAD"]), "refs/heads/staging");
    assert.equal(git(targetWorktree, ["rev-parse", "HEAD"]), git(repo, ["rev-parse", "refs/heads/staging"]));
    assert.equal(git(targetWorktree, ["write-tree"]), git(repo, ["rev-parse", "refs/heads/staging^{tree}"]));
    assert.equal(git(targetWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal(git(repo, ["rev-parse", "refs/heads/other"]), otherTipBefore);
    assert.equal(git(repo, ["rev-parse", "refs/heads/other^{tree}"]), otherTreeBefore);
    assert.deepEqual(captureCheckoutState(repo), rootBefore);
    assert.equal(ownerBefore.branch, "refs/heads/staging");
    assert.equal(ownerBefore.head, initial);
    assert.deepEqual(fs.readFileSync(rootUntrackedPath), rootBefore.untrackedBytes);
    assert.equal(fs.existsSync(`${indexPath}.lock`), false);
  });

  it("revalidates the exact owner after acquiring its index lock and before commit or ref creation", () => {
    const { repo, targetWorktree, initial } = createLinkedTargetRepo();
    git(repo, ["branch", "other", initial]);
    const indexPath = git(targetWorktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const indexBytesBefore = fs.readFileSync(indexPath);
    const baseBytesBefore = fs.readFileSync(path.join(targetWorktree, "base.txt"));
    const commands: string[][] = [];
    const events: MergeBranchEvent[] = [];
    let switchedAfterPreflight = false;

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "staging", expectTip: initial, message: "must not land stale owner" },
      {
        runGit: (origin, args) => {
          commands.push(args);
          const actual = rawGit(origin, args);
          if (!switchedAfterPreflight && args[0] === "merge-tree") {
            assert.equal(actual.status, 0);
            switchedAfterPreflight = true;
            git(targetWorktree, ["switch", "other"]);
          }
          return actual;
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(switchedAfterPreflight, true);
    assert.equal(result.status, "operational_error");
    if (result.status !== "operational_error") return;
    assert.match(result.detail, /owner|worktree|refs\/heads\/staging/i);
    assert.equal(commands.some((args) => args[0] === "commit-tree" || args[0] === "update-ref"), false);
    assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), initial);
    assert.equal(git(targetWorktree, ["symbolic-ref", "HEAD"]), "refs/heads/other");
    assert.equal(git(targetWorktree, ["rev-parse", "HEAD"]), initial);
    assert.deepEqual(fs.readFileSync(indexPath), indexBytesBefore);
    assert.deepEqual(fs.readFileSync(path.join(targetWorktree, "base.txt")), baseBytesBefore);
    assert.equal(git(targetWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal(fs.existsSync(`${indexPath}.lock`), false);
    assert.deepEqual(events, []);
  });

  it("fails before target CAS when the locked owner drifts after merge commit creation", () => {
    const { repo, targetWorktree, initial } = createLinkedTargetRepo();
    git(repo, ["branch", "other", initial]);
    fs.writeFileSync(path.join(repo, "operator-notes.txt"), "root operator bytes\n", "utf-8");
    const commands: Array<{ indexed: boolean; args: string[] }> = [];
    const events: MergeBranchEvent[] = [];
    let rootAfterDrift: ReturnType<typeof captureCheckoutState> | undefined;
    let ownerAfterDrift: ReturnType<typeof captureCheckoutState> | undefined;

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "staging", expectTip: initial, message: "reject pre-CAS owner drift" },
      {
        runGit: (origin, args) => {
          commands.push({ indexed: false, args });
          const actual = rawGit(origin, args);
          if (args[0] === "commit-tree" && actual.status === 0 && !ownerAfterDrift) {
            git(targetWorktree, ["symbolic-ref", "HEAD", "refs/heads/other"]);
            rootAfterDrift = captureCheckoutState(repo);
            ownerAfterDrift = captureCheckoutState(targetWorktree);
          }
          return actual;
        },
        runGitWithIndex: (origin, args, indexPath) => {
          commands.push({ indexed: true, args });
          return rawGitWithIndex(origin, args, indexPath);
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.ok(rootAfterDrift);
    assert.ok(ownerAfterDrift);
    assert.equal(result.status, "operational_error");
    if (result.status !== "operational_error") return;
    assert.match(result.detail, /pre-CAS state drifted.*owner|owner.*pre-CAS state drifted/i);
    assert.equal(
      commands.some(({ args }) => args[0] === "update-ref" && args[1] === "refs/heads/staging"),
      false,
      "target CAS must not run after locked owner drift",
    );
    assert.equal(commands.some(({ indexed, args }) => indexed && args[0] === "read-tree"), false);
    assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), initial);
    assert.deepEqual(captureCheckoutState(repo), rootAfterDrift);
    assert.deepEqual(captureCheckoutState(targetWorktree), ownerAfterDrift);
    assert.deepEqual(events, []);
  });

  it("rolls back without checkout mutation when ownership changes after target CAS", () => {
    const { repo, targetWorktree, initial } = createLinkedTargetRepo();
    git(repo, ["branch", "other", initial]);
    fs.writeFileSync(path.join(repo, "operator-notes.txt"), "root operator bytes\n", "utf-8");
    const commands: Array<{ indexed: boolean; args: string[] }> = [];
    const events: MergeBranchEvent[] = [];
    let injected = false;
    let rootAfterDrift: ReturnType<typeof captureCheckoutState> | undefined;
    let ownerAfterDrift: ReturnType<typeof captureCheckoutState> | undefined;

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "staging", expectTip: initial, message: "rollback post-CAS owner drift" },
      {
        runGit: (origin, args) => {
          commands.push({ indexed: false, args });
          const actual = rawGit(origin, args);
          if (!injected && args[0] === "update-ref" && args[1] === "refs/heads/staging" && args[3] === initial) {
            assert.equal(actual.status, 0);
            injected = true;
            git(targetWorktree, ["symbolic-ref", "HEAD", "refs/heads/other"]);
            rootAfterDrift = captureCheckoutState(repo);
            ownerAfterDrift = captureCheckoutState(targetWorktree);
          }
          return actual;
        },
        runGitWithIndex: (origin, args, indexPath) => {
          commands.push({ indexed: true, args });
          return rawGitWithIndex(origin, args, indexPath);
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(injected, true);
    assert.ok(rootAfterDrift);
    assert.ok(ownerAfterDrift);
    assert.equal(result.status, "operational_error");
    if (result.status !== "operational_error") return;
    assert.match(result.detail, /post-CAS\/pre-refresh state drifted/i);
    assert.match(result.detail, /ref rollback: restored/i);
    assert.match(result.detail, /checkout restoration: not attempted because state drifted/i);
    assert.equal(commands.some(({ indexed, args }) => indexed && args[0] === "read-tree"), false);
    assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), initial);
    assert.deepEqual(captureCheckoutState(repo), rootAfterDrift);
    assert.deepEqual(captureCheckoutState(targetWorktree), ownerAfterDrift);
    assert.deepEqual(events, []);
  });

  it("removes only its own owner index lock when a dependency throws", () => {
    const { repo, targetWorktree, initial } = createLinkedTargetRepo();
    const indexPath = git(targetWorktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const lockPath = `${indexPath}.lock`;
    const indexBytesBefore = fs.readFileSync(indexPath);
    const indexModeBefore = fs.statSync(indexPath).mode & 0o777;
    let sawOwnedLock = false;

    assert.throws(
      () => runPlumbingMerge(
        { origin: repo, branch: "feature", into: "staging", expectTip: initial, message: "throw under lock" },
        {
          runGit: (origin, args) => {
            if (args[0] === "commit-tree") {
              sawOwnedLock = fs.existsSync(lockPath);
              throw new Error("injected dependency exception");
            }
            return rawGit(origin, args);
          },
          emitEvent: () => undefined,
        },
      ),
      /injected dependency exception/,
    );
    assert.equal(sawOwnedLock, true);
    assert.equal(fs.existsSync(lockPath), false);
    assert.deepEqual(fs.readFileSync(indexPath), indexBytesBefore);
    assert.equal(fs.statSync(indexPath).mode & 0o777, indexModeBefore);
  });

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
          const actual = rawGit(origin, args);
          if (args[0] === "commit-tree" && actual.status === 0) mergedCommit = actual.stdout;
          return actual;
        },
        runGitWithIndex: (origin, args, temporaryIndexPath) => {
          commands.push(args);
          if (args[0] === "read-tree" && args[1] === "-m" && !injectedRefreshFailure) {
            injectedRefreshFailure = true;
            return { status: 128, stdout: "", stderr: "fatal: injected serialized read-tree failure" };
          }
          return rawGitWithIndex(origin, args, temporaryIndexPath);
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "operational_error");
    assert.equal(result.exitCode, 1);
    if (result.status !== "operational_error") return;
    assert.match(result.detail, /checkout refresh: failed.*injected serialized read-tree failure/i);
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

  it("does not mutate an already-restored checkout after guarded rollback", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const stateBefore = captureCheckoutState(repo);
    const indexedCommands: string[][] = [];
    let rejectedForwardRefresh = false;

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: initial, message: "fail before refresh" },
      {
        runGitWithIndex: (origin, args, temporaryIndexPath) => {
          indexedCommands.push(args);
          if (args[0] === "read-tree" && args[1] === "-m" && !rejectedForwardRefresh) {
            rejectedForwardRefresh = true;
            return { status: 128, stdout: "", stderr: "injected failure before checkout mutation" };
          }
          return rawGitWithIndex(origin, args, temporaryIndexPath);
        },
        emitEvent: () => assert.fail("failed refresh must not emit a landed event"),
      },
    );

    assert.equal(result.status, "operational_error");
    if (result.status !== "operational_error") return;
    assert.match(result.detail, /ref rollback: restored/i);
    assert.match(result.detail, /checkout restoration: restored \(checkout already matched the old tree\)/i);
    assert.equal(
      indexedCommands.filter((args) => args[0] === "read-tree").length,
      1,
      "an already-restored checkout must not receive a reset or reverse read-tree",
    );
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), initial);
    assert.deepEqual(captureCheckoutState(repo), stateBefore);
  });

  for (const drift of ["tracked edit", "ordinary untracked file"] as const) {
    it(`preserves a ${drift} introduced after rollback and skips checkout restoration`, () => {
      const { repo, initial } = createRepo();
      createFeature(repo);
      const events: MergeBranchEvent[] = [];
      const indexedCommands: string[][] = [];
      const operatorPath = drift === "tracked edit"
        ? path.join(repo, "base.txt")
        : path.join(repo, "operator-notes.txt");
      const operatorBytes = Buffer.from(`${drift} after rollback\n`);
      let mergedCommit = "";
      let forwardRefreshCompleted = false;
      let injectedAttestationFailure = false;
      let injectedPostRollbackDrift = false;

      const result = runPlumbingMerge(
        { origin: repo, branch: "feature", into: "main", expectTip: initial, message: `preserve ${drift}` },
        {
          runGit: (origin, args) => {
            if (args[0] === "commit-tree") {
              const actual = rawGit(origin, args);
              mergedCommit = actual.stdout;
              return actual;
            }
            const actual = rawGit(origin, args);
            if (
              args[0] === "update-ref" &&
              args[1] === "refs/heads/main" &&
              args[2] === initial &&
              args[3] === mergedCommit &&
              actual.status === 0
            ) {
              fs.writeFileSync(operatorPath, operatorBytes);
              injectedPostRollbackDrift = true;
            }
            return actual;
          },
          runGitWithIndex: (origin, args, temporaryIndexPath) => {
            indexedCommands.push(args);
            const actual = rawGitWithIndex(origin, args, temporaryIndexPath);
            if (args[0] === "read-tree" && args[1] === "-m" && actual.status === 0) {
              forwardRefreshCompleted = true;
            }
            if (forwardRefreshCompleted && !injectedAttestationFailure && args[0] === "ls-files") {
              injectedAttestationFailure = true;
              return { status: 128, stdout: "", stderr: "injected landed attestation failure" };
            }
            return actual;
          },
          emitEvent: (event) => events.push(event),
        },
      );

      assert.equal(injectedPostRollbackDrift, true);
      assert.equal(result.status, "operational_error");
      if (result.status !== "operational_error") return;
      assert.match(result.detail, /landed-state attestation failed/i);
      assert.match(result.detail, /ref rollback: restored/i);
      assert.match(result.detail, /checkout restoration: not attempted because state drifted/i);
      assert.match(
        result.detail,
        drift === "tracked edit" ? /tracked filesystem difference is M base\.txt/i : /ordinary untracked paths is operator-notes\.txt/i,
      );
      assert.equal(
        indexedCommands.filter((args) => args[0] === "read-tree" && args[1] === "-m").length,
        1,
        "only the forward transition may run when recovery state drifted",
      );
      assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), initial);
      assert.deepEqual(fs.readFileSync(operatorPath), operatorBytes);
      assert.deepEqual(events, []);
    });
  }

  it("restores only the precise merged-tree state after landed attestation fails", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const stateBefore = captureCheckoutState(repo);
    const events: MergeBranchEvent[] = [];
    const indexedCommands: string[][] = [];
    let forwardRefreshCompleted = false;
    let injectedAttestationFailure = false;

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: initial, message: "restore precise state" },
      {
        runGitWithIndex: (origin, args, temporaryIndexPath) => {
          indexedCommands.push(args);
          const actual = rawGitWithIndex(origin, args, temporaryIndexPath);
          if (args[0] === "read-tree" && args[1] === "-m" && actual.status === 0) {
            forwardRefreshCompleted = true;
          }
          if (forwardRefreshCompleted && !injectedAttestationFailure && args[0] === "ls-files") {
            injectedAttestationFailure = true;
            return { status: 128, stdout: "", stderr: "injected landed attestation failure" };
          }
          return actual;
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "operational_error");
    if (result.status !== "operational_error") return;
    assert.match(result.detail, /landed-state attestation failed/i);
    assert.match(result.detail, /ref rollback: restored/i);
    assert.match(result.detail, /checkout restoration: restored and verified/i);
    assert.equal(
      indexedCommands.filter((args) => args[0] === "read-tree" && args[1] === "-m").length,
      2,
      "the precise merged-tree state must receive one forward and one reverse transition",
    );
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), initial);
    assert.deepEqual(captureCheckoutState(repo), stateBefore);
    assert.deepEqual(events, []);
  });

  it("blocks a genuine competing branch switch at the final reverse-restoration boundary", () => {
    const { repo, targetWorktree, initial } = createLinkedTargetRepo();
    git(repo, ["branch", "other", initial]);
    const rootUntrackedPath = path.join(repo, "operator-notes.txt");
    const rootUntrackedBytes = Buffer.from("unrelated operator bytes\n");
    fs.writeFileSync(rootUntrackedPath, rootUntrackedBytes);
    const rootBefore = captureCheckoutState(repo);
    const ownerBefore = captureCheckoutState(targetWorktree);
    const otherTipBefore = git(repo, ["rev-parse", "refs/heads/other"]);
    const ownerIndexPath = git(targetWorktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const events: MergeBranchEvent[] = [];
    let forwardRefreshCompleted = false;
    let landedAttestationFailed = false;
    let rollbackCompleted = false;
    let finalRestoreValidationCompleted = false;
    let recoveryValidationCount = 0;
    let reverseMutationCompleted = false;
    let competitorStatus: number | undefined;
    let competitorDiagnostic = "";
    const restoredChecksUnderLock = new Set<string>();

    const result = runPlumbingMerge(
      {
        origin: repo,
        branch: "feature",
        into: "staging",
        expectTip: initial,
        message: "serialize reverse boundary",
      },
      {
        runGit: (origin, args) => {
          const actual = rawGit(origin, args);
          if (
            args[0] === "update-ref" &&
            args[1] === "refs/heads/staging" &&
            args[2] === initial &&
            args[3] !== initial &&
            actual.status === 0
          ) {
            rollbackCompleted = true;
          }
          return actual;
        },
        runGitWithIndex: (origin, args, temporaryIndexPath) => {
          if (
            forwardRefreshCompleted &&
            !landedAttestationFailed &&
            args[0] === "ls-files" &&
            args.includes("--others")
          ) {
            landedAttestationFailed = true;
            return { status: 128, stdout: "", stderr: "injected landed attestation failure" };
          }

          const isReverseMutation =
            args[0] === "read-tree" &&
            args[1] === "-m" &&
            forwardRefreshCompleted;
          if (isReverseMutation) {
            assert.equal(rollbackCompleted, true, "guarded rollback must win before reverse mutation");
            assert.equal(finalRestoreValidationCompleted, true, "exact reversible state must be validated last");
            assert.equal(recoveryValidationCount, 2, "safely reversible state must be revalidated immediately before mutation");
            assert.equal(fs.existsSync(`${ownerIndexPath}.lock`), true);
            const competitor = rawGit(targetWorktree, ["switch", "other"]);
            competitorStatus = competitor.status;
            competitorDiagnostic = competitor.stderr;
          }

          const actual = rawGitWithIndex(origin, args, temporaryIndexPath);
          if (args[0] === "read-tree" && args[1] === "-m" && actual.status === 0) {
            if (forwardRefreshCompleted) reverseMutationCompleted = true;
            else forwardRefreshCompleted = true;
          } else if (
            rollbackCompleted &&
            !reverseMutationCompleted &&
            args[0] === "ls-files" &&
            args.includes("--others") &&
            actual.status === 0
          ) {
            finalRestoreValidationCompleted = true;
            recoveryValidationCount += 1;
          } else if (
            reverseMutationCompleted &&
            ["write-tree", "diff-files", "ls-files"].includes(args[0] ?? "")
          ) {
            assert.equal(fs.existsSync(`${ownerIndexPath}.lock`), true);
            restoredChecksUnderLock.add(args[0] ?? "");
          }
          return actual;
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "operational_error");
    if (result.status !== "operational_error") return;
    assert.match(result.detail, /landed-state attestation failed/i);
    assert.match(result.detail, /ref rollback: restored/i);
    assert.match(result.detail, /checkout restoration: restored and verified/i);
    assert.equal(competitorStatus, 128);
    assert.match(competitorDiagnostic, /index\.lock.*exists/i);
    assert.deepEqual(restoredChecksUnderLock, new Set(["write-tree", "diff-files", "ls-files"]));
    assert.equal(fs.existsSync(`${ownerIndexPath}.lock`), false);
    const ownerAfter = captureCheckoutState(targetWorktree);
    assert.equal(ownerAfter.branch, ownerBefore.branch);
    assert.equal(ownerAfter.head, ownerBefore.head);
    assert.equal(ownerAfter.indexTree, ownerBefore.indexTree);
    assert.equal(ownerAfter.status, ownerBefore.status);
    assert.deepEqual(ownerAfter.trackedBytes, ownerBefore.trackedBytes);
    assert.deepEqual(ownerAfter.untrackedBytes, ownerBefore.untrackedBytes);
    assert.deepEqual(captureCheckoutState(repo), rootBefore);
    assert.equal(git(repo, ["rev-parse", "refs/heads/other"]), otherTipBefore);
    assert.deepEqual(fs.readFileSync(rootUntrackedPath), rootUntrackedBytes);
    assert.deepEqual(events, []);
  });

  it("preserves a concurrent target winner when refresh rollback loses its CAS", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const events: MergeBranchEvent[] = [];
    const checkoutBefore = captureCheckoutState(repo);
    const operatorPath = path.join(repo, "operator-notes.txt");
    const operatorBytes = Buffer.from("winner-owned operator bytes\n");
    let competingCommit = "";
    let mergedCommit = "";
    const indexedCommands: string[][] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: initial, message: "Land feature", runId: "run-refresh-race" },
      {
        runGit: (origin, args) => {
          const actual = rawGit(origin, args);
          if (args[0] === "commit-tree" && actual.status === 0) mergedCommit = actual.stdout;
          return actual;
        },
        runGitWithIndex: (origin, args, temporaryIndexPath) => {
          indexedCommands.push(args);
          if (args[0] === "read-tree" && args[1] === "-m" && competingCommit === "") {
            const initialTree = git(repo, ["rev-parse", `${initial}^{tree}`]);
            competingCommit = git(repo, ["commit-tree", initialTree, "-p", initial, "-m", "concurrent winner"]);
            git(repo, ["update-ref", "refs/heads/main", competingCommit, mergedCommit]);
            fs.writeFileSync(operatorPath, operatorBytes);
            return { status: 128, stdout: "", stderr: "injected refresh failure after CAS" };
          }
          return rawGitWithIndex(origin, args, temporaryIndexPath);
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
    assert.equal(git(repo, ["symbolic-ref", "HEAD"]), checkoutBefore.branch);
    assert.equal(git(repo, ["rev-parse", "HEAD"]), competingCommit);
    assert.equal(git(repo, ["rev-parse", "HEAD^{tree}"]), checkoutBefore.indexTree);
    assert.equal(git(repo, ["write-tree"]), checkoutBefore.indexTree);
    assert.deepEqual(
      fs.readFileSync(git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"])),
      checkoutBefore.indexBytes,
    );
    assert.equal(git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]), "?? operator-notes.txt");
    assert.deepEqual(fs.readFileSync(path.join(repo, "base.txt")), checkoutBefore.trackedBytes);
    assert.equal(fs.existsSync(path.join(repo, "feature.txt")), false);
    assert.deepEqual(fs.readFileSync(operatorPath), operatorBytes);
    assert.equal(indexedCommands.filter((args) => args[0] === "read-tree" && args[1] === "-m").length, 1);
    assert.deepEqual(events, []);
  });

  it("does not reverse-refresh a concurrent winner that arrives after guarded rollback", () => {
    const { repo, targetWorktree, initial } = createLinkedTargetRepo();
    const rootOperatorPath = path.join(repo, "operator-notes.txt");
    fs.writeFileSync(rootOperatorPath, "root operator bytes\n");
    const rootBefore = captureCheckoutState(repo);
    const events: MergeBranchEvent[] = [];
    const indexedCommands: string[][] = [];
    let mergedCommit = "";
    let mergedTree = "";
    let forwardRefreshCompleted = false;
    let injectedAttestationFailure = false;
    let winnerCommit = "";
    let winnerState: ReturnType<typeof captureCheckoutState> | undefined;

    const result = runPlumbingMerge(
      {
        origin: repo,
        branch: "feature",
        into: "staging",
        expectTip: initial,
        message: "preserve winner after rollback",
      },
      {
        runGit: (origin, args) => {
          const actual = rawGit(origin, args);
          if (args[0] === "commit-tree" && actual.status === 0) {
            mergedCommit = actual.stdout;
            mergedTree = git(repo, ["rev-parse", `${mergedCommit}^{tree}`]);
          }
          if (
            args[0] === "update-ref" &&
            args[1] === "refs/heads/staging" &&
            args[2] === initial &&
            args[3] === mergedCommit &&
            actual.status === 0
          ) {
            winnerCommit = git(repo, ["commit-tree", mergedTree, "-p", initial, "-m", "post-rollback winner"]);
            git(repo, ["update-ref", "refs/heads/staging", winnerCommit, initial]);
            winnerState = captureCheckoutState(targetWorktree);
          }
          return actual;
        },
        runGitWithIndex: (origin, args, temporaryIndexPath) => {
          indexedCommands.push(args);
          const actual = rawGitWithIndex(origin, args, temporaryIndexPath);
          if (args[0] === "read-tree" && args[1] === "-m" && actual.status === 0) {
            forwardRefreshCompleted = true;
          } else if (
            forwardRefreshCompleted &&
            !injectedAttestationFailure &&
            args[0] === "ls-files" &&
            args.includes("--others")
          ) {
            injectedAttestationFailure = true;
            return { status: 128, stdout: "", stderr: "injected landed attestation failure" };
          }
          return actual;
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.ok(winnerCommit, "the concurrent winner must arrive after guarded rollback");
    assert.ok(winnerState, "the winner checkout state must be captured at the race boundary");
    assert.equal(result.status, "operational_error");
    if (result.status !== "operational_error") return;
    assert.match(result.detail, /landed-state attestation failed/i);
    assert.match(result.detail, /ref rollback: restored/i);
    assert.match(result.detail, /checkout restoration: not attempted because state drifted/i);
    assert.equal(
      indexedCommands.filter((args) => args[0] === "read-tree" && args[1] === "-m").length,
      1,
      "a concurrent post-rollback winner must never receive reverse read-tree",
    );
    assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), winnerCommit);
    assert.deepEqual(captureCheckoutState(targetWorktree), winnerState);
    assert.deepEqual(captureCheckoutState(repo), rootBefore);
    assert.deepEqual(fs.readFileSync(rootOperatorPath), rootBefore.untrackedBytes);
    assert.deepEqual(events, []);
  });

  it("bounds every post-CAS recovery diagnostic before composing all outcome labels", () => {
    for (const failure of ["ref-rollback", "checkout-restoration"] as const) {
      const { repo, initial } = createRepo();
      createFeature(repo, `feature-long-${failure}`);
      const events: MergeBranchEvent[] = [];
      let mergedCommit = "";
      let forwardRefreshCompleted = false;
      let injectedAttestationFailure = false;
      const refreshError = `refresh-start-${"r".repeat(5000)}-refresh-tail`;
      const rollbackError = `rollback-start-${"b".repeat(5000)}-rollback-tail`;
      const restorationError = `restoration-start-${"s".repeat(5000)}-restoration-tail`;

      const result = runPlumbingMerge(
        {
          origin: repo,
          branch: `feature-long-${failure}`,
          into: "main",
          expectTip: initial,
          message: `long ${failure} diagnostics`,
        },
        {
          runGit: (origin, args) => {
            if (args[0] === "commit-tree") {
              const actual = rawGit(origin, args);
              mergedCommit = actual.stdout;
              return actual;
            }
            if (failure === "ref-rollback" && args[0] === "update-ref" && args[2] === initial && args[3] === mergedCommit) {
              return { status: 128, stdout: "", stderr: rollbackError };
            }
            return rawGit(origin, args);
          },
          runGitWithIndex: (origin, args, temporaryIndexPath) => {
            if (args[0] === "read-tree" && args[1] === "-m") {
              if (!forwardRefreshCompleted) {
                forwardRefreshCompleted = true;
                if (failure === "ref-rollback") {
                  return { status: 128, stdout: "", stderr: refreshError };
                }
              } else if (failure === "checkout-restoration") {
                return { status: 128, stdout: "", stderr: restorationError };
              }
            }
            if (
              failure === "checkout-restoration" &&
              forwardRefreshCompleted &&
              !injectedAttestationFailure &&
              args[0] === "ls-files"
            ) {
              injectedAttestationFailure = true;
              return { status: 128, stdout: "", stderr: refreshError };
            }
            return rawGitWithIndex(origin, args, temporaryIndexPath);
          },
          emitEvent: (event) => events.push(event),
        },
      );

      assert.equal(result.status, "operational_error");
      if (result.status !== "operational_error") continue;
      assert.match(result.detail, /checkout refresh: failed:/i);
      assert.match(result.detail, /ref rollback: (?:failed|restored)/i);
      assert.match(result.detail, /checkout restoration: (?:not attempted|failed)/i);
      assert.ok(result.detail.length < 2000, `diagnostic was not bounded: ${result.detail.length}`);
      assert.doesNotMatch(result.detail, /refresh-tail|rollback-tail|restoration-tail/);
      assert.deepEqual(events, []);
    }
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
            if (failure === "ref-rollback" && args[0] === "update-ref" && args[2] === initial && args[3] === mergedCommit) {
              return { status: 128, stdout: "", stderr: "injected rollback failure" };
            }
            return rawGit(origin, args);
          },
          runGitWithIndex: (origin, args, temporaryIndexPath) => {
            if (args[0] === "read-tree" && args[1] === "-m" && !refreshFailed) {
              refreshFailed = true;
              if (failure === "checkout-restoration") {
                const applied = rawGitWithIndex(origin, args, temporaryIndexPath);
                assert.equal(applied.status, 0);
                const realIndexPath = git(origin, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
                fs.renameSync(temporaryIndexPath, realIndexPath);
              }
              return { status: 128, stdout: "", stderr: "injected refresh failure" };
            }
            if (failure === "checkout-restoration" && args[0] === "read-tree" && args[1] === "-m") {
              return { status: 128, stdout: "", stderr: "injected restoration failure" };
            }
            return rawGitWithIndex(origin, args, temporaryIndexPath);
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
        assert.match(result.detail, /pre-restore state: safely-reversible state verified/i);
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
    assert.equal(
      commands.some((args) =>
        args[0] === "checkout" ||
        args[0] === "switch" ||
        args.includes("--ignore-other-worktrees") ||
        (args[0] === "merge" && args.includes("--squash")) ||
        (args[0] === "reset" && args.includes("--hard"))
      ),
      false,
      "merge-branch must not use checkout/switch bypasses, squash merge, or hard reset",
    );
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
