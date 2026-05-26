import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflowRunArgs } from "../../dist/cli/workflow-run-args.js";
import { cleanChildEnv } from "../../tests/helpers/test-env.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function makeTestEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-cli-test-"));
  const stateDir = path.join(tmpDir, "state");
  const homeDir = path.join(tmpDir, "home");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(homeDir);
  return { tmpDir, stateDir, homeDir };
}

function cli(args: string[], env?: Record<string, string>) {
  const wrapperPath = path.resolve("bin/tamandua");
  const testEnv = makeTestEnv();
  try {
    const result = spawnSync("/bin/sh", [wrapperPath, ...args], {
      encoding: "utf8",
      env: cleanChildEnv({ HOME: testEnv.homeDir,
        TAMANDUA_STATE_DIR: testEnv.stateDir,
        ...env, }),
    });
    return { ...result, testEnv };
  } catch (err) {
    fs.rmSync(testEnv.tmpDir, { recursive: true, force: true });
    throw err;
  }
}

describe("parseWorkflowRunArgs", () => {
  it("parses task title from positional args (no flags)", () => {
    const result = parseWorkflowRunArgs(["Implement", "a thing"]);
    assert.deepEqual(result, {
      taskTitle: "Implement a thing",
      workingDirectoryForHarness: undefined,
      worktreeOriginRepository: undefined,
      worktreeOriginRef: undefined,
      noHurrySaveTokensMode: undefined,
      noRelaunchUponRugpull: undefined,
      harnessAs: undefined,
    });
  });

  it("parses --no-hurry-please-save-tokens-mode as a boolean flag", () => {
    const result = parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "do something",
    ]);
    assert.equal(result.taskTitle, "do something");
    assert.equal(result.noHurrySaveTokensMode, true);
  });

  it("parses --no-hurry-please-save-tokens-mode alongside other flags", () => {
    const result = parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "--working-directory-for-harness",
      "/some/dir",
      "build the frontend",
    ]);
    assert.equal(result.taskTitle, "build the frontend");
    assert.equal(result.noHurrySaveTokensMode, true);
    assert.equal(result.workingDirectoryForHarness, "/some/dir");
  });

  it("flag not set when absent", () => {
    const result = parseWorkflowRunArgs([
      "--working-directory-for-harness",
      "/tmp",
      "task here",
    ]);
    assert.equal(result.noHurrySaveTokensMode, undefined);
    assert.equal(result.workingDirectoryForHarness, "/tmp");
    assert.equal(result.taskTitle, "task here");
  });

  it("parses all flags together with save-tokens-mode", () => {
    const result = parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "--worktree-origin-repository",
      "/repo",
      "--worktree-origin-ref",
      "main",
      "--working-directory-for-harness",
      "/work",
      "do the task",
    ]);
    assert.equal(result.taskTitle, "do the task");
    assert.equal(result.noHurrySaveTokensMode, true);
    assert.equal(result.worktreeOriginRepository, "/repo");
    assert.equal(result.worktreeOriginRef, "main");
    assert.equal(result.workingDirectoryForHarness, "/work");
  });

  it("save-tokens-mode at end of args", () => {
    const result = parseWorkflowRunArgs([
      "do something",
      "--no-hurry-please-save-tokens-mode",
    ]);
    assert.equal(result.taskTitle, "do something");
    assert.equal(result.noHurrySaveTokensMode, true);
  });

  it("parses --working-directory-for-harness=VALUE inline form", () => {
    const result = parseWorkflowRunArgs([
      "--working-directory-for-harness=/some/path",
      "task",
    ]);
    assert.equal(result.taskTitle, "task");
    assert.equal(result.workingDirectoryForHarness, "/some/path");
  });

  it("throws when inline --working-directory-for-harness= has empty value", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["--working-directory-for-harness=", "task"]),
      /Missing value for --working-directory-for-harness/i,
    );
  });

  it("parses --worktree-origin-repository=VALUE inline form", () => {
    const result = parseWorkflowRunArgs([
      "--worktree-origin-repository=/repo/path",
      "task",
    ]);
    assert.equal(result.taskTitle, "task");
    assert.equal(result.worktreeOriginRepository, "/repo/path");
  });

  it("throws when inline --worktree-origin-repository= has empty value", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["--worktree-origin-repository=", "task"]),
      /Missing value for --worktree-origin-repository/i,
    );
  });

  it("parses --worktree-origin-ref=VALUE inline form", () => {
    const result = parseWorkflowRunArgs([
      "--worktree-origin-ref=main",
      "task",
    ]);
    assert.equal(result.taskTitle, "task");
    assert.equal(result.worktreeOriginRef, "main");
  });

  it("throws when inline --worktree-origin-ref= has empty value", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["--worktree-origin-ref=", "task"]),
      /Missing value for --worktree-origin-ref/i,
    );
  });

  it("throws when --working-directory-for-harness has missing value (separate form)", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["--working-directory-for-harness"]),
      /Missing value for --working-directory-for-harness/i,
    );
  });

  it("handles inline form with no additional task args", () => {
    const result = parseWorkflowRunArgs(["--working-directory-for-harness=/tmp"]);
    assert.equal(result.taskTitle, "");
    assert.equal(result.workingDirectoryForHarness, "/tmp");
  });

  it("parses --pi-as-harness flag", () => {
    const result = parseWorkflowRunArgs(["--pi-as-harness", "do the task"]);
    assert.equal(result.taskTitle, "do the task");
    assert.equal(result.harnessAs, "pi");
  });

  it("parses --hermes-as-harness flag", () => {
    const result = parseWorkflowRunArgs(["--hermes-as-harness", "do the task"]);
    assert.equal(result.taskTitle, "do the task");
    assert.equal(result.harnessAs, "hermes");
  });

  it("does not set harnessAs when neither flag present", () => {
    const result = parseWorkflowRunArgs(["do the task"]);
    assert.equal(result.harnessAs, undefined);
  });

  it("throws when both --pi-as-harness and --hermes-as-harness specified", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["--pi-as-harness", "--hermes-as-harness", "task"]),
      /Cannot specify both --pi-as-harness and --hermes-as-harness/,
    );
  });

  it("throws when both flags in reverse order", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["--hermes-as-harness", "--pi-as-harness", "task"]),
      /Cannot specify both --pi-as-harness and --hermes-as-harness/,
    );
  });

  it("parses hermes harness alongside other flags", () => {
    const result = parseWorkflowRunArgs([
      "--hermes-as-harness",
      "--no-hurry-please-save-tokens-mode",
      "--working-directory-for-harness",
      "/work",
      "build feature",
    ]);
    assert.equal(result.taskTitle, "build feature");
    assert.equal(result.harnessAs, "hermes");
    assert.equal(result.noHurrySaveTokensMode, true);
    assert.equal(result.workingDirectoryForHarness, "/work");
  });

  it("parses pi harness alongside other flags", () => {
    const result = parseWorkflowRunArgs([
      "--pi-as-harness",
      "--worktree-origin-repository",
      "/repo",
      "--worktree-origin-ref",
      "main",
      "implement feature",
    ]);
    assert.equal(result.taskTitle, "implement feature");
    assert.equal(result.harnessAs, "pi");
    assert.equal(result.worktreeOriginRepository, "/repo");
    assert.equal(result.worktreeOriginRef, "main");
  });

  it("parses --no-relaunch-upon-rugpull as a boolean flag", () => {
    const result = parseWorkflowRunArgs([
      "--no-relaunch-upon-rugpull",
      "do something",
    ]);
    assert.equal(result.taskTitle, "do something");
    assert.equal(result.noRelaunchUponRugpull, true);
  });

  it("noRelaunchUponRugpull is undefined when flag not set", () => {
    const result = parseWorkflowRunArgs(["task here"]);
    assert.equal(result.noRelaunchUponRugpull, undefined);
  });

  it("parses --no-relaunch-upon-rugpull alongside other flags", () => {
    const result = parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "--no-relaunch-upon-rugpull",
      "--working-directory-for-harness",
      "/work",
      "build feature",
    ]);
    assert.equal(result.taskTitle, "build feature");
    assert.equal(result.noHurrySaveTokensMode, true);
    assert.equal(result.noRelaunchUponRugpull, true);
    assert.equal(result.workingDirectoryForHarness, "/work");
  });
});

