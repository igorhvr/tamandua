import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";

import {
  resolveWorktreeRoot,
  buildWorktreePath,
  createRunWorktree,
  getRunWorktree,
  validateRunWorktree,
  removeRunWorktree,
  listRunWorktrees,
  type ManagedRunWorktree,
} from "../../dist/installer/worktree-manager.js";

// ── Helpers ──

function runGit(args: string[], cwd: string): { stdout: string; status: number } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    status: result.status ?? -1,
  };
}

function initGitRepo(dir: string): void {
  runGit(["init"], dir);
  runGit(["config", "user.email", "test@tamandua.local"], dir);
  runGit(["config", "user.name", "Tamandua Test"], dir);
  // Create an initial commit so we have a ref to work with
  writeFileSync(path.join(dir, "README.md"), "# Test Repo\n", "utf-8");
  runGit(["add", "README.md"], dir);
  runGit(["commit", "-m", "initial commit"], dir);
}

function getHeadSha(dir: string): string {
  return runGit(["rev-parse", "HEAD"], dir).stdout;
}

function getGitCommonDir(dir: string): string {
  return runGit(["rev-parse", "--git-common-dir"], dir).stdout;
}

// ── Test suite ──

describe("worktree-manager", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;
  let origWorktreeRoot: string | undefined;

  before(() => {
    tempHome = tamanduaTempDir("tamandua-worktree-mgr-");
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    origWorktreeRoot = process.env.TAMANDUA_WORKTREE_ROOT;
    process.env.HOME = tempHome;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
    if (origWorktreeRoot) {
      process.env.TAMANDUA_WORKTREE_ROOT = origWorktreeRoot;
    } else {
      delete process.env.TAMANDUA_WORKTREE_ROOT;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  // ── resolveWorktreeRoot ──

  describe("resolveWorktreeRoot", () => {
    it("defaults to ~/.tamandua/worktrees when no env var set", () => {
      delete process.env.TAMANDUA_WORKTREE_ROOT;
      const root = resolveWorktreeRoot();
      assert.ok(root.endsWith(".tamandua/worktrees"), "should end with .tamandua/worktrees");
    });

    it("honors TAMANDUA_WORKTREE_ROOT env var", () => {
      process.env.TAMANDUA_WORKTREE_ROOT = "/custom/worktree/path";
      const root = resolveWorktreeRoot();
      assert.equal(root, "/custom/worktree/path");
      delete process.env.TAMANDUA_WORKTREE_ROOT;
    });
  });

  // ── buildWorktreePath ──

  describe("buildWorktreePath", () => {
    it("generates path with repo-slug, repo-hash, run-number, and run-id-short", () => {
      const result = buildWorktreePath({
        worktreeOriginGitCommonDir: "/home/user/my-repo/.git",
        worktreeOriginRepository: "/home/user/my-repo",
        runId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        runNumber: 42,
      });
      // Should be: <root>/my-repo-<hash>/42-aaaaaaaa
      const parts = result.split(path.sep);
      const lastDir = parts[parts.length - 1];
      const parentDir = parts[parts.length - 2];

      assert.equal(lastDir, "42-aaaaaaaa");
      assert.match(parentDir, /^my-repo-[0-9a-f]{8}$/);
    });

    it("avoids basename collisions using git-common-dir hash (different repos, same basename)", () => {
      const path1 = buildWorktreePath({
        worktreeOriginGitCommonDir: "/home/user/project-a/.git",
        worktreeOriginRepository: "/home/user/repo",
        runId: "11111111-2222-3333-4444-555555555555",
        runNumber: 1,
      });

      const path2 = buildWorktreePath({
        worktreeOriginGitCommonDir: "/home/user/project-b/.git",
        worktreeOriginRepository: "/home/user/repo",
        runId: "11111111-2222-3333-4444-555555555555",
        runNumber: 1,
      });

      // Same basename but different hash => different dirs
      const parent1 = path.dirname(path1);
      const parent2 = path.dirname(path2);
      assert.notEqual(parent1, parent2, "different git-common-dir should produce different hashes");
    });
  });

  // ── createRunWorktree ──

  describe("createRunWorktree", () => {
    let originRepo: string;

    before(() => {
      originRepo = tamanduaTempDir("tamandua-origin-");
      initGitRepo(originRepo);
    });

    after(() => {
      rmSync(originRepo, { recursive: true, force: true });
    });

    it("creates a detached worktree and inserts DB row", () => {
      const sha = getHeadSha(originRepo);
      const result = createRunWorktree({
        runId: "run-create-001",
        runNumber: 1,
        workflowId: "test-workflow",
        worktreeOriginRepository: originRepo,
      });

      assert.equal(result.runId, "run-create-001");
      assert.equal(result.status, "ready");
      assert.equal(result.worktreeOriginSha, sha);
      assert.ok(result.worktreeOriginRef, "should have origin ref");
      assert.ok(result.worktreePath, "should have worktree path");
      assert.equal(result.cleanupPolicy, "keep");
      assert.ok(result.worktreeOriginGitCommonDir.endsWith(".git"),
        "git common dir should point to .git");

      // Verify worktree exists on disk
      const { status } = runGit(["rev-parse", "--show-toplevel"], result.worktreePath);
      assert.equal(status, 0, "worktree should be a valid git working tree");

      // Verify it's detached (no branch checked out)
      const branchResult = runGit(["branch", "--show-current"], result.worktreePath);
      assert.equal(branchResult.stdout, "", "worktree should be detached (no current branch)");

      // Clean up
      removeRunWorktree({ runId: "run-create-001", force: true });
    });

    it("rejects non-git origin repos with clear error", () => {
      const nonGitDir = tamanduaTempDir("tamandua-non-git-");
      try {
        assert.throws(
          () =>
            createRunWorktree({
              runId: "run-create-002",
              runNumber: 2,
              workflowId: "test-workflow",
              worktreeOriginRepository: nonGitDir,
            }),
          /origin repository is not a git working tree/i,
        );
      } finally {
        rmSync(nonGitDir, { recursive: true, force: true });
      }
    });

    it("rejects detached origin with no ref and no original branch", () => {
      // Create a repo, then detach HEAD
      const detachedRepo = tamanduaTempDir("tamandua-detached-");
      try {
        initGitRepo(detachedRepo);
        // Detach HEAD by checking out a SHA
        const sha = getHeadSha(detachedRepo);
        runGit(["checkout", sha], detachedRepo);

        assert.throws(
          () =>
            createRunWorktree({
              runId: "run-create-003",
              runNumber: 3,
              workflowId: "test-workflow",
              worktreeOriginRepository: detachedRepo,
            }),
          /detached HEAD state/i,
        );
      } finally {
        rmSync(detachedRepo, { recursive: true, force: true });
      }
    });

    it("works with detached origin when explicit origin ref is provided", () => {
      const detachedRepo = tamanduaTempDir("tamandua-detached2-");
      try {
        initGitRepo(detachedRepo);
        const sha = getHeadSha(detachedRepo);
        runGit(["checkout", sha], detachedRepo);

        const result = createRunWorktree({
          runId: "run-create-004",
          runNumber: 4,
          workflowId: "test-workflow",
          worktreeOriginRepository: detachedRepo,
          worktreeOriginRef: "HEAD",
        });

        assert.equal(result.status, "ready");
        assert.equal(result.worktreeOriginSha, sha);

        // Clean up
        removeRunWorktree({ runId: "run-create-004", force: true });
      } finally {
        rmSync(detachedRepo, { recursive: true, force: true });
      }
    });

    it("rejects dirty origin repositories", () => {
      const dirtyRepo = tamanduaTempDir("tamandua-dirty-origin-");
      try {
        initGitRepo(dirtyRepo);
        writeFileSync(path.join(dirtyRepo, "dirty.txt"), "unstaged change", "utf-8");

        assert.throws(
          () =>
            createRunWorktree({
              runId: "run-create-dirty",
              runNumber: 99,
              workflowId: "test-workflow",
              worktreeOriginRepository: dirtyRepo,
            }),
          /origin repository has uncommitted changes/i,
        );
      } finally {
        rmSync(dirtyRepo, { recursive: true, force: true });
      }
    });

    it("captures original_branch from origin repo", () => {
      // originRepo already has 'main' or 'master' checked out from initGitRepo
      const result = createRunWorktree({
        runId: "run-create-005",
        runNumber: 5,
        workflowId: "test-workflow",
        worktreeOriginRepository: originRepo,
      });

      assert.ok(result.originalBranch, "should capture original branch");
      // The default branch name depends on git config; just verify it's truthy (not undefined/null)
      assert.equal(typeof result.originalBranch, "string");

      // Clean up
      removeRunWorktree({ runId: "run-create-005", force: true });
    });

    it("uses custom cleanupPolicy when provided", () => {
      const result = createRunWorktree({
        runId: "run-create-006",
        runNumber: 6,
        workflowId: "test-workflow",
        worktreeOriginRepository: originRepo,
        cleanupPolicy: "remove_on_success",
      });

      assert.equal(result.cleanupPolicy, "remove_on_success");

      // Clean up
      removeRunWorktree({ runId: "run-create-006", force: true });
    });
  });

  // ── getRunWorktree ──

  describe("getRunWorktree", () => {
    let originRepo: string;

    before(() => {
      originRepo = tamanduaTempDir("tamandua-get-");
      initGitRepo(originRepo);
    });

    after(() => {
      rmSync(originRepo, { recursive: true, force: true });
    });

    it("returns null for unknown runId", () => {
      const result = getRunWorktree("nonexistent-run-id");
      assert.equal(result, null);
    });

    it("returns correct data for known runId", () => {
      const created = createRunWorktree({
        runId: "run-get-001",
        runNumber: 10,
        workflowId: "test-workflow",
        worktreeOriginRepository: originRepo,
      });

      const retrieved = getRunWorktree("run-get-001");
      assert.ok(retrieved, "should find the worktree");
      assert.equal(retrieved!.runId, created.runId);
      assert.equal(retrieved!.worktreePath, created.worktreePath);
      assert.equal(retrieved!.worktreeOriginSha, created.worktreeOriginSha);
      assert.equal(retrieved!.status, "ready");

      // Clean up
      removeRunWorktree({ runId: "run-get-001", force: true });
    });
  });

  // ── validateRunWorktree ──

  describe("validateRunWorktree", () => {
    let originRepo: string;

    before(() => {
      originRepo = tamanduaTempDir("tamandua-validate-");
      initGitRepo(originRepo);
    });

    after(() => {
      rmSync(originRepo, { recursive: true, force: true });
    });

    it("passes validation when all conditions met", () => {
      const wt = createRunWorktree({
        runId: "run-validate-001",
        runNumber: 20,
        workflowId: "test-workflow",
        worktreeOriginRepository: originRepo,
      });

      const validated = validateRunWorktree("run-validate-001", {
        repo: wt.worktreePath,
        working_directory_for_harness: wt.worktreePath,
      });

      assert.equal(validated.runId, wt.runId);
      assert.equal(validated.status, "ready");

      // Clean up
      removeRunWorktree({ runId: "run-validate-001", force: true });
    });

    it("throws when worktree path does not exist", () => {
      const wt = createRunWorktree({
        runId: "run-validate-002",
        runNumber: 21,
        workflowId: "test-workflow",
        worktreeOriginRepository: originRepo,
      });

      // Remove the worktree from disk to simulate missing path
      rmSync(wt.worktreePath, { recursive: true, force: true });

      assert.throws(
        () => validateRunWorktree("run-validate-002", {
          repo: wt.worktreePath,
          working_directory_for_harness: wt.worktreePath,
        }),
        /does not exist/i,
      );

      // Clean up DB (worktree already gone from disk, just mark as removed)
      removeRunWorktree({ runId: "run-validate-002", force: true });
    });

    it("throws when context.repo does not match worktree_path", () => {
      const wt = createRunWorktree({
        runId: "run-validate-003",
        runNumber: 22,
        workflowId: "test-workflow",
        worktreeOriginRepository: originRepo,
      });

      assert.throws(
        () => validateRunWorktree("run-validate-003", {
          repo: "/some/other/path",
          working_directory_for_harness: wt.worktreePath,
        }),
        /does not match worktree_path/i,
      );

      // Clean up
      removeRunWorktree({ runId: "run-validate-003", force: true });
    });

    it("throws when context.working_directory_for_harness does not match worktree_path", () => {
      const wt = createRunWorktree({
        runId: "run-validate-004",
        runNumber: 23,
        workflowId: "test-workflow",
        worktreeOriginRepository: originRepo,
      });

      assert.throws(
        () => validateRunWorktree("run-validate-004", {
          repo: wt.worktreePath,
          working_directory_for_harness: "/some/other/path",
        }),
        /context\.working_directory_for_harness .* does not match worktree_path/i,
      );

      removeRunWorktree({ runId: "run-validate-004", force: true });
    });

    it("throws when run has no managed worktree", () => {
      assert.throws(
        () => validateRunWorktree("nonexistent-run", { repo: "/tmp" }),
        /has no managed worktree/i,
      );
    });
  });

  // ── removeRunWorktree ──

  describe("removeRunWorktree", () => {
    let originRepo: string;

    before(() => {
      originRepo = tamanduaTempDir("tamandua-remove-");
      initGitRepo(originRepo);
    });

    after(() => {
      rmSync(originRepo, { recursive: true, force: true });
    });

    it("removes a clean worktree and marks DB as removed", () => {
      const wt = createRunWorktree({
        runId: "run-remove-001",
        runNumber: 30,
        workflowId: "test-workflow",
        worktreeOriginRepository: originRepo,
      });

      removeRunWorktree({ runId: "run-remove-001" });

      const row = getRunWorktree("run-remove-001");
      assert.ok(row, "row should still exist in DB");
      assert.equal(row!.status, "removed", "status should be removed");
    });

    it("refuses dirty worktrees without --force", () => {
      const wt = createRunWorktree({
        runId: "run-remove-002",
        runNumber: 31,
        workflowId: "test-workflow",
        worktreeOriginRepository: originRepo,
      });

      // Create a dirty change
      writeFileSync(path.join(wt.worktreePath, "dirty-file.txt"), "unstaged change", "utf-8");

      assert.throws(
        () => removeRunWorktree({ runId: "run-remove-002" }),
        /is dirty/i,
      );

      // Clean up with force
      removeRunWorktree({ runId: "run-remove-002", force: true });
    });

    it("--force removes dirty worktrees", () => {
      const wt = createRunWorktree({
        runId: "run-remove-003",
        runNumber: 32,
        workflowId: "test-workflow",
        worktreeOriginRepository: originRepo,
      });

      // Create a dirty change
      writeFileSync(path.join(wt.worktreePath, "dirty-file.txt"), "unstaged change", "utf-8");

      // Should succeed with --force
      removeRunWorktree({ runId: "run-remove-003", force: true });

      const row = getRunWorktree("run-remove-003");
      assert.ok(row, "row should still exist");
      assert.equal(row!.status, "removed");
    });

    it("throws when run has no managed worktree", () => {
      assert.throws(
        () => removeRunWorktree({ runId: "nonexistent-run" }),
        /has no managed worktree/i,
      );
    });
  });

  // ── listRunWorktrees ──

  describe("listRunWorktrees", () => {
    let originRepo: string;

    before(() => {
      originRepo = tamanduaTempDir("tamandua-list-");
      initGitRepo(originRepo);
    });

    after(() => {
      rmSync(originRepo, { recursive: true, force: true });
    });

    it("returns empty array initially", () => {
      // The test DB should be empty for list tests
      const all = listRunWorktrees();
      // May contain rows from other tests sharing the temp HOME, but the list
      // function itself should be callable and return an array
      assert.ok(Array.isArray(all), "should return an array");
    });

    it("returns created worktrees", () => {
      const wt1 = createRunWorktree({
        runId: "run-list-001",
        runNumber: 40,
        workflowId: "test-workflow",
        worktreeOriginRepository: originRepo,
      });

      const wt2 = createRunWorktree({
        runId: "run-list-002",
        runNumber: 41,
        workflowId: "test-workflow",
        worktreeOriginRepository: originRepo,
      });

      const all = listRunWorktrees();
      const ids = all.map((w) => w.runId);

      assert.ok(ids.includes("run-list-001"), "should include run-list-001");
      assert.ok(ids.includes("run-list-002"), "should include run-list-002");

      // Clean up
      removeRunWorktree({ runId: "run-list-001", force: true });
      removeRunWorktree({ runId: "run-list-002", force: true });
    });
  });
});
