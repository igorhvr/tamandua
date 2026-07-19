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
import type { CheckoutRefreshOutcome } from "../../dist/installer/events.js";

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

interface ExactFileSnapshot {
  bytes: Buffer;
  mode: number;
  size: bigint;
  mtimeNs: bigint;
}

interface OwnerSafetySnapshot {
  refs: string;
  objectStore: Array<[string, ExactFileSnapshot]>;
  symbolicHead: string;
  head: string;
  headTree: string;
  targetTip: string;
  indexTree: string;
  index: ExactFileSnapshot;
  trackedBytes: Buffer;
  untrackedBytes: Buffer;
  ignoredCollisionBytes: Buffer;
  indexLock: ExactFileSnapshot & { dev: bigint; ino: bigint };
  adjacentArtifacts: string[];
}

function captureExactFile(file: string): ExactFileSnapshot {
  const stat = fs.statSync(file, { bigint: true });
  return {
    bytes: fs.readFileSync(file),
    mode: Number(stat.mode),
    size: stat.size,
    mtimeNs: stat.mtimeNs,
  };
}

function captureObjectStore(repo: string): Array<[string, ExactFileSnapshot]> {
  const objectDirectory = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  visit(objectDirectory);
  return files
    .sort()
    .map((file) => [path.relative(objectDirectory, file), captureExactFile(file)]);
}

function captureOwnerSafetyState(
  repo: string,
  owner: string,
  targetRef: string,
  indexPath: string,
  untrackedPath: string,
  ignoredCollisionPath: string,
): OwnerSafetySnapshot {
  const lockPath = `${indexPath}.lock`;
  const lockStat = fs.statSync(lockPath, { bigint: true });
  const indexDirectory = path.dirname(indexPath);
  return {
    refs: git(repo, ["for-each-ref", "--sort=refname", "--format=%(refname) %(objectname)"]),
    objectStore: captureObjectStore(repo),
    symbolicHead: git(owner, ["symbolic-ref", "HEAD"]),
    head: git(owner, ["rev-parse", "HEAD"]),
    headTree: git(owner, ["rev-parse", "HEAD^{tree}"]),
    targetTip: git(repo, ["rev-parse", targetRef]),
    indexTree: treeFromIndexCopy(owner, indexPath),
    index: captureExactFile(indexPath),
    trackedBytes: fs.readFileSync(path.join(owner, "base.txt")),
    untrackedBytes: fs.readFileSync(untrackedPath),
    ignoredCollisionBytes: fs.readFileSync(ignoredCollisionPath),
    indexLock: {
      ...captureExactFile(lockPath),
      dev: lockStat.dev,
      ino: lockStat.ino,
    },
    adjacentArtifacts: fs.readdirSync(indexDirectory)
      .filter((name) => /tamandua|quarantine/i.test(name))
      .sort(),
  };
}

