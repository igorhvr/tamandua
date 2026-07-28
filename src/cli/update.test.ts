import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  createDefaultUpdateServices,
  defaultRunCommand,
  installAllBundledWorkflowsForUpdate,
  runUpdate,
} from "../../dist/cli/update.js";
import { createTempHome } from "../../tests/helpers/test-env.ts";

describe("update exports", () => {
  describe("createDefaultUpdateServices", () => {
    it("returns an object with snapshot, stop, and start functions", () => {
      const services = createDefaultUpdateServices();
      assert.equal(typeof services.snapshot, "function");
      assert.equal(typeof services.stopDaemon, "function");
      assert.equal(typeof services.stopDashboard, "function");
      assert.equal(typeof services.stopMcp, "function");
      assert.equal(typeof services.startDaemon, "function");
      assert.equal(typeof services.startDashboard, "function");
      assert.equal(typeof services.startMcp, "function");
    });

    it("snapshot returns an object with daemon, dashboard, and mcp", () => {
      const prevGuard = process.env.TAMANDUA_TEST_GUARD;
      process.env.TAMANDUA_TEST_GUARD = "0";
      let snap: ReturnType<ReturnType<typeof createDefaultUpdateServices>["snapshot"]>;
      try {
        const services = createDefaultUpdateServices();
        snap = services.snapshot();
      } finally {
        if (prevGuard === undefined) delete process.env.TAMANDUA_TEST_GUARD;
        else process.env.TAMANDUA_TEST_GUARD = prevGuard;
      }
      assert.ok("daemon" in snap);
      assert.ok("dashboard" in snap);
      assert.ok("mcp" in snap);
      assert.equal(typeof snap.daemon.running, "boolean");
      assert.equal(typeof snap.dashboard.running, "boolean");
      assert.equal(typeof snap.mcp.running, "boolean");
    });
  });

  describe("defaultRunCommand", () => {
    it("executes a simple command and returns stdout", async () => {
      const result = await defaultRunCommand("echo", ["hello"], {
        cwd: "/tmp",
        stdio: "pipe",
      });
      assert.ok(result.stdout.includes("hello"));
      assert.equal(result.stderr, "");
    });

    it("rejects on non-zero exit", async () => {
      await assert.rejects(
        defaultRunCommand("sh", ["-c", "exit 1"], {
          cwd: "/tmp",
          stdio: "pipe",
        }),
        /Command failed/,
      );
    });

    it("captures stderr", async () => {
      const result = await defaultRunCommand("sh", ["-c", "echo err >&2; echo out"], {
        cwd: "/tmp",
        stdio: "pipe",
      });
      assert.ok(result.stdout.includes("out"));
      assert.ok(result.stderr.includes("err"));
    });
  });

  describe("installAllBundledWorkflowsForUpdate", () => {
    it("installs workflows from the provided list", async () => {
      const installed: string[] = [];
      const result = await installAllBundledWorkflowsForUpdate({
        output: { log: () => {}, warn: () => {} },
        listWorkflows: async () => ["feature-dev-merge"],
        installWorkflowById: async (id: string) => {
          installed.push(id);
        },
      });
      assert.deepEqual(result, ["feature-dev-merge"]);
      assert.deepEqual(installed, ["feature-dev-merge"]);
    });

    it("returns empty array when no bundled workflows", async () => {
      const result = await installAllBundledWorkflowsForUpdate({
        output: { log: () => {}, warn: () => {} },
        listWorkflows: async () => [],
      });
      assert.deepEqual(result, []);
    });

    it("throws when one or more workflows fail to install", async () => {
      const installed: string[] = [];
      await assert.rejects(
        installAllBundledWorkflowsForUpdate({
          output: { log: () => {}, warn: () => {} },
          listWorkflows: async () => ["wf-a", "wf-b", "wf-c"],
          installWorkflowById: async (id: string) => {
            if (id === "wf-b") throw new Error("install failed");
            installed.push(id);
          },
        }),
        /Failed to install bundled workflow/,
      );
      // wf-a and wf-c should have been installed before the throw
      assert.deepEqual(installed, ["wf-a", "wf-c"]);
    });
  });

  describe("runUpdate refreshes version status", () => {
    const originalStateDir = process.env.TAMANDUA_STATE_DIR;
    const th = createTempHome("tamandua-update-version-status-");
    const testStateDir = th.tamanduaDir;
    process.env.TAMANDUA_STATE_DIR = testStateDir;

    after(() => {
      if (originalStateDir === undefined) {
        delete process.env.TAMANDUA_STATE_DIR;
      } else {
        process.env.TAMANDUA_STATE_DIR = originalStateDir;
      }
    });

    it("writes version-status.json after no_change update", async () => {
      const fakeHead = "abc1234def5678abc1234def5678abc1234def";
      let revParseCalls = 0;

      const mockRunCommand = async (
        command: string,
        args: string[],
        _options: unknown,
      ): Promise<{ stdout: string; stderr: string }> => {
        if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
          revParseCalls++;
          return { stdout: fakeHead, stderr: "" };
        }
        if (command === "git" && args[0] === "pull" && args[1] === "--ff-only") {
          return { stdout: "Already up to date.", stderr: "" };
        }
        if (command === "git" && args[0] === "ls-remote" && args[1] === "--heads" && args[2] === "--exit-code") {
          return { stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "rev-parse" && args[1] === "@{u}") {
          return { stdout: "refs/remotes/origin/main\n", stderr: "" };
        }
        if (command === "git" && args[0] === "rev-list" && args[1] === "--count") {
          return { stdout: "0\n", stderr: "" };
        }
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      };

      const result = await runUpdate({
        runCommand: mockRunCommand,
        output: { log: () => {}, warn: () => {} },
        services: {
          snapshot: () => ({
            daemon: { running: false, pid: null, port: 3334 },
            dashboard: { running: false, pid: null, port: 3338 },
            mcp: { running: false, pid: null, port: 3339 },
          }),
          stopDaemon: () => false,
          stopDashboard: () => false,
          stopMcp: () => false,
          startDaemon: async () => ({ pid: 1, port: 3334 }),
          startDashboard: async () => ({ pid: 2, port: 3338 }),
          startMcp: async () => ({ pid: 3, port: 3339 }),
        },
      });

      assert.equal(result.status, "no_change");
      assert.equal(revParseCalls, 2); // before + after git pull

      // Version status should have been refreshed by runVersionCheck()
      const statusPath = path.join(testStateDir, "version-status.json");
      assert.ok(fs.existsSync(statusPath), `Expected ${statusPath} to exist`);

      const raw = fs.readFileSync(statusPath, "utf-8");
      const status = JSON.parse(raw);
      assert.equal(typeof status.updateAvailable, "boolean");
      assert.notEqual(status.checkedAt, "");
      // checkedAt should be recent (within last 60 seconds)
      const checkedMs = new Date(status.checkedAt).getTime();
      const nowMs = Date.now();
      assert.ok(
        Math.abs(nowMs - checkedMs) < 60_000,
        `checkedAt ${status.checkedAt} should be within 60s of now`,
      );
    });
  });

  // --- Real-git fixture tests ---

  describe("runUpdate with real git repos", () => {
    const originalGuard = process.env.TAMANDUA_TEST_GUARD;
    const originalStateDir = process.env.TAMANDUA_STATE_DIR;

    /**
     * Creates a temp directory with:
     * - a bare "origin" repo at <tmpDir>/origin.git with one commit
     * - a working clone at <tmpDir>/working with package.json and build-and-install
     * Returns { tmpDir, workingDir, originDir } and a cleanup function
     */
    function setupRealGitRepo(): { tmpDir: string; workingDir: string; originDir: string; stateDir: string; dbPath: string; cleanup: () => void } {
      const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "tamandua-update-git-"));
      const stateDir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "tamandua-update-state-"));
      const dbPath = path.join(stateDir, "tamandua.db");
      const originDir = path.join(tmpDir, "origin.git");
      const workingDir = path.join(tmpDir, "working");

      // Isolate from real tamandua state
      process.env.TAMANDUA_TEST_GUARD = "0";
      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = dbPath;

      // Bare origin repo
      fs.mkdirSync(originDir, { recursive: true });
      execSync("git init --bare", { cwd: originDir, stdio: "pipe" });

      // Clone into working
      execSync(`git clone "${originDir}" "${workingDir}"`, { cwd: tmpDir, stdio: "pipe" });
      execSync("git config user.email test@test.com", { cwd: workingDir, stdio: "pipe" });
      execSync("git config user.name Test", { cwd: workingDir, stdio: "pipe" });

      // Initial commit (needed for rev-parse HEAD to work)
      fs.writeFileSync(path.join(workingDir, "package.json"), JSON.stringify({ name: "test", scripts: { build: "echo ok" } }));
      fs.writeFileSync(path.join(workingDir, "build-and-install"), "#!/bin/sh\necho 'build-and-install ok'\n");
      fs.chmodSync(path.join(workingDir, "build-and-install"), 0o755);
      execSync("git add -A", { cwd: workingDir, stdio: "pipe" });
      execSync("git commit -m initial", { cwd: workingDir, stdio: "pipe" });
      const branch = execSync("git branch --show-current", { cwd: workingDir, encoding: "utf-8", stdio: "pipe" }).trim();
      execSync(`git push -u origin "${branch}"`, { cwd: workingDir, stdio: "pipe" });

      const cleanup = () => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
        if (originalGuard === undefined) delete process.env.TAMANDUA_TEST_GUARD;
        else process.env.TAMANDUA_TEST_GUARD = originalGuard;
        if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
        else process.env.TAMANDUA_STATE_DIR = originalStateDir;
        delete process.env.TAMANDUA_DB_PATH;
      };

      return { tmpDir, workingDir, originDir, stateDir, dbPath, cleanup };
    }

    function git(args: string[], cwd: string): string {
      return execSync(`git ${args.join(" ")}`, { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
    }

    function makeDummyServices() {
      const serviceCalls: string[] = [];
      return {
        serviceCalls,
        services: {
          snapshot: () => ({
            daemon: { running: false as const, pid: null, port: 3334 },
            dashboard: { running: false as const, pid: null, port: 3338 },
            mcp: { running: false as const, pid: null, port: 3339 },
          }),
          stopDaemon: () => { serviceCalls.push("stopDaemon"); return true; },
          stopDashboard: () => { serviceCalls.push("stopDashboard"); return true; },
          stopMcp: () => { serviceCalls.push("stopMcp"); return true; },
          startDaemon: async () => { serviceCalls.push("startDaemon"); return { pid: 1, port: 3334 }; },
          startDashboard: async () => { serviceCalls.push("startDashboard"); return { pid: 2, port: 3338 }; },
          startMcp: async () => { serviceCalls.push("startMcp"); return { pid: 3, port: 3339 }; },
        },
      };
    }

    it("behind-origin: ff pull succeeds, detects change", async () => {
      const { workingDir, originDir, cleanup } = setupRealGitRepo();
      try {
        // Add a new commit to origin
        const work2 = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "tamandua-update-git2-"));
        try {
          execSync(`git clone "${originDir}" "${work2}"`, { cwd: work2, stdio: "pipe" });
          execSync("git config user.email test@test.com", { cwd: work2, stdio: "pipe" });
          execSync("git config user.name Test", { cwd: work2, stdio: "pipe" });
          fs.writeFileSync(path.join(work2, "CHANGES.md"), "# v2");
          const branch2 = execSync("git branch --show-current", { cwd: work2, encoding: "utf-8", stdio: "pipe" }).trim();
          execSync(`git add -A && git commit -m v2 && git push origin "${branch2}"`, { cwd: work2, stdio: "pipe" });
        } finally {
          fs.rmSync(work2, { recursive: true, force: true });
        }

        const { services } = makeDummyServices();

        const result = await runUpdate({
          sourcePath: workingDir,
          output: { log: () => {}, warn: () => {} },
          services,
          checkActiveRuns: async () => [],
        });

        // Should detect change: pull updated HEAD, then build-and-install ran
        assert.equal(result.status, "updated");
        assert.notEqual(result.beforeHead, result.afterHead);
      } finally {
        cleanup();
      }
    });

    it("up-to-date: no_change when no new commits on origin", async () => {
      const { workingDir, cleanup } = setupRealGitRepo();
      try {
        const result = await runUpdate({
          sourcePath: workingDir,
          output: { log: () => {}, warn: () => {} },
        });

        assert.equal(result.status, "no_change");
        assert.equal(result.head, git(["rev-parse", "HEAD"], workingDir));
      } finally {
        cleanup();
      }
    });

    it("local-ahead: no_change when local has commits origin lacks (pull succeeds)", async () => {
      const { workingDir, cleanup } = setupRealGitRepo();
      try {
        // Make a local commit
        fs.writeFileSync(path.join(workingDir, "local-change.txt"), "local");
        execSync("git add -A && git commit -m 'local commit'", { cwd: workingDir, stdio: "pipe" });

        const result = await runUpdate({
          sourcePath: workingDir,
          output: { log: () => {}, warn: () => {} },
        });

        // git pull --ff-only succeeds when only local is ahead (no new origin commits)
        // since HEAD didn't change, result is no_change
        assert.equal(result.status, "no_change");
        assert.equal(result.head, git(["rev-parse", "HEAD"], workingDir));
      } finally {
        cleanup();
      }
    });

    it("diverged: refused_diverged when local and origin have diverged", async () => {
      const { workingDir, originDir, cleanup } = setupRealGitRepo();
      try {
        // Local commit
        fs.writeFileSync(path.join(workingDir, "local.txt"), "local");
        execSync("git add -A && git commit -m local", { cwd: workingDir, stdio: "pipe" });

        // Origin commit (via another clone)
        const work2 = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "tamandua-update-git3-"));
        try {
          execSync(`git clone "${originDir}" "${work2}"`, { cwd: work2, stdio: "pipe" });
          execSync("git config user.email test@test.com", { cwd: work2, stdio: "pipe" });
          execSync("git config user.name Test", { cwd: work2, stdio: "pipe" });
          fs.writeFileSync(path.join(work2, "origin.txt"), "origin");
          const branch2 = execSync("git branch --show-current", { cwd: work2, encoding: "utf-8", stdio: "pipe" }).trim();
          execSync(`git add -A && git commit -m origin && git push origin "${branch2}"`, { cwd: work2, stdio: "pipe" });
        } finally {
          fs.rmSync(work2, { recursive: true, force: true });
        }

        const result = await runUpdate({
          sourcePath: workingDir,
          output: { log: () => {}, warn: () => {} },
        });

        assert.equal(result.status, "refused_diverged");

        // Recovery assertions
        assert.ok(!fs.existsSync(path.join(workingDir, ".git", "rebase-merge")), "no rebase-merge");
        assert.ok(!fs.existsSync(path.join(workingDir, ".git", "rebase-apply")), "no rebase-apply");
        assert.ok(git(["symbolic-ref", "HEAD"], workingDir).startsWith("refs/heads/"), "HEAD is attached");
      } finally {
        cleanup();
      }
    });

    it("ahead+--force: rebuilds despite no new origin commits", async () => {
      const { workingDir, cleanup } = setupRealGitRepo();
      try {
        // Local commit
        fs.writeFileSync(path.join(workingDir, "local.txt"), "local");
        execSync("git add -A && git commit -m local", { cwd: workingDir, stdio: "pipe" });

        const { serviceCalls, services } = makeDummyServices();

        const result = await runUpdate({
          force: true,
          sourcePath: workingDir,
          output: { log: () => {}, warn: () => {} },
          services,
        });

        // With --force, build proceeds even when pull is up-to-date
        assert.equal(result.status, "updated");
        // The build-and-install ran (status is updated, not no_change)
        // Service stop/start only happens for services that were running
        // (our dummy services report all as stopped, so no stop calls expected)
      } finally {
        cleanup();
      }
    });

    it("refusal does not invoke service callbacks (true divergence)", async () => {
      const { workingDir, originDir, cleanup } = setupRealGitRepo();
      try {
        // Local commit
        fs.writeFileSync(path.join(workingDir, "local.txt"), "local");
        execSync("git add -A && git commit -m local", { cwd: workingDir, stdio: "pipe" });

        // Origin commit (via another clone) — creates true divergence
        const work2 = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "tamandua-update-git4-"));
        try {
          execSync(`git clone "${originDir}" "${work2}"`, { cwd: work2, stdio: "pipe" });
          execSync("git config user.email test@test.com", { cwd: work2, stdio: "pipe" });
          execSync("git config user.name Test", { cwd: work2, stdio: "pipe" });
          fs.writeFileSync(path.join(work2, "origin.txt"), "origin");
          const branch2 = execSync("git branch --show-current", { cwd: work2, encoding: "utf-8", stdio: "pipe" }).trim();
          execSync(`git add -A && git commit -m origin && git push origin "${branch2}"`, { cwd: work2, stdio: "pipe" });
        } finally {
          fs.rmSync(work2, { recursive: true, force: true });
        }

        const { serviceCalls, services } = makeDummyServices();

        const result = await runUpdate({
          sourcePath: workingDir,
          output: { log: () => {}, warn: () => {} },
          services,
        });

        assert.equal(result.status, "refused_diverged");
        // No service calls should have been made
        assert.deepEqual(serviceCalls, [], "service callbacks must not be invoked on refusal");
      } finally {
        cleanup();
      }
    });

    it("network failure: pull_failed when remote unreachable", async () => {
      const { workingDir, originDir, cleanup } = setupRealGitRepo();
      try {
        // Make a local commit so we're not at origin HEAD
        fs.writeFileSync(path.join(workingDir, "local.txt"), "local");
        execSync("git add -A && git commit -m local", { cwd: workingDir, stdio: "pipe" });

        // Replace origin remote URL with nonexistent path
        const nonexistentDir = path.join(fs.realpathSync("/tmp"), "nonexistent-git-dir-" + Date.now());
        execSync(`git remote set-url origin "${nonexistentDir}"`, { cwd: workingDir, stdio: "pipe" });

        const warnings: string[] = [];
        const logs: string[] = [];

        const result = await runUpdate({
          sourcePath: workingDir,
          output: {
            log: (msg) => logs.push(msg),
            warn: (msg) => warnings.push(msg),
          },
        });

        // Should return pull_failed, not refused_diverged (network/auth/missing-upstream = pull failure, not divergence)
        assert.equal(result.status, "pull_failed");
        // The pull_failed result includes an error field with the captured stderr
        if (result.status === "pull_failed") {
          assert.ok(typeof result.error === "string");
          assert.ok(result.error.length > 0, "error field must not be empty");
          // The error message should include stderr content (git error details)
          assert.ok(
            result.error.includes("fatal") || result.error.includes("not found") || result.error.includes("exit code"),
            `Expected error to contain git stderr, got: ${result.error.slice(0, 200)}`,
          );
        }
        // The warning should contain the pull failure details
        const allMessages = [...warnings, ...logs].join(" ");
        assert.ok(
          allMessages.includes("git pull failed") || allMessages.includes("Command failed") || allMessages.includes("fatal"),
          `Expected pull failure message, got: ${allMessages.slice(0, 500)}`,
        );
        // Must NOT contain the misleading divergence message
        assert.ok(
          !allMessages.includes("local commits origin does not have"),
          `Must not claim divergence on network failure: ${allMessages.slice(0, 500)}`,
        );
      } finally {
        cleanup();
      }
    });

    it("network failure with --force: proceeds rebuild-only with honest message", async () => {
      const { workingDir, cleanup } = setupRealGitRepo();
      try {
        // Replace origin remote URL with nonexistent path
        const nonexistentDir = path.join(fs.realpathSync("/tmp"), "nonexistent-git-dir-" + Date.now());
        execSync(`git remote set-url origin "${nonexistentDir}"`, { cwd: workingDir, stdio: "pipe" });

        const logs: string[] = [];
        const warnings: string[] = [];
        const { services } = makeDummyServices();

        const result = await runUpdate({
          force: true,
          sourcePath: workingDir,
          output: {
            log: (msg) => logs.push(msg),
            warn: (msg) => warnings.push(msg),
          },
          services,
          checkActiveRuns: async () => [],
        });

        // With --force, should proceed with rebuild
        assert.equal(result.status, "updated");
        const allMessages = [...logs, ...warnings].join(" ");
        // Must contain rebuild-as-is message, NOT the divergence message
        assert.ok(
          allMessages.includes("rebuilding current checkout as-is") || allMessages.includes("pull failed"),
          `Expected rebuild-as-is message, got: ${allMessages.slice(0, 500)}`,
        );
        assert.ok(
          !allMessages.includes("local checkout ahead of/diverged"),
          `Must not claim divergence on network failure with --force: ${allMessages.slice(0, 500)}`,
        );
      } finally {
        cleanup();
      }
    });
  });
});
