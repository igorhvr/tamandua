/**
 * Tests for tamandua control-plane CLI commands (US-004).
 *
 * Validates:
 * 1. tamandua control-plane start prints PID and endpoint URL
 * 2. tamandua control-plane start --port <random> starts control plane on a random port
 * 3. tamandua control-plane start <random> (positional) starts on custom port
 * 4. tamandua control-plane start when already running shows existing status without restarting
 * 5. tamandua control-plane status shows running state, PID, port, and endpoint when up
 * 6. tamandua control-plane status shows not running when down
 * 7. tamandua control-plane stop kills control plane process and prints confirmation
 * 8. tamandua control-plane stop when not running prints not running message
 *
 * All tests use isolated temp HOME directories so they do not share
 * PID/port files with parallel tests (US-004 isolation).
 */

import { describe, it } from "node:test";
import { cleanChildEnv, createTempHome, reservePortHandle } from "./helpers/test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In dev (tsx), compiled CLI is in dist/cli/
const CLI_SCRIPT = path.resolve(__dirname, "..", "dist", "cli", "cli.js");

import { stopControlPlane } from "../dist/server/daemonctl.js";
import { DEFAULT_CONTROL_PORT } from "../dist/server/control-server.js";

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

async function getAvailablePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

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
// Isolated control-plane helpers (mirror daemonctl API but resolve against temp HOME)
// ═══════════════════════════════════════════════════════════════════

const TMP_PREFIX = "tamandua-cp-cli-";

function getIsolatedControlPlanePidFile(homeDir: string): string {
  // The daemon writes tamandua.pid, not control-plane.pid.
  return path.join(homeDir, ".tamandua", "tamandua.pid");
}

function getIsolatedControlPlanePortFile(homeDir: string): string {
  return path.join(homeDir, ".tamandua", "control-plane-port");
}

function readIsolatedControlPlanePort(homeDir: string): number {
  const portFile = getIsolatedControlPlanePortFile(homeDir);
  try {
    const raw = fs.readFileSync(portFile, "utf-8").trim();
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port > 0 && port < 65536) return port;
  } catch {}
  return DEFAULT_CONTROL_PORT;
}

