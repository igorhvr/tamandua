/**
 * Tests for tamandua workflow install --all (US-002).
 *
 * Validates:
 * 1. workflow install --all installs all bundled workflows (AC 1)
 * 2. workflow install all (positional) also works (AC 2)
 * 3. workflow install <name> still installs a single workflow (AC 3)
 * 4. Installed workflow directories exist on disk (AC 4)
 * 5. agents.json is populated after install (cross-cutting)
 *
 * All tests use isolated temp HOME directories.
 */

import { describe, it, before, after } from "node:test";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_SCRIPT = path.resolve(__dirname, "..", "dist", "cli", "cli.js");

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
      env: cleanChildEnv({ HOME: homeDir  }),
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

/**
 * Filter harmless node warnings from stderr (e.g. SQLite experimental warning)
 * so they don't pollute test assertions.
 */
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

const TMP_PREFIX = "tamandua-wf-install-all-";

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
 * Read agents.json from the temp HOME's .tamandua directory.
 */
function readAgentsList(homeDir: string): Array<Record<string, unknown>> {
  const agentsPath = path.join(homeDir, ".tamandua", "agents.json");
  if (!fs.existsSync(agentsPath)) return [];
  const raw = fs.readFileSync(agentsPath, "utf-8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
  return [];
}

/**
 * Get the expected count of bundled workflows.
 * Reads from the repo's workflows/ directory at test time.
 */
function getBundledWorkflowCount(): number {
  const workflowsDir = path.resolve(__dirname, "..", "workflows");
  return fs.readdirSync(workflowsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .length;
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe("tamandua workflow install --all", () => {
  const expectedWorkflowCount = getBundledWorkflowCount();

  // AC 1: workflow install --all installs all bundled workflows
  it("workflow install --all installs all bundled workflows", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = setupTempHome();
      const { stdout, stderr, exitCode } = await runCli(
        ["workflow", "install", "--all"],
        tempHome,
      );

      const cleanErr = cleanStderr(stderr);

      assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}. stderr: ${cleanErr}`);
      assert.equal(cleanErr, "");

      // Should mention total count
      assert.ok(
        stdout.includes(`Installing ${expectedWorkflowCount} workflow(s)`),
        `Expected "Installing ${expectedWorkflowCount} workflow(s)", got: ${stdout}`,
      );

      // Should have a ✓ for each workflow
      const checkMarks = (stdout.match(/✓/g) || []).length;
      assert.ok(
        checkMarks >= expectedWorkflowCount,
        `Expected at least ${expectedWorkflowCount} ✓ marks, got ${checkMarks}`,
      );

      // Verify agents.json is populated
      const agents = readAgentsList(tempHome);
      assert.ok(agents.length > 0, "agents.json should contain agent entries");

      // At minimum, the "main" agent + agents from each workflow
      const mainAgent = agents.find((a) => a.id === "main");
      assert.ok(mainAgent, "agents.json should have a main agent entry");
      assert.equal(mainAgent.default, true, "main agent should have default: true");

      // Workflow-prefixed agents should exist (e.g. feature-dev-merge_developer)
      const workflowAgents = agents.filter(
        (a) => typeof a.id === "string" && a.id.includes("_"),
      );
      assert.ok(
        workflowAgents.length > 0,
        `Expected workflow-prefixed agents in agents.json, got: ${agents.map((a) => a.id).join(", ")}`,
      );
  });

  // AC 2: workflow install all (positional) also works
  it('workflow install "all" (positional) installs all bundled workflows', async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = setupTempHome();
      const { stdout, stderr, exitCode } = await runCli(
        ["workflow", "install", "all"],
        tempHome,
      );

      const cleanErr = cleanStderr(stderr);

      assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}. stderr: ${cleanErr}`);
      assert.equal(cleanErr, "");

      // Should mention total count
      assert.ok(
        stdout.includes(`Installing ${expectedWorkflowCount} workflow(s)`),
        `Expected "Installing ${expectedWorkflowCount} workflow(s)" in --all output, got: ${stdout}`,
      );

      // Should have a ✓ for each workflow
      const checkMarks = (stdout.match(/✓/g) || []).length;
      assert.ok(
        checkMarks >= expectedWorkflowCount,
        `Expected at least ${expectedWorkflowCount} ✓ marks, got ${checkMarks}`,
      );

      // Should end with the "Done. Start with:" message
      assert.ok(
        stdout.includes("Done. Start with:"),
        "Expected 'Done. Start with:' message in output",
      );
  });

  // AC 3: workflow install <name> still installs a single workflow
  it("workflow install <name> still installs a single workflow", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = setupTempHome();
      const { stdout, stderr, exitCode } = await runCli(
        ["workflow", "install", "feature-dev"],
        tempHome,
      );

      const cleanErr = cleanStderr(stderr);

      assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}. stderr: ${cleanErr}`);
      assert.equal(cleanErr, "");

      // Single install uses different output format than --all
      assert.ok(
        stdout.includes("Installed workflow:"),
        `Expected "Installed workflow:" in output, got: ${stdout}`,
      );
      assert.ok(
        stdout.includes("feature-dev"),
        `Expected "feature-dev" in output, got: ${stdout}`,
      );

      // Should NOT have the --all message
      assert.ok(
        !stdout.includes("Installing"),
        "Should not have 'Installing N workflow(s)' for single install",
      );

      // Verify agents.json has only the single workflow's agents (plus main)
      const agents = readAgentsList(tempHome);
      const workflowAgents = agents.filter(
        (a) => typeof a.id === "string" && a.id.startsWith("feature-dev_"),
      );
      assert.ok(
        workflowAgents.length > 0,
        `Expected feature-dev_ agents, got: ${agents.map((a) => a.id).join(", ")}`,
      );

      // Should NOT have agents from other workflows
      const otherAgents = agents.filter(
        (a) =>
          typeof a.id === "string" &&
          a.id.includes("_") &&
          !a.id.startsWith("feature-dev_"),
      );
      assert.equal(
        otherAgents.length,
        0,
        `Should not have agents from other workflows, got: ${otherAgents.map((a) => a.id).join(", ")}`,
      );
  });

  // AC 4: installed workflow directories exist on disk
  it("installed workflow directories exist on disk after --all", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = setupTempHome();
      const { stdout, stderr, exitCode } = await runCli(
        ["workflow", "install", "--all"],
        tempHome,
      );

      const cleanErr = cleanStderr(stderr);
      assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}. stderr: ${cleanErr}`);

      // Verify workflow directories exist under ~/.tamandua/workflows/
      const workflowsRoot = path.join(tempHome, ".tamandua", "workflows");
      assert.ok(
        fs.existsSync(workflowsRoot),
        `Expected workflows directory at ${workflowsRoot}`,
      );

      // Check a few known workflows exist
      const sampleWorkflows = ["feature-dev", "bug-fix", "security-audit"];
      for (const wf of sampleWorkflows) {
        const wfDir = path.join(workflowsRoot, wf);
        assert.ok(
          fs.existsSync(wfDir),
          `Expected workflow directory ${wfDir} to exist`,
        );

        // Each should have a workflow.yml
        const ymlPath = path.join(wfDir, "workflow.yml");
        assert.ok(
          fs.existsSync(ymlPath),
          `Expected workflow.yml in ${wfDir}`,
        );
      }
  });

  // Additional: verify metadata.json is written for each installed workflow
  it("metadata.json is written for each installed workflow", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = setupTempHome();
      await runCli(["workflow", "install", "--all"], tempHome);

      const workflowsRoot = path.join(tempHome, ".tamandua", "workflows");
      const entries = fs.readdirSync(workflowsRoot, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const metadataPath = path.join(workflowsRoot, entry.name, "metadata.json");
        assert.ok(
          fs.existsSync(metadataPath),
          `Expected metadata.json in ${entry.name}`,
        );

        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
        assert.ok(metadata.workflowId, "metadata.json should have workflowId");
        assert.ok(metadata.source, "metadata.json should have source");
        assert.ok(metadata.installedAt, "metadata.json should have installedAt");
      }
  });

  // Additional: agents.json entries have workspace and agentDir paths
  it("agents.json entries have valid workspace and agentDir paths", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = setupTempHome();
      await runCli(["workflow", "install", "--all"], tempHome);

      const agents = readAgentsList(tempHome);
      const workflowAgents = agents.filter(
        (a) => typeof a.id === "string" && a.id.includes("_"),
      );

      assert.ok(workflowAgents.length > 0, "Should have workflow agents");

      for (const agent of workflowAgents) {
        // workspace path should exist
        if (typeof agent.workspace === "string") {
          assert.ok(
            fs.existsSync(agent.workspace),
            `Agent ${agent.id}: workspace ${agent.workspace} should exist`,
          );
        }

        // agentDir path should exist
        if (typeof agent.agentDir === "string") {
          assert.ok(
            fs.existsSync(agent.agentDir),
            `Agent ${agent.id}: agentDir ${agent.agentDir} should exist`,
          );
        }

        // Should have a config with role
        const config = agent.config as Record<string, unknown> | undefined;
        assert.ok(config, `Agent ${agent.id} should have config`);
        assert.ok(typeof config?.role === "string", `Agent ${agent.id} config should have role`);
      }
  });
});
