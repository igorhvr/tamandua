/**
 * Tests for tamandua mcp CLI commands (US-003).
 *
 * Validates:
 * 1. tamandua mcp start prints PID and endpoint URL
 * 2. tamandua mcp start --port <random> starts MCP on a random port
 * 3. tamandua mcp start when already running shows existing status without restarting
 * 4. tamandua mcp status shows running state, PID, port, and endpoint when MCP is up
 * 5. tamandua mcp status shows not running when MCP is down
 * 6. tamandua mcp stop kills MCP process and prints confirmation
 * 7. tamandua mcp stop when not running prints not running message
 *
 * All tests use isolated temp HOME directories so they do not share
 * PID/port files with parallel tests (US-003 isolation).
 */

import { describe, it } from "node:test";
import { cleanChildEnv, createTempHome, reservePortHandle } from "./helpers/test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In dev (tsx), compiled CLI is in dist/cli/
const CLI_SCRIPT = path.resolve(__dirname, "..", "dist", "cli", "cli.js");

import { stopMcp } from "../dist/server/daemonctl.js";
import { DEFAULT_MCP_PORT } from "../dist/server/mcp-server.js";

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

async function waitForHttpUp(url: string, timeoutMs = 7000): Promise<Response> {
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

async function waitForHttpDown(url: string, timeoutMs = 7000): Promise<void> {
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

// ═══════════════════════════════════════════════════════════════════
// Isolated MCP helpers (mirror daemonctl API but resolve against temp HOME)
// ═══════════════════════════════════════════════════════════════════

const TMP_PREFIX = "tamandua-mcp-cli-";

function getIsolatedMcpPidFile(homeDir: string): string {
  return path.join(homeDir, ".tamandua", "mcp.pid");
}

function getIsolatedMcpPortFile(homeDir: string): string {
  return path.join(homeDir, ".tamandua", "mcp-port");
}

function readIsolatedMcpPort(homeDir: string): number {
  const portFile = getIsolatedMcpPortFile(homeDir);
  try {
    const raw = fs.readFileSync(portFile, "utf-8").trim();
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port > 0 && port < 65536) return port;
  } catch {}
  return DEFAULT_MCP_PORT;
}

function isIsolatedMcpRunning(homeDir: string): { running: true; pid: number } | { running: false } {
  const pidFile = getIsolatedMcpPidFile(homeDir);
  if (!fs.existsSync(pidFile)) return { running: false };

  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid)) return { running: false };
  } catch {
    return { running: false };
  }

  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    try { fs.unlinkSync(pidFile); } catch {}
    return { running: false };
  }
}

function stopIsolatedMcp(homeDir: string): boolean {
  return stopMcp({ homeDir });
}

