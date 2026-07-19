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

function collectObjectFiles(objectsDir: string) {
  const result: Array<{ relativePath: string; bytes: Buffer; mode: number; size: bigint; mtimeNs: bigint }> = [];
  function walk(dir: string, prefix: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        const st = fs.statSync(full, { bigint: true });
        result.push({ relativePath: rel, bytes: fs.readFileSync(full), mode: st.mode, size: st.size, mtimeNs: st.mtimeNs });
      }
    }
  }
  walk(objectsDir, "");
  result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return result;
}

function captureExactSnapshot(
  repo: string,
  ownerWorktree: string,
  targetBranch: string,
  ignoredCollisionPaths: string[],
  eventsPath?: string,
) {
  const commonGitDir = git(ownerWorktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const objectsDir = path.join(commonGitDir, "objects");
  const ownerGitDir = git(ownerWorktree, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const ownerIndexPath = git(ownerWorktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);

  const objectFiles = collectObjectFiles(objectsDir);

  const idxCopyDir = tamanduaTempDir("tamandua-mblc-idx-");
  cleanup.push(idxCopyDir);
  const tempIndex = path.join(idxCopyDir, "index");
  fs.copyFileSync(ownerIndexPath, tempIndex);
  const writeTreeResult = spawnSync("git", ["write-tree"], {
    cwd: ownerWorktree,
    encoding: "utf-8",
    env: { ...process.env, GIT_INDEX_FILE: tempIndex },
  });
  assert.equal(writeTreeResult.status, 0, `git write-tree failed: ${writeTreeResult.stderr}`);
  const indexTree = writeTreeResult.stdout.trim();
  fs.rmSync(idxCopyDir, { recursive: true, force: true });

  const idxStat = fs.statSync(ownerIndexPath, { bigint: true });

  const trackedFileList = git(ownerWorktree, ["ls-files", "--cached"])
    .split("\n")
    .filter(Boolean)
    .sort();
  const trackedFiles: Array<[string, Buffer]> = trackedFileList.map(
    (f) => [f, fs.readFileSync(path.join(ownerWorktree, f))] as [string, Buffer],
  );

  const untrackedFileList = git(ownerWorktree, ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter(Boolean)
    .sort();
  const untrackedFiles: Array<[string, Buffer]> = untrackedFileList.map(
    (f) => [f, fs.readFileSync(path.join(ownerWorktree, f))] as [string, Buffer],
  );

  const ignoredCollisionFiles: Array<[string, Buffer]> = ignoredCollisionPaths
    .slice()
    .sort()
    .map((f) => [f, fs.readFileSync(path.join(ownerWorktree, f))] as [string, Buffer]);

  const lockPath = path.join(ownerGitDir, "index.lock");
  let indexLock: {
    dev: bigint;
    ino: bigint;
    bytes: Buffer;
    mode: number;
    size: bigint;
    mtimeNs: bigint;
  } | null = null;
  if (fs.existsSync(lockPath)) {
    const lkStat = fs.statSync(lockPath, { bigint: true });
    indexLock = {
      dev: lkStat.dev,
      ino: lkStat.ino,
      bytes: fs.readFileSync(lockPath),
      mode: lkStat.mode,
      size: lkStat.size,
      mtimeNs: lkStat.mtimeNs,
    };
  }

  const tamanduaQuarantineFilenames = fs
    .readdirSync(ownerGitDir)
    .filter((n) => /tamandua|quarantine/i.test(n))
    .sort();

  const events =
    eventsPath && fs.existsSync(eventsPath)
      ? fs
          .readFileSync(eventsPath, "utf-8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

  return {
    refs: git(repo, ["for-each-ref", "--sort=refname", "--format=%(refname) %(objectname)"]),
    objectFiles,
    symbolicHead: git(ownerWorktree, ["symbolic-ref", "HEAD"]),
    headCommit: git(ownerWorktree, ["rev-parse", "HEAD"]),
    headTree: git(ownerWorktree, ["rev-parse", "HEAD^{tree}"]),
    targetRefTip: git(repo, ["rev-parse", `refs/heads/${targetBranch}`]),
    indexTree,
    indexBytes: fs.readFileSync(ownerIndexPath),
    indexMode: idxStat.mode,
    indexSize: idxStat.size,
    indexMtimeNs: idxStat.mtimeNs,
    trackedFiles,
    untrackedFiles,
    ignoredCollisionFiles,
    indexLock,
    tamanduaQuarantineFilenames,
    events,
  };
}

function createWrappedGitLedger(): { env: Record<string, string>; getLedger: () => string[][] } {
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

    const wrapper = createWrappedGitLedger();
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

  it("proves exact CLI boundary through checked-out refusal with full repository snapshot", () => {
    // 1. Create the base repository.
    const { repo, initial } = createRepo();

    // 2. Add and commit .gitignore on the target baseline.
    fs.writeFileSync(path.join(repo, ".gitignore"), "collision/\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-m", "add .gitignore with collision rule"]);
    const baselineTip = git(repo, ["rev-parse", "HEAD"]);

    // 3. Create the candidate feature from the baseline tip.
    git(repo, ["switch", "-c", "feature", baselineTip]);
    fs.mkdirSync(path.join(repo, "collision"));
    fs.writeFileSync(path.join(repo, "collision", "data.txt"), "candidate collision bytes\n");
    git(repo, ["add", "-f", "collision/data.txt"]);
    fs.writeFileSync(path.join(repo, "ordinary.txt"), "candidate ordinary\n");
    git(repo, ["add", "ordinary.txt"]);
    git(repo, ["commit", "-m", "candidate with tracked collision and ordinary"]);
    const featureTip = git(repo, ["rev-parse", "HEAD"]);

    // 4. Return the root checkout to a different branch.
    git(repo, ["switch", "main"]);

    // 5. Create staging at the baseline tip and create the linked worktree.
    git(repo, ["branch", "staging", baselineTip]);
    const targetWorktree = tamanduaTempDir("tamandua-merge-branch-cli-linked-");
    cleanup.push(targetWorktree);
    git(repo, ["worktree", "add", targetWorktree, "staging"]);
    const stagingTip = git(repo, ["rev-parse", "refs/heads/staging"]);

    // 6. Populate target owner with operator artifacts.
    fs.writeFileSync(path.join(targetWorktree, "untracked.txt"), "operator untracked bytes\n");
    fs.mkdirSync(path.join(targetWorktree, "collision"));
    fs.writeFileSync(path.join(targetWorktree, "collision", "data.txt"), "operator collision bytes\n");

    const ownerGitDir = git(targetWorktree, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    const lockPath = path.join(ownerGitDir, "index.lock");
    const lockBytes = Buffer.from("pre-existing lock payload\n");
    fs.writeFileSync(lockPath, lockBytes);
    fs.chmodSync(lockPath, 0o600);

    // 7. Assert Git ignore and file listing before snapshot.
    const checkIgnore = rawGit(targetWorktree, ["check-ignore", "collision/data.txt"]);
    assert.equal(checkIgnore.status, 0, `check-ignore failed: ${checkIgnore.stderr}`);
    assert.equal(checkIgnore.stdout, "collision/data.txt");

    const others = git(targetWorktree, ["ls-files", "--others", "--exclude-standard"])
      .split("\n")
      .filter(Boolean);
    assert.ok(others.includes("untracked.txt"), "untracked.txt should appear in ls-files --others");
    assert.ok(!others.includes("collision/data.txt"), "collision/data.txt should be ignored and excluded");

    // Candidate tree contains the tracked collision path.
    assert.ok(
      git(repo, ["ls-tree", featureTip, "collision/data.txt"]).length > 0,
      "candidate tree should contain collision/data.txt",
    );

    // Target baseline tree contains .gitignore but not collision/data.txt.
    const baselineLs = git(repo, ["ls-tree", baselineTip]);
    assert.ok(baselineLs.includes(".gitignore"), "baseline tree should contain .gitignore");
    assert.ok(!baselineLs.includes("collision"), "baseline tree should not contain collision");

    // 8. Exact snapshot BEFORE CLI invocation.
    const before = captureExactSnapshot(repo, targetWorktree, "staging", ["collision/data.txt"]);

    // 9. Run the CLI under ledger wrapper, targeting the checked-out staging branch.
    const wrapper = createWrappedGitLedger();
    const result = runCli(validArgs(repo, stagingTip, "staging"), wrapper.env);
    const eventsPath = path.join(result.testHome.tamanduaDir, "events", "all.jsonl");
    const after = captureExactSnapshot(repo, targetWorktree, "staging", ["collision/data.txt"], eventsPath);

    // --- CLI behavioural assertions ---
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Error: /);
    const detail = result.stderr.replace(/^Error: /, "").replace(/\n$/, "");
    assert.ok(detail.length <= 512, `detail length ${detail.length} > 512`);
    assert.match(detail, /checked-out target landing is disabled/);
    assert.match(detail, /exact owned-index-lock release cannot be guaranteed/);
    assert.match(detail, /this is not a partial landing/);
    assert.match(detail, /this is not a retryable lock wait/);
    assert.deepEqual(readEvents(eventsPath), []);

    // --- Command ledger: exactly rev-parse then worktree list, nothing after ---
    const ledger = wrapper.getLedger();
    assert.equal(ledger.length, 2, `unexpected ledger length ${ledger.length}`);
    assert.deepEqual(ledger[0], ["-C", repo, "rev-parse", "--verify", "refs/heads/staging"]);
    assert.deepEqual(ledger[1], ["-C", repo, "worktree", "list", "--porcelain", "-z"]);

    // --- Repository snapshot: nothing changed ---
    assert.deepEqual(after, before);

    // Clean up the lock so afterEach cleanup doesn't fail.
    fs.unlinkSync(lockPath);
  });

  it("reports not-applicable CHECKOUT_REFRESH for a bare origin", () => {
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
