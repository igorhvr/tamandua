import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { once } from "node:events";
import { describe, it, after } from "node:test";
import { cleanChildEnv, createTempHome, reserveRandomPort } from "./helpers/test-env.ts";

const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");
const DEFAULT_MCP_PORT = 3338;

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

async function canBind(port: number): Promise<boolean> {
  const server = http.createServer();

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });

    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
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

  // AC 1: Dashboard status shows MCP as independently managed
  it("shows MCP as not running when dashboard is started without MCP", async (t) => {
    const dashboardPort = await reserveRandomPort();
    const controlPort = await reserveRandomPort();
    const mcpPort = await reserveRandomPort(); // unused port to isolate from production MCP on 3338
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
      fs.writeFileSync(path.join(mcpPortDir, "mcp-port"), String(mcpPort), "utf-8");

      // Start dashboard only (without MCP)
      const start = await runCliOnce(["dashboard", "start", "--port", String(dashboardPort)], cliEnv);
      assert.equal(start.code, 0, start.stderr || start.stdout);

      // Check status — MCP should be independently reported as not running
      const status = await runCliOnce(["dashboard", "status"], cliEnv);
      assert.equal(status.code, 0, status.stderr || status.stdout);
      assert.match(status.stdout, /Dashboard running \(PID \d+\)/);
      assert.match(status.stdout, new RegExp(`Dashboard endpoint: http://localhost:${dashboardPort}`));
      assert.match(status.stdout, /MCP server is not running/);

      const stop = await runCliOnce(["dashboard", "stop"], cliEnv);
      assert.equal(stop.code, 0, stop.stderr || stop.stdout);
    } finally {
      await runCliOnce(["dashboard", "stop"], cliEnv);
      await runCliOnce(["mcp", "stop"], cliEnv);
      fs.rmSync(tempEnv.root, { recursive: true, force: true });
    }
  });

  // AC 1: Dashboard status shows MCP running independently when started via mcp start
  it("shows MCP as independently running after tamandua mcp start", async (t) => {
    const mcpPort = await reserveRandomPort();
    if (!(await canBind(mcpPort))) {
      t.skip(`Port ${mcpPort} is already in use — another test may be using it`);
      return;
    }

    const dashboardPort = await reserveRandomPort();
    const controlPort = await reserveRandomPort();
    const unusedMcpPort = await reserveRandomPort(); // isolates from production MCP on 3338
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
      // Start dashboard first
      const start = await runCliOnce(["dashboard", "start", "--port", String(dashboardPort)], cliEnv);
      assert.equal(start.code, 0, start.stderr || start.stdout);

      // Dashboard status should show MCP not running (isolate from production MCP)
      writeUnusedMcpPort();
      const beforeMcp = await runCliOnce(["dashboard", "status"], cliEnv);
      assert.equal(beforeMcp.code, 0, beforeMcp.stderr || beforeMcp.stdout);
      assert.match(beforeMcp.stdout, /MCP server is not running/);

      // Start MCP independently (mcp start writes the correct port file itself)
      const mcpStart = await runCliOnce(["mcp", "start", "--port", String(mcpPort)], cliEnv);
      assert.equal(mcpStart.code, 0, mcpStart.stderr || mcpStart.stdout);
      assert.match(mcpStart.stdout, /MCP server started/);

      // Dashboard status should now show MCP as running independently
      const afterMcp = await runCliOnce(["dashboard", "status"], cliEnv);
      assert.equal(afterMcp.code, 0, afterMcp.stderr || afterMcp.stdout);
      assert.match(afterMcp.stdout, /Dashboard running \(PID \d+\)/);
      assert.match(afterMcp.stdout, /MCP server running \(PID \d+\)/);
      assert.match(afterMcp.stdout, new RegExp(`MCP endpoint: http://localhost:${mcpPort}/mcp`));

      // MCP should still be running after dashboard stop
      const dashStop = await runCliOnce(["dashboard", "stop"], cliEnv);
      assert.equal(dashStop.code, 0, dashStop.stderr || dashStop.stdout);

      const afterDashStop = await runCliOnce(["dashboard", "status"], cliEnv);
      assert.match(afterDashStop.stdout, /Dashboard is not running/);
      assert.match(afterDashStop.stdout, /MCP server running \(PID \d+\)/);

      // Stop MCP (cleans up PID and port files)
      const mcpStop = await runCliOnce(["mcp", "stop"], cliEnv);
      assert.equal(mcpStop.code, 0, mcpStop.stderr || mcpStop.stdout);

      // Both should show not running (isolate from production MCP again)
      writeUnusedMcpPort();
      const finalStatus = await runCliOnce(["dashboard", "status"], cliEnv);
      assert.match(finalStatus.stdout, /Dashboard is not running/);
      assert.match(finalStatus.stdout, /MCP server is not running/);
    } finally {
      await runCliOnce(["dashboard", "stop"], cliEnv);
      await runCliOnce(["mcp", "stop"], cliEnv);
      fs.rmSync(tempEnv.root, { recursive: true, force: true });
    }
  });

  // AC 2 & 3: Dashboard HTML shows MCP status section and /api/mcp-status endpoint works
  it("dashboard HTML shows MCP status section with running/stopped state", async (t) => {
    const dashboardPort = await reserveRandomPort();
    const controlPort = await reserveRandomPort();
    const tempEnv = createTempEnv();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(controlPort),
    };

    try {
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
      assert.equal(apiBody.port, DEFAULT_MCP_PORT);
      assert.equal(apiBody.path, "/mcp");

      // Start MCP and verify endpoint updates
      const mcpPort = await reserveRandomPort();
      if (!(await canBind(mcpPort))) {
        t.skip(`Port ${mcpPort} is already in use — another test may be using it`);
        return;
      }

      const mcpStart = await runCliOnce(["mcp", "start", "--port", String(mcpPort)], cliEnv);
      assert.equal(mcpStart.code, 0, mcpStart.stderr || mcpStart.stdout);

      const apiResRunning = await fetch(`http://localhost:${dashboardPort}/api/mcp-status`);
      assert.equal(apiResRunning.status, 200);
      const apiBodyRunning = await apiResRunning.json() as { running: boolean; port: number; path: string };
      assert.equal(apiBodyRunning.running, true);
      assert.equal(apiBodyRunning.port, mcpPort);
      assert.equal(apiBodyRunning.path, "/mcp");

    } finally {
      await runCliOnce(["dashboard", "stop"], cliEnv);
      await runCliOnce(["mcp", "stop"], cliEnv);
      fs.rmSync(tempEnv.root, { recursive: true, force: true });
    }
  });

  // AC 4: get-ready tries to start MCP when not running
  it("tamandua get-ready starts MCP when MCP is not running", async () => {
    const tempEnv = createTempEnv();
    const controlPort = await reserveRandomPort();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(controlPort),
    };

    try {
      const install = await runCliOnce(["get-ready"], cliEnv);
      assert.equal(install.code, 0, install.stderr || install.stdout);
      // get-ready now actively attempts to start MCP (and control plane);
      // when MCP start fails (e.g., no built mcp-standalone.js), it prints
      // a Note with the recovery command instead of the old passive message.
      assert.match(install.stdout, /MCP server already running\.|MCP server started|Note: MCP server not started[\s\S]*recover: tamandua mcp start/);
    } finally {
      await runCliOnce(["uninstall", "--force"], cliEnv);
      fs.rmSync(tempEnv.root, { recursive: true, force: true });
    }
  });

  // AC 5: uninstall stops MCP if running
  it("tamandua uninstall stops MCP if it was running", async (t) => {
    const mcpPort = await reserveRandomPort();
    if (!(await canBind(mcpPort))) {
      t.skip(`Port ${mcpPort} is already in use — another test may be using it`);
      return;
    }

    const unusedMcpPort = await reserveRandomPort();
    const tempEnv = createTempEnv();
    const controlPort = await reserveRandomPort();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(controlPort),
    };

    try {
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
      const mcpPortDir = path.join(tempEnv.homeDir, ".tamandua");
      fs.mkdirSync(mcpPortDir, { recursive: true });
      fs.writeFileSync(path.join(mcpPortDir, "mcp-port"), String(unusedMcpPort), "utf-8");

      // Verify MCP is no longer running
      const mcpStatusAfter = await runCliOnce(["mcp", "status"], cliEnv);
      assert.match(mcpStatusAfter.stdout, /MCP server is not running/);
    } finally {
      await runCliOnce(["mcp", "stop"], cliEnv);
      fs.rmSync(tempEnv.root, { recursive: true, force: true });
    }
  });
});
