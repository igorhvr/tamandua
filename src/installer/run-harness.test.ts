import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { validateRunHarnessForScheduling, getRunHarnessType } from "../../dist/installer/run-harness.js";
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
    tempDir = tamanduaTempDir("tamandua-harness-");
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

  it("throws when context is missing working_directory_for_harness", async () => {
    await assert.rejects(
      validateRunHarnessForScheduling("run-1", JSON.stringify({})),
      /missing working_directory_for_harness/,
    );
  });

  it("throws when context is not valid JSON", async () => {
    await assert.rejects(
      validateRunHarnessForScheduling("run-1", "not json"),
      /run context is not valid JSON/,
    );
  });

  it("throws when working_directory_for_harness is a relative path", async () => {
    await assert.rejects(
      validateRunHarnessForScheduling("run-1", JSON.stringify({
        working_directory_for_harness: "relative/path",
      })),
      /relative harness workdir/,
    );
  });

  it("throws when harness workdir does not exist", async () => {
    const nonexistent = path.join(tempDir, "nonexistent");
    await assert.rejects(
      validateRunHarnessForScheduling("run-1", JSON.stringify({
        working_directory_for_harness: nonexistent,
      })),
      /harness workdir does not exist/,
    );
  });

  it("throws when harness workdir is a file, not a directory", async () => {
    const filePath = path.join(tempDir, "file.txt");
    fs.writeFileSync(filePath, "content", "utf-8");
    await assert.rejects(
      validateRunHarnessForScheduling("run-1", JSON.stringify({
        working_directory_for_harness: filePath,
      })),
      /not a directory/,
    );
  });

  it("returns result for valid absolute working_directory_for_harness", async () => {
    const workdir = path.join(tempDir, "work");
    fs.mkdirSync(workdir, { recursive: true });
    const result = await validateRunHarnessForScheduling("run-1", JSON.stringify({
      working_directory_for_harness: workdir,
    }));
    assert.equal(result.workingDirectoryForHarness, workdir);
    assert.equal(result.expectedBranch, undefined);
  });

  it("resolves symlinks and relative segments", async () => {
    const workdir = path.join(tempDir, "work");
    fs.mkdirSync(workdir, { recursive: true });
    const withDots = path.join(tempDir, ".", "work");
    const result = await validateRunHarnessForScheduling("run-1", JSON.stringify({
      working_directory_for_harness: withDots,
    }));
    assert.equal(result.workingDirectoryForHarness, workdir);
  });

  it("skips branch-mismatch checks for worktree runs and validates managed worktree metadata", async () => {
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

      const result = await validateRunHarnessForScheduling("run-harness-worktree-1", JSON.stringify({
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

  it("throws when worktree path does not exist", async () => {
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

      await assert.rejects(
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

  it("throws when git-common-dir mismatches for worktree run", async () => {
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

      await assert.rejects(
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

  it("throws when worktree run has no managed worktree row", async () => {
    const nonexistentWorktreePath = path.join(tempDir, "nonexistent-wt");

    await assert.rejects(
      () => validateRunHarnessForScheduling("no-wt-row", JSON.stringify({
        workspace_mode: "worktree",
        repo: nonexistentWorktreePath,
        working_directory_for_harness: nonexistentWorktreePath,
      })),
      /no managed worktree/,
    );
  });

  it("throws when context.repo does not match worktree_path", async () => {
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
      await assert.rejects(
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

  // ── HRM2/WADM: worktree hermes admission tests ──

  it("rejects worktree run with harness_type=hermes when hermes is unavailable", async () => {
    const originRepo = path.join(tempDir, "origin-wt-hermes-reject");
    fs.mkdirSync(originRepo, { recursive: true });
    spawnSync("git", ["init", "--initial-branch=main"], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["config", "user.email", "test@test"], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: originRepo, encoding: "utf-8" });
    fs.writeFileSync(path.join(originRepo, "README.md"), "# test\n", "utf-8");
    spawnSync("git", ["add", "."], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["commit", "-m", "initial"], { cwd: originRepo, encoding: "utf-8" });

    const worktree = createRunWorktree({
      runId: "run-wt-hermes-reject",
      runNumber: 1,
      workflowId: "test-workflow",
      worktreeOriginRepository: originRepo,
    });

    const savedPath = process.env.PATH;
    const savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    try {
      // Determine the absolute real git executable BEFORE any PATH mutation.
      const gitWhich = spawnSync("which", ["git"], { encoding: "utf-8" });
      const realGit = fs.realpathSync(gitWhich.stdout.trim());
      // Validate setup: real git must be absolute and executable.
      assert.ok(path.isAbsolute(realGit), "real git must be absolute");
      fs.accessSync(realGit, fs.constants.X_OK);

      // Create an isolated tool dir with ONLY a symlink named git → real git.
      const toolDir = path.join(tempDir, "tools");
      fs.mkdirSync(toolDir, { recursive: true });
      fs.symlinkSync(realGit, path.join(toolDir, "git"));

      // Verify no hermes exists in the isolated tool dir.
      assert.equal(
        fs.existsSync(path.join(toolDir, "hermes")),
        false,
        "isolated tool dir must not contain hermes",
      );

      // PATH = isolated git only; no hermes, no zsh, no savedPath.
      delete process.env.TAMANDUA_HERMES_BINARY;
      process.env.PATH = toolDir;

      await assert.rejects(
        validateRunHarnessForScheduling("run-wt-hermes-reject", JSON.stringify({
          workspace_mode: "worktree",
          repo: worktree.worktreePath,
          working_directory_for_harness: worktree.worktreePath,
          harness_type: "hermes",
        })),
        /hermes is not available/,
      );
    } finally {
      if (savedPath !== undefined) {
        process.env.PATH = savedPath;
      } else {
        delete process.env.PATH;
      }
      if (savedHermesBinary !== undefined) {
        process.env.TAMANDUA_HERMES_BINARY = savedHermesBinary;
      } else {
        delete process.env.TAMANDUA_HERMES_BINARY;
      }
      removeRunWorktree({ runId: "run-wt-hermes-reject", force: true });
    }
  });

  it("accepts worktree run with harness_type=hermes when hermes is found via env var", async () => {
    const originRepo = path.join(tempDir, "origin-wt-hermes-env");
    fs.mkdirSync(originRepo, { recursive: true });
    spawnSync("git", ["init", "--initial-branch=main"], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["config", "user.email", "test@test"], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: originRepo, encoding: "utf-8" });
    fs.writeFileSync(path.join(originRepo, "README.md"), "# test\n", "utf-8");
    spawnSync("git", ["add", "."], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["commit", "-m", "initial"], { cwd: originRepo, encoding: "utf-8" });

    const worktree = createRunWorktree({
      runId: "run-wt-hermes-env",
      runNumber: 1,
      workflowId: "test-workflow",
      worktreeOriginRepository: originRepo,
    });

    const hermesPath = path.join(tempDir, "hermes-mock-wt-env");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho ok\n", { mode: 0o755 });

    const saved = process.env.TAMANDUA_HERMES_BINARY;
    try {
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;
      const result = await validateRunHarnessForScheduling("run-wt-hermes-env", JSON.stringify({
        workspace_mode: "worktree",
        repo: worktree.worktreePath,
        working_directory_for_harness: worktree.worktreePath,
        harness_type: "hermes",
      }));
      assert.equal(result.workingDirectoryForHarness, worktree.worktreePath);
      assert.equal(result.expectedBranch, undefined);
    } finally {
      if (saved === undefined) delete process.env.TAMANDUA_HERMES_BINARY;
      else process.env.TAMANDUA_HERMES_BINARY = saved;
      removeRunWorktree({ runId: "run-wt-hermes-env", force: true });
    }
  });

  it("accepts worktree run with harness_type=hermes when hermes is found via PATH", async () => {
    const originRepo = path.join(tempDir, "origin-wt-hermes-path");
    fs.mkdirSync(originRepo, { recursive: true });
    spawnSync("git", ["init", "--initial-branch=main"], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["config", "user.email", "test@test"], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: originRepo, encoding: "utf-8" });
    fs.writeFileSync(path.join(originRepo, "README.md"), "# test\n", "utf-8");
    spawnSync("git", ["add", "."], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["commit", "-m", "initial"], { cwd: originRepo, encoding: "utf-8" });

    const worktree = createRunWorktree({
      runId: "run-wt-hermes-path",
      runNumber: 1,
      workflowId: "test-workflow",
      worktreeOriginRepository: originRepo,
    });

    // Create a hermes binary in a dir that will be on PATH
    const hermesDir = path.join(tempDir, "hermes-bin");
    fs.mkdirSync(hermesDir, { recursive: true });
    fs.writeFileSync(path.join(hermesDir, "hermes"), "#!/bin/sh\necho ok\n", { mode: 0o755 });

    const savedPath = process.env.PATH;
    const savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    delete process.env.TAMANDUA_HERMES_BINARY;
    try {
      // Prepend hermes bin dir to saved PATH so hermes is found via tier 2
      process.env.PATH = `${hermesDir}${path.delimiter}${savedPath}`;
      const result = await validateRunHarnessForScheduling("run-wt-hermes-path", JSON.stringify({
        workspace_mode: "worktree",
        repo: worktree.worktreePath,
        working_directory_for_harness: worktree.worktreePath,
        harness_type: "hermes",
      }));
      assert.equal(result.workingDirectoryForHarness, worktree.worktreePath);
      assert.equal(result.expectedBranch, undefined);
    } finally {
      if (savedPath !== undefined) {
        process.env.PATH = savedPath;
      } else {
        delete process.env.PATH;
      }
      if (savedHermesBinary !== undefined) {
        process.env.TAMANDUA_HERMES_BINARY = savedHermesBinary;
      } else {
        delete process.env.TAMANDUA_HERMES_BINARY;
      }
      removeRunWorktree({ runId: "run-wt-hermes-path", force: true });
    }
  });

  it("accepts worktree run with harness_type=hermes via login-shell fallback", async () => {
    const originRepo = path.join(tempDir, "origin-wt-hermes-login");
    fs.mkdirSync(originRepo, { recursive: true });
    spawnSync("git", ["init", "--initial-branch=main"], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["config", "user.email", "test@test"], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: originRepo, encoding: "utf-8" });
    fs.writeFileSync(path.join(originRepo, "README.md"), "# test\n", "utf-8");
    spawnSync("git", ["add", "."], { cwd: originRepo, encoding: "utf-8" });
    spawnSync("git", ["commit", "-m", "initial"], { cwd: originRepo, encoding: "utf-8" });

    const worktree = createRunWorktree({
      runId: "run-wt-hermes-login",
      runNumber: 1,
      workflowId: "test-workflow",
      worktreeOriginRepository: originRepo,
    });

    // Determine the absolute real git binary BEFORE any PATH mutation.
    const gitWhich = spawnSync("which", ["git"], { encoding: "utf-8" });
    const realGit = fs.realpathSync(gitWhich.stdout.trim());
    assert.ok(path.isAbsolute(realGit), "real git must be absolute");
    fs.accessSync(realGit, fs.constants.X_OK);

    // Create isolated tool dir with ONLY a symlink named git.
    const toolDir = path.join(tempDir, "tools");
    fs.mkdirSync(toolDir, { recursive: true });
    fs.symlinkSync(realGit, path.join(toolDir, "git"));
    // Verify no hermes in the tool dir.
    assert.equal(
      fs.existsSync(path.join(toolDir, "hermes")),
      false,
      "isolated tool dir must not contain hermes",
    );

    // Create a mock hermes binary that the mock zsh will report.
    // It lives OUTSIDE PATH so only login-shell fallback can reach it.
    const hermesDir = path.join(tempDir, "hermes-bin");
    fs.mkdirSync(hermesDir, { recursive: true });
    const hermesPath = path.join(hermesDir, "hermes");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho ok\n", { mode: 0o755 });

    // Create a mock zsh that reports the hermes path via login shell discovery.
    const mockZshDir = path.join(tempDir, "mock-zsh-dir");
    fs.mkdirSync(mockZshDir, { recursive: true });
    const mockZshPath = path.join(mockZshDir, "zsh");
    fs.writeFileSync(mockZshPath, `#!/bin/sh\necho "${hermesPath}"\n`, { mode: 0o755 });

    const savedPath = process.env.PATH;
    const savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    try {
      // PATH = isolated git dir + fake zsh dir only. NO savedPath append.
      // Hermes is NOT on PATH (neither in toolDir nor mockZshDir), so tier 2
      // fails and the resolver falls through to tier 3 (login-shell fallback).
      delete process.env.TAMANDUA_HERMES_BINARY;
      process.env.PATH = `${toolDir}${path.delimiter}${mockZshDir}`;

      const result = await validateRunHarnessForScheduling("run-wt-hermes-login", JSON.stringify({
        workspace_mode: "worktree",
        repo: worktree.worktreePath,
        working_directory_for_harness: worktree.worktreePath,
        harness_type: "hermes",
      }));
      assert.equal(result.workingDirectoryForHarness, worktree.worktreePath);
      assert.equal(result.expectedBranch, undefined);
    } finally {
      if (savedPath !== undefined) {
        process.env.PATH = savedPath;
      } else {
        delete process.env.PATH;
      }
      if (savedHermesBinary !== undefined) {
        process.env.TAMANDUA_HERMES_BINARY = savedHermesBinary;
      } else {
        delete process.env.TAMANDUA_HERMES_BINARY;
      }
      removeRunWorktree({ runId: "run-wt-hermes-login", force: true });
    }
  });

  it("throws when harness_type is 'hermes' and hermes binary not found", async () => {
    const workdir = path.join(tempDir, "work");
    fs.mkdirSync(workdir, { recursive: true });
    // Unset TAMANDUA_HERMES_BINARY so PATH search fails
    const savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    delete process.env.TAMANDUA_HERMES_BINARY;
    // Save and clear PATH to guarantee hermes not found
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = tempDir; // empty dir, no hermes
      await assert.rejects(
        validateRunHarnessForScheduling("run-hermes-missing", JSON.stringify({
          working_directory_for_harness: workdir,
          harness_type: "hermes",
        })),
        /hermes is not available/,
      );
    } finally {
      if (savedPath !== undefined) {
        process.env.PATH = savedPath;
      } else {
        delete process.env.PATH;
      }
      if (savedHermesBinary !== undefined) {
        process.env.TAMANDUA_HERMES_BINARY = savedHermesBinary;
      } else {
        delete process.env.TAMANDUA_HERMES_BINARY;
      }
    }
  });

  it("succeeds when harness_type is 'hermes' and hermes binary is available via env var", async () => {
    const workdir = path.join(tempDir, "work");
    fs.mkdirSync(workdir, { recursive: true });
    const hermesPath = path.join(tempDir, "hermes-mock");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho ok\n", { mode: 0o755 });

    const saved = process.env.TAMANDUA_HERMES_BINARY;
    try {
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;
      const result = await validateRunHarnessForScheduling("run-hermes-ok", JSON.stringify({
        working_directory_for_harness: workdir,
        harness_type: "hermes",
      }));
      assert.equal(result.workingDirectoryForHarness, workdir);
    } finally {
      if (saved === undefined) delete process.env.TAMANDUA_HERMES_BINARY;
      else process.env.TAMANDUA_HERMES_BINARY = saved;
    }
  });

  it("does not check hermes binary when harness_type is 'pi'", async () => {
    const workdir = path.join(tempDir, "work");
    fs.mkdirSync(workdir, { recursive: true });
    // Even with hermes missing, "pi" harness should succeed
    const savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    delete process.env.TAMANDUA_HERMES_BINARY;
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = tempDir;
      const result = await validateRunHarnessForScheduling("run-pi", JSON.stringify({
        working_directory_for_harness: workdir,
        harness_type: "pi",
      }));
      assert.equal(result.workingDirectoryForHarness, workdir);
    } finally {
      if (savedPath !== undefined) {
        process.env.PATH = savedPath;
      } else {
        delete process.env.PATH;
      }
      if (savedHermesBinary !== undefined) {
        process.env.TAMANDUA_HERMES_BINARY = savedHermesBinary;
      } else {
        delete process.env.TAMANDUA_HERMES_BINARY;
      }
    }
  });

  it("does not check hermes binary when harness_type is not present", async () => {
    const workdir = path.join(tempDir, "work");
    fs.mkdirSync(workdir, { recursive: true });
    // No harness_type — should default to pi, no hermes check
    const savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    delete process.env.TAMANDUA_HERMES_BINARY;
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = tempDir;
      const result = await validateRunHarnessForScheduling("run-noharness", JSON.stringify({
        working_directory_for_harness: workdir,
      }));
      assert.equal(result.workingDirectoryForHarness, workdir);
    } finally {
      if (savedPath !== undefined) {
        process.env.PATH = savedPath;
      } else {
        delete process.env.PATH;
      }
      if (savedHermesBinary !== undefined) {
        process.env.TAMANDUA_HERMES_BINARY = savedHermesBinary;
      } else {
        delete process.env.TAMANDUA_HERMES_BINARY;
      }
    }
  });

  it("direct workflow branch-mismatch validation is unchanged", async () => {
    const workdir = path.join(tempDir, "direct-work");
    fs.mkdirSync(workdir, { recursive: true });
    spawnSync("git", ["init", "--initial-branch=main"], { cwd: workdir, encoding: "utf-8" });
    spawnSync("git", ["config", "user.email", "test@test"], { cwd: workdir, encoding: "utf-8" });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: workdir, encoding: "utf-8" });
    fs.writeFileSync(path.join(workdir, "README.md"), "# test\n", "utf-8");
    spawnSync("git", ["add", "."], { cwd: workdir, encoding: "utf-8" });
    spawnSync("git", ["commit", "-m", "initial"], { cwd: workdir, encoding: "utf-8" });

    // Direct workflow with wrong branch should throw
    await assert.rejects(
      validateRunHarnessForScheduling("run-direct-1", JSON.stringify({
        workspace_mode: "direct",
        repo: workdir,
        working_directory_for_harness: workdir,
        branch: "nonexistent-branch",
      })),
      /branch mismatch/,
    );

    // Direct workflow without workspace_mode (defaults to direct) with wrong branch should throw
    await assert.rejects(
      validateRunHarnessForScheduling("run-direct-2", JSON.stringify({
        repo: workdir,
        working_directory_for_harness: workdir,
        branch: "nonexistent-branch",
      })),
      /branch mismatch/,
    );
  });
});

describe("getRunHarnessType with corrupt context (US-005)", () => {
  let tempDir: string;
  let _savedStateDir: string | undefined;
  let _savedDbPath: string | undefined;

  before(() => {
    tempDir = tamanduaTempDir("tamandua-us005-harness-");
    const tamanduaDir = path.join(tempDir, ".tamandua");
    fs.mkdirSync(tamanduaDir, { recursive: true });
    _savedStateDir = process.env.TAMANDUA_STATE_DIR;
    _savedDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.TAMANDUA_STATE_DIR = tamanduaDir;
    process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns 'pi' on corrupt context and emits run.context_corrupt event", async () => {
    const db = getDb();
    const runId = "run-us005-harness-01";
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);

    // Insert a run with corrupt JSON context
    db.prepare(
      `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
       VALUES (?, 1, 'us005-harness-test', 'test harness corrupt', 'running', ?, 0, ?, ?)`
    ).run(runId, "{not valid json << }  ", now, now);

    // getRunHarnessType should NOT crash on corrupt context
    const harnessType = getRunHarnessType(runId);
    assert.equal(harnessType, "pi", "should fall back to pi on corrupt context");

    // Verify run.context_corrupt event was emitted
    const { getRunEvents } = await import("../../dist/installer/events.js");
    const events = getRunEvents(runId);
    const corruptEvents = events.filter((e: { event: string }) => e.event === "run.context_corrupt");
    assert.equal(corruptEvents.length, 1, "should emit one run.context_corrupt event");
    assert.ok(
      typeof corruptEvents[0].detail === "string" && corruptEvents[0].detail!.length <= 200,
      "detail should be a bounded prefix of the raw context"
    );
  });
});
