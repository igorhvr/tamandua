import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { cleanChildEnv, createTempHome } from "../../tests/helpers/test-env.ts";

const cleanup: string[] = [];
const requiredOptions = ["--origin", "--branch", "--into", "--expect-tip", "--message"];

function rawGit(repo: string, args: string[]) {
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

function git(repo: string, args: string[]): string {
  const result = rawGit(repo, args);
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function runCli(args: string[], envOverrides: Record<string, string> = {}) {
  const testHome = createTempHome("tamandua-merge-branch-cli-home-");
  cleanup.push(testHome.root);
  const result = spawnSync("/bin/sh", [path.resolve("bin/tamandua"), ...args], {
    encoding: "utf-8",
    env: cleanChildEnv({
      HOME: testHome.homeDir,
      TAMANDUA_STATE_DIR: testHome.tamanduaDir,
      ...envOverrides,
    }),
  });
  return { ...result, testHome };
}

function createRepo(): { repo: string; initial: string } {
  const repo = tamanduaTempDir("tamandua-merge-branch-cli-");
  cleanup.push(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "test@tamandua.local"]);
  git(repo, ["config", "user.name", "Tamandua Test"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf-8");
  git(repo, ["add", "base.txt"]);
  git(repo, ["commit", "-m", "base"]);
  return { repo, initial: git(repo, ["rev-parse", "HEAD"]) };
}

function createFeature(repo: string, start: string, contents = "feature\n"): void {
  git(repo, ["switch", "-c", "feature", start]);
  fs.writeFileSync(path.join(repo, "feature.txt"), contents, "utf-8");
  git(repo, ["add", "feature.txt"]);
  git(repo, ["commit", "-m", "feature"]);
  git(repo, ["switch", "main"]);
}

function createFeatureChangingBase(repo: string, start: string): void {
  git(repo, ["switch", "-c", "feature", start]);
  fs.writeFileSync(path.join(repo, "base.txt"), "feature change\n", "utf-8");
  git(repo, ["commit", "-am", "feature changes base"]);
  git(repo, ["switch", "main"]);
}

function createLinkedTargetRepo(): { repo: string; targetWorktree: string; initial: string } {
  const { repo, initial } = createRepo();
  createFeatureChangingBase(repo, initial);
  git(repo, ["branch", "staging", initial]);
  const targetWorktree = tamanduaTempDir("tamandua-merge-branch-cli-linked-");
  cleanup.push(targetWorktree);
  git(repo, ["worktree", "add", targetWorktree, "staging"]);
  return { repo, targetWorktree, initial };
}

function readEvents(eventsPath: string): Array<{ event: string; checkoutRefresh?: string }> {
  if (!fs.existsSync(eventsPath)) return [];
  const contents = fs.readFileSync(eventsPath, "utf-8").trim();
  if (!contents) return [];
  return contents.split("\n").map((line) => JSON.parse(line) as { event: string; checkoutRefresh?: string });
}

function createRefreshFailureGitWrapper(
  repo: string,
  initial: string,
  mode: "rollback" | "concurrent-winner",
): { env: Record<string, string>; competingCommitPath: string } {
  const wrapperDir = tamanduaTempDir("tamandua-merge-branch-cli-git-wrapper-");
  cleanup.push(wrapperDir);
  const markerPath = path.join(wrapperDir, "refresh-failed");
  const mergedCommitPath = path.join(wrapperDir, "merged-commit");
  const competingCommitPath = path.join(wrapperDir, "competing-commit");
  const wrapperPath = path.join(wrapperDir, "git");
  fs.writeFileSync(wrapperPath, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const run = (gitArgs) => spawnSync("/usr/bin/git", gitArgs, { encoding: "utf-8" });
const command = args[0] === "-C" ? args[2] : args[0];
const actual = run(args);
if (command === "commit-tree" && actual.status === 0) {
  fs.writeFileSync(process.env.MBLC_MERGED_COMMIT_PATH, actual.stdout.trim());
}
if (command === "read-tree" && actual.status === 0 && !fs.existsSync(process.env.MBLC_MARKER_PATH)) {
  fs.writeFileSync(process.env.MBLC_MARKER_PATH, "failed");
  if (process.env.MBLC_MODE === "concurrent-winner") {
    const initialTree = run(["-C", process.env.MBLC_REPO, "rev-parse", process.env.MBLC_INITIAL + "^{tree}"]).stdout.trim();
    const winner = run(["-C", process.env.MBLC_REPO, "commit-tree", initialTree, "-p", process.env.MBLC_INITIAL, "-m", "concurrent winner"]);
    if (winner.status !== 0) {
      process.stderr.write(winner.stderr);
      process.exit(winner.status || 1);
    }
    const competingCommit = winner.stdout.trim();
    const mergedCommit = fs.readFileSync(process.env.MBLC_MERGED_COMMIT_PATH, "utf-8").trim();
    const update = run(["-C", process.env.MBLC_REPO, "update-ref", "refs/heads/staging", competingCommit, mergedCommit]);
    if (update.status !== 0) {
      process.stderr.write(update.stderr);
      process.exit(update.status || 1);
    }
    fs.writeFileSync(process.env.MBLC_COMPETING_COMMIT_PATH, competingCommit);
  }
  process.stderr.write("injected CLI refresh failure after CAS\\n");
  process.exit(128);
}
process.stdout.write(actual.stdout || "");
process.stderr.write(actual.stderr || "");
process.exit(actual.status === null ? 1 : actual.status);
`, "utf-8");
  fs.chmodSync(wrapperPath, 0o755);
  return {
    env: {
      PATH: `${wrapperDir}:${process.env.PATH ?? ""}`,
      MBLC_MODE: mode,
      MBLC_REPO: repo,
      MBLC_INITIAL: initial,
      MBLC_MARKER_PATH: markerPath,
      MBLC_MERGED_COMMIT_PATH: mergedCommitPath,
      MBLC_COMPETING_COMMIT_PATH: competingCommitPath,
    },
    competingCommitPath,
  };
}

function validArgs(repo: string, expectTip: string, into = "scratch"): string[] {
  return [
    "merge-branch",
    "--origin", repo,
    "--branch", "feature",
    "--into", into,
    "--expect-tip", expectTip,
    "--message", "Land feature",
  ];
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("tamandua merge-branch CLI", () => {
  it("documents required options, statuses, and distinct exit codes without executing Git", () => {
    const result = runCli(["merge-branch", "--help"]);
    const globalHelp = runCli(["--help"]);

    assert.equal(result.status, 0);
    for (const option of requiredOptions) assert.match(result.stdout, new RegExp(option));
    assert.match(result.stdout, /STATUS: landed/);
    assert.match(result.stdout, /NOOP: <true \| false>/);
    assert.match(result.stdout, /true[\s\S]*already landed[\s\S]*false[\s\S]*new squash commit/i);
    assert.match(result.stdout, /STATUS: target_moved/);
    assert.match(result.stdout, /STATUS: conflicts/);
    assert.match(result.stdout, /linked worktrees/i);
    assert.match(result.stdout, /dirty or ambiguous[\s\S]*exit code 1/i);
    assert.match(result.stdout, /post-CAS[\s\S]*rollback/i);
    assert.match(result.stdout, /CHECKOUT_REFRESH: <refreshed \| not-applicable>/);
    assert.doesNotMatch(result.stdout, /skipped:/);
    assert.match(result.stdout, /Exit codes:[\s\S]*0\s+Newly landed or already landed \(no-op\)[\s\S]*2[\s\S]*3/);
    assert.equal(result.stderr, "");
    assert.equal(globalHelp.status, 0);
    assert.match(globalHelp.stdout, /tamandua merge-branch/);
  });

  it("rejects each missing required option before mutating the target", () => {
    const { repo, initial } = createRepo();
    git(repo, ["branch", "scratch", initial]);
    createFeature(repo, initial);
    const args = validArgs(repo, initial);

    for (const option of requiredOptions) {
      const optionIndex = args.indexOf(option);
      const result = runCli(args.filter((_, index) => index !== optionIndex && index !== optionIndex + 1));
      assert.equal(result.status, 1, `${option} should be required`);
      assert.match(result.stderr, new RegExp(`Missing required option ${option}`));
      assert.equal(git(repo, ["rev-parse", "refs/heads/scratch"]), initial);
    }
  });

  it("rejects unknown, duplicate, positional, and valueless options", () => {
    const { repo, initial } = createRepo();
    git(repo, ["branch", "scratch", initial]);
    createFeature(repo, initial);
    const args = validArgs(repo, initial);
    const invalidCases = [
      { args: [...args, "--bogus", "value"], error: /Unknown option --bogus/ },
      { args: [...args, "--branch", "other"], error: /Duplicate option --branch/ },
      { args: [...args, "extra"], error: /Unexpected argument extra/ },
      { args: args.slice(0, -1), error: /Missing value for --message/ },
      { args: [...args.slice(0, -2), "--message="], error: /Missing value for --message/ },
    ];

    for (const invalid of invalidCases) {
      const result = runCli(invalid.args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, invalid.error);
      assert.equal(git(repo, ["rev-parse", "refs/heads/scratch"]), initial);
    }
  });

  it("lands on an explicit non-main target and leaves the current worktree and index unchanged", () => {
    const { repo, initial } = createRepo();
    git(repo, ["branch", "scratch", initial]);
    createFeature(repo, initial);
    const branchBefore = git(repo, ["symbolic-ref", "--short", "HEAD"]);
    const indexTreeBefore = git(repo, ["write-tree"]);
    const baseBefore = fs.readFileSync(path.join(repo, "base.txt"), "utf-8");

    const result = runCli(validArgs(repo, initial));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^STATUS: landed$/m);
    assert.match(result.stdout, /^NOOP: false$/m);
    assert.match(result.stdout, /^MERGED_COMMIT: [0-9a-f]{40}$/m);
    assert.match(result.stdout, /^MERGED_TREE: [0-9a-f]{40}$/m);
    assert.match(result.stdout, /^TARGET: refs\/heads\/scratch$/m);
    assert.match(result.stdout, /^CHECKOUT_REFRESH: not-applicable$/m);
    assert.equal(git(repo, ["symbolic-ref", "--short", "HEAD"]), branchBefore);
    assert.equal(git(repo, ["write-tree"]), indexTreeBefore);
    assert.equal(fs.readFileSync(path.join(repo, "base.txt"), "utf-8"), baseBefore);
    assert.equal(fs.existsSync(path.join(repo, "feature.txt")), false);
    assert.equal(git(repo, ["show", "refs/heads/scratch:feature.txt"]), "feature");
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), initial);
  });

  it("IDEM reports an already-landed branch without changing target history", () => {
    const { repo, initial } = createRepo();
    createFeature(repo, initial);
    git(repo, ["merge", "--ff-only", "feature"]);
    const targetBefore = git(repo, ["rev-parse", "refs/heads/main"]);
    const treeBefore = git(repo, ["rev-parse", "refs/heads/main^{tree}"]);
    const commitCountBefore = git(repo, ["rev-list", "--count", "refs/heads/main"]);

    const result = runCli(validArgs(repo, targetBefore, "main"));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^STATUS: landed$/m);
    assert.match(result.stdout, /^NOOP: true$/m);
    assert.match(result.stdout, new RegExp(`^MERGED_COMMIT: ${targetBefore}$`, "m"));
    assert.match(result.stdout, new RegExp(`^MERGED_TREE: ${treeBefore}$`, "m"));
    assert.match(result.stdout, /^TARGET: refs\/heads\/main$/m);
    assert.match(result.stdout, /^CHECKOUT_REFRESH: not-applicable$/m);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), targetBefore);
    assert.equal(git(repo, ["rev-list", "--count", "refs/heads/main"]), commitCountBefore);

    const eventsPath = path.join(result.testHome.tamanduaDir, "events", "all.jsonl");
    const events = fs.readFileSync(eventsPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        event: string;
        noop?: boolean;
        mergedCommit?: string;
        mergedTree?: string;
      });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "merge.landed");
    assert.equal(events[0]?.noop, true);
    assert.equal(events[0]?.mergedCommit, targetBefore);
    assert.equal(events[0]?.mergedTree, treeBefore);
  });

  it("STCK reports refreshed and synchronizes a clean checked-out target", () => {
    const { repo, initial } = createRepo();
    createFeature(repo, initial);

    const result = runCli(validArgs(repo, initial, "main"));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^STATUS: landed$/m);
    assert.match(result.stdout, /^CHECKOUT_REFRESH: refreshed$/m);
    assert.equal(fs.readFileSync(path.join(repo, "feature.txt"), "utf-8"), "feature\n");
    assert.equal(git(repo, ["status", "--porcelain"]), "");
    assert.equal(git(repo, ["diff", "--cached", "--name-only"]), "");
  });

  it("refreshes linked staging while leaving the root checkout byte-for-byte unchanged", () => {
    const { repo, targetWorktree, initial } = createLinkedTargetRepo();
    const rootUntrackedPath = path.join(repo, "operator-notes.txt");
    fs.writeFileSync(rootUntrackedPath, Buffer.from("root operator bytes\n"));
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

    const result = runCli(validArgs(repo, initial, "staging"));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^STATUS: landed$/m);
    assert.match(result.stdout, /^CHECKOUT_REFRESH: refreshed$/m);
    const mergedCommit = result.stdout.match(/^MERGED_COMMIT: ([0-9a-f]{40})$/m)?.[1];
    const mergedTree = result.stdout.match(/^MERGED_TREE: ([0-9a-f]{40})$/m)?.[1];
    assert.ok(mergedCommit);
    assert.ok(mergedTree);
    assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), mergedCommit);
    assert.equal(git(targetWorktree, ["rev-parse", "HEAD"]), mergedCommit);
    assert.equal(git(targetWorktree, ["rev-parse", "HEAD^{tree}"]), mergedTree);
    assert.equal(git(targetWorktree, ["write-tree"]), mergedTree);
    assert.equal(git(targetWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal(fs.readFileSync(path.join(targetWorktree, "base.txt"), "utf-8"), "feature change\n");
    assert.equal(git(repo, ["symbolic-ref", "HEAD"]), rootBefore.branch);
    assert.equal(git(repo, ["rev-parse", "HEAD"]), rootBefore.head);
    assert.equal(git(repo, ["write-tree"]), rootBefore.indexTree);
    assert.deepEqual(fs.readFileSync(rootIndexPath), rootBefore.indexBytes);
    assert.equal(git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]), rootBefore.status);
    assert.deepEqual(fs.readFileSync(path.join(repo, "base.txt")), rootBefore.trackedBytes);
    assert.deepEqual(fs.readFileSync(rootUntrackedPath), rootBefore.untrackedBytes);
    assert.equal(fs.existsSync(path.join(repo, "feature.txt")), false);
    const events = readEvents(path.join(result.testHome.tamanduaDir, "events", "all.jsonl"));
    assert.deepEqual(events.map(({ event, checkoutRefresh }) => ({ event, checkoutRefresh })), [
      { event: "merge.landed", checkoutRefresh: "refreshed" },
    ]);
  });

  for (const dirtyState of ["tracked", "staged", "untracked"] as const) {
    it(`rejects a linked target with ${dirtyState} bytes before moving its ref`, () => {
      const { repo, targetWorktree, initial } = createLinkedTargetRepo();
      const userPath = dirtyState === "untracked"
        ? path.join(targetWorktree, "operator-notes.txt")
        : path.join(targetWorktree, "base.txt");
      const userBytes = Buffer.from(`${dirtyState} operator bytes\n`);
      fs.writeFileSync(userPath, userBytes);
      if (dirtyState === "staged") git(targetWorktree, ["add", "base.txt"]);
      const rootBranchBefore = git(repo, ["symbolic-ref", "HEAD"]);
      const targetBranchBefore = git(targetWorktree, ["symbolic-ref", "HEAD"]);
      const targetIndexPath = git(targetWorktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
      const targetIndexBytesBefore = fs.readFileSync(targetIndexPath);
      const targetStatusBefore = git(targetWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]);

      const result = runCli(validArgs(repo, initial, "staging"));

      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /target worktree.*not clean/i);
      assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), initial);
      assert.equal(git(repo, ["symbolic-ref", "HEAD"]), rootBranchBefore);
      assert.equal(git(targetWorktree, ["symbolic-ref", "HEAD"]), targetBranchBefore);
      assert.deepEqual(fs.readFileSync(targetIndexPath), targetIndexBytesBefore);
      assert.equal(git(targetWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]), targetStatusBefore);
      assert.deepEqual(fs.readFileSync(userPath), userBytes);
      assert.deepEqual(readEvents(path.join(result.testHome.tamanduaDir, "events", "all.jsonl")), []);
    });
  }

  it("rolls back a linked target after a forced post-CAS refresh failure without emitting landed", () => {
    const { repo, targetWorktree, initial } = createLinkedTargetRepo();
    const targetTreeBefore = git(targetWorktree, ["rev-parse", "HEAD^{tree}"]);
    const targetIndexBefore = git(targetWorktree, ["write-tree"]);
    const targetBytesBefore = fs.readFileSync(path.join(targetWorktree, "base.txt"));
    const injection = createRefreshFailureGitWrapper(repo, initial, "rollback");

    const result = runCli(validArgs(repo, initial, "staging"), injection.env);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /checkout refresh: failed.*injected CLI refresh failure/i);
    assert.match(result.stderr, /ref rollback: restored/i);
    assert.match(result.stderr, /checkout restoration: restored/i);
    assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), initial);
    assert.equal(git(targetWorktree, ["rev-parse", "HEAD"]), initial);
    assert.equal(git(targetWorktree, ["rev-parse", "HEAD^{tree}"]), targetTreeBefore);
    assert.equal(git(targetWorktree, ["write-tree"]), targetIndexBefore);
    assert.equal(git(targetWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.deepEqual(fs.readFileSync(path.join(targetWorktree, "base.txt")), targetBytesBefore);
    assert.deepEqual(readEvents(path.join(result.testHome.tamanduaDir, "events", "all.jsonl")), []);
  });

  it("preserves a concurrent ref winner when forced refresh rollback loses at the CLI boundary", () => {
    const { repo, initial } = createLinkedTargetRepo();
    const injection = createRefreshFailureGitWrapper(repo, initial, "concurrent-winner");

    const result = runCli(validArgs(repo, initial, "staging"), injection.env);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /checkout refresh: failed.*injected CLI refresh failure/i);
    assert.match(result.stderr, /ref rollback: failed/i);
    assert.match(result.stderr, /checkout restoration: not attempted/i);
    const competingCommit = fs.readFileSync(injection.competingCommitPath, "utf-8").trim();
    assert.match(competingCommit, /^[0-9a-f]{40}$/);
    assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), competingCommit);
    assert.deepEqual(readEvents(path.join(result.testHome.tamanduaDir, "events", "all.jsonl")), []);
  });

  it("STCK fails closed while preserving a touched local change", () => {
    const { repo, initial } = createRepo();
    createFeatureChangingBase(repo, initial);
    const localContents = "local change\n";
    fs.writeFileSync(path.join(repo, "base.txt"), localContents, "utf-8");

    const result = runCli(validArgs(repo, initial, "main"));

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /target worktree.*not clean/i);
    assert.equal(fs.readFileSync(path.join(repo, "base.txt"), "utf-8"), localContents);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), initial);
    assert.equal(git(repo, ["show", "refs/heads/main:base.txt"]), "base");
  });

  it("STCK reports not-applicable for a bare origin", () => {
    const { repo, initial } = createRepo();
    createFeature(repo, initial);
    const cloneRoot = tamanduaTempDir("tamandua-merge-branch-cli-bare-");
    cleanup.push(cloneRoot);
    const bareRepo = path.join(cloneRoot, "origin.git");
    git(repo, ["clone", "--bare", repo, bareRepo]);
    git(bareRepo, ["config", "user.email", "test@tamandua.local"]);
    git(bareRepo, ["config", "user.name", "Tamandua Test"]);

    const result = runCli(validArgs(bareRepo, initial, "main"));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^STATUS: landed$/m);
    assert.match(result.stdout, /^CHECKOUT_REFRESH: not-applicable$/m);
    assert.notEqual(git(bareRepo, ["rev-parse", "refs/heads/main"]), initial);
  });

  it("prints target_moved with exit code 2", () => {
    const { repo, initial } = createRepo();
    git(repo, ["branch", "scratch", initial]);
    createFeature(repo, initial);

    const result = runCli(validArgs(repo, "0".repeat(40)));

    assert.equal(result.status, 2);
    assert.match(result.stdout, /^STATUS: target_moved$/m);
    assert.equal(git(repo, ["rev-parse", "refs/heads/scratch"]), initial);
  });

  it("prints conflicts and Git's listing with exit code 3", () => {
    const { repo, initial } = createRepo();
    git(repo, ["switch", "-c", "scratch", initial]);
    fs.writeFileSync(path.join(repo, "base.txt"), "scratch\n", "utf-8");
    git(repo, ["commit", "-am", "scratch conflict"]);
    const scratchTip = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["switch", "-c", "feature", initial]);
    fs.writeFileSync(path.join(repo, "base.txt"), "feature\n", "utf-8");
    git(repo, ["commit", "-am", "feature conflict"]);
    git(repo, ["switch", "main"]);

    const result = runCli(validArgs(repo, scratchTip));

    assert.equal(result.status, 3);
    assert.match(result.stdout, /^STATUS: conflicts$/m);
    assert.match(result.stdout, /CONFLICT|Auto-merging/);
    assert.equal(git(repo, ["rev-parse", "refs/heads/scratch"]), scratchTip);
  });
});