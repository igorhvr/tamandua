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
 * All tests use isolated temp HOME directories. A temp workflows source dir
 * is created by copying all valid bundled workflows, then adding a deliberately
 * broken directory (no workflow.yml) there. The CLI is run with
 * TAMANDUA_WORKFLOWS_SRC pointing at this temp dir. The temp dir is removed
 * in a finally block.
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
const REAL_WORKFLOWS_SRC = path.resolve(__dirname, "..", "..", "workflows");

const BROKEN_WORKFLOW_DIRNAME = "_test-partial-failure-broken";

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCli(args: string[], homeDir: string, extraEnv?: Record<string, string>): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("node", ["--no-warnings", CLI_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanChildEnv({ HOME: homeDir, ...(extraEnv ?? {}) }),
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
 * Create an isolated temp workflows source by copying all real bundled
 * workflows into a temp dir, then creating the deliberately-broken fixture
 * there. Returns the temp workflows source dir, the broken fixture path,
 * and a cleanup function.
 */
function createTestWorkflowsSource(): { workflowsSrc: string; brokenDir: string; cleanup: () => void } {
  const workflowsSrc = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "tamandua-install-pf-wf-"));

  // Copy all valid bundled workflows from the real checkout
  for (const entry of fs.readdirSync(REAL_WORKFLOWS_SRC, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      fs.cpSync(path.join(REAL_WORKFLOWS_SRC, entry.name), path.join(workflowsSrc, entry.name), { recursive: true });
    }
  }

  // Create the broken fixture in the temp workflows dir
  const brokenDir = path.join(workflowsSrc, BROKEN_WORKFLOW_DIRNAME);
  fs.mkdirSync(brokenDir, { recursive: true });

  const cleanup = () => {
    try { fs.rmSync(workflowsSrc, { recursive: true, force: true }); } catch { /* best-effort */ }
  };

  return { workflowsSrc, brokenDir, cleanup };
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe("tamandua install partial failure", () => {
  // Clean up any lingering temp dirs from a previous aborted run.
  before(() => {
    // Best-effort: clean up any leftover temp dirs matching our prefix
    const tmpDir = fs.realpathSync("/tmp");
    for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("tamandua-install-pf-wf-")) {
        try { fs.rmSync(path.join(tmpDir, entry.name), { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  });

  // AC 1: workflow install --all exits non-zero on partial failure,
  // prints summary line, and shows checkmarks for valid workflows.
  it("workflow install --all exits 1 with summary line on partial failure (try/finally)", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    // Use try/finally for broken directory cleanup as required by AC 3.
    const { workflowsSrc, cleanup } = createTestWorkflowsSource();
    try {
      const tempHome = setupTempHome();

      const { stdout, stderr, exitCode } = await runCli(
        ["workflow", "install", "--all"],
        tempHome,
        { TAMANDUA_WORKFLOWS_SRC: workflowsSrc },
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
      cleanup();
    }
  });

  // AC 1 (continued): valid workflows still install on partial failure
  it("workflow install --all still installs valid workflows on partial failure", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const { workflowsSrc, cleanup } = createTestWorkflowsSource();
    try {
      const tempHome = setupTempHome();
      await runCli(["workflow", "install", "--all"], tempHome, { TAMANDUA_WORKFLOWS_SRC: workflowsSrc });

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
      cleanup();
    }
  });

  // AC 2: get-ready exits non-zero on partial failure,
  // prints summary line, and shows checkmarks for valid workflows.
  it("get-ready exits 1 with summary line on partial failure (try/finally)", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const { workflowsSrc, cleanup } = createTestWorkflowsSource();
    try {
      const tempHome = setupTempHome();

      const { stdout, stderr, exitCode } = await runCli(
        ["get-ready"],
        tempHome,
        { TAMANDUA_WORKFLOWS_SRC: workflowsSrc },
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
      cleanup();
    }
  });

  // AC 2 (continued): get-ready "Done. Start with:" after summary
  it('get-ready prints "Done. Start with:" after failure summary', async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const { workflowsSrc, cleanup } = createTestWorkflowsSource();
    try {
      const tempHome = setupTempHome();

      const { stdout } = await runCli(["get-ready"], tempHome, { TAMANDUA_WORKFLOWS_SRC: workflowsSrc });

      // "Done. Start with:" should appear after the summary line
      const failureSummaryIdx = stdout.search(/\d+ of \d+ workflows failed to install/);
      const doneIdx = stdout.indexOf("Done. Start with:");

      assert.ok(doneIdx !== -1, `Expected "Done. Start with:" in output, got: ${stdout}`);
      assert.ok(
        doneIdx > failureSummaryIdx,
        `Expected "Done. Start with:" after failure summary, got: ${stdout}`,
      );
    } finally {
      cleanup();
    }
  });

  // AC 2 (continued): get-ready valid workflows still produce agents
  it("get-ready still installs valid workflow agents on partial failure", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const { workflowsSrc, cleanup } = createTestWorkflowsSource();
    try {
      const tempHome = setupTempHome();
      await runCli(["get-ready"], tempHome, { TAMANDUA_WORKFLOWS_SRC: workflowsSrc });

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
      cleanup();
    }
  });

  // Regression: the two serial-lane test suites (this file and update.test.ts)
  // must be hermetic — they must never influence each other's execution.
  // Before the fix, install-partial-failure created a broken fixture in the
  // live workflows/ dir that update.test.ts's real-git runUpdate tests could
  // pick up, making the serial lane order-dependent.
  //
  // Guard: don't re-enter when this test spawns itself (prevent infinite recursion).
  const HERMETIC_GUARD = process.env.TAMANDUA_HERMETIC_PROBE;
  it("serial lane is hermetic: interleaved with update.test.ts 2x passes", { skip: !!HERMETIC_GUARD }, async (t) => {
    // Build first so the CLI script exists
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const testDir = path.resolve(__dirname, "..", "..");
    const updateTestFile = path.join(testDir, "src", "cli", "update.test.ts");
    const installPfTestFile = path.join(testDir, "tests", "cli", "install-partial-failure.test.ts");

    const failures: string[] = [];

    for (let i = 0; i < 2; i++) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("node", ["--experimental-test-module-mocks", "--test", installPfTestFile, updateTestFile], {
          stdio: ["ignore", "pipe", "pipe"],
          env: cleanChildEnv({ TAMANDUA_TEST_GUARD: "1", TAMANDUA_HERMETIC_PROBE: "1" }),
          cwd: testDir,
        });

        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });

        child.once("error", reject);
        child.once("close", (code) => {
          if (code !== 0) {
            failures.push(
              `Iteration ${i + 1} failed (exit ${code}):\nSTDOUT last 2k: ${stdout.slice(-2000)}\nSTDERR last 2k: ${stderr.slice(-2000)}`,
            );
          }
          resolve();
        });
      });
    }

    assert.equal(
      failures.length,
      0,
      `Expected all 2 interleaved runs to pass, got ${failures.length} failure(s):\n${failures.join("\n---\n")}`,
    );
  });
});