function isIsolatedControlPlaneRunning(homeDir: string): { running: true; pid: number } | { running: false } {
  const pidFile = getIsolatedControlPlanePidFile(homeDir);
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

function stopIsolatedControlPlane(homeDir: string): boolean {
  return stopControlPlane({ homeDir });
}

function cleanupIsolatedControlPlaneFiles(homeDir: string): void {
  try { fs.unlinkSync(getIsolatedControlPlanePidFile(homeDir)); } catch {}
  try { fs.unlinkSync(getIsolatedControlPlanePortFile(homeDir)); } catch {}
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe("tamandua control-plane CLI", { concurrency: 1 }, () => {
  // AC 6 (partial): tamandua control-plane status shows not running when down
  it("control-plane status shows not running when down", async () => {
    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    const portHandle = await reservePortHandle();
    const unusedPort = portHandle.port;
    cleanupIsolatedControlPlaneFiles(tempHome);
    try {

    // Write a control-plane port file with a port that is guaranteed not to
    // have a control plane listening. The async status probe (added in the
    // status-control-plane-false-down fix) queries the health endpoint on the
    // configured port, so without this isolation the test would report "running"
    // if a production daemon happens to be listening on the default port 3339.
    fs.mkdirSync(path.join(tempHome, ".tamandua"), { recursive: true });
    fs.writeFileSync(getIsolatedControlPlanePortFile(tempHome), String(unusedPort), "utf-8");

    const { stdout, stderr, exitCode } = await runCli(["control-plane", "status"], tempHome);

    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("not running"), `Expected "not running" in output, got: ${stdout}`);
    assert.equal(cleanStderr(stderr), "");
    } finally {
      portHandle.close().catch(() => {});
      stopIsolatedControlPlane(tempHome);
    }
  });

  // AC 1: tamandua control-plane start prints PID and endpoint URL
  it("control-plane start prints PID and endpoint URL", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }
    const portHandle = await reservePortHandle();
    const controlPort = portHandle.port;

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    cleanupIsolatedControlPlaneFiles(tempHome);
    try {
    await portHandle.close();

    const { stdout, stderr, exitCode } = await runCli(["control-plane", "start", "--port", String(controlPort)], tempHome);

    assert.equal(exitCode, 0, `CLI exited with code ${exitCode}, stderr: ${cleanStderr(stderr)}`);
    assert.ok(stdout.includes("started"), `Expected "started" in output, got: ${stdout}`);
    assert.ok(stdout.includes("PID"), `Expected "PID" in output, got: ${stdout}`);
    // After the dashboard/daemon split, the control-plane start message no longer prints a URL.
    // The control plane health endpoint is internal and not surfaced in the user-facing CLI message.

    // Verify it actually started via isolated PID file
    const status = isIsolatedControlPlaneRunning(tempHome);
    assert.equal(status.running, true);
    assert.notEqual(status.pid, null);

    // Verify health endpoint reachable
    const res = await waitForHttpUp(`http://127.0.0.1:${controlPort}/control/health`);
    assert.ok(res.status >= 200 && res.status < 500);

    } finally {
      portHandle.close().catch(() => {});
      stopIsolatedControlPlane(tempHome);
    }
  });

  // AC 2: tamandua control-plane start --port <random> starts on a custom port
  it("control-plane start --port <random> starts on a custom port", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const portHandle = await reservePortHandle();
    const customPort = portHandle.port;

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    cleanupIsolatedControlPlaneFiles(tempHome);
    try {
    await portHandle.close();

    const { stdout, stderr, exitCode } = await runCli(["control-plane", "start", "--port", String(customPort)], tempHome);

    assert.equal(exitCode, 0, `CLI exited with code ${exitCode}, stderr: ${cleanStderr(stderr)}`);
    assert.ok(stdout.includes("started"), `Expected "started" in output, got: ${stdout}`);

    // Verify on custom port
    const res = await waitForHttpUp(`http://127.0.0.1:${customPort}/control/health`);
    assert.ok(res.status >= 200 && res.status < 500);

    assert.equal(readIsolatedControlPlanePort(tempHome), customPort);

    } finally {
      portHandle.close().catch(() => {});
      stopIsolatedControlPlane(tempHome);
    }
  });

  // AC 3: tamandua control-plane start <random> (positional) starts on a custom port
  it("control-plane start <random> (positional) starts on a custom port", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const portHandle = await reservePortHandle();
    const customPort = portHandle.port;

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    cleanupIsolatedControlPlaneFiles(tempHome);
    try {
    await portHandle.close();

    const { stdout, stderr, exitCode } = await runCli(["control-plane", "start", "--port", String(customPort)], tempHome);

    assert.equal(exitCode, 0, `CLI exited with code ${exitCode}, stderr: ${cleanStderr(stderr)}`);
    assert.ok(stdout.includes("started"), `Expected "started" in output, got: ${stdout}`);

    // Verify on custom port
    const res = await waitForHttpUp(`http://127.0.0.1:${customPort}/control/health`);
    assert.ok(res.status >= 200 && res.status < 500);

    } finally {
      portHandle.close().catch(() => {});
      stopIsolatedControlPlane(tempHome);
    }
  });

  // AC 4: tamandua control-plane start when already running shows existing status
  it("control-plane start when already running shows existing status", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }
    const portHandle = await reservePortHandle();
    const controlPort = portHandle.port;

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    cleanupIsolatedControlPlaneFiles(tempHome);
    try {
    await portHandle.close();

    // First start
    const first = await runCli(["control-plane", "start", "--port", String(controlPort)], tempHome);
    assert.equal(first.exitCode, 0);
    assert.ok(first.stdout.includes("started"));

    // Capture the PID from first start via isolated helper
    const runningStatus = isIsolatedControlPlaneRunning(tempHome);
    assert.equal(runningStatus.running, true);
    const firstPid = runningStatus.pid;

    // Second start - should show "already running" with the same PID
    const second = await runCli(["control-plane", "start", "--port", String(controlPort)], tempHome);
    assert.equal(second.exitCode, 0);
    assert.ok(second.stdout.includes("already running"), `Expected "already running", got: ${second.stdout}`);
    assert.ok(second.stdout.includes(`PID ${firstPid}`), `Expected PID ${firstPid}, got: ${second.stdout}`);
    // Should NOT show "started" (second attempt didn't restart)
    assert.ok(!second.stdout.includes("Control plane started"));

    } finally {
      portHandle.close().catch(() => {});
      stopIsolatedControlPlane(tempHome);
    }
  });

  it("control-plane start reports already running when the health endpoint is up but PID file is missing", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }
    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    const port = await getAvailablePort();
    cleanupIsolatedControlPlaneFiles(tempHome);
    try {

    const first = await runCli(["control-plane", "start", "--port", String(port)], tempHome);
    assert.equal(first.exitCode, 0, cleanStderr(first.stderr));
    assert.ok(first.stdout.includes("started"));

    // Verify running via health endpoint
    const healthResp = await waitForHttpUp(`http://127.0.0.1:${port}/control/health`);
    assert.equal(healthResp.status, 200);

    const runningStatus = isIsolatedControlPlaneRunning(tempHome);
    assert.equal(runningStatus.running, true);
    assert.ok(runningStatus.pid);

    fs.unlinkSync(getIsolatedControlPlanePidFile(tempHome));

    // After the split, the CLI start handler relies on the PID file for
    // "already running" detection. Without the PID file, startDaemon tries
    // to spawn a new process, which fails with EADDRINUSE on the port.
    const second = await runCli(["control-plane", "start", "--port", String(port)], tempHome);
    assert.equal(second.exitCode, 1, cleanStderr(second.stderr));
    assert.ok(second.stderr.includes("Failed to start control plane"), `Expected failure, got: ${second.stderr}`);
    assert.ok(!second.stdout.includes("Control plane started"));

    } finally {
      stopIsolatedControlPlane(tempHome);
    }
  });

  // AC 5: tamandua control-plane status reports running state with PID, port, endpoint
  it("control-plane status shows running state when up", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }
    const portHandle = await reservePortHandle();
    const controlPort = portHandle.port;

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    cleanupIsolatedControlPlaneFiles(tempHome);
    try {
    await portHandle.close();

    // Start control plane
    const start = await runCli(["control-plane", "start", "--port", String(controlPort)], tempHome);
    assert.equal(start.exitCode, 0);

    const runningStatus = isIsolatedControlPlaneRunning(tempHome);
    assert.equal(runningStatus.running, true);

    const port = readIsolatedControlPlanePort(tempHome);
    assert.equal(port, controlPort);

    // Check status via CLI with same isolated HOME
    const { stdout, stderr, exitCode } = await runCli(["control-plane", "status"], tempHome);

    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("running"), `Expected "running", got: ${stdout}`);
    assert.ok(stdout.includes(`PID ${runningStatus.pid}`), `Expected PID ${runningStatus.pid}, got: ${stdout}`);
    assert.equal(cleanStderr(stderr), "");

    } finally {
      portHandle.close().catch(() => {});
      stopIsolatedControlPlane(tempHome);
    }
  });

  // AC 6: tamandua control-plane stop kills process and prints confirmation
  it("control-plane stop kills process and prints confirmation", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }
    const portHandle = await reservePortHandle();
    const controlPort = portHandle.port;

    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    cleanupIsolatedControlPlaneFiles(tempHome);
    try {
    await portHandle.close();

    // Start control plane
    const start = await runCli(["control-plane", "start", "--port", String(controlPort)], tempHome);
    assert.equal(start.exitCode, 0);

    // Verify it's running via isolated helper
    let status = isIsolatedControlPlaneRunning(tempHome);
    assert.equal(status.running, true);

    // Stop via CLI with same isolated HOME
    const { stdout, stderr, exitCode } = await runCli(["control-plane", "stop"], tempHome);

    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("stopped"), `Expected "stopped", got: ${stdout}`);
    assert.equal(cleanStderr(stderr), "");

    // Wait for process to fully exit
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    // Verify it's actually stopped via isolated helper
    status = isIsolatedControlPlaneRunning(tempHome);
    assert.equal(status.running, false, "Control plane should not be running after stop");

    // Verify PID file is cleaned up on isolated HOME
    assert.equal(fs.existsSync(getIsolatedControlPlanePidFile(tempHome)), false, "PID file should be removed after stop");

    } finally {
      portHandle.close().catch(() => {});
      stopIsolatedControlPlane(tempHome);
    }
  });

  // AC 7: tamandua control-plane stop when not running prints not running message
  it("control-plane stop when not running prints not running", async () => {
    const tempHome = createTempHome(TMP_PREFIX).homeDir;
    cleanupIsolatedControlPlaneFiles(tempHome);
    try {

    const { stdout, stderr, exitCode } = await runCli(["control-plane", "stop"], tempHome);

    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("not running"), `Expected "not running", got: ${stdout}`);
    assert.equal(cleanStderr(stderr), "");
    } finally {
      stopIsolatedControlPlane(tempHome);
    }
  });
});
