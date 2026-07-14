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

function runCli(args: string[]) {
  const testHome = createTempHome("tamandua-merge-branch-cli-home-");
  cleanup.push(testHome.root);
  return spawnSync("/bin/sh", [path.resolve("bin/tamandua"), ...args], {
    encoding: "utf-8",
    env: cleanChildEnv({
      HOME: testHome.homeDir,
      TAMANDUA_STATE_DIR: testHome.tamanduaDir,
    }),
  });
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
    assert.match(result.stdout, /STATUS: target_moved/);
    assert.match(result.stdout, /STATUS: conflicts/);
    assert.match(result.stdout, /CHECKOUT_REFRESH: <refreshed \| skipped:<reason> \| not-applicable>/);
    assert.match(result.stdout, /refreshed[\s\S]*skipped:<reason>[\s\S]*not-applicable/);
    assert.match(result.stdout, /Exit codes:[\s\S]*0[\s\S]*2[\s\S]*3/);
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

  it("STCK reports skipped while preserving a touched local change", () => {
    const { repo, initial } = createRepo();
    createFeatureChangingBase(repo, initial);
    const localContents = "local change\n";
    fs.writeFileSync(path.join(repo, "base.txt"), localContents, "utf-8");

    const result = runCli(validArgs(repo, initial, "main"));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^STATUS: landed$/m);
    assert.match(result.stdout, /^CHECKOUT_REFRESH: skipped:.+$/m);
    assert.equal(fs.readFileSync(path.join(repo, "base.txt"), "utf-8"), localContents);
    assert.notEqual(git(repo, ["rev-parse", "refs/heads/main"]), initial);
    assert.equal(git(repo, ["show", "refs/heads/main:base.txt"]), "feature change");
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