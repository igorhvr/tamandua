import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import { fileURLToPath } from "node:url";
import { resolveSourcePath } from "../dist/installer/paths.js";
import {
  runUpdate,
  type RunCommand,
  type UpdateOutput,
  type UpdateServiceSnapshot,
  type UpdateServices,
} from "../dist/cli/update.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

let envRoot: string | undefined;
let previousHome: string | undefined;
let previousStateDir: string | undefined;
let previousDbPath: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  previousStateDir = process.env.TAMANDUA_STATE_DIR;
  previousDbPath = process.env.TAMANDUA_DB_PATH;

  envRoot = tamanduaTempDir("tamandua-update-env-");
  const home = path.join(envRoot, "home");
  const state = path.join(envRoot, "state");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(state, { recursive: true });

  process.env.HOME = home;
  process.env.TAMANDUA_STATE_DIR = state;
  process.env.TAMANDUA_DB_PATH = path.join(state, "tamandua.db");
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
  else process.env.TAMANDUA_STATE_DIR = previousStateDir;
  if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
  else process.env.TAMANDUA_DB_PATH = previousDbPath;

  if (envRoot) {
    fs.rmSync(envRoot, { recursive: true, force: true });
    envRoot = undefined;
  }
});

function createSourceRoot(): string {
  const root = tamanduaTempDir("tamandua-update-source-");
  fs.writeFileSync(path.join(root, "package.json"), "{\"name\":\"tamandua-test\"}\n", "utf-8");
  fs.writeFileSync(path.join(root, "build-and-install"), "#!/bin/sh\nexit 0\n", { encoding: "utf-8", mode: 0o755 });
  return root;
}

function createOutput(): { output: UpdateOutput; logs: string[]; warnings: string[] } {
  const logs: string[] = [];
  const warnings: string[] = [];
  return {
    logs,
    warnings,
    output: {
      log: (message) => logs.push(message),
      warn: (message) => warnings.push(message),
    },
  };
}

interface CreateRunCommandOpts {
  heads: string[];
  pullShouldFail?: boolean;
  /** rev-list --count @{u}..HEAD result — set to "1" or higher for ahead/divergence tests */
  aheadCount?: string;
  /** Whether ls-remote --heads --exit-code origin fails (remote unreachable) */
  lsRemoteFails?: boolean;
  /** Whether rev-parse @{u} succeeds (upstream exists) — default true */
  upstreamExists?: boolean;
}