function createCheckedOutSafetyFixture(ownerKind: "root" | "linked"): {
  repo: string;
  owner: string;
  target: string;
  targetRef: string;
  initial: string;
  indexPath: string;
  untrackedPath: string;
  ignoredCollisionPath: string;
} {
  const { repo } = createRepo();
  fs.writeFileSync(path.join(repo, ".gitignore"), ".collision/\n", "utf-8");
  git(repo, ["add", ".gitignore"]);
  git(repo, ["commit", "-m", "ignore collision fixture"]);
  const initial = git(repo, ["rev-parse", "HEAD"]);

  git(repo, ["switch", "-c", "feature"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "candidate tracked bytes\n", "utf-8");
  const candidateCollision = path.join(repo, ".collision", "payload.bin");
  fs.mkdirSync(path.dirname(candidateCollision), { recursive: true });
  fs.writeFileSync(candidateCollision, Buffer.from([0, 1, 2, 3, 255]));
  git(repo, ["add", "base.txt"]);
  git(repo, ["add", "-f", ".collision/payload.bin"]);
  git(repo, ["commit", "-m", "candidate collides with ignored owner bytes"]);
  git(repo, ["switch", "main"]);

  let owner = repo;
  let target = "main";
  if (ownerKind === "linked") {
    target = "staging";
    git(repo, ["branch", target, initial]);
    owner = tamanduaTempDir("tamandua-merge-branch-safety-linked-");
    cleanup.push(owner);
    git(repo, ["worktree", "add", owner, target]);
  }

  const untrackedPath = path.join(owner, "operator-notes.txt");
  const ignoredCollisionPath = path.join(owner, ".collision", "payload.bin");
  fs.writeFileSync(untrackedPath, Buffer.from("ordinary untracked operator bytes\n"));
  fs.mkdirSync(path.dirname(ignoredCollisionPath), { recursive: true });
  fs.writeFileSync(ignoredCollisionPath, Buffer.from("ignored owner collision bytes\n"));

  const indexPath = git(owner, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  fs.writeFileSync(`${indexPath}.lock`, Buffer.from("pre-existing real owner index lock\n"), {
    flag: "wx",
    mode: 0o640,
  });
  return {
    repo,
    owner,
    target,
    targetRef: `refs/heads/${target}`,
    initial,
    indexPath,
    untrackedPath,
    ignoredCollisionPath,
  };
}

function assertCheckedOutRefusal(ownerKind: "root" | "linked"): void {
  const fixture = createCheckedOutSafetyFixture(ownerKind);
  const before = captureOwnerSafetyState(
    fixture.repo,
    fixture.owner,
    fixture.targetRef,
    fixture.indexPath,
    fixture.untrackedPath,
    fixture.ignoredCollisionPath,
  );
  assert.deepEqual(before.adjacentArtifacts, []);

  const commands: string[][] = [];
  const events: MergeBranchEvent[] = [];
  let indexedCalls = 0;
  const result = runPlumbingMerge(
    {
      origin: fixture.repo,
      branch: "feature",
      into: fixture.target,
      expectTip: fixture.initial,
      message: `must refuse ${ownerKind} owner`,
      runId: `run-refuse-${ownerKind}`,
    },
    {
      runGit: (origin, args) => {
        commands.push([...args]);
        return rawGit(origin, args);
      },
      runGitWithIndex: () => {
        indexedCalls += 1;
        return { status: 99, stdout: "", stderr: "deprecated dependency must be unreachable" };
      },
      emitEvent: (event) => events.push(event),
    },
  );

  assert.equal(result.status, "operational_error");
  assert.equal(result.exitCode, 1);
  if (result.status !== "operational_error") return;
  assert.ok(result.detail.length <= 512, "the refusal diagnostic must remain bounded");
  assert.match(result.detail, /checked-out target landing is disabled/);
  assert.match(result.detail, /exact owned-index-lock release cannot be guaranteed/);
  assert.match(result.detail, /this is not a partial landing/);
  assert.match(result.detail, /this is not a retryable lock wait/);
  assert.match(result.detail, new RegExp(fixture.targetRef.replaceAll("/", "\\/")));
  assert.ok(result.detail.includes(fixture.owner));
  assert.equal(indexedCalls, 0);
  assert.deepEqual(events, []);

  const ownerDiscovery = ["worktree", "list", "--porcelain", "-z"];
  const ownerDiscoveryIndex = commands.findIndex((args) => args.join("\0") === ownerDiscovery.join("\0"));
  assert.equal(ownerDiscoveryIndex, 1, "owner discovery must immediately follow target-tip verification");
  assert.deepEqual(commands.slice(ownerDiscoveryIndex + 1), [], "no Git command may follow owner discovery");
  assert.deepEqual(commands, [
    ["rev-parse", "--verify", fixture.targetRef],
    ownerDiscovery,
  ]);

  const after = captureOwnerSafetyState(
    fixture.repo,
    fixture.owner,
    fixture.targetRef,
    fixture.indexPath,
    fixture.untrackedPath,
    fixture.ignoredCollisionPath,
  );
  assert.deepEqual(after, before);
  assert.equal(fs.existsSync(`${fixture.indexPath}.lock`), true);
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runPlumbingMerge", () => {
  it("keeps historical CheckoutRefreshOutcome values source-compatible while current successes are not-applicable", () => {
    const historicalValues: CheckoutRefreshOutcome[] = ["refreshed", "already-coherent", "not-applicable"];
    assert.deepEqual(historicalValues, ["refreshed", "already-coherent", "not-applicable"]);

    const source = fs.readFileSync(path.resolve("src/installer/merge-branch.ts"), "utf-8");
    assert.doesNotMatch(
      source,
      /checkoutRefresh\s*(?::[^=;]+)?=\s*["'](?:refreshed|already-coherent)["']/,
      "current production must not construct a positive checkout-refresh success",
    );
    assert.match(source, /checkoutRefresh(?:\s*:\s*CheckoutRefreshOutcome)?\s*=\s*["']not-applicable["']/);
    assert.match(source, /checkoutRefresh:\s*["']not-applicable["']/);
  });

  it("refuses an ordinary non-no-op landing into a root checked-out target without any mutation", () => {
    assertCheckedOutRefusal("root");
  });

  it("refuses an ordinary non-no-op landing into a linked checked-out target without any mutation", () => {
    assertCheckedOutRefusal("linked");
  });

  it("refuses a checked-out would-be no-op before candidate resolution or merge-base", () => {
    const { repo } = createRepo();
    const featureTip = createFeature(repo);
    git(repo, ["merge", "--ff-only", "feature"]);
    const targetTip = git(repo, ["rev-parse", "refs/heads/main"]);
    const events: MergeBranchEvent[] = [];
    const commands: string[][] = [];
    let indexedCalls = 0;

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "main", expectTip: targetTip, message: "would-be no-op" },
      {
        runGit: (origin, args) => {
          commands.push([...args]);
          return rawGit(origin, args);
        },
        runGitWithIndex: () => {
          indexedCalls += 1;
          return { status: 99, stdout: "", stderr: "must not run" };
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(featureTip, targetTip);
    assert.equal(result.status, "operational_error");
    assert.equal(result.exitCode, 1);
    assert.equal(indexedCalls, 0);
    assert.deepEqual(commands, [
      ["rev-parse", "--verify", "refs/heads/main"],
      ["worktree", "list", "--porcelain", "-z"],
    ]);
    assert.equal(commands.some((args) => args.includes("refs/heads/feature^{commit}")), false);
    assert.equal(commands.some((args) => args[0] === "merge-base"), false);
    assert.deepEqual(events, []);
  });

  it("lands into an unowned target when metadata also contains a detached worktree", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    git(repo, ["branch", "release", initial]);
    const detachedWorktree = tamanduaTempDir("tamandua-merge-branch-detached-");
    cleanup.push(detachedWorktree);
    git(repo, ["worktree", "add", "--detach", detachedWorktree, initial]);
    assert.notEqual(rawGit(detachedWorktree, ["symbolic-ref", "HEAD"]).status, 0);
    const events: MergeBranchEvent[] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "release", expectTip: initial, message: "detached metadata is safe", runId: "run-detached" },
      { emitEvent: (event) => events.push(event) },
    );

    assert.equal(result.status, "landed");
    assert.equal(result.exitCode, 0);
    if (result.status !== "landed") return;
    assert.equal(result.noop, false);
    assert.equal(result.checkoutRefresh, "not-applicable");
    assert.equal(git(repo, ["rev-parse", "refs/heads/release"]), result.mergedCommit);
    assert.equal(git(detachedWorktree, ["rev-parse", "HEAD"]), initial);
    assert.deepEqual(events.map(({ event, checkoutRefresh, noop }) => ({ event, checkoutRefresh, noop })), [
      { event: "merge.landed", checkoutRefresh: "not-applicable", noop: false },
    ]);
  });

  it("IDEM returns a no-op landing when the branch is already ancestral to the target", () => {
    const { repo } = createRepo();
    const featureTip = createFeature(repo);
    git(repo, ["merge", "--ff-only", "feature"]);
    const targetTip = git(repo, ["rev-parse", "refs/heads/main"]);
    git(repo, ["branch", "staging", targetTip]);
    const targetTree = git(repo, ["rev-parse", `${targetTip}^{tree}`]);
    const events: MergeBranchEvent[] = [];
    const commands: string[][] = [];
    const checkoutBefore = captureCheckoutState(repo);

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "staging", expectTip: targetTip, message: "must not duplicate", runId: "run-noop-ancestor" },
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
    assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), targetTip);
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
        target: "refs/heads/staging",
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
    git(repo, ["branch", "staging", equivalentTarget]);
    const events: MergeBranchEvent[] = [];
    const commands: string[][] = [];
    const checkoutBefore = captureCheckoutState(repo);

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "staging", expectTip: equivalentTarget, message: "must not duplicate", runId: "run-noop-tree" },
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
    assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), equivalentTarget);
    assert.deepEqual(captureCheckoutState(repo), checkoutBefore);
    assert.equal(commands.some((args) => args[0] === "commit-tree"), false);
    assert.equal(commands.some((args) => args[0] === "update-ref"), false);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "merge.landed");
    assert.equal(events[0]?.noop, true);
    assert.equal(events[0]?.mergedCommit, equivalentTarget);
    assert.equal(events[0]?.mergedTree, targetTree);
    assert.equal(events[0]?.checkoutRefresh, "not-applicable");
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
    git(repo, ["branch", "staging", targetTip]);
    const events: MergeBranchEvent[] = [];
    const commands: string[][] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "staging", expectTip: targetTip, message: "land remaining", runId: "run-partial" },
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
    assert.equal(result.checkoutRefresh, "not-applicable");
    assert.notEqual(result.mergedCommit, targetTip);
    assert.equal(git(repo, ["rev-parse", `${result.mergedCommit}^`]), targetTip);
    assert.equal(git(repo, ["show", `${result.mergedCommit}:shared.txt`]), "shared");
    assert.equal(git(repo, ["show", `${result.mergedCommit}:remaining.txt`]), "remaining");
    assert.equal(commands.filter((args) => args[0] === "commit-tree").length, 1);
    assert.equal(commands.filter((args) => args[0] === "update-ref").length, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "merge.landed");
    assert.equal(events[0]?.noop, false);
    assert.equal(events[0]?.checkoutRefresh, "not-applicable");
  });

  it("STCK leaves the checkout untouched when landing into a non-checked-out branch", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    git(repo, ["branch", "release", initial]);
    const events: MergeBranchEvent[] = [];
    const checkoutBefore = captureCheckoutState(repo);

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "release", expectTip: initial, message: "Land feature", runId: "run-other" },
      { emitEvent: (event) => events.push(event) },
    );

    assert.equal(result.status, "landed");
    if (result.status !== "landed") return;
    assert.equal(result.checkoutRefresh, "not-applicable");
    assert.deepEqual(captureCheckoutState(repo), checkoutBefore);
    assert.equal(fs.existsSync(path.join(repo, "feature.txt")), false);
    assert.equal(events[0]?.checkoutRefresh, "not-applicable");
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
    assert.deepEqual(events, [{
      ts: events[0]?.ts,
      event: "merge.target_moved",
      runId: "run-preflight",
      origin: repo,
      branch: "feature",
      target: "refs/heads/main",
      expectedTip: "0".repeat(40),
      actualTip: initial,
    }]);
  });

  it("reports a compare-and-swap race without overwriting the winner", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    git(repo, ["branch", "release", initial]);
    const events: MergeBranchEvent[] = [];
    let competingCommit = "";

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "release", expectTip: initial, message: "losing merge", runId: "run-cas" },
      {
        runGit: (origin, args) => {
          if (args[0] === "update-ref" && competingCommit === "") {
            const initialTree = git(repo, ["rev-parse", `${initial}^{tree}`]);
            competingCommit = git(repo, ["commit-tree", initialTree, "-p", initial, "-m", "competing land"]);
            git(repo, ["update-ref", "refs/heads/release", competingCommit, initial]);
          }
          return rawGit(origin, args);
        },
        emitEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "target_moved");
    assert.equal(result.exitCode, 2);
    if (result.status !== "target_moved") return;
    assert.equal(git(repo, ["rev-parse", "refs/heads/release"]), competingCommit);
    assert.ok(result.mergedTree);
    assert.ok(result.mergedCommit);
    assert.deepEqual(events, [{
      ts: events[0]?.ts,
      event: "merge.target_moved",
      runId: "run-cas",
      origin: repo,
      branch: "feature",
      target: "refs/heads/release",
      expectedTip: initial,
      actualTip: competingCommit,
      mergedTree: result.mergedTree,
      mergedCommit: result.mergedCommit,
    }]);
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
    git(repo, ["branch", "staging", mainTip]);
    const events: MergeBranchEvent[] = [];

    const result = runPlumbingMerge(
      { origin: repo, branch: "feature", into: "staging", expectTip: mainTip, message: "conflicting merge", runId: "run-conflict" },
      { emitEvent: (event) => events.push(event) },
    );

    assert.equal(result.status, "conflicts");
    assert.equal(result.exitCode, 3);
    if (result.status !== "conflicts") return;
    assert.match(result.conflicts, /CONFLICT|Auto-merging/);
    assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), mainTip);
    assert.ok(result.mergedTree);
    assert.deepEqual(events, [{
      ts: events[0]?.ts,
      event: "merge.conflicts",
      runId: "run-conflict",
      origin: repo,
      branch: "feature",
      target: "refs/heads/staging",
      expectedTip: mainTip,
      mergedTree: result.mergedTree,
    }]);
  });

  it("returns an operational error for a missing feature branch", () => {
    const { repo, initial } = createRepo();
    git(repo, ["branch", "release", initial]);
    const result = runPlumbingMerge({ origin: repo, branch: "missing", into: "release", expectTip: initial, message: "cannot merge" });

    assert.equal(result.status, "operational_error");
    assert.equal(result.exitCode, 1);
    if (result.status !== "operational_error") return;
    assert.match(result.detail, /refs\/heads\/missing/);
    assert.equal(git(repo, ["rev-parse", "refs/heads/release"]), initial);
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
