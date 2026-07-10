import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
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
      assert.equal(typeof services.stopDashboard, "function");
      assert.equal(typeof services.stopMcp, "function");
      assert.equal(typeof services.stopControlPlane, "function");
      assert.equal(typeof services.startDashboard, "function");
      assert.equal(typeof services.startMcp, "function");
      assert.equal(typeof services.startControlPlane, "function");
    });

    it("snapshot returns an object with dashboard, mcp, and controlPlane", () => {
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
      assert.ok("dashboard" in snap);
      assert.ok("mcp" in snap);
      assert.ok("controlPlane" in snap);
      assert.equal(typeof snap.dashboard.running, "boolean");
      assert.equal(typeof snap.mcp.running, "boolean");
      assert.equal(typeof snap.controlPlane.running, "boolean");
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
        if (command === "git" && args[0] === "pull") {
          return { stdout: "Already up to date.", stderr: "" };
        }
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      };

      const result = await runUpdate({
        runCommand: mockRunCommand,
        output: { log: () => {}, warn: () => {} },
        services: {
          snapshot: () => ({
            dashboard: { running: false, pid: null, port: 3334 },
            mcp: { running: false, pid: null, port: 3338 },
            controlPlane: { running: false, pid: null, port: 3339 },
          }),
          stopDashboard: () => false,
          stopMcp: () => false,
          stopControlPlane: () => false,
          startDashboard: async () => ({ pid: 1, port: 3334 }),
          startMcp: async () => ({ pid: 2, port: 3338 }),
          startControlPlane: async () => ({ pid: 3, port: 3339 }),
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
});
