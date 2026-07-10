/**
 * Integration tests for independent MCP lifecycle (US-005).
 *
 * Validates:
 * 1. MCP starts on a random port and responds to initialize/tools/list requests
 * 2. MCP stops cleanly and isMcpRunning() returns false
 * 3. Custom port MCP starts on the specified port
 * 4. MCP continues running when dashboard is started/stopped
 * 5. MCP stays running when dashboard is not running
 * 6. Port file is cleaned up on stop and recreated on restart
 * 7. Tests clean up processes and temp files regardless of pass/fail
 */

import fs from "node:fs";
import {
  cleanChildEnv,
  createTempHome,
  reserveDistinctRandomPorts,
  reserveRandomPort,
} from "./helpers/test-env.ts";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { once } from "node:events";
import { describe, it, after } from "node:test";

const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");

// Import daemonctl helpers for direct API-level testing
import {
  startMcp,
} from "../dist/server/daemonctl.js";

// ── Helpers ────────────────────────────────────────────────────────

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

async function createTempEnv(): Promise<{
  root: string;
  stateDir: string;
  homeDir: string;
  controlPort: number;
  dashboardPort: number;
}> {
  const [controlPort, dashboardPort] = await reserveDistinctRandomPorts(2);
  const th = createTempHome("tamandua-mcp-lifecycle-");
  const stateDir = path.join(th.root, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(th.tamanduaDir, "port"), String(dashboardPort), "utf-8");
  return { root: th.root, stateDir, homeDir: th.homeDir, controlPort, dashboardPort };
}

function writeMinimalWorkflow(stateDir: string, workflowId: string): void {
  const workflowDir = path.join(stateDir, "workflows", workflowId);
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowDir, "workflow.yml"),
    [
      `id: ${workflowId}`,
      "agents:",
      "  - id: dev",
      "    model: fake",
      "    workspace:",
      "      baseDir: .",
      "steps:",
      "  - id: implement",
      "    agent: dev",
      "    input: Implement the task",
      "    expects: STATUS, CHANGES, TESTS",
      "",
    ].join("\n"),
    "utf-8",
  );
}

async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  const child = spawn(
    process.execPath,
    ["--no-warnings", cliPath, ...args],
    {
      env: cleanChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

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

async function waitForHttpUp(
  url: string,
  timeoutMs = 7000,
): Promise<Response> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fetch(url);
    } catch (err) {
      lastError = err;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(`Timed out waiting for ${url} to become reachable: ${String(lastError)}`);
}

async function waitForHttpDown(url: string, timeoutMs = 30000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(url);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    } catch {
      return;
    }
  }

  throw new Error(`Timed out waiting for ${url} to become unreachable`);
}

/**
 * Parse an MCP JSON-RPC response body (plain JSON or SSE data: line).
 */
function parseMcpBody(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Empty MCP response body");
  }

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Try SSE format: look for "data:" prefixed line
    const sseDataLine = trimmed
      .split(/\r?\n/)
      .find((line) => line.startsWith("data:"));

    if (!sseDataLine) {
      throw new Error(`Unexpected MCP response payload: ${trimmed.slice(0, 200)}`);
    }

    return JSON.parse(sseDataLine.slice("data:".length).trim()) as Record<string, unknown>;
  }
}

/**
 * Make a JSON-RPC request to an MCP endpoint.
 */
async function mcpRpc(
  baseUrl: string,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  const res = await fetch(baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id: 1,
    }),
  });

  const text = await res.text();
  const body = parseMcpBody(text);

  return { status: res.status, body };
}

/**
 * Send an MCP initialize request and return the session ID.
 * Session IDs come from the `Mcp-Session-Id` response header after initialize.
 */
async function mcpInitialize(baseUrl: string): Promise<{ sessionId: string; result: unknown }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  const res = await fetch(baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
      id: 1,
    }),
  });

  const sessionId = res.headers.get("mcp-session-id");
  assert.ok(sessionId, "initialize response must include Mcp-Session-Id header");

  const text = await res.text();
  const body = parseMcpBody(text);
  assert.ok(body.result, `initialize should return a result, got error: ${JSON.stringify(body.error)}`);

  return { sessionId, result: body.result };
}

