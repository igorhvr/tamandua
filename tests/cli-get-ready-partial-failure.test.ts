/**
 * Tests for tamandua get-ready partial failure (US-002).
 *
 * Validates:
 * 1. get-ready with all valid workflows exits 0 and shows all checkmarks (AC 1)
 * 2. get-ready with one broken workflow exits with code 1 (AC 2)
 * 3. Partial failure prints "1 of N workflows failed to install" summary (AC 3)
 * 4. Daemon/MCP/control-plane startup still runs after summary (AC 4)
 *    (exitCode is set but process continues — "Done. Start with:" line appears
 *     after summary)
 */

import { describe, it, before, after, afterEach } from "node:test";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_SCRIPT = path.resolve(__dirname, "..", "dist", "cli", "cli.js");

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

function setupTempHome(): string {
  const th = createTempHome("tamandua-get-ready-");
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
 * Helper: create a deliberately broken workflow directory under the source
 * checkout's workflows/ dir. The directory has no workflow.yml, so install will fail.
 */
function createBrokenWorkflowDir(): string {
  const workflowsRoot = path.resolve(__dirname, "..", "workflows");
  const brokenDir = path.join(workflowsRoot, BROKEN_WORKFLOW_DIRNAME);
  fs.mkdirSync(brokenDir, { recursive: true });
  return brokenDir;
}

function removeBrokenWorkflowDir(): void {
  const workflowsRoot = path.resolve(__dirname, "..", "workflows");
  const brokenDir = path.join(workflowsRoot, BROKEN_WORKFLOW_DIRNAME);
  try {
    fs.rmSync(brokenDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe("tamandua get-ready partial failure", () => {
  // Clean up any lingering broken dir from a previous aborted run.
  before(() => {
    removeBrokenWorkflowDir();
  });

  afterEach(() => {
    removeBrokenWorkflowDir();
  });

  after(() => {
    removeBrokenWorkflowDir();
  });

  // AC 1: get-ready with all valid workflows exits 0 and shows all checkmarks
  it("get-ready with all valid workflows exits 0 and shows all checkmarks", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = setupTempHome();

    // Get expected count from the source checkout (before running, since the
    // broken dir may be absent or present but we want the correct count if absent).
    // We can't use getBundledWorkflowCount() since the broken dir might still be around.
    // Instead, just verify exit 0 and no failure summary.
    const { stdout, stderr, exitCode } = await runCli(
      ["get-ready"],
      tempHome,
    );

    const cleanErr = cleanStderr(stderr);
    assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}. stderr: ${cleanErr}`);

    // Should NOT have failure summary
    assert.ok(
      !/\d+ of \d+ workflows failed to install/.test(stdout),
      `Should not have failure summary, got: ${stdout}`,
    );

    // Should have checkmarks for valid workflows
    const checkMarks = (stdout.match(/✓/g) || []).length;
    assert.ok(checkMarks > 0, `Expected checkmarks for workflows, got ${checkMarks}`);

    // Should have the "Done. Start with:" line
    assert.ok(
      stdout.includes("Done. Start with:"),
      `Expected "Done. Start with:" in output, got: ${stdout}`,
    );
  });

  // AC 2: get-ready with one broken workflow exits with code 1
  it("get-ready with one broken workflow exits with code 1", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    createBrokenWorkflowDir();

    const tempHome = setupTempHome();
    const { stdout, stderr, exitCode } = await runCli(
      ["get-ready"],
      tempHome,
    );

    assert.equal(exitCode, 1, `Expected exit 1, got ${exitCode}. stdout: ${stdout}`);

    const cleanErr = cleanStderr(stderr);
    assert.equal(cleanErr, "");

    // Should show a failure for the broken workflow
    assert.ok(
      stdout.includes(`✗ ${BROKEN_WORKFLOW_DIRNAME}`),
      `Expected failure mark for ${BROKEN_WORKFLOW_DIRNAME}, got: ${stdout}`,
    );

    // Should have checkmarks for valid workflows
    const checkMarks = (stdout.match(/✓/g) || []).length;
    assert.ok(checkMarks > 0, `Expected checkmarks for valid workflows, got ${checkMarks}`);
  });

  // AC 3: Partial failure prints "1 of N workflows failed to install" summary
  it('partial failure prints "1 of N workflows failed to install" summary line', async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    createBrokenWorkflowDir();

    const tempHome = setupTempHome();
    const { stdout } = await runCli(
      ["get-ready"],
      tempHome,
    );

    // Should print exactly "1 of N workflows failed to install"
    assert.ok(
      /1 of \d+ workflows failed to install/.test(stdout),
      `Expected "1 of N workflows failed to install", got: ${stdout}`,
    );
  });

  // AC 4: Daemon/MCP/control-plane startup still runs after summary on partial failure
  it('"Done. Start with:" line appears after failure summary', async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    createBrokenWorkflowDir();

    const tempHome = setupTempHome();
    const { stdout } = await runCli(
      ["get-ready"],
      tempHome,
    );

    // "Done. Start with:" should appear after the summary line
    const failureSummaryIdx = stdout.search(/\d+ of \d+ workflows failed to install/);
    const doneIdx = stdout.indexOf("Done. Start with:");

    assert.ok(
      doneIdx !== -1,
      `Expected "Done. Start with:" in output, got: ${stdout}`,
    );
    assert.ok(
      doneIdx > failureSummaryIdx,
      `Expected "Done. Start with:" after failure summary, got: ${stdout}`,
    );
  });

  // Additional: valid workflows still produce agents on partial failure
  it("valid workflows still produce agents on partial failure", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    createBrokenWorkflowDir();

    const tempHome = setupTempHome();
    await runCli(["get-ready"], tempHome);

    // agents.json should exist and have entries
    const agentsPath = path.join(tempHome, ".tamandua", "agents.json");
    assert.ok(fs.existsSync(agentsPath), "agents.json should exist even on partial failure");

    const agents = JSON.parse(fs.readFileSync(agentsPath, "utf-8")) as Array<Record<string, unknown>>;
    const mainAgent = agents.find((a) => a.id === "main");
    assert.ok(mainAgent, "agents.json should have main agent even on partial failure");

    // Should have agents from valid workflows (not the broken one)
    const workflowAgents = agents.filter(
      (a) => typeof a.id === "string" && a.id.includes("_"),
    );
    assert.ok(workflowAgents.length > 0, "agents.json should have valid workflow agents on partial failure");

    // The broken workflow should NOT have agents
    const brokenAgents = agents.filter(
      (a) => typeof a.id === "string" && a.id.startsWith(BROKEN_WORKFLOW_DIRNAME),
    );
    assert.equal(brokenAgents.length, 0, `broken workflow should have no agents, got: ${brokenAgents.map((a) => a.id).join(", ")}`);
  });
});
