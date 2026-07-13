import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { once } from "node:events";
import { describe, it, after } from "node:test";
import { cleanChildEnv, createTempHome, reservePortHandle } from "./helpers/test-env.ts";
import type { PortHandle } from "./helpers/test-env.ts";

const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function createTempEnv(): { root: string; stateDir: string; homeDir: string } {
  const th = createTempHome("tamandua-dashboard-status-");
  const root = th.root;
  const stateDir = path.join(root, "state");
  const homeDir = th.homeDir;
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, stateDir, homeDir };
}

async function runCliOnce(args: string[], env: Record<string, string>): Promise<CliResult> {
  const child = spawn(process.execPath, [cliPath, ...args], {
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

  const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  return { code, stdout, stderr };
}

/** Safety-close a port handle, ignoring errors if already closed. */
async function safeClose(h: PortHandle | undefined): Promise<void> {
  if (!h) return;
  try { await h.close(); } catch { /* already closed */ }
}


describe("tamandua dashboard status MCP visibility", () => {
  // Belt-and-suspenders: kill any leaked mcp-standalone/daemon orphans
  after(() => {
    try {
      const pids = execSync(
        "pgrep -f 'mcp-standalone\\.js|daemon\\.js'",
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter(Boolean);

      for (const pid of pids) {
        try {
          // Only kill processes bound to a test temp dir. On Linux the
          // HOME= env entry says so; macOS hides other processes' envs,
          // but the services keep their log fd open under the temp home,
          // which lsof reports.
          let belongsToTest = false;
          if (process.platform === "linux") {
            const env = execSync(
              `cat /proc/${pid}/environ 2>/dev/null | tr '\\0' '\\n' | grep '^HOME='`,
              { encoding: "utf8" },
            );
            belongsToTest = env.includes("tamandua-dashboard-status");
          } else {
            const fds = execSync(`lsof -p ${pid} -Fn 2>/dev/null || true`, {
              encoding: "utf8",
            });
            belongsToTest = fds.includes("tamandua-dashboard-status");
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

  // AC 1: tamandua status reports Dashboard and MCP as separate services
  it("shows MCP as not running when dashboard is started without MCP", async (t) => {
    const dashboardPortHandle = await reservePortHandle();
    const controlPortHandle = await reservePortHandle();
    const mcpPortHandle = await reservePortHandle();
    const dashboardPort = dashboardPortHandle.port;
    const controlPort = controlPortHandle.port;
    const mcpPort = mcpPortHandle.port;
    const tempEnv = createTempEnv();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(controlPort),
    };

    try {
      // Write an MCP port file with an unused port so the async status probe
      // (which probes the TCP port on the configured port) doesn't detect a
      // production MCP on the default port 3338.
      const mcpPortDir = path.join(tempEnv.homeDir, ".tamandua");
      fs.mkdirSync(mcpPortDir, { recursive: true });
      await mcpPortHandle.close();
      fs.writeFileSync(path.join(mcpPortDir, "mcp-port"), String(mcpPort), "utf-8");

      // Close port handles just before daemon bind
      await dashboardPortHandle.close();
      await controlPortHandle.close();

      // Start dashboard only (without MCP)
      const start = await runCliOnce(["dashboard", "start", "--port", String(dashboardPort)], cliEnv);
      assert.equal(start.code, 0, start.stderr || start.stdout);

      // Dashboard status shows only dashboard info (not MCP — it's standalone)
      const dashStatus = await runCliOnce(["dashboard", "status"], cliEnv);
      assert.equal(dashStatus.code, 0, dashStatus.stderr || dashStatus.stdout);
      assert.match(dashStatus.stdout, /Dashboard running \(PID \d+\)/);
      assert.match(dashStatus.stdout, new RegExp(`Dashboard endpoint: http://localhost:${dashboardPort}`));
      assert.doesNotMatch(dashStatus.stdout, /MCP/);

      // tamandua status shows all services independently
      const status = await runCliOnce(["status"], cliEnv);
      assert.equal(status.code, 0, status.stderr || status.stdout);
      assert.match(status.stdout, /Dashboard: +UP/);
      assert.match(status.stdout, /MCP: +DOWN/);

      const stop = await runCliOnce(["dashboard", "stop"], cliEnv);
      assert.equal(stop.code, 0, stop.stderr || stop.stdout);
    } finally {
      await safeClose(dashboardPortHandle);
      await safeClose(controlPortHandle);
      await safeClose(mcpPortHandle);
      await runCliOnce(["dashboard", "stop"], cliEnv);
      await runCliOnce(["mcp", "stop"], cliEnv);
      fs.rmSync(tempEnv.root, { recursive: true, force: true });
    }
  });

  // AC 1: tamandua status reports MCP running independently when started via mcp start
  it("shows MCP as independently running after tamandua mcp start", async (t) => {
    const mcpPortHandle = await reservePortHandle();
    const dashboardPortHandle = await reservePortHandle();
    const controlPortHandle = await reservePortHandle();
    const unusedMcpPortHandle = await reservePortHandle();
    const mcpPort = mcpPortHandle.port;
    const dashboardPort = dashboardPortHandle.port;
    const controlPort = controlPortHandle.port;
    const unusedMcpPort = unusedMcpPortHandle.port;
    const tempEnv = createTempEnv();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(controlPort),
    };

    /** Write an MCP port file pointing to an unused port so the async
     * status probe doesn't detect a production MCP on the default 3338. */
    const writeUnusedMcpPort = () => {
      const mcpPortDir = path.join(tempEnv.homeDir, ".tamandua");
      fs.mkdirSync(mcpPortDir, { recursive: true });
      fs.writeFileSync(path.join(mcpPortDir, "mcp-port"), String(unusedMcpPort), "utf-8");
    };

    try {
      // Close port handles just before daemon bind
      await dashboardPortHandle.close();
      await controlPortHandle.close();

      // Start dashboard first
      const start = await runCliOnce(["dashboard", "start", "--port", String(dashboardPort)], cliEnv);
      assert.equal(start.code, 0, start.stderr || start.stdout);

      // tamandua status should show MCP not running (isolate from production MCP)
      writeUnusedMcpPort();
      const beforeMcp = await runCliOnce(["status"], cliEnv);
      assert.equal(beforeMcp.code, 0, beforeMcp.stderr || beforeMcp.stdout);
      assert.match(beforeMcp.stdout, /MCP: +DOWN/);

      // Start MCP independently (mcp start writes the correct port file itself)
      await mcpPortHandle.close();
      const mcpStart = await runCliOnce(["mcp", "start", "--port", String(mcpPort)], cliEnv);
      assert.equal(mcpStart.code, 0, mcpStart.stderr || mcpStart.stdout);
      assert.match(mcpStart.stdout, /MCP server started/);

      // tamandua status should now show MCP as running independently
      const afterMcp = await runCliOnce(["status"], cliEnv);
      assert.equal(afterMcp.code, 0, afterMcp.stderr || afterMcp.stdout);
      assert.match(afterMcp.stdout, /Dashboard: +UP/);
      assert.match(afterMcp.stdout, /MCP: +UP/);
      assert.match(afterMcp.stdout, new RegExp(`port ${mcpPort}, http://localhost:${mcpPort}/mcp`));

      // MCP should still be running after dashboard stop
      const dashStop = await runCliOnce(["dashboard", "stop"], cliEnv);
      assert.equal(dashStop.code, 0, dashStop.stderr || dashStop.stdout);

      // Dashboard status shows not running, MCP status shows still running
      const dashAfterStatus = await runCliOnce(["dashboard", "status"], cliEnv);
      assert.equal(dashAfterStatus.code, 0, dashAfterStatus.stderr || dashAfterStatus.stdout);
      assert.match(dashAfterStatus.stdout, /Dashboard is not running/);

      const mcpAfterStatus = await runCliOnce(["mcp", "status"], cliEnv);
      assert.equal(mcpAfterStatus.code, 0, mcpAfterStatus.stderr || mcpAfterStatus.stdout);
      assert.match(mcpAfterStatus.stdout, /MCP server running/);

      // Stop MCP (cleans up PID and port files)
      const mcpStop = await runCliOnce(["mcp", "stop"], cliEnv);
      assert.equal(mcpStop.code, 0, mcpStop.stderr || mcpStop.stdout);

      // Both should show not running
      const finalDashStatus = await runCliOnce(["dashboard", "status"], cliEnv);
      assert.match(finalDashStatus.stdout, /Dashboard is not running/);

      writeUnusedMcpPort();
      const finalMcpStatus = await runCliOnce(["mcp", "status"], cliEnv);
      assert.match(finalMcpStatus.stdout, /MCP server is not running/);
    } finally {
      await safeClose(dashboardPortHandle);
      await safeClose(controlPortHandle);
      await safeClose(mcpPortHandle);
      await safeClose(unusedMcpPortHandle);
      await runCliOnce(["dashboard", "stop"], cliEnv);
      await runCliOnce(["mcp", "stop"], cliEnv);
      fs.rmSync(tempEnv.root, { recursive: true, force: true });
    }
  });

  // AC 2 & 3: Dashboard HTML shows MCP status section and /api/mcp-status endpoint works
  it("dashboard HTML shows MCP status section with running/stopped state", async (t) => {
    const dashboardPortHandle = await reservePortHandle();
    const controlPortHandle = await reservePortHandle();
    const mcpConfigPortHandle = await reservePortHandle();
    const dashboardPort = dashboardPortHandle.port;
    const controlPort = controlPortHandle.port;
    const mcpConfigPort = mcpConfigPortHandle.port;
    const tempEnv = createTempEnv();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(controlPort),
    };

    try {
      // Write the test's own MCP port into the config so the /api/mcp-status
      // endpoint reports the injected port instead of the hardcoded default.
      const mcpPortDir = path.join(tempEnv.homeDir, ".tamandua");
      fs.mkdirSync(mcpPortDir, { recursive: true });
      await mcpConfigPortHandle.close();
      fs.writeFileSync(path.join(mcpPortDir, "mcp-port"), String(mcpConfigPort), "utf-8");

      // Close port handles just before daemon bind
      await dashboardPortHandle.close();
      await controlPortHandle.close();

      // Start dashboard
      const start = await runCliOnce(["dashboard", "start", "--port", String(dashboardPort)], cliEnv);
      assert.equal(start.code, 0, start.stderr || start.stdout);

      // AC 2: Check that index.html contains MCP status section
      const htmlRes = await fetch(`http://localhost:${dashboardPort}/`);
      assert.equal(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.match(html, /MCP Server/);
      assert.match(html, /mcp-status-content/);
      assert.match(html, /fetchMcpStatus/);
      assert.match(html, /fetch\("\/api\/mcp-status"\)/);

      // AC 3: /api/mcp-status returns { running, port, path }
      const apiRes = await fetch(`http://localhost:${dashboardPort}/api/mcp-status`);
      assert.equal(apiRes.status, 200);
      const apiBody = await apiRes.json() as { running: boolean; port: number; path: string };
      assert.equal(typeof apiBody.running, "boolean");
      assert.equal(apiBody.running, false); // MCP not started
      assert.equal(apiBody.port, mcpConfigPort);
      assert.equal(apiBody.path, "/mcp");

      // Start MCP and verify endpoint updates
      const mcpPortHandle = await reservePortHandle();
      const mcpPort = mcpPortHandle.port;
      await mcpPortHandle.close();

      const mcpStart = await runCliOnce(["mcp", "start", "--port", String(mcpPort)], cliEnv);
      assert.equal(mcpStart.code, 0, mcpStart.stderr || mcpStart.stdout);

      const apiResRunning = await fetch(`http://localhost:${dashboardPort}/api/mcp-status`);
      assert.equal(apiResRunning.status, 200);
      const apiBodyRunning = await apiResRunning.json() as { running: boolean; port: number; path: string };
      assert.equal(apiBodyRunning.running, true);
      assert.equal(apiBodyRunning.port, mcpPort);
      assert.equal(apiBodyRunning.path, "/mcp");

      await safeClose(mcpPortHandle);
    } finally {
      await safeClose(dashboardPortHandle);
      await safeClose(controlPortHandle);
      await safeClose(mcpConfigPortHandle);
      await runCliOnce(["dashboard", "stop"], cliEnv);
      await runCliOnce(["mcp", "stop"], cliEnv);
      fs.rmSync(tempEnv.root, { recursive: true, force: true });
    }
  });

  // AC 4: get-ready tries to start MCP when not running
  it("tamandua get-ready starts MCP when MCP is not running", async () => {
    const tempEnv = createTempEnv();
    const controlPortHandle = await reservePortHandle();
    const controlPort = controlPortHandle.port;
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(controlPort),
    };

    try {
      await controlPortHandle.close();

      const install = await runCliOnce(["get-ready"], cliEnv);
      assert.equal(install.code, 0, install.stderr || install.stdout);
      // get-ready now actively attempts to start MCP (and control plane);
      // when MCP start fails (e.g., no built mcp-standalone.js), it prints
      // a Note with the recovery command instead of the old passive message.
      assert.match(install.stdout, /MCP server already running\.|MCP server started|Note: MCP server not started[\s\S]*recover: tamandua mcp start/);
    } finally {
      await safeClose(controlPortHandle);
      await runCliOnce(["uninstall", "--force"], cliEnv);
      fs.rmSync(tempEnv.root, { recursive: true, force: true });
    }
  });

  // AC 5: uninstall stops MCP if running
  it("tamandua uninstall stops MCP if it was running", async (t) => {
    const mcpPortHandle = await reservePortHandle();
    const unusedMcpPortHandle = await reservePortHandle();
    const controlPortHandle = await reservePortHandle();
    const mcpPort = mcpPortHandle.port;
    const unusedMcpPort = unusedMcpPortHandle.port;
    const controlPort = controlPortHandle.port;
    const tempEnv = createTempEnv();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(controlPort),
    };

    try {
      // Close port handles just before daemon/MCP bind
      await controlPortHandle.close();
      await mcpPortHandle.close();

      // Start MCP
      const mcpStart = await runCliOnce(["mcp", "start", "--port", String(mcpPort)], cliEnv);
      assert.equal(mcpStart.code, 0, mcpStart.stderr || mcpStart.stdout);

      // Verify MCP is running
      const mcpStatusBefore = await runCliOnce(["mcp", "status"], cliEnv);
      assert.match(mcpStatusBefore.stdout, /MCP server running/);

      // Run uninstall --force
      const uninstall = await runCliOnce(["uninstall", "--force"], cliEnv);
      assert.equal(uninstall.code, 0, uninstall.stderr || uninstall.stdout);
      assert.match(uninstall.stdout, /MCP server stopped/);

      // After uninstall cleans up the MCP port file, write an unused port
      // so the async status probe doesn't detect a production MCP on 3338.
      await unusedMcpPortHandle.close();
      const mcpPortDir = path.join(tempEnv.homeDir, ".tamandua");
      fs.mkdirSync(mcpPortDir, { recursive: true });
      fs.writeFileSync(path.join(mcpPortDir, "mcp-port"), String(unusedMcpPort), "utf-8");

      // Verify MCP is no longer running
      const mcpStatusAfter = await runCliOnce(["mcp", "status"], cliEnv);
      assert.match(mcpStatusAfter.stdout, /MCP server is not running/);
    } finally {
      await safeClose(mcpPortHandle);
      await safeClose(unusedMcpPortHandle);
      await safeClose(controlPortHandle);
      await runCliOnce(["mcp", "stop"], cliEnv);
      fs.rmSync(tempEnv.root, { recursive: true, force: true });
    }
  });
});