describe("CLI entrypoint regression: no ExperimentalWarning", () => {
  it("should not emit SQLite ExperimentalWarning when invoked through bin/tamandua wrapper", () => {
    const result = cli(["version"]);
    try {
      const stderr = result.stderr ?? "";
      const stdout = result.stdout ?? "";

      assert.doesNotMatch(stderr, /ExperimentalWarning/);
      assert.doesNotMatch(stdout, /ExperimentalWarning/);
      assert.match(stdout, /^tamandua v/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });
});

describe("CLI entrypoint", () => {
  it("runs when invoked through a symlink", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-cli-test-"));
    const stateDir = path.join(tmpDir, "state");
    const homeDir = path.join(tmpDir, "home");
    fs.mkdirSync(stateDir);
    fs.mkdirSync(homeDir);

    try {
      const cliPath = path.resolve("dist/cli/cli.js");
      const symlinkPath = path.join(tmpDir, "tamandua");
      fs.symlinkSync(cliPath, symlinkPath);

      const output = execFileSync(symlinkPath, ["version"], {
        encoding: "utf8",
        env: cleanChildEnv({ HOME: homeDir,
          TAMANDUA_STATE_DIR: stateDir, }),
      });

      assert.match(output, /^tamandua v/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("--help infrastructure", () => {
  it("tamandua --help prints usage and exits 0", () => {
    const result = cli(["--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /tamandua get-ready/);
      assert.match(result.stdout ?? "", /tamandua update/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua -h prints usage and exits 0 (shorthand)", () => {
    const result = cli(["-h"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("command with --help prints usage and exits 0", () => {
    const result = cli(["step", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("--help suppresses update warning on stderr", () => {
    const result = cli(["--help"]);
    try {
      assert.equal(result.status, 0);
      assert.doesNotMatch(result.stderr ?? "", /WARNING: A new version/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("--help does not execute the command (no side effects)", () => {
    // Using a command that would normally require state/files
    const result = cli(["workflow", "run", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Start a new workflow run/);
      // Should not produce error about missing workflow name
      assert.doesNotMatch(result.stderr ?? "", /Missing workflow name/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("--help works regardless of position in args", () => {
    const result = cli(["--help", "workflow", "run"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua tamandua --help shows help about the ant easter egg", () => {
    const result = cli(["tamandua", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /ASCII art easter egg/);
      assert.match(result.stdout ?? "", /tamandua tamandua/);
      assert.match(result.stdout ?? "", /randomly selected tamandua-themed quote/);
      // Should NOT contain global usage
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua version --help shows help about version display", () => {
    const result = cli(["version", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Display installed version/);
      assert.match(result.stdout ?? "", /tamandua version/);
      assert.match(result.stdout ?? "", /tamandua --version/);
      assert.match(result.stdout ?? "", /tamandua -v/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua --version --help shows version help (alias)", () => {
    const result = cli(["--version", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Display installed version/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua -v --help shows version help (shorthand alias)", () => {
    const result = cli(["-v", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Display installed version/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua skill-path --help shows help about skill path resolution", () => {
    const result = cli(["skill-path", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Print path to bundled tamandua-agents skill/);
      assert.match(result.stdout ?? "", /AGENTS\.md/);
      assert.match(result.stdout ?? "", /IDENTITY\.md/);
      assert.match(result.stdout ?? "", /SOUL\.md/);
      assert.match(result.stdout ?? "", /provisioned to workflow agents/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua source-path --help shows help about source path resolution", () => {
    const result = cli(["source-path", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Print Tamandua source checkout path/);
      assert.match(result.stdout ?? "", /dist\//);
      assert.match(result.stdout ?? "", /package\.json/);
      assert.match(result.stdout ?? "", /build-and-install/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("existing commands still work when --help is NOT passed", () => {
    const result = cli(["version"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /^tamandua v/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  // US-003: update, install, uninstall
  it("tamandua update --help shows detailed 12-step explanation", () => {
    const result = cli(["update", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /local source maintenance/);
      assert.match(result.stdout ?? "", /not a package-manager update/);
      // Step-by-step detail
      assert.match(result.stdout ?? "", /1\. Resolves the installed/);
      assert.match(result.stdout ?? "", /2\. Reads current git HEAD/);
      assert.match(result.stdout ?? "", /3\. Runs git pull/);
      assert.match(result.stdout ?? "", /4\. Reads git HEAD again/);
      assert.match(result.stdout ?? "", /5\. If HEAD did not change/);
      assert.match(result.stdout ?? "", /6\. If HEAD changed/);
      assert.match(result.stdout ?? "", /7\. Takes a snapshot/);
      assert.match(result.stdout ?? "", /8\. Checks for active runs/);
      assert.match(result.stdout ?? "", /9\. If active runs exist/);
      assert.match(result.stdout ?? "", /10\. Otherwise, it stops/);
      assert.match(result.stdout ?? "", /11\. Installs every bundled/);
      assert.match(result.stdout ?? "", /12\. Restarts only the services/);
      // --force documented
      assert.match(result.stdout ?? "", /--force/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua get-ready --help explains workflow installation and dashboard startup", () => {
    const result = cli(["get-ready", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Install all bundled workflows/);
      assert.match(result.stdout ?? "", /CLI symlink/);
      assert.match(result.stdout ?? "", /starts it on the default port/);
      assert.match(result.stdout ?? "", /registers agents/);
      assert.match(result.stdout ?? "", /MCP server/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua update/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua uninstall --help explains service shutdown and workflow removal", () => {
    const result = cli(["uninstall", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Fully remove Tamandua workflows/);
      assert.match(result.stdout ?? "", /Stops the dashboard daemon/);
      assert.match(result.stdout ?? "", /Stops the standalone MCP/);
      assert.match(result.stdout ?? "", /removes every installed/);
      assert.match(result.stdout ?? "", /agent workspaces/);
      assert.match(result.stdout ?? "", /cron jobs/);
      assert.match(result.stdout ?? "", /--force/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua update/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua update shows --force flag behavior in help", () => {
    const result = cli(["update", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /--force\s+Continue update despite active runs/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua uninstall shows --force flag behavior in help", () => {
    const result = cli(["uninstall", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /--force\s+Skip the active-runs check/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  // US-004: step subcommand help
  it("tamandua step peek --help shows HAS_WORK/NO_WORK output and --run-id", () => {
    const result = cli(["step", "peek", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Check for pending work/);
      assert.match(result.stdout ?? "", /HAS_WORK/);
      assert.match(result.stdout ?? "", /NO_WORK/);
      assert.match(result.stdout ?? "", /--run-id/);
      assert.match(result.stdout ?? "", /agent-id/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua step claim --help shows JSON output and --run-id", () => {
    const result = cli(["step", "claim", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Atomically claim a pending step/);
      assert.match(result.stdout ?? "", /"stepId"/);
      assert.match(result.stdout ?? "", /"runId"/);
      assert.match(result.stdout ?? "", /"input"/);
      assert.match(result.stdout ?? "", /--run-id/);
      assert.match(result.stdout ?? "", /NO_WORK/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua step complete --help shows stdin input format", () => {
    const result = cli(["step", "complete", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Mark a step as done/);
      assert.match(result.stdout ?? "", /STATUS: done/);
      assert.match(result.stdout ?? "", /CHANGES:/);
      assert.match(result.stdout ?? "", /TESTS:/);
      assert.match(result.stdout ?? "", /stdin/);
      assert.match(result.stdout ?? "", /EOF/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua step fail --help shows retry behavior", () => {
    const result = cli(["step", "fail", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Mark a step as failed/);
      assert.match(result.stdout ?? "", /retry logic/);
      assert.match(result.stdout ?? "", /escalated/);
      assert.match(result.stdout ?? "", /Unknown error/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua step stories --help shows story status display", () => {
    const result = cli(["step", "stories", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /List all stories/);
      assert.match(result.stdout ?? "", /US-001/);
      assert.match(result.stdout ?? "", /done/);
      assert.match(result.stdout ?? "", /pending/);
      assert.match(result.stdout ?? "", /retry/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua step --help (no known subcommand) falls back to global usage", () => {
    const result = cli(["step", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  // US-005: mcp, dashboard, control-plane help
  it("tamandua mcp --help shows help for all MCP subcommands", () => {
    const result = cli(["mcp", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Manage the standalone MCP HTTP server/);
      assert.match(result.stdout ?? "", /start.*--port/);
      assert.match(result.stdout ?? "", /stop/);
      assert.match(result.stdout ?? "", /status/);
      assert.match(result.stdout ?? "", /3338/);
      assert.match(result.stdout ?? "", /\/mcp/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua dashboard --help shows help for all dashboard subcommands", () => {
    const result = cli(["dashboard", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Manage the web dashboard daemon/);
      assert.match(result.stdout ?? "", /start.*--port/);
      assert.match(result.stdout ?? "", /stop/);
      assert.match(result.stdout ?? "", /status/);
      assert.match(result.stdout ?? "", /3334/);
      assert.match(result.stdout ?? "", /MCP server/);
      assert.match(result.stdout ?? "", /monitoring workflow runs/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua control-plane --help shows help for all control-plane subcommands", () => {
    const result = cli(["control-plane", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Manage the control plane server/);
      assert.match(result.stdout ?? "", /start.*--port/);
      assert.match(result.stdout ?? "", /stop/);
      assert.match(result.stdout ?? "", /status/);
      assert.match(result.stdout ?? "", /3339/);
      assert.match(result.stdout ?? "", /scheduling API/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua mcp start --help shows specific help for the start subcommand", () => {
    const result = cli(["mcp", "start", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Start the standalone MCP HTTP server/);
      assert.match(result.stdout ?? "", /--port/);
      assert.match(result.stdout ?? "", /default: 3338/);
      assert.match(result.stdout ?? "", /already running/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("--port flag is documented in mcp start command help", () => {
    const result = cli(["mcp", "start", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /--port N\s+Port to listen on \(default: 3338\)/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  // US-006: logs and logs-tail help
  it("tamandua logs --help shows selector syntax (run-id, #run-number, line count)", () => {
    const result = cli(["logs", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Show recent activity events/);
      assert.match(result.stdout ?? "", /run-id.*prefix/);
      assert.match(result.stdout ?? "", /#<N>/);
      assert.match(result.stdout ?? "", /last 50/);
      assert.match(result.stdout ?? "", /tamandua logs 20/);
      assert.match(result.stdout ?? "", /tamandua logs abc123/);
      assert.match(result.stdout ?? "", /tamandua logs #3/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua logs-tail --help explains real-time following and SIGINT to stop", () => {
    const result = cli(["logs-tail", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Follow activity events in real-time/);
      assert.match(result.stdout ?? "", /SIGINT/);
      assert.match(result.stdout ?? "", /polling for new events/);
      assert.match(result.stdout ?? "", /TAMANDUA_LOGS_TAIL_POLL_MS/);
      assert.match(result.stdout ?? "", /tamandua logs-tail 20/);
      assert.match(result.stdout ?? "", /tamandua logs-tail abc123/);
      assert.match(result.stdout ?? "", /tamandua logs-tail #3/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  // US-007: worktree commands help
  it("tamandua worktree --help shows all subcommands", () => {
    const result = cli(["worktree", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Manage git worktrees for workflow runs/);
      assert.match(result.stdout ?? "", /list.*List all managed worktrees/);
      assert.match(result.stdout ?? "", /status.*Show detailed info/);
      assert.match(result.stdout ?? "", /remove.*Remove a managed worktree/);
      assert.match(result.stdout ?? "", /prune.*Remove old completed worktrees/);
      // Should show examples
      assert.match(result.stdout ?? "", /tamandua worktree list/);
      assert.match(result.stdout ?? "", /tamandua worktree status abc12345/);
      assert.match(result.stdout ?? "", /tamandua worktree prune --completed --older-than 7d/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua worktree prune --help documents --completed and --older-than flags", () => {
    const result = cli(["worktree", "prune", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Remove old completed worktrees/);
      assert.match(result.stdout ?? "", /--completed/);
      assert.match(result.stdout ?? "", /--older-than/);
      assert.match(result.stdout ?? "", /completed or canceled/);
      assert.match(result.stdout ?? "", /Duration format/);
      assert.match(result.stdout ?? "", /7d.*7 days/);
      assert.match(result.stdout ?? "", /24h.*24 hours/);
      assert.match(result.stdout ?? "", /30m.*30 minutes/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua worktree remove --help documents --force flag", () => {
    const result = cli(["worktree", "remove", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Remove a managed worktree/);
      assert.match(result.stdout ?? "", /--force/);
      assert.match(result.stdout ?? "", /Allow removal.*any status/);
      assert.match(result.stdout ?? "", /non-ready/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua worktree list --help explains list output", () => {
    const result = cli(["worktree", "list", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /List all managed worktrees/);
      assert.match(result.stdout ?? "", /Status.*Worktree status/);
      assert.match(result.stdout ?? "", /Run ID/);
      assert.match(result.stdout ?? "", /Cleanup/);
      assert.match(result.stdout ?? "", /Path/);
      assert.match(result.stdout ?? "", /Origin/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua worktree status --help shows detailed fields", () => {
    const result = cli(["worktree", "status", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Show detailed worktree info for a run/);
      assert.match(result.stdout ?? "", /Origin repo/);
      assert.match(result.stdout ?? "", /Origin ref/);
      assert.match(result.stdout ?? "", /Origin SHA/);
      assert.match(result.stdout ?? "", /Orig branch/);
      assert.match(result.stdout ?? "", /Worktree.*Absolute filesystem path/);
      assert.match(result.stdout ?? "", /Cleanup/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua logs --help shows examples for each selector kind", () => {
    const result = cli(["logs", "--help"]);
    try {
      assert.equal(result.status, 0);
      // last 50 global
      assert.match(result.stdout ?? "", /Show last 50 global events/);
      // line count
      assert.match(result.stdout ?? "", /Show last 20 global events/);
      // run-id prefix
      assert.match(result.stdout ?? "", /Show events for run starting with/);
      // run number
      assert.match(result.stdout ?? "", /Show events for run #3/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua autoresearch --help shows the native experiment-loop commands", () => {
    const result = cli(["autoresearch", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Run durable optimization experiment loops/);
      assert.match(result.stdout ?? "", /init.*Create a new AutoResearch session/);
      assert.match(result.stdout ?? "", /run.*Run the configured experiment command/);
      assert.match(result.stdout ?? "", /log.*Log the keep\/discard decision/);
      assert.match(result.stdout ?? "", /status.*Summarize baseline/);
      assert.match(result.stdout ?? "", /next.*Print the ratchet prompt/);
      assert.match(result.stdout ?? "", /autoresearch\.jsonl/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua autoresearch log --help documents the ratchet fields", () => {
    const result = cli(["autoresearch", "log", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Record experiment learning and decision/);
      assert.match(result.stdout ?? "", /--status/);
      assert.match(result.stdout ?? "", /--hypothesis/);
      assert.match(result.stdout ?? "", /--learned/);
      assert.match(result.stdout ?? "", /--next-focus/);
      assert.match(result.stdout ?? "", /checks_failed/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  // US-008: workflow commands help
  it("tamandua workflow --help lists all subcommands with brief descriptions", () => {
    const result = cli(["workflow", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Manage workflows and runs/);
      assert.match(result.stdout ?? "", /list.*List available bundled workflows/);
      assert.match(result.stdout ?? "", /runs.*List all workflow runs/);
      assert.match(result.stdout ?? "", /install.*Install a specific workflow/);
      assert.match(result.stdout ?? "", /uninstall.*Uninstall a workflow/);
      assert.match(result.stdout ?? "", /run.*Start a new workflow run/);
      assert.match(result.stdout ?? "", /status.*Show detailed run status/);
      assert.match(result.stdout ?? "", /autoresearch[\s\S]*Show AutoResearch progress/);
      assert.match(result.stdout ?? "", /stop.*Cancel a running workflow/);
      assert.match(result.stdout ?? "", /pause.*Pause a running workflow/);
      assert.match(result.stdout ?? "", /resume.*Resume a paused or failed/);
      assert.match(result.stdout ?? "", /pause-all.*Pause all running/);
      assert.match(result.stdout ?? "", /resume-all.*Resume all paused/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow autoresearch --help documents run progress", () => {
    const result = cli(["workflow", "autoresearch", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Show AutoResearch progress for a workflow run/);
      assert.match(result.stdout ?? "", /autoresearch\.jsonl/);
      assert.match(result.stdout ?? "", /tamandua workflow autoresearch abc12345/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow run --help documents all flags", () => {
    const result = cli(["workflow", "run", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Start a new workflow run/);
      assert.match(result.stdout ?? "", /--no-hurry-please-save-tokens-mode/);
      assert.match(result.stdout ?? "", /token-saving mode/);
      assert.match(result.stdout ?? "", /--working-directory-for-harness/);
      assert.match(result.stdout ?? "", /--worktree-origin-repository/);
      assert.match(result.stdout ?? "", /--worktree-origin-ref/);
      assert.match(result.stdout ?? "", /Add dark mode toggle/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow pause --help documents --drain flag", () => {
    const result = cli(["workflow", "pause", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Pause a running workflow/);
      assert.match(result.stdout ?? "", /--drain/);
      assert.match(result.stdout ?? "", /in-flight agent sessions/);
      assert.match(result.stdout ?? "", /dashboard daemon/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow uninstall --help documents --all and --force flags", () => {
    const result = cli(["workflow", "uninstall", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Uninstall one or all workflows/);
      assert.match(result.stdout ?? "", /--all.*Uninstall every installed/);
      assert.match(result.stdout ?? "", /--force.*Skip the active-runs/);
      assert.match(result.stdout ?? "", /active runs.*running or paused/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow resume --help explains paused vs failed resume behavior", () => {
    const result = cli(["workflow", "resume", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Resume a paused or failed workflow/);
      assert.match(result.stdout ?? "", /paused.*Connects to the dashboard daemon/);
      assert.match(result.stdout ?? "", /failed.*Restarts the run/);
      assert.match(result.stdout ?? "", /completed.*cannot be resumed/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow list --help shows list help", () => {
    const result = cli(["workflow", "list", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /List available bundled workflows with descriptions/);
      assert.match(result.stdout ?? "", /workflows\/ directory/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow list prints descriptions for each workflow", () => {
    const result = cli(["workflow", "list"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Available workflows:/);
      // Each line should have format "  <id> - <description>"
      assert.match(result.stdout ?? "", /^  \S+ - \S/m);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow runs --help shows runs help", () => {
    const result = cli(["workflow", "runs", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /List all workflow runs/);
      assert.match(result.stdout ?? "", /Status.*Run status/);
      assert.match(result.stdout ?? "", /Tokens.*Total tokens spent/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow install --help shows install help", () => {
    const result = cli(["workflow", "install", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Install a specific workflow by name/);
      assert.match(result.stdout ?? "", /YAML spec/);
      assert.match(result.stdout ?? "", /agent workspaces/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow status --help shows status help with step listing", () => {
    const result = cli(["workflow", "status", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Show detailed run status/);
      assert.match(result.stdout ?? "", /done.*Step completed/);
      assert.match(result.stdout ?? "", /running.*Step currently being executed/);
      assert.match(result.stdout ?? "", /failed.*Step failed/);
      assert.match(result.stdout ?? "", /pending.*Step waiting/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow stop --help shows stop help", () => {
    const result = cli(["workflow", "stop", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Cancel a running workflow/);
      assert.match(result.stdout ?? "", /prefix matching/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow pause-all --help shows pause-all help with --drain", () => {
    const result = cli(["workflow", "pause-all", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Pause all running workflows/);
      assert.match(result.stdout ?? "", /--drain/);
      assert.match(result.stdout ?? "", /in-flight agent sessions/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  // US-009: global usage includes --help hint
  it("tamandua --help includes note about command-level --help", () => {
    const result = cli(["--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Run tamandua <command> --help for detailed command help/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow resume-all --help shows resume-all help", () => {
    const result = cli(["workflow", "resume-all", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Resume all paused workflows/);
      assert.match(result.stdout ?? "", /Only paused runs are resumed/);
      assert.match(result.stdout ?? "", /failed runs are not resumed/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  // US-001: get-ready replaces install
  it("tamandua install as top-level command is no longer accepted", () => {
    const result = cli(["install"]);
    try {
      assert.notEqual(result.status, 0);
      // Should not perform old workflow installation behavior
      assert.doesNotMatch(result.stdout ?? "", /Installing.*workflow/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });
});

describe("status command", () => {
  it("tamandua status --help shows help about status display", () => {
    const result = cli(["status", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Show detailed Tamandua system status/);
      assert.match(result.stdout ?? "", /Services.*Dashboard, MCP, and control-plane/);
      assert.match(result.stdout ?? "", /Tamandua Info.*Source path, skill path, version/);
      assert.match(result.stdout ?? "", /Workflow Runs.*Summary of all runs/);
      assert.match(result.stdout ?? "", /Running Processes.*Active pi\/hermes/);
      assert.match(result.stdout ?? "", /tamandua status/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua status produces comprehensive output with all sections and dividers", () => {
    const result = cli(["status"]);
    try {
      assert.equal(result.status, 0);
      const out = result.stdout ?? "";

      // Overall header
      assert.match(out, /Tamandua Status/);

      // All four sections present
      assert.match(out, /Services/);
      assert.match(out, /Tamandua Info/);
      assert.match(out, /Workflow Runs/);
      assert.match(out, /Running Processes/);

      // Section dividers between sections (3 dividers: after Services, after Info, after Runs)
      const dividerCount = (out.match(/^---$/gm) || []).length;
      assert.equal(dividerCount, 3, `expected 3 section dividers, got ${dividerCount}`);

      // Services section details
      assert.match(out, /Dashboard: +DOWN/);
      assert.match(out, /MCP: +DOWN/);
      assert.match(out, /Control-plane: +DOWN/);

      // Tamandua Info section details
      assert.match(out, /Source-path:/);
      assert.match(out, /Skill-path:/);
      assert.match(out, /Version:/);
      assert.match(out, /Source tree:/);

      // Workflow Runs section (should gracefully show "No workflow runs")
      assert.match(out, /No workflow runs/);

      // Running Processes section (should show daemon down message)
      assert.match(out, /Daemon not running/);

      // Should NOT show placeholder text
      assert.doesNotMatch(out, /Full status output coming in future stories/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua --help lists status command", () => {
    const result = cli(["--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /tamandua status/);
      assert.match(result.stdout ?? "", /Show detailed system status/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });
});

// Direct unit tests for formatServiceStatus() — uses dependency injection
// to mock daemonctl responses without needing running processes.
describe("formatServiceStatus", () => {
  it("shows all services UP when everything is running", async () => {
    const { formatServiceStatus } = await import("../../dist/cli/status-format.js");

    const result = formatServiceStatus({
      getDaemonStatus: () => ({ running: true, pid: 12345, port: 3334 }),
      getMcpStatus: () => ({
        running: true,
        pid: 12346,
        port: 3338,
        endpoint: "/mcp",
      }),
      getControlPlaneStatus: () => ({
        running: true,
        pid: 12347,
        port: 3339,
        endpoint: "/control/health",
      }),
    });

    assert.match(result, /Services/);
    assert.match(result, /Dashboard: +UP +\(pid 12345, port 3334, http:\/\/localhost:3334\)/);
    assert.match(result, /MCP: +UP +\(pid 12346, port 3338, http:\/\/localhost:3338\/mcp\)/);
    assert.match(result, /Control-plane: +UP +\(pid 12347, port 3339, http:\/\/localhost:3339\/control\/health\)/);
  });

  it("shows all services DOWN when nothing is running", async () => {
    const { formatServiceStatus } = await import("../../dist/cli/status-format.js");

    const result = formatServiceStatus({
      getDaemonStatus: () => ({ running: false, pid: null, port: 3334 }),
      getMcpStatus: () => ({
        running: false,
        pid: null,
        port: 3338,
        endpoint: "/mcp",
      }),
      getControlPlaneStatus: () => ({
        running: false,
        pid: null,
        port: 3339,
        endpoint: "/control/health",
      }),
    });

    assert.match(result, /Services/);
    assert.match(result, /Dashboard: +DOWN \(port 3334\)/);
    assert.match(result, /MCP: +DOWN \(port 3338, endpoint \/mcp\)/);
    assert.match(result, /Control-plane: +DOWN \(port 3339, endpoint \/control\/health\)/);
  });

  it("shows mixed state: dashboard up, MCP and control-plane down", async () => {
    const { formatServiceStatus } = await import("../../dist/cli/status-format.js");

    const result = formatServiceStatus({
      getDaemonStatus: () => ({ running: true, pid: 42, port: 3334 }),
      getMcpStatus: () => ({
        running: false,
        pid: null,
        port: 3338,
        endpoint: "/mcp",
      }),
      getControlPlaneStatus: () => ({
        running: false,
        pid: null,
        port: 3339,
        endpoint: "/control/health",
      }),
    });

    assert.match(result, /Services/);
    assert.match(result, /Dashboard: +UP +\(pid 42, port 3334, http:\/\/localhost:3334\)/);
    assert.match(result, /MCP: +DOWN/);
    assert.match(result, /Control-plane: +DOWN/);
  });

  it("shows MCP endpoint even when not running", async () => {
    const { formatServiceStatus } = await import("../../dist/cli/status-format.js");

    const result = formatServiceStatus({
      getDaemonStatus: () => ({ running: false, pid: null, port: 3334 }),
      getMcpStatus: () => ({
        running: false,
        pid: null,
        port: 3338,
        endpoint: "/mcp",
      }),
      getControlPlaneStatus: () => ({
        running: false,
        pid: null,
        port: 3339,
        endpoint: "/control/health",
      }),
    });

    // MCP should show its endpoint even when down
    assert.match(result, /MCP: +DOWN \(port 3338, endpoint \/mcp\)/);
  });

  it("defaults to real daemonctl when no overrides provided (accepts any output)", async () => {
    const { formatServiceStatus } = await import("../../dist/cli/status-format.js");

    // Without overrides, uses real daemonctl — should not throw
    const result = formatServiceStatus();
    assert.match(result, /Services/);
    assert.match(result, /Dashboard:/);
    assert.match(result, /MCP:/);
    assert.match(result, /Control-plane:/);
  });
});

// Direct unit tests for formatTamanduaInfo() — uses dependency injection
// to mock paths, version, git, and version status without needing filesystem or git.
describe("formatTamanduaInfo", () => {
  it("shows source-path, skill-path, version, and tree SHA", async () => {
    const { formatTamanduaInfo } = await import("../../dist/cli/status-format.js");

    const result = formatTamanduaInfo({
      getVersion: () => "1.2.3",
      resolveSourcePath: () => "/opt/tamandua",
      resolveSkillPath: () => "/opt/tamandua/skills/tamandua-agents/SKILL.md",
      getReadVersionStatus: () => ({
        updateAvailable: false,
        currentHead: "",
        remoteHead: "",
        checkedAt: "",
      }),
      execSync: () => "a1b2c3d4e5f6789012345678abcdef1234567890",
    });

    assert.match(result, /Tamandua Info/);
    assert.match(result, /Source-path: +\/opt\/tamandua/);
    assert.match(result, /Skill-path: +\/opt\/tamandua\/skills\/tamandua-agents\/SKILL.md/);
    assert.match(result, /Version: +1\.2\.3/);
    assert.match(result, /Source tree: +a1b2c3d4e5f6789012345678abcdef1234567890/);
    // No update available — update line should NOT appear
    assert.doesNotMatch(result, /Update:/);
  });

  it("shows 'unavailable' when git fails", async () => {
    const { formatTamanduaInfo } = await import("../../dist/cli/status-format.js");

    const result = formatTamanduaInfo({
      getVersion: () => "1.0.0",
      resolveSourcePath: () => "/some/path",
      resolveSkillPath: () => "/some/path/skills.md",
      getReadVersionStatus: () => ({
        updateAvailable: false,
        currentHead: "",
        remoteHead: "",
        checkedAt: "",
      }),
      execSync: () => { throw new Error("git not found"); },
    });

    assert.match(result, /Tamandua Info/);
    assert.match(result, /Source tree: +unavailable/);
  });

  it("shows 'unavailable' when git output is not a valid sha", async () => {
    const { formatTamanduaInfo } = await import("../../dist/cli/status-format.js");

    const result = formatTamanduaInfo({
      getVersion: () => "1.0.0",
      resolveSourcePath: () => "/some/path",
      resolveSkillPath: () => "/some/path/skills.md",
      getReadVersionStatus: () => ({
        updateAvailable: false,
        currentHead: "",
        remoteHead: "",
        checkedAt: "",
      }),
      execSync: () => "not-a-valid-sha",
    });

    assert.match(result, /Source tree: +unavailable/);
  });

  it("shows update available when version status has updateAvailable=true", async () => {
    const { formatTamanduaInfo } = await import("../../dist/cli/status-format.js");

    const result = formatTamanduaInfo({
      getVersion: () => "1.0.0",
      resolveSourcePath: () => "/some/path",
      resolveSkillPath: () => "/some/path/skills.md",
      getReadVersionStatus: () => ({
        updateAvailable: true,
        currentHead: "abc123",
        remoteHead: "def456",
        checkedAt: "2026-05-18T00:00:00Z",
      }),
      execSync: () => "a1b2c3d4e5f6789012345678abcdef1234567890",
    });

    assert.match(result, /Update: +available \(run 'tamandua update'\)/);
  });

  it("defaults to real paths and git when no overrides provided (accepts any output)", async () => {
    const { formatTamanduaInfo } = await import("../../dist/cli/status-format.js");

    // Without overrides, uses real resolveSourcePath, resolveSkillPath, etc. — should not throw
    const result = formatTamanduaInfo({ getVersion: () => "1.0.0" });
    assert.match(result, /Tamandua Info/);
    assert.match(result, /Source-path:/);
    assert.match(result, /Skill-path:/);
    assert.match(result, /Version: +1\.0\.0/);
    assert.match(result, /Source tree:/);
  });
});

// Direct unit tests for formatRunsSummary() — uses dependency injection
// to mock listRuns without needing a real database.
describe("formatRunsSummary", () => {
  it("shows 'No workflow runs' when list is empty", async () => {
    const { formatRunsSummary } = await import("../../dist/cli/status-format.js");
    const result = formatRunsSummary({
      listRuns: () => [],
    });
    assert.match(result, /Workflow Runs/);
    assert.match(result, /No workflow runs/);
  });

  it("shows total count and status breakdown with mixed statuses", async () => {
    const { formatRunsSummary } = await import("../../dist/cli/status-format.js");
    const result = formatRunsSummary({
      listRuns: () => [
        { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", workflowId: "wf1", task: "Fix login bug", status: "running", createdAt: "", updatedAt: "", tokensSpent: 1500 },
        { id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", workflowId: "wf1", task: "Add dashboard", status: "done", createdAt: "", updatedAt: "", tokensSpent: 3000 },
        { id: "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee", workflowId: "wf2", task: "Refactor auth", status: "failed", createdAt: "", updatedAt: "", tokensSpent: 500 },
        { id: "dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee", workflowId: "wf3", task: "Update deps", status: "paused", createdAt: "", updatedAt: "", tokensSpent: 200 },
      ],
    });
    assert.match(result, /Workflow Runs/);
    assert.match(result, /4 total/);
    assert.match(result, /1 done/);
    assert.match(result, /1 failed/);
    assert.match(result, /1 paused/);
    assert.match(result, /1 running/);
  });

  it("lists running and paused runs with ID, workflow, tokens, and task preview", async () => {
    const { formatRunsSummary } = await import("../../dist/cli/status-format.js");
    const result = formatRunsSummary({
      listRuns: () => [
        { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", workflowId: "feature-dev", task: "Implement login page with validation and error handling", status: "running", createdAt: "", updatedAt: "", tokensSpent: 4200 },
        { id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", workflowId: "bug-fix", task: "Fix navbar", status: "paused", createdAt: "", updatedAt: "", tokensSpent: 800 },
      ],
    });
    // Running run
    assert.match(result, /\[running\] aaaaaaaa/);
    assert.match(result, /feature-dev/);
    assert.match(result, /4,200 tokens/);
    assert.match(result, /Implement login page/);
    // Paused run
    assert.match(result, /\[paused \] bbbbbbbb/);
    assert.match(result, /bug-fix/);
    assert.match(result, /800 tokens/);
    assert.match(result, /Fix navbar/);
    // Should NOT show done/failed not-shown line when there are none
    assert.doesNotMatch(result, /runs not shown/);
  });

  it("shows '(N done, M failed runs not shown)' when terminal runs exist", async () => {
    const { formatRunsSummary } = await import("../../dist/cli/status-format.js");
    const result = formatRunsSummary({
      listRuns: () => [
        { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", workflowId: "wf1", task: "Current task", status: "running", createdAt: "", updatedAt: "", tokensSpent: 100 },
        { id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", workflowId: "wf1", task: "Old task", status: "done", createdAt: "", updatedAt: "", tokensSpent: 2000 },
        { id: "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee", workflowId: "wf2", task: "Broken task", status: "failed", createdAt: "", updatedAt: "", tokensSpent: 0 },
      ],
    });
    assert.match(result, /3 total/);
    assert.match(result, /\(1 done, 1 failed runs not shown\)/);
    // Running run still listed
    assert.match(result, /\[running\] aaaaaaaa/);
  });

  it("handles long task descriptions with truncation", async () => {
    const { formatRunsSummary } = await import("../../dist/cli/status-format.js");
    const longTask = "A".repeat(80);
    const result = formatRunsSummary({
      listRuns: () => [
        { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", workflowId: "wf1", task: longTask, status: "running", createdAt: "", updatedAt: "", tokensSpent: 0 },
      ],
    });
    // Should be truncated to 60 chars with "..."
    const expectedPreview = "A".repeat(57) + "...";
    assert.match(result, new RegExp(expectedPreview.replace(/\./g, "\\.")));
    // Should NOT contain the full 80-char string
    assert.doesNotMatch(result, /A{80}/);
  });

  it("catches errors from listRuns gracefully", async () => {
    const { formatRunsSummary } = await import("../../dist/cli/status-format.js");
    const result = formatRunsSummary({
      listRuns: () => { throw new Error("DB error"); },
    });
    assert.match(result, /Workflow Runs/);
    assert.match(result, /No workflow runs/);
  });

  it("defaults to real listRuns when no override provided (accepts any output)", async () => {
    const { formatRunsSummary } = await import("../../dist/cli/status-format.js");
    // Without overrides, uses the real listRuns from the DB — should not throw
    const result = formatRunsSummary();
    assert.match(result, /Workflow Runs/);
    // Should either show "No workflow runs" or a counts line
    assert.ok(
      result.includes("No workflow runs") || result.includes("total"),
      "should produce valid output",
    );
  });
});

// Direct unit tests for formatProcessList() — uses dependency injection
// to mock ps output without needing real processes.
describe("formatProcessList", () => {
  it("shows daemon down message when daemon not running", async () => {
    const { formatProcessList } = await import("../../dist/cli/status-format.js");
    const result = formatProcessList({
      isDaemonRunning: () => false,
    });
    assert.match(result, /Running Processes/);
    assert.match(result, /Daemon not running/);
  });

  it("shows no processes when daemon is running but ps returns no matches", async () => {
    const { formatProcessList } = await import("../../dist/cli/status-format.js");
    const result = formatProcessList({
      isDaemonRunning: () => true,
      execSync: () =>
        "  123  01:23:45  /usr/bin/node some-other-thing\n  456  00:05:00  bash\n",
    });
    assert.match(result, /Running Processes/);
    assert.match(result, /No active agent processes/);
  });

  it("detects pi processes and shows PID and runtime", async () => {
    const { formatProcessList } = await import("../../dist/cli/status-format.js");
    const result = formatProcessList({
      isDaemonRunning: () => true,
      execSync: () =>
        "  1001  02:30:00  /usr/bin/pi --print --session abc123 --model gpt-4\n" +
        "  1002  01:15:00  node /usr/local/bin/pi --print --mode json\n",
    });
    assert.match(result, /Running Processes/);
    assert.match(result, /\[pi\s*\] PID 1001/);
    assert.match(result, /up 02:30:00/);
    assert.match(result, /\[pi\s*\] PID 1002/);
    assert.match(result, /up 01:15:00/);
  });

  it("detects hermes processes", async () => {
    const { formatProcessList } = await import("../../dist/cli/status-format.js");
    const result = formatProcessList({
      isDaemonRunning: () => true,
      execSync: () =>
        "  2001  00:45:00  /usr/bin/hermes agent --provider openrouter\n",
    });
    assert.match(result, /Running Processes/);
    assert.match(result, /\[hermes\s*\] PID 2001/);
    assert.match(result, /up 00:45:00/);
  });

  it("distinguishes pi and hermes processes in mixed output", async () => {
    const { formatProcessList } = await import("../../dist/cli/status-format.js");
    const result = formatProcessList({
      isDaemonRunning: () => true,
      execSync: () =>
        "  1001  02:30:00  /usr/bin/pi --print --session abc\n" +
        "  2001  00:45:00  /usr/bin/hermes agent --provider openrouter\n" +
        "  3001  01:00:00  node /path/to/tamandua/dist/cli/cli.js step claim some-agent\n",
    });
    assert.match(result, /\[pi\s*\] PID 1001/);
    assert.match(result, /\[hermes\s*\] PID 2001/);
    assert.match(result, /\[tamandua\s*\] PID 3001/); // tamandua step claim classified as tamandua
    // Should have 3 process lines
    const lines = result.split("\n");
    const processLines = lines.filter((l) => /\[.*\] PID/.test(l));
    assert.strictEqual(processLines.length, 3);
  });

  it("handles empty ps output gracefully", async () => {
    const { formatProcessList } = await import("../../dist/cli/status-format.js");
    const result = formatProcessList({
      isDaemonRunning: () => true,
      execSync: () => "",
    });
    assert.match(result, /Running Processes/);
    assert.match(result, /No active agent processes/);
  });

  it("handles execSync error gracefully", async () => {
    const { formatProcessList } = await import("../../dist/cli/status-format.js");
    const result = formatProcessList({
      isDaemonRunning: () => true,
      execSync: () => {
        throw new Error("ps not found");
      },
    });
    assert.match(result, /Running Processes/);
    assert.match(result, /Unable to scan for agent processes/);
  });

  it("defaults to real isRunning when no overrides provided (accepts any output)", async () => {
    const { formatProcessList } = await import("../../dist/cli/status-format.js");
    // Without overrides, uses real daemonctl isRunning + ps — should not throw
    const result = formatProcessList();
    assert.match(result, /Running Processes/);
    // Should show something (either daemon down message or process list)
    assert.ok(
      result.includes("Daemon not running") ||
        result.includes("No active agent processes") ||
        result.includes("PID ") ||
        result.includes("Unable to scan"),
      "should produce valid output",
    );
  });

  // Regression: BSD ps on macOS outputs a column header that must be stripped.
  it("strips BSD ps header on darwin and parses processes correctly", async () => {
    const { formatProcessList } = await import("../../dist/cli/status-format.js");
    const result = formatProcessList({
      isDaemonRunning: () => true,
      execSync: () =>
        "  PID ELAPSED COMMAND\n" +
        " 1001  02:30:00  /usr/bin/pi --print --session abc123\n" +
        " 2001  00:45:00  /usr/bin/hermes agent --provider openrouter\n",
    });
    assert.match(result, /Running Processes/);
    // Header line must NOT appear in the output.
    assert.doesNotMatch(result, /^\s*PID\s+ELAPSED/m);
    // Process data must still be parsed correctly.
    assert.match(result, /\[pi\s*\] PID 1001/);
    assert.match(result, /up 02:30:00/);
    assert.match(result, /\[hermes\s*\] PID 2001/);
  });

  // Regression: darwin path must not strip data rows when there is no header.
  it("does not strip data rows on darwin when BSD header is absent", async () => {
    const { formatProcessList } = await import("../../dist/cli/status-format.js");
    const result = formatProcessList({
      isDaemonRunning: () => true,
      execSync: () =>
        "  1001  02:30:00  /usr/bin/pi --print --session abc\n" +
        "  2001  00:45:00  /usr/bin/hermes agent --provider openrouter\n",
    });
    assert.match(result, /Running Processes/);
    // Both processes should appear (no data rows stripped).
    assert.match(result, /\[pi\s*\] PID 1001/);
    assert.match(result, /\[hermes\s*\] PID 2001/);
  });

  // Regression: linux path preserves existing GNU ps behavior.
  it("preserves GNU ps behavior on linux platform", async () => {
    const { listProcessesForStatus } = await import("../../dist/cli/status-format.js");
    let receivedCmd = "";
    const mockExSync = (cmd: string): string => {
      receivedCmd = cmd;
      return "  1001  02:30:00  /usr/bin/pi --print\n";
    };
    const output = listProcessesForStatus(mockExSync, "linux");
    // Must use GNU-style --no-headers flag.
    assert.match(receivedCmd, /ps -eo pid,etime,args --no-headers/);
    assert.doesNotMatch(receivedCmd, /-ax/);
    // Output is passed through unchanged.
    assert.match(output, /1001/);
  });

  // Regression: BSD ps args on darwin.
  it("uses BSD-compatible ps args on darwin platform", async () => {
    const { listProcessesForStatus } = await import("../../dist/cli/status-format.js");
    let receivedCmd = "";
    const mockExSync = (cmd: string): string => {
      receivedCmd = cmd;
      return "  PID ELAPSED COMMAND\n  1001  02:30:00  /usr/bin/pi\n";
    };
    const output = listProcessesForStatus(mockExSync, "darwin");
    // Must use BSD-compatible flags (no --no-headers).
    assert.match(receivedCmd, /ps -ax -o pid,etime,command/);
    assert.doesNotMatch(receivedCmd, /--no-headers/);
    // Header is stripped.
    assert.doesNotMatch(output, /^\s*PID\s/m);
    assert.match(output, /1001/);
  });

  // Regression: ps failure degrades gracefully without leaking raw usage text.
  it("degrades gracefully on ps failure without raw usage text", async () => {
    const { formatProcessList } = await import("../../dist/cli/status-format.js");
    const result = formatProcessList({
      isDaemonRunning: () => true,
      execSync: () => {
        throw new Error("ps: illegal option -- -\nusage: ps ...");
      },
    });
    assert.match(result, /Running Processes/);
    assert.match(result, /Unable to scan for agent processes/);
    // Raw ps usage text must NOT appear in output.
    assert.doesNotMatch(result, /illegal option/);
    assert.doesNotMatch(result, /usage:/);
  });
});

describe("nudge command", { concurrency: 1 }, () => {
  it("tamandua --help includes tamandua nudge in command listing", () => {
    const result = cli(["--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /tamandua nudge.*Wake all scheduled agents for all running runs/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua nudge --help shows usage with no args/no options", () => {
    const result = cli(["nudge", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /tamandua nudge — Wake all scheduled agents for running runs/);
      assert.match(result.stdout ?? "", /Usage: tamandua nudge/);
      assert.match(result.stdout ?? "", /Wakes all scheduled agents for all currently running runs/);
      assert.match(result.stdout ?? "", /Does not\nresume paused runs or interrupt in-flight agents/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua nudge extra-arg fails with usage message", () => {
    const result = cli(["nudge", "extra-arg"]);
    try {
      assert.equal(result.status, 1);
      const stderr = result.stderr ?? "";
      assert.match(stderr, /Unknown nudge option: extra-arg/);
      assert.match(stderr, /Usage: tamandua nudge/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua nudge with daemon unreachable prints clear error message", () => {
    // Use a temp HOME with no daemon and a port that won't have a control plane.
    const result = cli(["nudge"], { TAMANDUA_CONTROL_PORT: "65531" });
    try {
      assert.equal(result.status, 1);
      const stderr = result.stderr ?? "";
      assert.match(stderr, /Failed to nudge: control plane is not reachable/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua nudge with daemon running and no runs prints zero-runs message", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-nudge-test-"));
    const { reserveDistinctRandomPorts, cleanChildEnv: testCleanChildEnv } = await import("../../tests/helpers/test-env.ts");
    const [dp, cp] = await reserveDistinctRandomPorts(2);
    const daemonScript = path.resolve(__dirname, "..", "..", "dist", "server", "daemon.js");

    let daemon: ChildProcess | undefined;
    try {
      daemon = spawn("node", [daemonScript, String(dp)], {
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_CONTROL_PORT: String(cp) }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      daemon.stdout?.resume();
      daemon.stderr?.resume();

      // Wait for daemon to be up
      const { setTimeout: sleep } = await import("node:timers/promises");
      const startedAt = Date.now();
      let up = false;
      while (Date.now() - startedAt < 7000) {
        try {
          await new Promise<void>((resolve, reject) => {
            const req = http.request({ method: "GET", hostname: "127.0.0.1", port: cp, path: "/control/health" }, (res) => {
              res.resume();
              res.on("end", () => {
                if (res.statusCode === 200) resolve();
                else reject(new Error(`status ${res.statusCode}`));
              });
            });
            req.on("error", reject);
            req.setTimeout(500);
            req.end();
          });
          up = true;
          break;
        } catch {
          await sleep(100);
        }
      }
      if (!up) {
        t.skip("daemon did not come up");
        return;
      }

      // Run nudge with the daemon's HOME and control port
      const result = cli(["nudge"], { HOME: tmpDir, TAMANDUA_CONTROL_PORT: String(cp) });
      try {
        assert.equal(result.status, 0);
        assert.match(result.stdout ?? "", /No running Tamandua runs to nudge/);
      } finally {
        fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
      }
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* gone */ }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua nudge with daemon running and active runs prints summary", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-nudge-test-"));
    const { reserveDistinctRandomPorts, cleanChildEnv: testCleanChildEnv2 } = await import("../../tests/helpers/test-env.ts");
    const [dp, cp] = await reserveDistinctRandomPorts(2);
    const daemonScript = path.resolve(__dirname, "..", "..", "dist", "server", "daemon.js");

    let daemon: ChildProcess | undefined;
    try {
      daemon = spawn("node", [daemonScript, String(dp)], {
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_CONTROL_PORT: String(cp) }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      daemon.stdout?.resume();
      daemon.stderr?.resume();

      // Wait for daemon to be up
      const { setTimeout: sleep } = await import("node:timers/promises");
      const startedAt = Date.now();
      let up = false;
      while (Date.now() - startedAt < 7000) {
        try {
          await new Promise<void>((resolve, reject) => {
            const req = http.request({ method: "GET", hostname: "127.0.0.1", port: cp, path: "/control/health" }, (res) => {
              res.resume();
              res.on("end", () => {
                if (res.statusCode === 200) resolve();
                else reject(new Error(`status ${res.statusCode}`));
              });
            });
            req.on("error", reject);
            req.setTimeout(500);
            req.end();
          });
          up = true;
          break;
        } catch {
          await sleep(100);
        }
      }
      if (!up) {
        t.skip("daemon did not come up");
        return;
      }

      // Wait for the daemon's reconciler to create the DB schema (~1s first tick).
      await sleep(2000);

      // Insert a running run into the daemon's DB
      const { DatabaseSync } = await import("node:sqlite");
      const crypto = await import("node:crypto");
      const dbPath = path.join(tmpDir, ".tamandua", "tamandua.db");
      const runId = crypto.randomUUID();
      const now = new Date().toISOString();
      const db = new DatabaseSync(dbPath);
      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, scheduling_requested_at, created_at, updated_at) VALUES (?, 'wf-nudge-cli', 'nudge-cli-test', 'running', '{}', 0, 'pending_register', ?, ?, ?)",
      ).run(runId, now, now, now);
      db.close();

      // Run nudge with the daemon's HOME and control port
      const result = cli(["nudge"], { HOME: tmpDir, TAMANDUA_CONTROL_PORT: String(cp) });
      try {
        assert.equal(result.status, 0);
        // Should print a summary; there is 1 running run but no agents scheduled,
        // so launched should be 0.
        assert.match(result.stdout ?? "", /Nudged \d+ running run\(s\): launched \d+ agent\(s\), skipped \d+ in-flight\./);
      } finally {
        fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
      }

      // Cleanup DB
      const db2 = new DatabaseSync(dbPath);
      db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
      db2.close();
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* gone */ }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
