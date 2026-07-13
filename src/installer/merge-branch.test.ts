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

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runPlumbingMerge", () => {
  it("lands a squash result without changing the working tree or index", () => {
    const { repo, initial } = createRepo();
    createFeature(repo);
    const events: MergeBranchEvent[] = [];
    const indexTreeBefore = git(repo, ["write-tree"]);
    const worktreeBaseBefore = fs.readFileSync(path.join(repo, "base.txt"), "utf-8");
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
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), result.mergedCommit);
    assert.equal(git(repo, ["rev-parse", `${result.mergedCommit}^`]), initial);
    assert.equal(git(repo, ["rev-parse", `${result.mergedCommit}^{tree}`]), result.mergedTree);
    assert.equal(git(repo, ["show", `${result.mergedCommit}:feature.txt`]), "feature");
    assert.equal(git(repo, ["write-tree"]), indexTreeBefore);
    assert.equal(fs.readFileSync(path.join(repo, "base.txt"), "utf-8"), worktreeBaseBefore);
    assert.equal(fs.existsSync(path.join(repo, "feature.txt")), false);
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
      },
    ]);
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

  it("uses only plumbing commands against the origin", () => {
    const commands: string[][] = [];
    const expected = "1".repeat(40);
    const tree = "2".repeat(40);
    const commit = "3".repeat(40);
    const scripted = [
      { status: 0, stdout: expected, stderr: "" },
      { status: 0, stdout: "4".repeat(40), stderr: "" },
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
      ["rev-parse", "--verify", "refs/heads/feature^{commit}"],
      ["merge-tree", "--write-tree", expected, "refs/heads/feature"],
      ["commit-tree", tree, "-p", expected, "-m", "plumbing only"],
      ["update-ref", "refs/heads/release", commit, expected],
    ]);
    assert.equal(commands.some((args) => ["checkout", "switch", "merge", "commit", "read-tree"].includes(args[0]!)), false);
  });

  it("does not misclassify a non-CAS update-ref failure as target movement", () => {
    const expected = "1".repeat(40);
    const tree = "2".repeat(40);
    const commit = "3".repeat(40);
    const events: MergeBranchEvent[] = [];
    const scripted = [
      { status: 0, stdout: expected, stderr: "" },
      { status: 0, stdout: "4".repeat(40), stderr: "" },
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