function cleanupIsolatedMcpFiles(homeDir: string): void {
  try { fs.unlinkSync(getIsolatedMcpPidFile(homeDir)); } catch {}
  try { fs.unlinkSync(getIsolatedMcpPortFile(homeDir)); } catch {}
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe("tamandua mcp CLI", { concurrency: 1 }, () => {
  // AC 5: tamandua mcp status shows not running when MCP is down
  it("mcp status shows not running when MCP is down", async () => {
    const portHandle = await reservePortHandle();
    const unusedPort = portHandle.port;
    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    cleanupIsolatedMcpFiles(tempHome);
    try {
    // Write an isolated port file pointing to an unused port so the
    // async status probe doesn't detect a production MCP on the default 3338.
    const tamanduaDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(tamanduaDir, { recursive: true });
    fs.writeFileSync(getIsolatedMcpPortFile(tempHome), String(unusedPort), "utf-8");

    const { stdout, stderr, exitCode } = await runCli(["mcp", "status"], tempHome);

    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("not running"), `Expected "not running" in output, got: ${stdout}`);
    assert.equal(cleanStderr(stderr), "");
    } finally {
      portHandle.close().catch(() => {});
      stopIsolatedMcp(tempHome);
    }
  });

  // AC 1: tamandua mcp start prints PID and endpoint URL
  it("mcp start prints PID and endpoint URL", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const portHandle = await reservePortHandle();
    const mcpPort = portHandle.port;

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    cleanupIsolatedMcpFiles(tempHome);
    try {
    await portHandle.close();

    const { stdout, stderr, exitCode } = await runCli(["mcp", "start", "--port", String(mcpPort)], tempHome);

    assert.equal(exitCode, 0, `CLI exited with code ${exitCode}, stderr: ${cleanStderr(stderr)}`);
    assert.ok(stdout.includes("started"), `Expected "started" in output, got: ${stdout}`);
    assert.ok(stdout.includes("PID"), `Expected "PID" in output, got: ${stdout}`);
    assert.ok(stdout.includes(`localhost:${mcpPort}`), `Expected port ${mcpPort} in output, got: ${stdout}`);
    assert.ok(stdout.includes("/mcp"), `Expected /mcp endpoint in output, got: ${stdout}`);

    // Verify it actually started via isolated PID file
    const status = isIsolatedMcpRunning(tempHome);
    assert.equal(status.running, true);
    assert.notEqual(status.pid, null);

    // Verify endpoint reachable
    const res = await waitForHttpUp(`http://127.0.0.1:${mcpPort}/mcp`);
    assert.ok(res.status >= 200 && res.status < 500);

    } finally {
      portHandle.close().catch(() => {});
      stopIsolatedMcp(tempHome);
    }
  });

  // AC 2: tamandua mcp start --port <random> starts MCP on a random custom port
  it("mcp start --port <random> starts MCP on a custom port", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const portHandle = await reservePortHandle();
    const customPort = portHandle.port;

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    cleanupIsolatedMcpFiles(tempHome);
    try {
    await portHandle.close();

    const { stdout, stderr, exitCode } = await runCli(["mcp", "start", "--port", String(customPort)], tempHome);

    assert.equal(exitCode, 0, `CLI exited with code ${exitCode}, stderr: ${cleanStderr(stderr)}`);
    assert.ok(stdout.includes("started"), `Expected "started" in output, got: ${stdout}`);
    assert.ok(stdout.includes(`localhost:${customPort}`), `Expected port ${customPort} in output, got: ${stdout}`);

    // Verify on custom port
    const res = await waitForHttpUp(`http://127.0.0.1:${customPort}/mcp`);
    assert.ok(res.status >= 200 && res.status < 500);

    assert.equal(readIsolatedMcpPort(tempHome), customPort);

    } finally {
      portHandle.close().catch(() => {});
      stopIsolatedMcp(tempHome);
    }
  });

  // AC 3: tamandua mcp start when already running shows existing status without restarting
  it("mcp start when already running shows existing status", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const portHandle = await reservePortHandle();
    const mcpPort = portHandle.port;

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    cleanupIsolatedMcpFiles(tempHome);
    try {
    await portHandle.close();

    // First start
    const first = await runCli(["mcp", "start", "--port", String(mcpPort)], tempHome);
    assert.equal(first.exitCode, 0);
    assert.ok(first.stdout.includes("started"));

    // Capture the PID from first start via isolated helper
    const runningStatus = isIsolatedMcpRunning(tempHome);
    assert.equal(runningStatus.running, true);
    const firstPid = runningStatus.pid;

    // Second start - should show "already running" with the same PID
    const second = await runCli(["mcp", "start", "--port", String(mcpPort)], tempHome);
    assert.equal(second.exitCode, 0);
    assert.ok(second.stdout.includes("already running"), `Expected "already running", got: ${second.stdout}`);
    assert.ok(second.stdout.includes(`PID ${firstPid}`), `Expected PID ${firstPid}, got: ${second.stdout}`);
    assert.ok(second.stdout.includes(`localhost:${mcpPort}`));
    assert.ok(second.stdout.includes("/mcp"));
    // Should NOT show "started" (second attempt didn't restart)
    assert.ok(!second.stdout.includes("MCP server started"));

    } finally {
      portHandle.close().catch(() => {});
      stopIsolatedMcp(tempHome);
    }
  });

  // AC 4: tamandua mcp status shows running state, PID, port, and endpoint when MCP is up
  it("mcp status shows running state when MCP is up", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const portHandle = await reservePortHandle();
    const mcpPort = portHandle.port;

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    cleanupIsolatedMcpFiles(tempHome);
    try {
    await portHandle.close();

    // Start MCP
    const start = await runCli(["mcp", "start", "--port", String(mcpPort)], tempHome);
    assert.equal(start.exitCode, 0);

    const runningStatus = isIsolatedMcpRunning(tempHome);
    assert.equal(runningStatus.running, true);

    const port = readIsolatedMcpPort(tempHome);
    assert.equal(port, mcpPort);

    // Check status via CLI with same isolated HOME
    const { stdout, stderr, exitCode } = await runCli(["mcp", "status"], tempHome);

    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("running"), `Expected "running", got: ${stdout}`);
    assert.ok(stdout.includes(`PID ${runningStatus.pid}`), `Expected PID ${runningStatus.pid}, got: ${stdout}`);
    assert.ok(stdout.includes(`Port: ${port}`), `Expected Port: ${port}, got: ${stdout}`);
    assert.ok(stdout.includes(`localhost:${port}`), `Expected localhost, got: ${stdout}`);
    assert.ok(stdout.includes("/mcp"), `Expected /mcp endpoint, got: ${stdout}`);
    assert.equal(cleanStderr(stderr), "");

    } finally {
      portHandle.close().catch(() => {});
      stopIsolatedMcp(tempHome);
    }
  });

  // AC 6: tamandua mcp stop kills MCP process and prints confirmation
  it("mcp stop kills MCP process and prints confirmation", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const portHandle = await reservePortHandle();
    const mcpPort = portHandle.port;

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    cleanupIsolatedMcpFiles(tempHome);
    try {
    await portHandle.close();

    // Start MCP
    const start = await runCli(["mcp", "start", "--port", String(mcpPort)], tempHome);
    assert.equal(start.exitCode, 0);

    // Verify it's running via isolated helper
    let status = isIsolatedMcpRunning(tempHome);
    assert.equal(status.running, true);

    // Stop via CLI with same isolated HOME
    const { stdout, stderr, exitCode } = await runCli(["mcp", "stop"], tempHome);

    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("stopped"), `Expected "stopped", got: ${stdout}`);
    assert.equal(cleanStderr(stderr), "");

    // Wait for process to fully exit
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    // Verify it's actually stopped via isolated helper
    status = isIsolatedMcpRunning(tempHome);
    assert.equal(status.running, false, "MCP should not be running after stop");

    // Verify PID file is cleaned up on isolated HOME
    assert.equal(fs.existsSync(getIsolatedMcpPidFile(tempHome)), false, "PID file should be removed after stop");

    } finally {
      portHandle.close().catch(() => {});
      stopIsolatedMcp(tempHome);
    }
  });

  // AC 7: tamandua mcp stop when not running prints not running message
  it("mcp stop when not running prints not running", async () => {
    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    cleanupIsolatedMcpFiles(tempHome);
    try {

    const { stdout, stderr, exitCode } = await runCli(["mcp", "stop"], tempHome);

    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("not running"), `Expected "not running", got: ${stdout}`);
    assert.equal(cleanStderr(stderr), "");
    } finally {
      stopIsolatedMcp(tempHome);
    }
  });

  // Extra: verify --port flag parsing works with various formats using random port
  it("mcp start --port with random custom port parses correctly", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const portHandle = await reservePortHandle();
    const customPort = portHandle.port;

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    cleanupIsolatedMcpFiles(tempHome);
    try {
    await portHandle.close();

    // --port flag placed after the start subcommand
    const { stdout, exitCode } = await runCli(["mcp", "start", "--port", String(customPort)], tempHome);

    assert.equal(exitCode, 0);
    assert.ok(stdout.includes(`localhost:${customPort}`), `Expected port ${customPort} in output, got: ${stdout}`);

    // Verify endpoint
    const res = await waitForHttpUp(`http://127.0.0.1:${customPort}/mcp`);
    assert.ok(res.status >= 200 && res.status < 500);

    } finally {
      portHandle.close().catch(() => {});
      stopIsolatedMcp(tempHome);
    }
  });
});
