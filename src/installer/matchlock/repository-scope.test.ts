/**
 * repository-scope.test.ts — MTLK-ADMIT (serial lane: spawns the real git
 * binary and builds real fixture repositories under owned temp dirs).
 */
import { describe, it, before, after } from "node:test";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  resolveRepositoryScope,
  admittedRootMatches,
  canonicalRealPath,
} from "../../../dist/installer/matchlock/repository-scope.js";
import { admittedRootsFromPolicy } from "../../../dist/installer/matchlock/pi-invocation-runner.js";
import type { ExecutionIsolation } from "../../../dist/installer/matchlock/policy.js";

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr?.trim() ?? ""}`);
  }
  return (result.stdout ?? "").trim();
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "--initial-branch=main"], dir);
  git(["config", "user.email", "scope@tamandua.test"], dir);
  git(["config", "user.name", "Scope Test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# repo\n", "utf-8");
  git(["add", "README.md"], dir);
  git(["commit", "-m", "initial"], dir);
}

describe("matchlock repository-scope resolution (real git)", () => {
  let tmpRoot: string;

  before(() => {
    tmpRoot = tamanduaTempDir("mtlk-scope-");
  });

  after(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("resolves a plain checkout: top level, git dir and common dir under the repo", () => {
    const repo = path.join(tmpRoot, "plain");
    initRepo(repo);
    const scope = resolveRepositoryScope(repo);
    assert.equal(scope.topLevel, repo);
    assert.equal(scope.gitDir, path.join(repo, ".git"));
    assert.equal(scope.commonDir, path.join(repo, ".git"));
    assert.equal(scope.mainWorktree, repo);
    assert.equal(scope.bare, false);
  });

  it("resolves a cwd INSIDE the repo to the repo top level (direct subdir case)", () => {
    const repo = path.join(tmpRoot, "subdir-repo");
    initRepo(repo);
    const sub = path.join(repo, "nested", "deep");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "file.txt"), "x\n", "utf-8");
    const scope = resolveRepositoryScope(sub);
    assert.equal(scope.topLevel, repo);
    assert.equal(scope.gitDir, path.join(repo, ".git"));
    assert.equal(scope.mainWorktree, repo);
  });

  it("resolves a NON-repository directory to an all-null scope (mounts itself only)", () => {
    const plain = path.join(tmpRoot, "not-a-repo");
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(plain, "a.txt"), "a\n", "utf-8");
    const scope = resolveRepositoryScope(plain);
    assert.deepEqual(scope, {
      topLevel: null,
      gitDir: null,
      commonDir: null,
      mainWorktree: null,
      bare: false,
    });
  });

  it("resolves a LINKED worktree to its own top level plus the original checkout (commondir followed)", () => {
    const repo = path.join(tmpRoot, "wt-origin");
    initRepo(repo);
    const worktree = path.join(tmpRoot, "wt-linked");
    git(["worktree", "add", "-b", "feat", worktree], repo);
    const scope = resolveRepositoryScope(worktree);
    // The worktree's own top level is the worktree path.
    assert.equal(scope.topLevel, worktree);
    // Its git dir lives under the origin's .git/worktrees.
    assert.ok(scope.gitDir!.startsWith(path.join(repo, ".git", "worktrees") + path.sep), scope.gitDir ?? "");
    // Its COMMON dir is the ORIGIN's .git (git rev-parse --git-common-dir).
    assert.equal(scope.commonDir, path.join(repo, ".git"));
    // The main/original checkout is the origin repository.
    assert.equal(scope.mainWorktree, repo);
    assert.equal(scope.bare, false);
  });

  it("resolves a separate-git-dir checkout: external git/common dir at their own exact path", () => {
    const checkout = path.join(tmpRoot, "sep-checkout");
    const gitDir = path.join(tmpRoot, "sep-gitdir");
    fs.mkdirSync(checkout, { recursive: true });
    // git init --separate-git-dir writes a .git FILE in the checkout.
    git(["init", "--initial-branch=main", `--separate-git-dir=${gitDir}`], checkout);
    git(["config", "user.email", "scope@tamandua.test"], checkout);
    git(["config", "user.name", "Scope Test"], checkout);
    fs.writeFileSync(path.join(checkout, "README.md"), "# sep\n", "utf-8");
    git(["add", "README.md"], checkout);
    git(["commit", "-m", "initial"], checkout);

    const dotGit = path.join(checkout, ".git");
    assert.ok(fs.statSync(dotGit).isFile(), ".git must be a file in a separate-git-dir layout");

    const scope = resolveRepositoryScope(checkout);
    assert.equal(scope.topLevel, checkout);
    assert.equal(scope.gitDir, gitDir);
    assert.equal(scope.commonDir, gitDir);
    // The checkout is the main (only) worktree of that external git dir.
    assert.equal(scope.mainWorktree, checkout);
    assert.equal(scope.bare, false);
  });

  it("treats a bare repository directory as NOT a working-tree scope (all null)", () => {
    const bare = path.join(tmpRoot, "bare.git");
    git(["init", "--bare", "bare.git"], tmpRoot);
    const scope = resolveRepositoryScope(bare);
    assert.equal(scope.topLevel, null);
    assert.equal(scope.commonDir, null);
  });
});

describe("matchlock admitted-root realpath identity (US-001)", () => {
  let tmpRoot: string;

  before(() => {
    tmpRoot = tamanduaTempDir("mtlk-admitted-");
  });

  after(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Create a real directory plus a symlink spelling of it. */
  function symlinkPair(name: string): { real: string; link: string } {
    const real = path.join(tmpRoot, name);
    fs.mkdirSync(real, { recursive: true });
    const link = path.join(tmpRoot, `${name}-link`);
    fs.symlinkSync(real, link);
    return { real, link };
  }

  it("returns true for an identical string", () => {
    const { real } = symlinkPair("identical");
    assert.equal(admittedRootMatches(real, [real]), true);
  });

  it("matches a symlink-spelled request against the canonical admitted root", () => {
    const { real, link } = symlinkPair("req-symlink");
    assert.equal(admittedRootMatches(link, [real]), true);
  });

  it("matches a canonical request against the symlink-spelled admitted root", () => {
    const { real, link } = symlinkPair("req-canonical");
    assert.equal(admittedRootMatches(real, [link]), true);
  });

  it("never accepts an unrelated root", () => {
    const { real } = symlinkPair("unrelated-admitted");
    const other = path.join(tmpRoot, "unrelated-request");
    fs.mkdirSync(other, { recursive: true });
    assert.equal(admittedRootMatches(other, [real]), false);
  });

  it("returns false (never throws) for a non-existent requested path that matches no admitted root", () => {
    const { real } = symlinkPair("absent-admitted");
    const absent = path.join(tmpRoot, "does-not-exist", "deeper");
    assert.equal(fs.existsSync(absent), false);
    assert.equal(admittedRootMatches(absent, [real]), false);
    assert.equal(admittedRootMatches(absent, []), false);
  });

  it("does not accept a root that merely shares a string prefix with an admitted root", () => {
    const admitted = path.join(tmpRoot, "prefix-admitted");
    fs.mkdirSync(admitted, { recursive: true });
    const prefixSibling = `${admitted}-evil`;
    fs.mkdirSync(prefixSibling, { recursive: true });
    assert.equal(admittedRootMatches(prefixSibling, [admitted]), false);
  });

  it("admittedRootsFromPolicy carries BOTH spellings for a symlinked originalRepositoryRoot and work mount, deduped", () => {
    const { real, link } = symlinkPair("policy-both");
    const canonical = canonicalRealPath(real);
    const policy = {
      originalRepositoryRoot: link,
      workMounts: [{ hostPath: link, hostRealPath: canonical, guestPath: link }],
    } as unknown as ExecutionIsolation;
    const roots = admittedRootsFromPolicy(policy);
    assert.deepEqual(roots, [link, canonical]);
  });

  it("admittedRootsFromPolicy dedupes when the exact spelling and canonical target coincide", () => {
    const { real } = symlinkPair("policy-dedupe");
    const canonical = canonicalRealPath(real);
    const policy = {
      originalRepositoryRoot: canonical,
      workMounts: [{ hostPath: canonical, hostRealPath: canonical, guestPath: canonical }],
    } as unknown as ExecutionIsolation;
    assert.deepEqual(admittedRootsFromPolicy(policy), [canonical]);
  });

  it("admittedRootsFromPolicy records the original spelling first, then its canonical target", () => {
    const { real, link } = symlinkPair("policy-order");
    const canonical = canonicalRealPath(real);
    const policy = {
      originalRepositoryRoot: link,
      workMounts: [{ hostPath: real, hostRealPath: canonical, guestPath: real }],
    } as unknown as ExecutionIsolation;
    const roots = admittedRootsFromPolicy(policy);
    assert.equal(roots[0], link);
    assert.ok(roots.includes(canonical), `expected canonical ${canonical} in ${JSON.stringify(roots)}`);
    assert.equal(new Set(roots).size, roots.length, "no duplicate admitted roots");
  });

  it("admittedRootsFromPolicy tolerates a null originalRepositoryRoot", () => {
    const { real, link } = symlinkPair("policy-null-origin");
    const canonical = canonicalRealPath(real);
    const policy = {
      originalRepositoryRoot: null,
      workMounts: [{ hostPath: link, hostRealPath: canonical, guestPath: link }],
    } as unknown as ExecutionIsolation;
    assert.deepEqual(admittedRootsFromPolicy(policy), [link, canonical]);
  });
});