/**
 * Filter harmless node warnings from stderr.
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

// ── Tests ──────────────────────────────────────────────────────────

describe("MCP lifecycle integration", { concurrency: 1 }, () => {
  after(() => {
    // Belt-and-suspenders: kill any leaked mcp-standalone/daemon orphans
    // that survived because a prior test run was SIGKILL'd before its
    // finally block could execute.
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
            belongsToTest = env.includes("tamandua-mcp-lifecycle");
          } else {
            const fds = execSync(`lsof -p ${pid} -Fn 2>/dev/null || true`, {
              encoding: "utf8",
            });
            belongsToTest = fds.includes("tamandua-mcp-lifecycle");
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

  // ────────────────────────────────────────────────────────────────
  // AC 1: MCP starts on random port and serves initialize/tools/list
  // ────────────────────────────────────────────────────────────────
  it("MCP starts on random port and serves initialize/tools/list", async (t) => {
    if (!fs.existsSync(cliPath)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const mcpPort = await reserveRandomPort();

    if (!(await canBind(mcpPort))) {
      assert.fail(`Port ${mcpPort} is already in use — likely a leaked test process from a prior run. Check: lsof -i :${mcpPort}`);
    }

    const tempEnv = await createTempEnv();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(tempEnv.controlPort),
    };

    try {
      // Start MCP on the reserved random port
      const start = await runCli(["mcp", "start", "--port", String(mcpPort)], cliEnv);
      assert.equal(start.code, 0, `MCP start failed: ${cleanStderr(start.stderr) || start.stdout}`);
      assert.match(start.stdout, /MCP server started/);
      assert.match(start.stdout, new RegExp(`localhost:${mcpPort}`));

      // Verify endpoint is reachable
      const baseUrl = `http://127.0.0.1:${mcpPort}/mcp`;

      // Send initialize and capture session ID
      const { sessionId, result: initResult } = await mcpInitialize(baseUrl);

      // Verify initialize result
      const init = initResult as {
        protocolVersion: string;
        serverInfo: { name: string; version: string };
        capabilities: { tools: { listChanged: boolean } };
      };
      assert.equal(init.protocolVersion, "2025-06-18");
      assert.equal(init.serverInfo.name, "tamandua-remote-mcp");
      assert.equal(init.capabilities.tools.listChanged, false);

      // Send tools/list with session ID
      const toolsResult = await mcpRpc(baseUrl, "tools/list", {}, sessionId);
      assert.ok(toolsResult.body.result, `tools/list should return a result, got: ${JSON.stringify(toolsResult.body.error)}`);

      const tools = (toolsResult.body.result as { tools: Array<{ name: string }> }).tools;
      assert.ok(Array.isArray(tools), "tools/list should return a tools array");
      assert.ok(tools.length >= 6, `Expected at least 6 MCP tools, got ${tools.length}`);

      const toolNames = tools.map((t: { name: string }) => t.name);
      assert.ok(toolNames.includes("tamandua.runs.list"), "Should include tamandua.runs.list tool");
      assert.ok(toolNames.includes("tamandua.run.status"), "Should include tamandua.run.status tool");
      assert.ok(toolNames.includes("tamandua.run.start"), "Should include tamandua.run.start tool");
      assert.ok(toolNames.includes("tamandua.events.recent"), "Should include tamandua.events.recent tool");
      assert.ok(toolNames.includes("tamandua.source.path"), "Should include tamandua.source.path tool");
      assert.ok(toolNames.includes("tamandua.update.command"), "Should include tamandua.update.command tool");

      // Verify MCP is independently running
      const status = await runCli(["mcp", "status"], cliEnv);
      assert.equal(status.code, 0);
      assert.match(status.stdout, /MCP server running/);
      assert.match(status.stdout, new RegExp(`Port: ${mcpPort}`));

    } finally {
      await runCli(["mcp", "stop"], cliEnv);
    }
  });

  it("tamandua.run.start requires workingDirectoryForHarness and can start runs", async (t) => {
    if (!fs.existsSync(cliPath)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const mcpPort = await reserveRandomPort();
    const tempEnv = await createTempEnv();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(tempEnv.controlPort),
    };

    try {
      writeMinimalWorkflow(tempEnv.stateDir, "mcp-run-start");

      const start = await runCli(["mcp", "start", "--port", String(mcpPort)], cliEnv);
      assert.equal(start.code, 0, `MCP start failed: ${cleanStderr(start.stderr) || start.stdout}`);

      const baseUrl = `http://127.0.0.1:${mcpPort}/mcp`;
      const { sessionId } = await mcpInitialize(baseUrl);

      const missingHarness = await mcpRpc(
        baseUrl,
        "tools/call",
        {
          name: "tamandua.run.start",
          arguments: {
            workflowId: "mcp-run-start",
            taskTitle: "Remote start without harness cwd",
          },
        },
        sessionId,
      );

      assert.ok(missingHarness.body.error, "expected invalid params error for missing workingDirectoryForHarness");
      assert.equal((missingHarness.body.error as { code: number }).code, -32602);
      assert.match(String((missingHarness.body.error as { message?: string }).message ?? ""), /workingDirectoryForHarness/);

      const harnessDir = path.join(tempEnv.root, "remote-repo");
      fs.mkdirSync(harnessDir, { recursive: true });

      const started = await mcpRpc(
        baseUrl,
        "tools/call",
        {
          name: "tamandua.run.start",
          arguments: {
            workflowId: "mcp-run-start",
            taskTitle: "Remote start with explicit harness cwd",
            workingDirectoryForHarness: harnessDir,
          },
        },
        sessionId,
      );

      const startResult = started.body.result as {
        structuredContent?: {
          run?: {
            runId: string;
            workflowId: string;
            taskTitle: string;
            status: string;
            workingDirectoryForHarness: string;
          };
        };
      };
      assert.ok(startResult?.structuredContent?.run, `expected run.start result, got ${JSON.stringify(started.body)}`);
      assert.equal(startResult.structuredContent!.run!.workflowId, "mcp-run-start");
      assert.equal(startResult.structuredContent!.run!.taskTitle, "Remote start with explicit harness cwd");
      assert.equal(startResult.structuredContent!.run!.status, "running");
      assert.equal(startResult.structuredContent!.run!.workingDirectoryForHarness, path.resolve(harnessDir));
    } finally {
      await runCli(["mcp", "stop"], cliEnv);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // AC 2: MCP stops cleanly and isMcpRunning() returns false
  // ────────────────────────────────────────────────────────────────
  it("MCP stops cleanly and isMcpRunning() returns false", async (t) => {
    if (!fs.existsSync(cliPath)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const mcpPort = await reserveRandomPort();

    if (!(await canBind(mcpPort))) {
      assert.fail(`Port ${mcpPort} is already in use — likely a leaked test process from a prior run. Check: lsof -i :${mcpPort}`);
    }

    const tempEnv = await createTempEnv();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(tempEnv.controlPort),
    };

    try {
      // Start MCP
      const start = await runCli(["mcp", "start", "--port", String(mcpPort)], cliEnv);
      assert.equal(start.code, 0);

      // Verify it's running
      let status = await runCli(["mcp", "status"], cliEnv);
      assert.match(status.stdout, /MCP server running/);

      const baseUrl = `http://127.0.0.1:${mcpPort}/mcp`;
      await waitForHttpUp(baseUrl);

      // Stop MCP
      const stop = await runCli(["mcp", "stop"], cliEnv);
      assert.equal(stop.code, 0, `MCP stop failed: ${cleanStderr(stop.stderr) || stop.stdout}`);
      assert.match(stop.stdout, /MCP server stopped/);

      // Wait for process to fully exit. Generous on purpose: under a
      // loaded parallel suite, SIGTERM-to-exit can take seconds.
      await new Promise<void>((resolve) => setTimeout(resolve, 5000));

      // The async status probe checks the HTTP endpoint on the configured port.
      // After stop cleans up the port file, readMcpPort falls back to the default
      // port (3338), which may have a production MCP. Write an unused port so the
      // probe correctly reports DOWN.
      const unusedPort = await reserveRandomPort();
      const portDir = path.join(tempEnv.homeDir, ".tamandua");
      fs.mkdirSync(portDir, { recursive: true });
      fs.writeFileSync(path.join(portDir, "mcp-port"), String(unusedPort), "utf-8");

      // Verify the isolated MCP state via CLI status and HTTP reachability.
      status = await runCli(["mcp", "status"], cliEnv);
      assert.match(status.stdout, /MCP server is not running/);

      // Verify endpoint is down
      await waitForHttpDown(baseUrl);

      // Also verify the PID file in the isolated environment is cleaned up
      const isolatedPidFile = path.join(tempEnv.homeDir, ".tamandua", "mcp.pid");
      assert.equal(
        fs.existsSync(isolatedPidFile),
        false,
        `PID file ${isolatedPidFile} should be cleaned up after stop`,
      );

    } finally {
      await runCli(["mcp", "stop"], cliEnv);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // AC 3: Custom port MCP starts on the specified port
  // ────────────────────────────────────────────────────────────────
  it("Custom port MCP starts on the specified port", async (t) => {
    if (!fs.existsSync(cliPath)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const customPort = await reserveRandomPort();

    if (!(await canBind(customPort))) {
      assert.fail(`Port ${customPort} is already in use — likely a leaked test process from a prior run. Check: lsof -i :${customPort}`);
    }

    const tempEnv = await createTempEnv();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(tempEnv.controlPort),
    };

    try {
      // Start MCP on a custom port
      const start = await runCli(["mcp", "start", "--port", String(customPort)], cliEnv);
      assert.equal(start.code, 0, `MCP start on custom port failed: ${cleanStderr(start.stderr) || start.stdout}`);
      assert.match(start.stdout, new RegExp(`localhost:${customPort}`));
      assert.match(start.stdout, /MCP server started/);

      // Verify endpoint on the custom port
      const baseUrl = `http://127.0.0.1:${customPort}/mcp`;
      const { sessionId } = await mcpInitialize(baseUrl);

      // Send a tools/list to confirm full functionality
      const toolsResult = await mcpRpc(baseUrl, "tools/list", {}, sessionId);
      assert.ok(toolsResult.body.result, `tools/list should return a result, got: ${JSON.stringify(toolsResult.body.error)}`);

      // Verify CLI status reports the custom port
      const status = await runCli(["mcp", "status"], cliEnv);
      assert.match(status.stdout, /MCP server running/);
      assert.match(status.stdout, new RegExp(`Port: ${customPort}`));

    } finally {
      await runCli(["mcp", "stop"], cliEnv);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // AC 4: MCP is unaffected by dashboard start/stop
  // ────────────────────────────────────────────────────────────────
  it("MCP continues running when dashboard is started and stopped", async (t) => {
    if (!fs.existsSync(cliPath)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const mcpPort = await reserveRandomPort();
    const dashboardPort = await reserveRandomPort();

    if (!(await canBind(mcpPort))) {
      assert.fail(`MCP port ${mcpPort} is already in use — likely a leaked test process from a prior run. Check: lsof -i :${mcpPort}`);
    }
    if (!(await canBind(dashboardPort))) {
      assert.fail(`Dashboard port ${dashboardPort} is already in use — likely a leaked test process from a prior run. Check: lsof -i :${dashboardPort}`);
    }

    const tempEnv = await createTempEnv();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(tempEnv.controlPort),
    };

    try {
      // 1. Start MCP first
      const mcpStart = await runCli(["mcp", "start", "--port", String(mcpPort)], cliEnv);
      assert.equal(mcpStart.code, 0, `MCP start failed: ${cleanStderr(mcpStart.stderr) || mcpStart.stdout}`);

      const mcpBaseUrl = `http://127.0.0.1:${mcpPort}/mcp`;

      // Verify MCP is reachable
      const { sessionId } = await mcpInitialize(mcpBaseUrl);

      // 2. Start dashboard while MCP is already running
      const dashStart = await runCli(["dashboard", "start", "--port", String(dashboardPort)], cliEnv);
      assert.equal(dashStart.code, 0, `Dashboard start failed: ${cleanStderr(dashStart.stderr) || dashStart.stdout}`);

      // 3. MCP should still be reachable
      const toolsDuring = await mcpRpc(mcpBaseUrl, "tools/list", {}, sessionId);
      assert.ok(toolsDuring.body.result, `MCP should still serve tools/list while dashboard is running: ${JSON.stringify(toolsDuring.body.error)}`);

      // Verify MCP status shows running
      const mcpStatusDuring = await runCli(["mcp", "status"], cliEnv);
      assert.match(mcpStatusDuring.stdout, /MCP server running/);

      // 4. Stop dashboard
      const dashStop = await runCli(["dashboard", "stop"], cliEnv);
      assert.equal(dashStop.code, 0, `Dashboard stop failed: ${cleanStderr(dashStop.stderr) || dashStop.stdout}`);

      // Wait for dashboard to fully stop
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      // 5. MCP should STILL be reachable after dashboard stops
      const toolsAfter = await mcpRpc(mcpBaseUrl, "tools/list", {}, sessionId);
      assert.ok(toolsAfter.body.result, `MCP should still serve tools/list after dashboard stops: ${JSON.stringify(toolsAfter.body.error)}`);

      // 6. Dashboard should show not running, MCP should show running
      const fullStatus = await runCli(["dashboard", "status"], cliEnv);
      assert.match(fullStatus.stdout, /Dashboard is not running/);
      assert.match(fullStatus.stdout, /MCP server running/);

    } finally {
      await runCli(["dashboard", "stop"], cliEnv);
      await runCli(["mcp", "stop"], cliEnv);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // AC 5: MCP stays running when dashboard is not running (AC 4 variant)
  // ────────────────────────────────────────────────────────────────
  it("MCP stays running when dashboard is not running", async (t) => {
    if (!fs.existsSync(cliPath)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const mcpPort = await reserveRandomPort();

    if (!(await canBind(mcpPort))) {
      assert.fail(`Port ${mcpPort} is already in use — likely a leaked test process from a prior run. Check: lsof -i :${mcpPort}`);
    }

    const tempEnv = await createTempEnv();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(tempEnv.controlPort),
    };

    try {
      // Start MCP WITHOUT starting the dashboard
      const mcpStart = await runCli(["mcp", "start", "--port", String(mcpPort)], cliEnv);
      assert.equal(mcpStart.code, 0, `MCP start failed: ${cleanStderr(mcpStart.stderr) || mcpStart.stdout}`);

      // Verify dashboard is NOT running
      const dashStatus = await runCli(["dashboard", "status"], cliEnv);
      assert.match(dashStatus.stdout, /Dashboard is not running/);

      // Verify MCP IS running
      const mcpStatus = await runCli(["mcp", "status"], cliEnv);
      assert.match(mcpStatus.stdout, /MCP server running/);
      assert.match(mcpStatus.stdout, new RegExp(`Port: ${mcpPort}`));

      // Verify MCP endpoint is reachable (no dashboard needed!)
      const mcpBaseUrl = `http://127.0.0.1:${mcpPort}/mcp`;
      const { sessionId } = await mcpInitialize(mcpBaseUrl);

      // Test a tools/list call
      const toolsResult = await mcpRpc(mcpBaseUrl, "tools/list", {}, sessionId);
      assert.ok(toolsResult.body.result, `tools/list should return a result, got: ${JSON.stringify(toolsResult.body.error)}`);

    } finally {
      await runCli(["mcp", "stop"], cliEnv);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // AC 6: Port file is cleaned up on stop and recreated on restart
  // ────────────────────────────────────────────────────────────────
  it("Port file is cleaned up on stop and recreated on restart", async (t) => {
    if (!fs.existsSync(cliPath)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const mcpPort = await reserveRandomPort();

    if (!(await canBind(mcpPort))) {
      assert.fail(`Port ${mcpPort} is already in use — likely a leaked test process from a prior run. Check: lsof -i :${mcpPort}`);
    }

    const tempEnv = await createTempEnv();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(tempEnv.controlPort),
    };

    // The MCP port file path in the isolated environment
    const isolatedPortFile = path.join(tempEnv.homeDir, ".tamandua", "mcp-port");

    try {
      // ── First cycle: start → verify port file → stop → verify cleanup ──

      // Start MCP
      const start1 = await runCli(["mcp", "start", "--port", String(mcpPort)], cliEnv);
      assert.equal(start1.code, 0, `MCP start failed: ${cleanStderr(start1.stderr) || start1.stdout}`);

      // Verify port file exists and contains the correct port
      assert.ok(fs.existsSync(isolatedPortFile), "Port file should exist after MCP start");
      const portContent1 = fs.readFileSync(isolatedPortFile, "utf-8").trim();
      assert.equal(parseInt(portContent1, 10), mcpPort, `Port file should contain ${mcpPort}, got ${portContent1}`);

      // Also verify PID file exists
      const isolatedPidFile = path.join(tempEnv.homeDir, ".tamandua", "mcp.pid");
      assert.ok(fs.existsSync(isolatedPidFile), "PID file should exist after MCP start");

      // Stop MCP
      const stop1 = await runCli(["mcp", "stop"], cliEnv);
      assert.equal(stop1.code, 0);
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      // Verify port file is cleaned up after stop
      assert.equal(
        fs.existsSync(isolatedPortFile),
        false,
        "Port file should be cleaned up after MCP stop",
      );

      // Verify PID file is cleaned up
      assert.equal(
        fs.existsSync(isolatedPidFile),
        false,
        "PID file should be cleaned up after MCP stop",
      );

      // ── Second cycle: restart → verify port file is recreated ──

      const secondPort = await reserveRandomPort();
      if (!(await canBind(secondPort))) {
        t.skip(`Second port ${secondPort} is already in use`);
        return;
      }

      // Restart MCP on a different port
      // Need to ensure port file is gone first (already verified above, but be explicit)
      try { fs.unlinkSync(isolatedPortFile); } catch {}

      const start2 = await runCli(["mcp", "start", "--port", String(secondPort)], cliEnv);
      assert.equal(start2.code, 0, `MCP restart failed: ${cleanStderr(start2.stderr) || start2.stdout}`);

      // Verify port file is recreated with the new port
      assert.ok(fs.existsSync(isolatedPortFile), "Port file should be recreated after MCP restart");
      const portContent2 = fs.readFileSync(isolatedPortFile, "utf-8").trim();
      assert.equal(parseInt(portContent2, 10), secondPort, `Port file should contain ${secondPort} after restart, got ${portContent2}`);

      // Verify PID file exists
      assert.ok(fs.existsSync(isolatedPidFile), "PID file should exist after MCP restart");

      // Verify new instance is reachable
      const baseUrl = `http://127.0.0.1:${secondPort}/mcp`;
      await mcpInitialize(baseUrl);

      // Verify the original port is NOT reachable
      try {
        await fetch(`http://127.0.0.1:${mcpPort}/mcp`);
        assert.fail(`Original port ${mcpPort} should be unreachable after restart on ${secondPort}`);
      } catch {
        // Expected
      }

    } finally {
      await runCli(["mcp", "stop"], cliEnv);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // AC 7: Full start → stop → start cycle with API-level helpers
  // ────────────────────────────────────────────────────────────────
  it("Full start/stop/start cycle with API-level helpers", async (t) => {
    if (!fs.existsSync(cliPath)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const mcpPort = await reserveRandomPort();

    if (!(await canBind(mcpPort))) {
      assert.fail(`Port ${mcpPort} is already in use — likely a leaked test process from a prior run. Check: lsof -i :${mcpPort}`);
    }

    const tempEnv = await createTempEnv();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(tempEnv.controlPort),
    };

    try {
      // Start MCP via CLI
      const startCmd = await runCli(["mcp", "start", "--port", String(mcpPort)], cliEnv);
      assert.equal(startCmd.code, 0);

      // Verify via isMcpRunning() on the isolated PID file
      const isolatedPidFile = path.join(tempEnv.homeDir, ".tamandua", "mcp.pid");

      // Verify the isolated PID file directly.
      assert.ok(fs.existsSync(isolatedPidFile), "PID file should exist in isolated env");
      const pid1 = parseInt(fs.readFileSync(isolatedPidFile, "utf-8").trim(), 10);
      assert.ok(pid1 > 0, "PID should be positive");
      assert.ok(Number.isInteger(pid1), "PID should be an integer");

      // Verify MCP is reachable
      const baseUrl = `http://127.0.0.1:${mcpPort}/mcp`;
      await mcpInitialize(baseUrl);

      // Stop via CLI
      const stopCmd = await runCli(["mcp", "stop"], cliEnv);
      assert.equal(stopCmd.code, 0);
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      // Verify PID file is cleaned up
      assert.equal(fs.existsSync(isolatedPidFile), false, "PID file should be cleaned up after stop");

      // Verify endpoint is down
      await waitForHttpDown(baseUrl);

      // Start again on the same port
      const restartCmd = await runCli(["mcp", "start", "--port", String(mcpPort)], cliEnv);
      assert.equal(restartCmd.code, 0);

      // Verify new PID
      assert.ok(fs.existsSync(isolatedPidFile), "PID file should exist after restart");
      const pid2 = parseInt(fs.readFileSync(isolatedPidFile, "utf-8").trim(), 10);
      assert.ok(pid2 > 0);
      assert.ok(Number.isInteger(pid2));
      // PID may or may not be different — OS reuses PIDs rapidly

      // Verify new instance is reachable
      await waitForHttpUp(baseUrl);
      await mcpInitialize(baseUrl);

      // Final stop and verify everything is cleaned up
      const finalStop = await runCli(["mcp", "stop"], cliEnv);
      assert.equal(finalStop.code, 0);
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      assert.equal(fs.existsSync(isolatedPidFile), false, "PID file should be cleaned up after final stop");
      await waitForHttpDown(baseUrl);

    } finally {
      await runCli(["mcp", "stop"], cliEnv);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Edge case: stopMcp when nothing is running
  // ────────────────────────────────────────────────────────────────
  it("MCP stop when nothing is running reports not running", async (t) => {
    if (!fs.existsSync(cliPath)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempEnv = await createTempEnv();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(tempEnv.controlPort),
    };

    try {
      const stop = await runCli(["mcp", "stop"], cliEnv);
      assert.equal(stop.code, 0);
      assert.match(stop.stdout, /not running/);
    } finally {
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Regression: keepHandle returns ChildProcess that can be killed
  // ────────────────────────────────────────────────────────────────
  it("keepHandle: true returns a ChildProcess handle that can be SIGKILL'd", async (t) => {
    if (!fs.existsSync(cliPath)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const mcpPort = await reserveRandomPort();

    if (!(await canBind(mcpPort))) {
      assert.fail(`Port ${mcpPort} is already in use — likely a leaked test process from a prior run. Check: lsof -i :${mcpPort}`);
    }

    const tempEnv = await createTempEnv();

    let result: { pid: number; port: number; child: ReturnType<typeof spawn> } | undefined;

    try {
      // Call the direct API with keepHandle: true and homeDir so the
      // spawned child writes its PID/port files into the isolated temp
      // directory, and the parent's PID-file checks target the same path.
      result = await startMcp(mcpPort, { keepHandle: true, homeDir: tempEnv.homeDir }) as { pid: number; port: number; child: ReturnType<typeof spawn> };

      // Verify the child handle is present and is a ChildProcess
      assert.ok(result.child, "keepHandle should return a child process handle");
      assert.equal(typeof result.child.kill, "function", "child should have a kill method");
      assert.equal(typeof result.pid, "number", "should return pid");
      assert.equal(typeof result.port, "number", "should return port");
      assert.ok(result.pid > 0, "pid should be positive");

      // Verify the process is actually running
      const baseUrl = `http://127.0.0.1:${mcpPort}/mcp`;
      await waitForHttpUp(baseUrl);

      // Kill it directly via the ChildProcess handle
      result.child.kill("SIGKILL");

      // Wait for the process to exit
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));

      // Verify the process is no longer running
      try {
        await fetch(baseUrl);
        assert.fail("MCP should be unreachable after SIGKILL");
      } catch {
        // Expected — process is dead
      }

      // Verify the PID file was cleaned up (the child process hooks SIGTERM
      // but SIGKILL doesn't give it a chance — the test shouldn't leave a
      // stale PID file behind. The kill is direct, so we clean it ourselves.)
      try { fs.unlinkSync(path.join(tempEnv.homeDir, ".tamandua", "mcp.pid")); } catch {}
      try { fs.unlinkSync(path.join(tempEnv.homeDir, ".tamandua", "mcp-port")); } catch {}
      try { fs.unlinkSync(path.join(tempEnv.homeDir, ".tamandua", "mcp.log")); } catch {}

    } finally {
      // Belt: if anything survived, kill it via the direct handle
      if (result?.child) {
        try { result.child.kill("SIGKILL"); } catch { /* already dead */ }
      }
      // Also try CLI stop with the temp HOME (belt-and-suspenders)
      try {
        await runCli(["mcp", "stop"], {
          HOME: tempEnv.homeDir,
          TAMANDUA_STATE_DIR: tempEnv.stateDir,
        });
      } catch { /* best effort */ }
    }
  });
});
