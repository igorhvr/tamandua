/**
 * WAVE-A.1 US-007 regression: tamandua get-ready honors TAMANDUA_DASHBOARD_PORT.
 *
 * Previously handleGetReady passed a hardcoded default port to the standalone
 * dashboard starter, so the TAMANDUA_DASHBOARD_PORT env override honored by the
 * standalone dashboard server (dashboard-standalone.ts) was silently ignored
 * by get-ready.
 *
 * These tests drive the real CLI (spawned node dist/cli/cli.js) with an
 * isolated temp HOME and assert:
 *  1. TAMANDUA_DASHBOARD_PORT=<valid port> → get-ready starts the standalone
 *     dashboard on that port (stdout + ~/.tamandua/port + live /api/health).
 *  2. TAMANDUA_DASHBOARD_PORT unset/invalid → get-ready attempts the fallback
 *     default port 3334 (observed via the start failure Note that names 3334;
 *     binding 3334 is guard-blocked in the spawned child, which is exactly
 *     what makes the attempt observable without squatting a production port).
 *
 * Each test installs a single bundled workflow (do-now) from a temp workflows
 * source so the run exercises the full get-ready path quickly. The daemon and
 * MCP branches also run (daemon on a reserved control port; MCP start on the
 * default 3338 is guard-blocked and surfaces as a Note, same as the existing
 * get-ready partial-failure suite).
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanChildEnv, createTempHome, reservePortHandle } from "./helpers/test-env.ts";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import type { PortHandle } from "./helpers/test-env.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CLI_SCRIPT = path.resolve(REPO_ROOT, "dist", "cli", "cli.js");
const SINGLE_WORKFLOW_ID = "do-now";
const TEST_TMP_PREFIX = "tamandua-get-ready-port-";
// Matches the resolver default (src/server/dashboard-port.ts DEFAULT_DASHBOARD_PORT).
const DEFAULT_DASHBOARD_PORT = 3334;

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

interface TempEnv {
  root: string;
  homeDir: string;
  tamanduaDir: string;
}

function createTempEnv(): TempEnv {
  const th = createTempHome(TEST_TMP_PREFIX);
  return { root: th.root, homeDir: th.homeDir, tamanduaDir: th.tamanduaDir };
}

function runCliOnce(args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    const child = spawn(process.execPath, [CLI_SCRIPT, ...args], {
      env: cleanChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function safeClose(h: PortHandle | undefined): Promise<void> {
  if (!h) return;
  try {
    await h.close();
  } catch {
    // already closed
  }
}

/** Seed a minimal pi settings.json so installWorkflow's readPiConfig() succeeds. */
function seedPiConfig(homeDir: string): void {
  const piAgentDir = path.join(homeDir, ".pi", "agent");
  fs.mkdirSync(piAgentDir, { recursive: true });
  fs.writeFileSync(
    path.join(piAgentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o" }),
    "utf-8",
  );
}

/**
 * Create an isolated workflows source containing exactly one real bundled
 * workflow, so get-ready exercises install → services quickly without
 * installing the whole catalog.
 */
function createWorkflowSource(): { workflowsSrc: string; cleanup: () => void } {
  // tamanduaTempDir is the sanctioned mkdtemp helper for test files.
  const workflowsSrc = tamanduaTempDir(`${TEST_TMP_PREFIX}wf-`);
  fs.cpSync(
    path.join(REPO_ROOT, "workflows", SINGLE_WORKFLOW_ID),
    path.join(workflowsSrc, SINGLE_WORKFLOW_ID),
    { recursive: true },
  );

  const cleanup = () => {
    try {
      fs.rmSync(workflowsSrc, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };

  return { workflowsSrc, cleanup };
}

/** Read the dashboard port file (~/.tamandua/port) content, if present. */
function readDashboardPortFile(tamanduaDir: string): string | null {
  const portFile = path.join(tamanduaDir, "port");
  try {
    return fs.readFileSync(portFile, "utf-8").trim();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Assert that a get-ready run whose dashboard start is guard-blocked on the
 * fallback 3334 printed the "Note: dashboard not started" line naming 3334 —
 * the observable proof that startDashboardStandalone received the resolver's
 * 3334 rather than any other port.
 */
function assertFallback3334Attempt(stdout: string, label: string): void {
  assert.ok(
    !stdout.includes("Dashboard started"),
    `[${label}] Dashboard must not start — binding 3334 is guard-blocked. stdout: ${stdout}`,
  );
  assert.match(
    stdout,
    new RegExp(`Note: dashboard not started[\\s\\S]{0,800}${DEFAULT_DASHBOARD_PORT}`),
    `[${label}] The fallback attempt on 3334 should surface in the Note. stdout: ${stdout}`,
  );
}

/** Stop any services get-ready started and remove the temp env. */
async function teardown(cliEnv: Record<string, string>, tempEnv: TempEnv, cleanupWorkflows: () => void): Promise<void> {
  await runCliOnce(["uninstall", "--force"], cliEnv);
  await runCliOnce(["dashboard", "stop"], cliEnv);
  await runCliOnce(["mcp", "stop"], cliEnv);
  cleanupWorkflows();
  fs.rmSync(tempEnv.root, { recursive: true, force: true });
}

describe("tamandua get-ready TAMANDUA_DASHBOARD_PORT", () => {
  // Belt-and-suspenders: kill any leaked daemon/dashboard/MCP orphans from a
  // hard failure that skipped the per-test finally cleanup.
  after(() => {
    try {
      const pids = execSync(
        "pgrep -f 'mcp-standalone\\.js|dashboard-standalone\\.js|daemon\\.js'",
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter(Boolean);

      for (const pid of pids) {
        try {
          // Only kill processes whose HOME env (read from the Linux environ
          // pseudo-file) or open log fds reference this test's temp prefix.
          // macOS hides other processes' envs, but services keep their log fd
          // open under the temp home, which lsof reports.
          let belongsToTest = false;
          if (process.platform === "linux") {
            const env = execSync(
              `cat /proc/${pid}/environ 2>/dev/null | tr '\\0' '\\n' | grep '^HOME='`,
              { encoding: "utf8" },
            );
            belongsToTest = env.includes(TEST_TMP_PREFIX);
          } else {
            const fds = execSync(`lsof -p ${pid} -Fn 2>/dev/null || true`, {
              encoding: "utf8",
            });
            belongsToTest = fds.includes(TEST_TMP_PREFIX);
          }
          if (belongsToTest) {
            process.kill(Number(pid), "SIGKILL");
          }
        } catch {
          // Process may have exited between pgrep and the evidence read
        }
      }
    } catch {
      // pgrep may fail if no processes match — that's fine
    }
  });

  it("starts the standalone dashboard on TAMANDUA_DASHBOARD_PORT when set to a valid port", async () => {
    const dashPortHandle = await reservePortHandle();
    const controlPortHandle = await reservePortHandle();
    const dashPort = dashPortHandle.port;
    const controlPort = controlPortHandle.port;

    const tempEnv = createTempEnv();
    const { workflowsSrc, cleanup: cleanupWorkflows } = createWorkflowSource();

    // TAMANDUA_TEST_GUARD_EXPECT=1: this get-ready run deliberately attempts
    // an MCP start on the production port 3338 (get-ready's MCP branch has no
    // env override), which the TISO guard blocks. That guard-blocked bind is a
    // deliberate provocation the run tolerates (surfaces as a Note), so the
    // ledger entry must be marked expected — otherwise the lane-level
    // guard-ledger enforcement fails the whole serial lane.
    const cliEnv: Record<string, string> = {
      HOME: tempEnv.homeDir,
      TAMANDUA_WORKFLOWS_SRC: workflowsSrc,
      TAMANDUA_CONTROL_PORT: String(controlPort),
      TAMANDUA_DASHBOARD_PORT: String(dashPort),
      TAMANDUA_TEST_GUARD: "1",
      TAMANDUA_TEST_GUARD_EXPECT: "1",
    };

    try {
      seedPiConfig(tempEnv.homeDir);

      // Free the reserved ports just before get-ready binds them.
      await dashPortHandle.close();
      await controlPortHandle.close();

      const result = await runCliOnce(["get-ready"], cliEnv);
      assert.equal(
        result.code,
        0,
        `Expected exit 0. stdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );

      // get-ready must start the dashboard on the env port (not hardcode 3334)
      assert.match(
        result.stdout,
        /Dashboard started \(PID \d+\): http:\/\/localhost:\d+/,
        `Expected dashboard start line, got: ${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes(`http://localhost:${dashPort}`),
        `Expected dashboard on env port ${dashPort}, got: ${result.stdout}`,
      );
      assert.ok(
        !result.stdout.includes("Dashboard already running."),
        "Dashboard should have been started by get-ready (fresh HOME), not pre-existing",
      );

      // The port file must record the env port
      assert.equal(
        readDashboardPortFile(tempEnv.tamanduaDir),
        String(dashPort),
        "~/.tamandua/port should record the TAMANDUA_DASHBOARD_PORT value",
      );

      // The standalone dashboard must actually be serving on the env port
      const health = await fetch(`http://127.0.0.1:${dashPort}/api/health`);
      assert.equal(
        health.status,
        200,
        `Dashboard /api/health on env port ${dashPort} should be 200`,
      );
    } finally {
      await safeClose(dashPortHandle);
      await safeClose(controlPortHandle);
      await teardown(cliEnv, tempEnv, cleanupWorkflows);
    }
  });

  it("falls back to the default port 3334 when TAMANDUA_DASHBOARD_PORT is unset or invalid", async () => {
    // Resolver unit coverage (src/server/dashboard-port.test.ts) pins unset /
    // empty / invalid / out-of-range → 3334. Here we prove the CLI wiring for
    // the fallback cases: an unset or non-numeric env value must resolve to
    // 3334 and be passed to startDashboardStandalone.
    const scenarios: Array<{ name: string; env: Record<string, string> }> = [
      { name: "unset", env: {} },
      { name: "non-numeric", env: { TAMANDUA_DASHBOARD_PORT: "not-a-port" } },
    ];

    for (const scenario of scenarios) {
      const controlPortHandle = await reservePortHandle();
      const controlPort = controlPortHandle.port;

      const tempEnv = createTempEnv();
      const { workflowsSrc, cleanup: cleanupWorkflows } = createWorkflowSource();

      // Fallback scenarios deliberately let the spawned child attempt the
      // production-port binds (dashboard fallback 3334 + MCP 3338) — the
      // guard-block on 3334 is the observable proof that startDashboardStandalone
      // received the resolver's 3334 fallback. TAMANDUA_TEST_GUARD_EXPECT=1
      // marks those deliberate violations as expected in the guard ledger so
      // the lane-level guard-ledger enforcement stays green.
      const cliEnv: Record<string, string> = {
        HOME: tempEnv.homeDir,
        TAMANDUA_WORKFLOWS_SRC: workflowsSrc,
        TAMANDUA_CONTROL_PORT: String(controlPort),
        ...scenario.env,
        TAMANDUA_TEST_GUARD: "1",
        TAMANDUA_TEST_GUARD_EXPECT: "1",
      };

      try {
        seedPiConfig(tempEnv.homeDir);
        await controlPortHandle.close();

        const result = await runCliOnce(["get-ready"], cliEnv);
        assert.equal(
          result.code,
          0,
          `[${scenario.name}] Expected exit 0. stdout: ${result.stdout}\nstderr: ${result.stderr}`,
        );

        assertFallback3334Attempt(result.stdout, scenario.name);
      } finally {
        await safeClose(controlPortHandle);
        await teardown(cliEnv, tempEnv, cleanupWorkflows);
      }
    }
  });
});