function createRunCommand(
  heads: string[] | CreateRunCommandOpts,
  calls: string[],
  opts?: { pullShouldFail?: boolean },
): RunCommand {
  const cfg: CreateRunCommandOpts =
    Array.isArray(heads)
      ? { heads, pullShouldFail: opts?.pullShouldFail }
      : heads;

  let headIndex = 0;
  return async (command, args, options) => {
    calls.push(`${command} ${args.join(" ")}`.trim());
    assert.equal(options.cwd.length > 0, true);

    if (command === "git" && args.join(" ") === "rev-parse HEAD") {
      const head = cfg.heads[Math.min(headIndex, cfg.heads.length - 1)];
      headIndex++;
      return { stdout: `${head}\n`, stderr: "" };
    }

    if (command === "git" && args[0] === "pull" && args[1] === "--ff-only") {
      if (cfg.pullShouldFail) {
        throw new Error("Command failed (exit code 128): git pull --ff-only");
      }
      return { stdout: "", stderr: "" };
    }

    if (command === "git" && args[0] === "ls-remote" && args[1] === "--heads" && args[2] === "--exit-code") {
      if (cfg.lsRemoteFails) {
        throw new Error("Command failed: git ls-remote");
      }
      return { stdout: "", stderr: "" };
    }

    if (command === "git" && args[0] === "rev-parse" && args[1] === "@{u}") {
      if (cfg.upstreamExists === false) {
        throw new Error("Command failed: no upstream");
      }
      return { stdout: "refs/remotes/origin/main\n", stderr: "" };
    }

    if (command === "git" && args[0] === "rev-list" && args[1] === "--count") {
      return { stdout: `${cfg.aheadCount ?? "0"}\n`, stderr: "" };
    }

    if (command === "./build-and-install" && args.length === 0) {
      return { stdout: "", stderr: "" };
    }

    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
}

function createServices(snapshot: UpdateServiceSnapshot, calls: string[] = []): UpdateServices {
  return {
    snapshot: () => {
      calls.push("snapshot");
      return snapshot;
    },
    stopDaemon: () => {
      calls.push("stopDaemon");
      return true;
    },
    stopDashboard: () => {
      calls.push("stopDashboard");
      return true;
    },
    stopMcp: () => {
      calls.push("stopMcp");
      return true;
    },
    startDaemon: async (port) => {
      calls.push(`startDaemon:${port}`);
      return { pid: 901, port };
    },
    startDashboard: async (port) => {
      calls.push(`startDashboard:${port}`);
      return { pid: 902, port };
    },
    startMcp: async (port) => {
      calls.push(`startMcp:${port}`);
      return { pid: 903, port };
    },
  };
}

describe("tamandua update command helpers", () => {
  it("resolves the source checkout path", () => {
    assert.equal(resolveSourcePath(), fs.realpathSync(REPO_ROOT));
  });

  it("stops after git pull when HEAD does not change", async () => {
    const sourcePath = createSourceRoot();
    const commands: string[] = [];
    const { output, logs } = createOutput();
    const sha = crypto.randomBytes(8).toString('hex');

    try {
      const result = await runUpdate({
        sourcePath,
        output,
        runCommand: createRunCommand([sha, sha], commands),
        services: {
          ...createServices({
            daemon: { running: false, pid: null, port: 4101 },
            dashboard: { running: false, pid: null, port: 4102 },
            mcp: { running: false, pid: null, port: 4103 },
          }),
          snapshot: () => {
            throw new Error("service snapshot should not run for no-change updates");
          },
        },
        checkActiveRuns: async () => {
          throw new Error("active run check should not run for no-change updates");
        },
      });

      assert.equal(result.status, "no_change");
      assert.deepEqual(commands, [
        "git rev-parse HEAD",
        "git pull --ff-only",
        "git rev-parse HEAD",
      ]);
      assert.match(logs.join("\n"), /No source changes after git pull/);
      assert.match(logs.join("\n"), /Skipping build, workflow install, and service restart/);
    } finally {
      fs.rmSync(sourcePath, { recursive: true, force: true });
    }
  });

  it("builds after a changed pull but does not cycle services when active runs exist without force", async () => {
    const sourcePath = createSourceRoot();
    const commands: string[] = [];
    const serviceCalls: string[] = [];
    const { output, warnings } = createOutput();
    const sha1 = crypto.randomBytes(8).toString('hex');
    const sha2 = crypto.randomBytes(8).toString('hex');

    try {
      const result = await runUpdate({
        sourcePath,
        output,
        runCommand: createRunCommand([sha1, sha2], commands),
        services: createServices({
          daemon: { running: true, pid: 111111, port: 4201 },
          dashboard: { running: true, pid: 222222, port: 4202 },
          mcp: { running: false, pid: null, port: 4203 },
        }, serviceCalls),
        checkActiveRuns: async () => [{
          id: "run-active",
          task: "keep working",
          status: "running",
          createdAt: "2026-05-13T00:00:00.000Z",
        }],
        listWorkflows: async () => {
          throw new Error("workflow install should not run while blocked");
        },
        waitForProcessExit: async () => {
          throw new Error("services should not be stopped while blocked");
        },
      });

      assert.equal(result.status, "blocked_active_runs");
      assert.deepEqual(commands, [
        "git rev-parse HEAD",
        "git pull --ff-only",
        "git rev-parse HEAD",
        "./build-and-install",
      ]);
      assert.deepEqual(serviceCalls, ["snapshot"]);
      assert.match(warnings.join("\n"), /Active Tamandua runs detected \(1\)/);
      assert.match(warnings.join("\n"), /tamandua update --force/);
    } finally {
      fs.rmSync(sourcePath, { recursive: true, force: true });
    }
  });

  it("with --force stops and restarts only services that were running, preserving ports", async () => {
    const sourcePath = createSourceRoot();
    const commands: string[] = [];
    const serviceCalls: string[] = [];
    const waitedPids: number[] = [];
    const installed: string[] = [];
    const { output, warnings } = createOutput();
    const sha1 = crypto.randomBytes(8).toString('hex');
    const sha2 = crypto.randomBytes(8).toString('hex');

    try {
      const result = await runUpdate({
        force: true,
        sourcePath,
        output,
        runCommand: createRunCommand([sha1, sha2], commands),
        services: createServices({
          daemon: { running: true, pid: 111111, port: 4301 },
          dashboard: { running: true, pid: 222222, port: 4302 },
          mcp: { running: false, pid: null, port: 4303 },
        }, serviceCalls),
        checkActiveRuns: async () => [{
          id: "run-active",
          task: "force through",
          status: "paused",
          createdAt: "2026-05-13T00:00:00.000Z",
        }],
        listWorkflows: async () => ["bug-fix", "feature-dev"],
        installWorkflowById: async (workflowId) => {
          installed.push(workflowId);
        },
        waitForProcessExit: async (pid) => {
          waitedPids.push(pid);
        },
      });

      assert.equal(result.status, "updated");
      assert.deepEqual(installed, ["bug-fix", "feature-dev"]);
      assert.deepEqual(waitedPids, [111111, 222222]);
      assert.deepEqual(serviceCalls, [
        "snapshot",
        "stopDaemon",
        "stopDashboard",
        "startDaemon:4301",
        "startDashboard:4302",
      ]);
      assert.match(warnings.join("\n"), /--force set, continuing/);
    } finally {
      fs.rmSync(sourcePath, { recursive: true, force: true });
    }
  });

  it("restarts previously running services if workflow install fails", async () => {
    const sourcePath = createSourceRoot();
    const serviceCalls: string[] = [];
    const sha1 = crypto.randomBytes(8).toString('hex');
    const sha2 = crypto.randomBytes(8).toString('hex');

    try {
      await assert.rejects(
        () => runUpdate({
          sourcePath,
          output: createOutput().output,
          runCommand: createRunCommand([sha1, sha2], []),
          services: createServices({
            daemon: { running: false, pid: null, port: 4401 },
            dashboard: { running: false, pid: null, port: 4402 },
            mcp: { running: true, pid: 333333, port: 4403 },
          }, serviceCalls),
          checkActiveRuns: async () => [],
          listWorkflows: async () => ["feature-dev"],
          installWorkflowById: async () => {
            throw new Error("install failed");
          },
          waitForProcessExit: async () => {},
        }),
        /Failed to install bundled workflow/,
      );

      assert.deepEqual(serviceCalls, [
        "snapshot",
        "stopMcp",
        "startMcp:4403",
      ]);
    } finally {
      fs.rmSync(sourcePath, { recursive: true, force: true });
    }
  });

  it("--force with no source changes still rebuilds, installs workflows, and cycles services", async () => {
    const sourcePath = createSourceRoot();
    const commands: string[] = [];
    const serviceCalls: string[] = [];
    const waitedPids: number[] = [];
    const installed: string[] = [];
    const { output, logs } = createOutput();
    const sha = crypto.randomBytes(8).toString('hex');

    try {
      const result = await runUpdate({
        force: true,
        sourcePath,
        output,
        runCommand: createRunCommand([sha, sha], commands),
        services: createServices({
          daemon: { running: true, pid: 111111, port: 4401 },
          dashboard: { running: true, pid: 222222, port: 4402 },
          mcp: { running: false, pid: null, port: 4403 },
        }, serviceCalls),
        checkActiveRuns: async () => [],
        listWorkflows: async () => ["bug-fix", "feature-dev"],
        installWorkflowById: async (workflowId) => {
          installed.push(workflowId);
        },
        waitForProcessExit: async (pid) => {
          waitedPids.push(pid);
        },
      });

      assert.equal(result.status, "updated");
      assert.deepEqual(commands, [
        "git rev-parse HEAD",
        "git pull --ff-only",
        "git rev-parse HEAD",
        "./build-and-install",
      ]);
      assert.deepEqual(installed, ["bug-fix", "feature-dev"]);
      assert.deepEqual(waitedPids, [111111, 222222]);
      assert.deepEqual(serviceCalls, [
        "snapshot",
        "stopDaemon",
        "stopDashboard",
        "startDaemon:4401",
        "startDashboard:4402",
      ]);
      assert.match(logs.join("\n"), /--force set; rebuilding/);
      assert.match(logs.join("\n"), /Running \.\/build-and-install/);
    } finally {
      fs.rmSync(sourcePath, { recursive: true, force: true });
    }
  });

  it("--force with no source changes returns updated not no_change", async () => {
    const sourcePath = createSourceRoot();
    const commands: string[] = [];
    const { output } = createOutput();
    const sha = crypto.randomBytes(8).toString('hex');

    try {
      const result = await runUpdate({
        force: true,
        sourcePath,
        output,
        runCommand: createRunCommand([sha, sha], commands),
        services: createServices({
          daemon: { running: false, pid: null, port: 4501 },
          dashboard: { running: false, pid: null, port: 4502 },
          mcp: { running: false, pid: null, port: 4503 },
        }),
        checkActiveRuns: async () => [],
        listWorkflows: async () => ["feature-dev"],
        installWorkflowById: async () => {},
        waitForProcessExit: async () => {},
      });

      assert.equal(result.status, "updated");
      assert.notDeepEqual(result.status, "no_change");
    } finally {
      fs.rmSync(sourcePath, { recursive: true, force: true });
    }
  });

  // --- ff-only divergence tests ---

  it("refuses when local is ahead of origin (ff-only pull fails, no --force)", async () => {
    const sourcePath = createSourceRoot();
    const commands: string[] = [];
    const { output, logs, warnings } = createOutput();
    const sha = crypto.randomBytes(8).toString('hex');

    try {
      const result = await runUpdate({
        sourcePath,
        output,
        runCommand: createRunCommand({ heads: [sha], pullShouldFail: true, aheadCount: "1" }, commands),
        services: createServices({
          daemon: { running: true, pid: 111111, port: 4601 },
          dashboard: { running: true, pid: 222222, port: 4602 },
          mcp: { running: false, pid: null, port: 4603 },
        }),
      });

      assert.equal(result.status, "refused_diverged");
      assert.deepEqual(commands, [
        "git rev-parse HEAD",
        "git pull --ff-only",
        "git ls-remote --heads --exit-code origin",
        "git rev-parse @{u}",
        "git rev-list --count @{u}..HEAD",
      ]);
      assert.match(warnings.join("\n"), /Source checkout at .+ has local commits origin does not have/);
      assert.match(warnings.join("\n"), /tamandua update --force/);
      // No service stop logs — refusal happens before service stops
      assert.ok(!logs.some(l => /Stopping|stop/i.test(l)), "no service stop messages in logs");
    } finally {
      fs.rmSync(sourcePath, { recursive: true, force: true });
    }
  });

  it("refuses on diverged histories (same as local-ahead)", async () => {
    const sourcePath = createSourceRoot();
    const commands: string[] = [];
    const { output, warnings } = createOutput();
    const sha = crypto.randomBytes(8).toString('hex');

    try {
      const result = await runUpdate({
        sourcePath,
        output,
        runCommand: createRunCommand({ heads: [sha], pullShouldFail: true, aheadCount: "1" }, commands),
        services: createServices({
          daemon: { running: false, pid: null, port: 4701 },
          dashboard: { running: false, pid: null, port: 4702 },
          mcp: { running: true, pid: 333333, port: 4703 },
        }),
      });

      assert.equal(result.status, "refused_diverged");
      assert.deepEqual(commands, [
        "git rev-parse HEAD",
        "git pull --ff-only",
        "git ls-remote --heads --exit-code origin",
        "git rev-parse @{u}",
        "git rev-list --count @{u}..HEAD",
      ]);
      assert.match(warnings.join("\n"), /Source checkout at .+ has local commits origin does not have/);
      assert.match(warnings.join("\n"), /tamandua update --force/);
    } finally {
      fs.rmSync(sourcePath, { recursive: true, force: true });
    }
  });

  it("ahead + --force skips pull and proceeds with rebuild", async () => {
    const sourcePath = createSourceRoot();
    const commands: string[] = [];
    const serviceCalls: string[] = [];
    const installed: string[] = [];
    const { output, logs } = createOutput();
    const sha = crypto.randomBytes(8).toString('hex');

    try {
      const result = await runUpdate({
        force: true,
        sourcePath,
        output,
        runCommand: createRunCommand({ heads: [sha, sha], pullShouldFail: true, aheadCount: "1" }, commands),
        services: createServices({
          daemon: { running: true, pid: 111111, port: 4801 },
          dashboard: { running: false, pid: null, port: 4802 },
          mcp: { running: false, pid: null, port: 4803 },
        }, serviceCalls),
        checkActiveRuns: async () => [],
        listWorkflows: async () => ["bug-fix"],
        installWorkflowById: async (workflowId) => {
          installed.push(workflowId);
        },
        waitForProcessExit: async () => {},
      });

      assert.equal(result.status, "updated");
      // Pull attempted and failed, then divergence probes, then force-skip, then rebuild
      assert.deepEqual(commands, [
        "git rev-parse HEAD",
        "git pull --ff-only",
        "git ls-remote --heads --exit-code origin",
        "git rev-parse @{u}",
        "git rev-list --count @{u}..HEAD",
        "git rev-parse HEAD",
        "./build-and-install",
      ]);
      assert.match(logs.join("\n"), /skipping pull: local checkout ahead of\/diverged from origin \(--force\)/);
      assert.match(logs.join("\n"), /--force set; rebuilding/);
      assert.deepEqual(installed, ["bug-fix"]);
      assert.deepEqual(serviceCalls, [
        "snapshot",
        "stopDaemon",
        "startDaemon:4801",
      ]);
    } finally {
      fs.rmSync(sourcePath, { recursive: true, force: true });
    }
  });

  it("after refusal, subsequent behind-origin update works", async () => {
    const sourcePath = createSourceRoot();
    const { output, warnings } = createOutput();
    const sha = crypto.randomBytes(8).toString('hex');
    const sha2 = crypto.randomBytes(8).toString('hex');

    try {
      // First update: pull fails, get refused
      const commands1: string[] = [];
      const result1 = await runUpdate({
        sourcePath,
        output,
        runCommand: createRunCommand({ heads: [sha], pullShouldFail: true, aheadCount: "1" }, commands1),
        services: createServices({
          daemon: { running: false, pid: null, port: 4901 },
          dashboard: { running: false, pid: null, port: 4902 },
          mcp: { running: false, pid: null, port: 4903 },
        }),
      });

      assert.equal(result1.status, "refused_diverged");
      assert.match(warnings.join("\n"), /Source checkout at .+ has local commits origin does not have/);

      // Generate fresh output/warnings for second call
      const { output: output2, warnings: warnings2 } = createOutput();

      // Second update: behind-origin (pull succeeds, heads differ)
      const cmd2: string[] = [];
      const result2 = await runUpdate({
        sourcePath,
        output: output2,
        runCommand: createRunCommand([sha, sha2], cmd2),
        services: createServices({
          daemon: { running: false, pid: null, port: 4901 },
          dashboard: { running: false, pid: null, port: 4902 },
          mcp: { running: false, pid: null, port: 4903 },
        }),
        checkActiveRuns: async () => [],
        listWorkflows: async () => ["bug-fix"],
        installWorkflowById: async () => {},
        waitForProcessExit: async () => {},
      });

      assert.equal(result2.status, "updated");
      assert.deepEqual(cmd2, [
        "git rev-parse HEAD",
        "git pull --ff-only",
        "git rev-parse HEAD",
        "./build-and-install",
      ]);
    } finally {
      fs.rmSync(sourcePath, { recursive: true, force: true });
    }
  });
});
