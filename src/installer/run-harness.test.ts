import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";
import { validateRunHarnessForScheduling } from "../../dist/installer/run-harness.js";
import {
  createRunWorktree,
  removeRunWorktree,
} from "../../dist/installer/worktree-manager.js";
import { getDb } from "../../dist/db.js";

describe("validateRunHarnessForScheduling", () => {
  let tempDir: string;
  let prevHome: string | undefined;
  let prevStateDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-harness-"));
    prevHome = process.env.HOME;
    prevStateDir = process.env.TAMANDUA_STATE_DIR;
    process.env.HOME = path.join(tempDir, "home");
    process.env.TAMANDUA_STATE_DIR = path.join(process.env.HOME, ".tamandua");
    fs.mkdirSync(process.env.TAMANDUA_STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = prevStateDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("throws when context is missing working_directory_for_harness", () => {
    assert.throws(
      () => validateRunHarnessForScheduling("run-1", JSON.stringify({})),
      /missing working_directory_for_harness/,
    );
  });

  it("throws when context is not valid JSON", () => {
    assert.throws(
      () => validateRunHarnessForScheduling("run-1", "not json"),
      /run context is not valid JSON/,
    );
  });

  it("throws when working_directory_for_harness is a relative path", () => {
    assert.throws(
      () => validateRunHarnessForScheduling("run-1", JSON.stringify({
        working_directory_for_harness: "relative/path",
      })),
      /relative harness workdir/,
    );
  });

  it("throws when harness workdir does not exist", () => {
    const nonexistent = path.join(tempDir, "nonexistent");
    assert.throws(
      () => validateRunHarnessForScheduling("run-1", JSON.stringify({
        working_directory_for_harness: nonexistent,
      })),
      /harness workdir does not exist/,
    );
  });

  it("throws when harness workdir is a file, not a directory", () => {
    const filePath = path.join(tempDir, "file.txt");
    fs.writeFileSync(filePath, "content", "utf-8");
    assert.throws(
      () => validateRunHarnessForScheduling("run-1", JSON.stringify({
        working_directory_for_harness: filePath,
      })),
      /not a directory/,
    );
  });

  it("returns result for valid absolute working_directory_for_harness", () => {
    const workdir = path.join(tempDir, "work");
    fs.mkdirSync(workdir, { recursive: true });
    const result = validateRunHarnessForScheduling("run-1", JSON.stringify({
      working_directory_for_harness: workdir,
    }));
    assert.equal(result.workingDirectoryForHarness, workdir);
    assert.equal(result.expectedBranch, undefined);
  });

  it("resolves symlinks and relative segments", () => {
    const workdir = path.join(tempDir, "work");
    fs.mkdirSync(workdir, { recursive: true });
    const withDots = path.join(tempDir, ".", "work");
    const result = validateRunHarnessForScheduling("run-1", JSON.stringify({
      working_directory_for_harness: withDots,
    }));
    assert.equal(result.workingDirectoryForHarness, workdir);
  });

  it("skips branch-mismatch checks for worktree runs and validates managed worktree metadata", () => {
    const originRepo = path.join(tempDir, "origin");
    fs.mkdirSync(originRepo, { recursive: true });
    spawnSync("git", ["init", "--initial-branch=main"], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["config", "user.email", "test@test"], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: originRepo, encoding: "utf-8" });
    fs.writeFileSync(path.join(originRepo, "README.md"), "# test\n", "utf-8");
    spawnSync("git", ["add", "."], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["commit", "-m", "initial"], { cwd: originRepo, encoding: "utf-8" });

    const worktree = createRunWorktree({
      runId: "run-harness-worktree-1",
      runNumber: 1,
      workflowId: "test-workflow",
      worktreeOriginRepository: originRepo,
    });

    try {
      spawnSync("git", ["checkout", "-b", "feature/test"], {
        cwd: worktree.worktreePath,
        encoding: "utf-8",
      });

      const result = validateRunHarnessForScheduling("run-harness-worktree-1", JSON.stringify({
        workspace_mode: "worktree",
        repo: worktree.worktreePath,
        working_directory_for_harness: worktree.worktreePath,
        branch: "some-other-branch",
      }));

      assert.equal(result.workingDirectoryForHarness, worktree.worktreePath);
      assert.equal(result.expectedBranch, undefined);
    } finally {
      removeRunWorktree({ runId: "run-harness-worktree-1", force: true });
    }
  });

  it("throws when worktree path does not exist", () => {
    const originRepo = path.join(tempDir, "origin2");
    fs.mkdirSync(originRepo, { recursive: true });
    spawnSync("git", ["init", "--initial-branch=main"], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["config", "user.email", "test@test"], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: originRepo, encoding: "utf-8" });
    fs.writeFileSync(path.join(originRepo, "file.txt"), "content", "utf-8");
    spawnSync("git", ["add", "."], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["commit", "-m", "initial"], { cwd: originRepo, encoding: "utf-8" });

    const worktree = createRunWorktree({
      runId: "run-harness-removed-wt",
      runNumber: 1,
      workflowId: "test-workflow",
      worktreeOriginRepository: originRepo,
    });

    try {
      // Remove the worktree directory to simulate disappearance
      fs.rmSync(worktree.worktreePath, { recursive: true, force: true });

      assert.throws(
        () => validateRunHarnessForScheduling("run-harness-removed-wt", JSON.stringify({
          workspace_mode: "worktree",
          repo: worktree.worktreePath,
          working_directory_for_harness: worktree.worktreePath,
        })),
        /managed worktree path does not exist/,
      );
    } finally {
      removeRunWorktree({ runId: "run-harness-removed-wt", force: true });
    }
  });

  it("throws when git-common-dir mismatches for worktree run", () => {
    const originRepo = path.join(tempDir, "origin3");
    fs.mkdirSync(originRepo, { recursive: true });
    spawnSync("git", ["init", "--initial-branch=main"], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["config", "user.email", "test@test"], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: originRepo, encoding: "utf-8" });
    fs.writeFileSync(path.join(originRepo, "file.txt"), "content", "utf-8");
    spawnSync("git", ["add", "."], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["commit", "-m", "initial"], { cwd: originRepo, encoding: "utf-8" });

    const worktree = createRunWorktree({
      runId: "run-harness-mismatch",
      runNumber: 1,
      workflowId: "test-workflow",
      worktreeOriginRepository: originRepo,
    });

    try {
      // Corrupt the DB-stored git-common-dir to cause a mismatch with reality.
      // The worktree is still intact; only the DB value is wrong.
      const db = getDb();
      db.prepare(
        "UPDATE run_worktrees SET worktree_origin_git_common_dir = ? WHERE run_id = ?",
      ).run("/nonexistent/git/common/dir", "run-harness-mismatch");

      assert.throws(
        () => validateRunHarnessForScheduling("run-harness-mismatch", JSON.stringify({
          workspace_mode: "worktree",
          repo: worktree.worktreePath,
          working_directory_for_harness: worktree.worktreePath,
        })),
        /git-common-dir mismatch/,
      );
    } finally {
      removeRunWorktree({ runId: "run-harness-mismatch", force: true });
    }
  });

  it("throws when worktree run has no managed worktree row", () => {
    const nonexistentWorktreePath = path.join(tempDir, "nonexistent-wt");

    assert.throws(
      () => validateRunHarnessForScheduling("no-wt-row", JSON.stringify({
        workspace_mode: "worktree",
        repo: nonexistentWorktreePath,
        working_directory_for_harness: nonexistentWorktreePath,
      })),
      /no managed worktree/,
    );
  });

  it("throws when context.repo does not match worktree_path", () => {
    const originRepo = path.join(tempDir, "origin5");
    fs.mkdirSync(originRepo, { recursive: true });
    spawnSync("git", ["init", "--initial-branch=main"], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["config", "user.email", "test@test"], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: originRepo, encoding: "utf-8" });
    fs.writeFileSync(path.join(originRepo, "file.txt"), "content", "utf-8");
    spawnSync("git", ["add", "."], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["commit", "-m", "initial"], { cwd: originRepo, encoding: "utf-8" });

    const worktree = createRunWorktree({
      runId: "run-harness-repo-mismatch",
      runNumber: 1,
      workflowId: "test-workflow",
      worktreeOriginRepository: originRepo,
    });

    try {
      assert.throws(
        () => validateRunHarnessForScheduling("run-harness-repo-mismatch", JSON.stringify({
          workspace_mode: "worktree",
          repo: "/wrong/path",
          working_directory_for_harness: worktree.worktreePath,
        })),
        /does not match worktree_path/,
      );
    } finally {
      removeRunWorktree({ runId: "run-harness-repo-mismatch", force: true });
    }
  });

  it("throws when harness_type is 'hermes' and hermes binary not found", () => {
    const workdir = path.join(tempDir, "work");
    fs.mkdirSync(workdir, { recursive: true });
    // Unset TAMANDUA_HERMES_BINARY so PATH search fails
    delete process.env.TAMANDUA_HERMES_BINARY;
    // Save and clear PATH to guarantee hermes not found
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = tempDir; // empty dir, no hermes
      assert.throws(
        () => validateRunHarnessForScheduling("run-hermes-missing", JSON.stringify({
          working_directory_for_harness: workdir,
          harness_type: "hermes",
        })),
        /hermes is not available/,
      );
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("succeeds when harness_type is 'hermes' and hermes binary is available via env var", () => {
    const workdir = path.join(tempDir, "work");
    fs.mkdirSync(workdir, { recursive: true });
    const hermesPath = path.join(tempDir, "hermes-mock");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho ok\n", { mode: 0o755 });

    const saved = process.env.TAMANDUA_HERMES_BINARY;
    try {
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;
      const result = validateRunHarnessForScheduling("run-hermes-ok", JSON.stringify({
        working_directory_for_harness: workdir,
        harness_type: "hermes",
      }));
      assert.equal(result.workingDirectoryForHarness, workdir);
    } finally {
      if (saved === undefined) delete process.env.TAMANDUA_HERMES_BINARY;
      else process.env.TAMANDUA_HERMES_BINARY = saved;
    }
  });

  it("does not check hermes binary when harness_type is 'pi'", () => {
    const workdir = path.join(tempDir, "work");
    fs.mkdirSync(workdir, { recursive: true });
    // Even with hermes missing, "pi" harness should succeed
    delete process.env.TAMANDUA_HERMES_BINARY;
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = tempDir;
      const result = validateRunHarnessForScheduling("run-pi", JSON.stringify({
        working_directory_for_harness: workdir,
        harness_type: "pi",
      }));
      assert.equal(result.workingDirectoryForHarness, workdir);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("does not check hermes binary when harness_type is not present", () => {
    const workdir = path.join(tempDir, "work");
    fs.mkdirSync(workdir, { recursive: true });
    // No harness_type — should default to pi, no hermes check
    delete process.env.TAMANDUA_HERMES_BINARY;
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = tempDir;
      const result = validateRunHarnessForScheduling("run-noharness", JSON.stringify({
        working_directory_for_harness: workdir,
      }));
      assert.equal(result.workingDirectoryForHarness, workdir);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("direct workflow branch-mismatch validation is unchanged", () => {
    const workdir = path.join(tempDir, "direct-work");
    fs.mkdirSync(workdir, { recursive: true });
    spawnSync("git", ["init", "--initial-branch=main"], { cwd: workdir, encoding: "utf-8" });
    spawnSync("git", ["config", "user.email", "test@test"], { cwd: workdir, encoding: "utf-8" });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: workdir, encoding: "utf-8" });
    fs.writeFileSync(path.join(workdir, "README.md"), "# test\n", "utf-8");
    spawnSync("git", ["add", "."], { cwd: workdir, encoding: "utf-8" });
    spawnSync("git", ["commit", "-m", "initial"], { cwd: workdir, encoding: "utf-8" });

    // Direct workflow with wrong branch should throw
    assert.throws(
      () => validateRunHarnessForScheduling("run-direct-1", JSON.stringify({
        workspace_mode: "direct",
        repo: workdir,
        working_directory_for_harness: workdir,
        branch: "nonexistent-branch",
      })),
      /branch mismatch/,
    );

    // Direct workflow without workspace_mode (defaults to direct) with wrong branch should throw
    assert.throws(
      () => validateRunHarnessForScheduling("run-direct-2", JSON.stringify({
        repo: workdir,
        working_directory_for_harness: workdir,
        branch: "nonexistent-branch",
      })),
      /branch mismatch/,
    );
  });
});
