/**
 * Tests for non-zero exit when get-ready or workflow install --all partially fails.
 *
 * Validates:
 * 1. workflow install --all exits non-zero on partial failure, prints summary
 *    line, and shows checkmarks for valid workflows (US-003 AC 1)
 * 2. get-ready exits non-zero on partial failure, prints summary line, and
 *    shows checkmarks for valid workflows (US-003 AC 2)
 * 3. Broken test directory is cleaned up even when the test fails via
 *    try/finally (US-003 AC 3)
 *
 * All tests use isolated temp HOME directories. The broken workflow directory
 * is a deliberately invalid dir (no workflow.yml) created under the source
 * checkout's workflows/ dir and removed in a finally block.
 */

import { describe, it, before } from "node:test";
import { cleanChildEnv, createTempHome } from "../helpers/test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "cli", "cli.js");
const WORKFLOWS_SRC = path.resolve(__dirname, "..", "..", "workflows");

const BROKEN_WORKFLOW_DIRNAME = "_test-partial-failure-broken";

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("node", ["--no-warnings", CLI_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanChildEnv({ HOME: homeDir }),
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.once("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function cleanStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => {
      if (line.includes("ExperimentalWarning") && line.includes("SQLite")) return false;
      if (line.includes("node --trace-warnings")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

const TMP_PREFIX = "tamandua-install-pf-";

function setupTempHome(): string {
  const th = createTempHome(TMP_PREFIX);
  const homeDir = th.homeDir;
  // Seed a minimal pi settings.json so installWorkflow's readPiConfig() succeeds
  const piAgentDir = path.join(homeDir, ".pi", "agent");
  fs.mkdirSync(piAgentDir, { recursive: true });
  fs.writeFileSync(
    path.join(piAgentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o" }),
    "utf-8",
  );
  return homeDir;
}

/**
 * Create a deliberately broken workflow directory (no workflow.yml) under
 * the source checkout's workflows/ dir. The caller MUST remove it in a
 * finally block.
 */
function createBrokenWorkflowDir(): string {
  const brokenDir = path.join(WORKFLOWS_SRC, BROKEN_WORKFLOW_DIRNAME);
  fs.mkdirSync(brokenDir, { recursive: true });
  return brokenDir;
}

function removeBrokenWorkflowDir(): void {
  const brokenDir = path.join(WORKFLOWS_SRC, BROKEN_WORKFLOW_DIRNAME);
  try {
    fs.rmSync(brokenDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe("tamandua install partial failure", () => {
  // Clean up any lingering broken dir from a previous aborted run.
  before(() => {
    removeBrokenWorkflowDir();
  });

  // AC 1: workflow install --all exits non-zero on partial failure,
  // prints summary line, and shows checkmarks for valid workflows.
  it("workflow install --all exits 1 with summary line on partial failure (try/finally)", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    // Use try/finally for broken directory cleanup as required by AC 3.
    createBrokenWorkflowDir();
    try {
      const tempHome = setupTempHome();

      const { stdout, stderr, exitCode } = await runCli(
        ["workflow", "install", "--all"],
        tempHome,
      );

      const cleanErr = cleanStderr(stderr);
      assert.equal(cleanErr, "", `stderr should be clean, got: ${cleanErr}`);

      // Should exit non-zero
      assert.equal(exitCode, 1, `Expected exit 1, got ${exitCode}. stdout: ${stdout}`);

      // Should show a failure mark for the broken workflow
      assert.ok(
        stdout.includes(`✗ ${BROKEN_WORKFLOW_DIRNAME}`),
        `Expected failure mark for ${BROKEN_WORKFLOW_DIRNAME}, got: ${stdout}`,
      );

      // Should print summary line: "N of M workflows failed to install"
      assert.ok(
        /1 of \d+ workflows failed to install/.test(stdout),
        `Expected "1 of N workflows failed to install", got: ${stdout}`,
      );

      // Should have checkmarks for valid workflows
      const checkMarks = (stdout.match(/✓/g) || []).length;
      assert.ok(
        checkMarks > 0,
        `Expected checkmarks for valid workflows, got ${checkMarks}`,
      );

      // "Done. Start with:" line should appear after the summary
      const failureSummaryIdx = stdout.search(/\d+ of \d+ workflows failed to install/);
      const doneIdx = stdout.indexOf("Done. Start with:");
      assert.ok(doneIdx !== -1, `Expected "Done. Start with:" in output`);
      assert.ok(
        doneIdx > failureSummaryIdx,
        `Expected "Done. Start with:" after failure summary`,
      );
    } finally {
      removeBrokenWorkflowDir();
    }
  });

  // AC 1 (continued): valid workflows still install on partial failure
  it("workflow install --all still installs valid workflows on partial failure", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    createBrokenWorkflowDir();
    try {
      const tempHome = setupTempHome();
      await runCli(["workflow", "install", "--all"], tempHome);

      // agents.json should have entries from valid workflows
      const agentsPath = path.join(tempHome, ".tamandua", "agents.json");
      assert.ok(fs.existsSync(agentsPath), "agents.json should exist even on partial failure");

      const agents = JSON.parse(fs.readFileSync(agentsPath, "utf-8")) as Array<Record<string, unknown>>;

      // Main agent should be present
      const mainAgent = agents.find((a) => a.id === "main");
      assert.ok(mainAgent, "agents.json should have main agent even on partial failure");

      // Should have workflow-prefixed agents from valid workflows
      const workflowAgents = agents.filter(
        (a) => typeof a.id === "string" && a.id.includes("_"),
      );
      assert.ok(workflowAgents.length > 0, "agents.json should have valid workflow agents on partial failure");

      // The broken workflow should NOT have agents
      const brokenAgents = agents.filter(
        (a) => typeof a.id === "string" && a.id.startsWith(BROKEN_WORKFLOW_DIRNAME),
      );
      assert.equal(
        brokenAgents.length,
        0,
        `broken workflow should have no agents, got: ${brokenAgents.map((a) => a.id).join(", ")}`,
      );
    } finally {
      removeBrokenWorkflowDir();
    }
  });

  // AC 2: get-ready exits non-zero on partial failure,
  // prints summary line, and shows checkmarks for valid workflows.
  it("get-ready exits 1 with summary line on partial failure (try/finally)", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    createBrokenWorkflowDir();
    try {
      const tempHome = setupTempHome();

      const { stdout, stderr, exitCode } = await runCli(
        ["get-ready"],
        tempHome,
      );

      const cleanErr = cleanStderr(stderr);
      assert.equal(cleanErr, "", `stderr should be clean, got: ${cleanErr}`);

      // Should exit non-zero
      assert.equal(exitCode, 1, `Expected exit 1, got ${exitCode}. stdout: ${stdout}`);

      // Should show a failure mark for the broken workflow
      assert.ok(
        stdout.includes(`✗ ${BROKEN_WORKFLOW_DIRNAME}`),
        `Expected failure mark for ${BROKEN_WORKFLOW_DIRNAME}, got: ${stdout}`,
      );

      // Should print summary line: "N of M workflows failed to install"
      assert.ok(
        /1 of \d+ workflows failed to install/.test(stdout),
        `Expected "1 of N workflows failed to install", got: ${stdout}`,
      );

      // Should have checkmarks for valid workflows
      const checkMarks = (stdout.match(/✓/g) || []).length;
      assert.ok(
        checkMarks > 0,
        `Expected checkmarks for valid workflows, got ${checkMarks}`,
      );
    } finally {
      removeBrokenWorkflowDir();
    }
  });

  // AC 2 (continued): get-ready "Done. Start with:" after summary
  it('get-ready prints "Done. Start with:" after failure summary', async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    createBrokenWorkflowDir();
    try {
      const tempHome = setupTempHome();

      const { stdout } = await runCli(["get-ready"], tempHome);

      // "Done. Start with:" should appear after the summary line
      const failureSummaryIdx = stdout.search(/\d+ of \d+ workflows failed to install/);
      const doneIdx = stdout.indexOf("Done. Start with:");

      assert.ok(doneIdx !== -1, `Expected "Done. Start with:" in output, got: ${stdout}`);
      assert.ok(
        doneIdx > failureSummaryIdx,
        `Expected "Done. Start with:" after failure summary, got: ${stdout}`,
      );
    } finally {
      removeBrokenWorkflowDir();
    }
  });

  // AC 2 (continued): get-ready valid workflows still produce agents
  it("get-ready still installs valid workflow agents on partial failure", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    createBrokenWorkflowDir();
    try {
      const tempHome = setupTempHome();
      await runCli(["get-ready"], tempHome);

      const agentsPath = path.join(tempHome, ".tamandua", "agents.json");
      assert.ok(fs.existsSync(agentsPath), "agents.json should exist even on partial failure");

      const agents = JSON.parse(fs.readFileSync(agentsPath, "utf-8")) as Array<Record<string, unknown>>;

      const mainAgent = agents.find((a) => a.id === "main");
      assert.ok(mainAgent, "agents.json should have main agent even on partial failure");

      const workflowAgents = agents.filter(
        (a) => typeof a.id === "string" && a.id.includes("_"),
      );
      assert.ok(workflowAgents.length > 0, "agents.json should have valid workflow agents on partial failure");

      const brokenAgents = agents.filter(
        (a) => typeof a.id === "string" && a.id.startsWith(BROKEN_WORKFLOW_DIRNAME),
      );
      assert.equal(
        brokenAgents.length,
        0,
        `broken workflow should have no agents`,
      );
    } finally {
      removeBrokenWorkflowDir();
    }
  });
});
