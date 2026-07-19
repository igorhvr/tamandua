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

function captureFileBytes(worktree: string, args: string[]): Array<[string, Buffer]> {
  const files = git(worktree, args)
    .split("\n")
    .filter(Boolean)
    .sort();
  return files.map((file) => [file, fs.readFileSync(path.join(worktree, file))]);
}

function captureCheckoutState(worktree: string) {
  const indexPath = git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  return {
    branch: git(worktree, ["symbolic-ref", "HEAD"]),
    head: git(worktree, ["rev-parse", "HEAD"]),
    indexTree: git(worktree, ["write-tree"]),
    indexBytes: fs.readFileSync(indexPath),
    status: git(worktree, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"]),
    trackedFiles: captureFileBytes(worktree, ["ls-files", "--cached"]),
    untrackedFiles: captureFileBytes(worktree, ["ls-files", "--others", "--exclude-standard"]),
  };
}

function readEvents(eventsPath: string): Array<{ event: string; checkoutRefresh?: string }> {
  if (!fs.existsSync(eventsPath)) return [];
  const contents = fs.readFileSync(eventsPath, "utf-8").trim();
  if (!contents) return [];
  return contents.split("\n").map((line) => JSON.parse(line) as { event: string; checkoutRefresh?: string });
}

function createWrappedGitLedger(
  repo: string,
): { env: Record<string, string>; getLedger: () => string[] } {
  const wrapperDir = tamanduaTempDir("tamandua-merge-branch-cli-git-wrapper-");
  cleanup.push(wrapperDir);
  const ledgerPath = path.join(wrapperDir, "commands.ledger");
  const wrapperPath = path.join(wrapperDir, "git");
  fs.writeFileSync(wrapperPath, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MBLC_LEDGER_PATH, JSON.stringify(args) + "\\n");
const result = spawnSync("/usr/bin/git", args, { encoding: "utf-8" });
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(result.status === null ? 1 : result.status);
`, "utf-8");
  fs.chmodSync(wrapperPath, 0o755);
  return {
    env: {
      PATH: `${wrapperDir}:${process.env.PATH ?? ""}`,
      MBLC_LEDGER_PATH: ledgerPath,
    },
    getLedger: () => {
      if (!fs.existsSync(ledgerPath)) return [];
      return fs.readFileSync(ledgerPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    },
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
    assert.match(result.stdout, /worktree list --porcelain/);
    assert.match(result.stdout, /checked-out[\s\S]*refusal[\s\S]*exit code 1/i);
    assert.match(result.stdout, /not a partial landing/i);
    assert.match(result.stdout, /not a retryable lock wait/i);
    assert.match(result.stdout, /CHECKOUT_REFRESH: not-applicable/);
    assert.doesNotMatch(result.stdout, /CHECKOUT_REFRESH: <refreshed/);
    assert.doesNotMatch(result.stdout, /post-CAS/);
    assert.doesNotMatch(result.stdout, /rollback/);
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

  it("reports an already-landed unowned branch with not-applicable and no target mutation", () => {
    const { repo, initial } = createRepo();
    createFeature(repo, initial);
    git(repo, ["merge", "--ff-only", "feature"]);
    git(repo, ["branch", "staging", "refs/heads/main"]);
    git(repo, ["checkout", "-b", "other", initial]);
    const targetBefore = git(repo, ["rev-parse", "refs/heads/staging"]);
    const treeBefore = git(repo, ["rev-parse", "refs/heads/staging^{tree}"]);
    const commitCountBefore = git(repo, ["rev-list", "--count", "refs/heads/staging"]);

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
        checkoutRefresh?: string;
      });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "merge.landed");
    assert.equal(events[0]?.noop, true);
    assert.equal(events[0]?.mergedCommit, targetBefore);
    assert.equal(events[0]?.mergedTree, treeBefore);
    assert.equal(events[0]?.checkoutRefresh, "not-applicable");
  });

  it("reports not-applicable for an unowned no-op without altering checkout state", () => {
    const { repo, initial } = createRepo();
    createFeature(repo, initial);
    const featureTip = git(repo, ["rev-parse", "refs/heads/feature"]);
    git(repo, ["branch", "staging", featureTip]);
    const before = captureCheckoutState(repo);

    const result = runCli(validArgs(repo, featureTip, "staging"));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^NOOP: true$/m);
    assert.match(result.stdout, /^CHECKOUT_REFRESH: not-applicable$/m);
    assert.equal(readEvents(path.join(result.testHome.tamanduaDir, "events", "all.jsonl"))[0]?.checkoutRefresh, "not-applicable");
    assert.deepEqual(captureCheckoutState(repo), before);
  });

  it("refuses a root checked-out non-no-op target with exit code 1 and operator diagnostics", () => {
    const { repo, initial } = createRepo();
    createFeature(repo, initial);
    const rootBranchBefore = git(repo, ["symbolic-ref", "--short", "HEAD"]);
    const targetRefBefore = git(repo, ["rev-parse", "refs/heads/main"]);
    const targetIndexPath = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const targetIndexBytesBefore = fs.readFileSync(targetIndexPath);
    const rootBefore = captureCheckoutState(repo);

    const result = runCli(validArgs(repo, initial, "main"));

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /checked-out target landing is disabled/i);
    assert.match(result.stderr, /exact owned-index-lock release cannot be guaranteed/i);
    assert.match(result.stderr, /this is not a partial landing/i);
    assert.match(result.stderr, /this is not a retryable lock wait/i);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), targetRefBefore);
    assert.equal(git(repo, ["symbolic-ref", "--short", "HEAD"]), rootBranchBefore);
    assert.deepEqual(fs.readFileSync(targetIndexPath), targetIndexBytesBefore);
    assert.deepEqual(captureCheckoutState(repo), rootBefore);
    assert.deepEqual(readEvents(path.join(result.testHome.tamanduaDir, "events", "all.jsonl")), []);
  });

  it("refuses a linked checked-out non-no-op target with exit code 1 and preserves root state", () => {
    const { repo, targetWorktree, initial } = createLinkedTargetRepo();
    const rootBranchBefore = git(repo, ["symbolic-ref", "HEAD"]);
    const rootBefore = captureCheckoutState(repo);
    const linkedBefore = captureCheckoutState(targetWorktree);
    const targetIndexPath = git(targetWorktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const targetIndexBytesBefore = fs.readFileSync(targetIndexPath);

    const result = runCli(validArgs(repo, initial, "staging"));

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /checked-out target landing is disabled/i);
    assert.match(result.stderr, /exact owned-index-lock release cannot be guaranteed/i);
    assert.match(result.stderr, /this is not a partial landing/i);
    assert.match(result.stderr, /this is not a retryable lock wait/i);
    assert.equal(git(repo, ["rev-parse", "refs/heads/staging"]), initial);
    assert.deepEqual(captureCheckoutState(repo), rootBefore);
    assert.deepEqual(captureCheckoutState(targetWorktree), linkedBefore);
    assert.deepEqual(fs.readFileSync(targetIndexPath), targetIndexBytesBefore);
    assert.deepEqual(readEvents(path.join(result.testHome.tamanduaDir, "events", "all.jsonl")), []);
  });

  it("refuses a checked-out would-be no-op without resolving candidate or emitting events", () => {
    const { repo, initial } = createRepo();
    createFeature(repo, initial);
    const featureTip = git(repo, ["rev-parse", "refs/heads/feature"]);
    git(repo, ["branch", "staging", featureTip]);
    const targetWorktree = tamanduaTempDir("tamandua-merge-branch-cli-noop-linked-");
    cleanup.push(targetWorktree);
    git(repo, ["worktree", "add", targetWorktree, "staging"]);
    const rootBefore = captureCheckoutState(repo);
    const linkedBefore = captureCheckoutState(targetWorktree);

    const wrapper = createWrappedGitLedger(repo);
    const result = runCli(validArgs(repo, featureTip, "staging"), wrapper.env);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /checked-out target landing is disabled/i);
    assert.deepEqual(captureCheckoutState(repo), rootBefore);
    assert.deepEqual(captureCheckoutState(targetWorktree), linkedBefore);
    assert.deepEqual(readEvents(path.join(result.testHome.tamanduaDir, "events", "all.jsonl")), []);

    const ledger = wrapper.getLedger();
    const wtListIdx = ledger.findIndex((cmd) => cmd[0] === "-C" && cmd[2] === "worktree" && cmd[3] === "list");
    assert.ok(wtListIdx !== -1, "expected worktree list in command ledger");
    const commandsAfterWtList = ledger.slice(wtListIdx + 1);
    assert.deepEqual(commandsAfterWtList, [], "no commands after worktree list for checked-out refusal");
    const commandNamesBefore = ledger.slice(0, wtListIdx).map((cmd) => cmd[0] === "-C" ? cmd[2] : cmd[0]);
    assert.ok(commandNamesBefore.every((n) => n === "rev-parse"), `unexpected commands before worktree list: ${commandNamesBefore.join(", ")}`);
  });

  it("preserves index-lock bytes and operator files through checked-out refusal", () => {
    const { repo, initial } = createRepo();
    createFeature(repo, initial);
    const operatorNotesPath = path.join(repo, "operator-notes.txt");
    const operatorBytes = Buffer.from("ordinary operator bytes\n");
    fs.writeFileSync(operatorNotesPath, operatorBytes);

    const rootBranchBefore = git(repo, ["symbolic-ref", "HEAD"]);
    const targetIndexPath = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const targetIndexBytesBefore = fs.readFileSync(targetIndexPath);
    const targetIndexTreeBefore = git(repo, ["write-tree"]);
    const targetHeadBefore = git(repo, ["rev-parse", "HEAD"]);
    const targetHeadTreeBefore = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const refsBefore = git(repo, ["show-ref"]);
    const objectCountBefore = Number(git(repo, ["count-objects", "-v"]).match(/count: (\d+)/)?.[1] ?? "0");

    const lockPath = path.join(repo, ".git", "index.lock");
    const lockBytes = Buffer.from("pre-existing lock payload\n");
    fs.writeFileSync(lockPath, lockBytes);
    const lockStat = fs.statSync(lockPath);

    const result = runCli(validArgs(repo, initial, "main"));

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /checked-out target landing is disabled/i);
    assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), targetHeadBefore);
    assert.equal(git(repo, ["symbolic-ref", "HEAD"]), rootBranchBefore);
    assert.equal(git(repo, ["rev-parse", "HEAD"]), targetHeadBefore);
    assert.equal(git(repo, ["rev-parse", "HEAD^{tree}"]), targetHeadTreeBefore);
    assert.deepEqual(fs.readFileSync(targetIndexPath), targetIndexBytesBefore);
    assert.deepEqual(fs.readFileSync(operatorNotesPath), operatorBytes);
    const lockAfter = fs.statSync(lockPath);
    assert.ok(lockAfter.isFile());
    assert.deepEqual(fs.readFileSync(lockPath), lockBytes);
    assert.equal(lockAfter.mode, lockStat.mode);
    assert.equal(lockAfter.mtimeMs, lockStat.mtimeMs);
    assert.equal(git(repo, ["show-ref"]), refsBefore);
    assert.equal(Number(git(repo, ["count-objects", "-v"]).match(/count: (\d+)/)?.[1] ?? "0"), objectCountBefore);
    assert.deepEqual(readEvents(path.join(result.testHome.tamanduaDir, "events", "all.jsonl")), []);
    assert.equal(
      fs.existsSync(path.join(repo, ".git", "tamandua.merge.lock")),
      false,
      "no Tamandua/quarantine lock artifacts",
    );
    assert.equal(
      fs.existsSync(path.join(repo, ".git", "tamandua.merge.quarantine")),
      false,
      "no Tamandua/quarantine directory artifacts",
    );

    // Clean up the lock so cleanup doesn't fail
    fs.unlinkSync(lockPath);
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