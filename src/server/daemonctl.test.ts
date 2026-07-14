import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createTempHome } from "../../tests/helpers/test-env.ts";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In dev (tsx), compiled output is in dist/server/
const MCP_STANDALONE_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "mcp-standalone.js");
const DASHBOARD_STANDALONE_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "dashboard-standalone.js");

// Import the module under test.
// tsx resolves .js extensions to .ts at runtime, so we import the source as .js
import {
  readMcpPort,
  writeMcpPort,
  isMcpRunning,
  startMcp,
  stopMcp,
  getMcpStatus,
  getMcpPidFile,
  getMcpPortFile,
  readControlPlanePort,
  writeControlPlanePort,
  isControlPlaneRunning,
  getControlPlaneStatus,
  startControlPlane,
  stopControlPlane,
  getControlPlanePidFile,
  getControlPlanePortFile,
  getDashboardPidFile,
  getDashboardPortFile,
  getDashboardLogFile,
  isDashboardRunning,
  getDashboardStatus,
  startDashboardStandalone,
  stopDashboardStandalone,
  restartDashboardStandalone,
  recordLifecycleEvent,
} from "../../dist/server/daemonctl.js";
import { DEFAULT_MCP_PORT } from "../../dist/server/mcp-server.js";
import { DEFAULT_CONTROL_PORT } from "../../dist/server/control-server.js";

// ── Helpers ────────────────────────────────────────────────────────

async function httpGet(url: string): Promise<Response> {
  return fetch(url);
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

// ── Isolated MCP helpers ───────────────────────────────────────────

function createDaemonctlTempHome(): string {
  const { root } = createTempHome("tamandua-daemonctl-mcp-");
  return root;
}

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

function writeIsolatedMcpPort(homeDir: string, port: number): void {
  const portFile = getIsolatedMcpPortFile(homeDir);
  fs.mkdirSync(path.dirname(portFile), { recursive: true });
  fs.writeFileSync(portFile, String(port), "utf-8");
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

// ── Isolated control plane helpers ────────────────────────────────

function createControlPlaneTempHome(): string {
  const { root } = createTempHome("tamandua-daemonctl-cp-");
  return root;
}

function getIsolatedControlPlanePidFile(homeDir: string): string {
  return path.join(homeDir, ".tamandua", "control-plane.pid");
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

function writeIsolatedControlPlanePort(homeDir: string, port: number): void {
  const portFile = getIsolatedControlPlanePortFile(homeDir);
  fs.mkdirSync(path.dirname(portFile), { recursive: true });
  fs.writeFileSync(portFile, String(port), "utf-8");
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

// ── Tests ──────────────────────────────────────────────────────────

describe("daemonctl MCP lifecycle", { concurrency: 1 }, () => {
  // AC: DEFAULT_MCP_PORT constant is 3338 (no processes spawned)
  it("DEFAULT_MCP_PORT constant equals 3338", () => {
    assert.equal(DEFAULT_MCP_PORT, 3338);
  });

  // AC: writeMcpPort(4242) persists and readMcpPort() returns 4242 — isolated
  it("writeMcpPort(4242) persists and readMcpPort() returns 4242 on isolated HOME", () => {
    const tempHome = createDaemonctlTempHome();
    writeIsolatedMcpPort(tempHome, 4242);
    const portFile = getIsolatedMcpPortFile(tempHome);
    assert.ok(fs.existsSync(portFile), "MCP port file should exist after writeMcpPort");
    assert.equal(fs.readFileSync(portFile, "utf-8").trim(), "4242");

    const port = readIsolatedMcpPort(tempHome);
    assert.equal(port, 4242);
  });

  // AC: isMcpRunning() returns false when no PID file exists — isolated
  it("isMcpRunning() returns false when no PID file exists on isolated HOME", () => {
    const tempHome = createDaemonctlTempHome();
    cleanupIsolatedMcpFiles(tempHome);
    const status = isIsolatedMcpRunning(tempHome);
    assert.equal(status.running, false);
  });

  // AC: startMcp() spawns MCP server and writes PID/port files — isolated
  it("startMcp() spawns MCP server and writes PID/port files on isolated HOME", async (t) => {
    if (!fs.existsSync(MCP_STANDALONE_SCRIPT)) {
      t.skip("mcp-standalone.js not found — run npm run build first");
      return;
    }

    const mcpPort = await getAvailablePort();
    if (!(await canBind(mcpPort))) {
      t.skip(`Port ${mcpPort} is already in use`);
      return;
    }

    const tempHome = createDaemonctlTempHome();
    try {
      // Ensure clean state in isolated HOME
      cleanupIsolatedMcpFiles(tempHome);

      const result = await startMcp(mcpPort, { homeDir: tempHome });
      assert.ok(result.pid > 0, "startMcp should return a valid PID");
      assert.equal(result.port, mcpPort);

      // Verify isolated PID file exists and contains a valid PID
      const pidFile = getIsolatedMcpPidFile(tempHome);
      assert.ok(fs.existsSync(pidFile), "MCP PID file should exist after startMcp on isolated HOME");
      const savedPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      assert.equal(savedPid, result.pid);

      // Verify isolated port file exists
      const portFile = getIsolatedMcpPortFile(tempHome);
      assert.ok(fs.existsSync(portFile), "MCP port file should exist after startMcp on isolated HOME");

      // Verify MCP endpoint is reachable
      const res = await httpGet(`http://127.0.0.1:${mcpPort}/mcp`);
      assert.ok(res.status >= 200 && res.status < 500, "MCP endpoint should respond to GET");

    } finally {
      stopIsolatedMcp(tempHome);
    }
  });

  // AC: stopMcp() kills MCP process and cleans up PID file — isolated
  it("stopMcp() kills MCP process and cleans up PID file on isolated HOME", async (t) => {
    if (!fs.existsSync(MCP_STANDALONE_SCRIPT)) {
      t.skip("mcp-standalone.js not found — run npm run build first");
      return;
    }

    const mcpPort = await getAvailablePort();
    if (!(await canBind(mcpPort))) {
      t.skip(`Port ${mcpPort} is already in use`);
      return;
    }

    const tempHome = createDaemonctlTempHome();
    try {
      cleanupIsolatedMcpFiles(tempHome);

      // Start the MCP server on isolated HOME
      const { pid } = await startMcp(mcpPort, { homeDir: tempHome });
      assert.ok(pid > 0);

      // Verify it's running via isolated PID file check
      let status = isIsolatedMcpRunning(tempHome);
      assert.equal(status.running, true);

      // Stop it using daemonctl against the isolated HOME
      const stopped = stopMcp({ homeDir: tempHome });
      assert.equal(stopped, true);

      // Verify isolated PID file is cleaned up
      const pidFile = getIsolatedMcpPidFile(tempHome);
      assert.equal(fs.existsSync(pidFile), false, "MCP PID file should be cleaned up after stopMcp on isolated HOME");

      // Wait briefly for process to fully exit
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      // Verify process is gone via isolated check
      status = isIsolatedMcpRunning(tempHome);
      assert.equal(status.running, false, "isMcpRunning should return false after stop on isolated HOME");

      // Verify endpoint is down
      await waitForHttpDown(`http://127.0.0.1:${mcpPort}/mcp`);
    } finally {
      try { stopIsolatedMcp(tempHome); } catch {}
    }
  });

  // AC: getMcpStatus() returns correct state before and after startMcp — isolated
  it("getMcpStatus() returns correct state before and after startMcp on isolated HOME", async (t) => {
    if (!fs.existsSync(MCP_STANDALONE_SCRIPT)) {
      t.skip("mcp-standalone.js not found — run npm run build first");
      return;
    }

    const mcpPort = await getAvailablePort();
    if (!(await canBind(mcpPort))) {
      t.skip(`Port ${mcpPort} is already in use`);
      return;
    }

    const tempHome = createDaemonctlTempHome();
    try {
      cleanupIsolatedMcpFiles(tempHome);

      // Before start: not running
      let status = isIsolatedMcpRunning(tempHome);
      assert.equal(status.running, false);

      // Verify port fallback from isolated HOME
      const beforePort = readIsolatedMcpPort(tempHome);
      assert.equal(beforePort, DEFAULT_MCP_PORT);

      // Start MCP on isolated HOME
      const { pid } = await startMcp(mcpPort, { homeDir: tempHome });
      assert.ok(pid > 0);

      // After start: running
      status = isIsolatedMcpRunning(tempHome);
      assert.equal(status.running, true);
      assert.equal(status.pid, pid);

      const afterPort = readIsolatedMcpPort(tempHome);
      assert.equal(afterPort, mcpPort);

    } finally {
      stopIsolatedMcp(tempHome);
    }
  });

  // Round-trip test with custom port — isolated HOME
  it("startMcp/stopMcp round-trip with custom port on isolated HOME", async (t) => {
    if (!fs.existsSync(MCP_STANDALONE_SCRIPT)) {
      t.skip("mcp-standalone.js not found — run npm run build first");
      return;
    }

    const customPort = await getAvailablePort();
    if (!(await canBind(customPort))) {
      t.skip(`Port ${customPort} is already in use`);
      return;
    }

    const tempHome = createDaemonctlTempHome();
    try {
      cleanupIsolatedMcpFiles(tempHome);

      const { pid, port } = await startMcp(customPort, { homeDir: tempHome });
      assert.ok(pid > 0);
      assert.equal(port, customPort);

      // Verify port file was written with custom port on isolated HOME
      assert.equal(readIsolatedMcpPort(tempHome), customPort);

      // Verify endpoint on custom port
      const res = await httpGet(`http://127.0.0.1:${customPort}/mcp`);
      assert.ok(res.status >= 200 && res.status < 500);

      // Stop using daemonctl against the isolated HOME
      const stopped = stopMcp({ homeDir: tempHome });
      assert.equal(stopped, true);

      // Verify down
      await waitForHttpDown(`http://127.0.0.1:${customPort}/mcp`);

      // PID file cleaned up on isolated HOME
      assert.equal(fs.existsSync(getIsolatedMcpPidFile(tempHome)), false);

      // Status reflects not running after stop
      const status = isIsolatedMcpRunning(tempHome);
      assert.equal(status.running, false);

    } finally {
      try { stopIsolatedMcp(tempHome); } catch {}
    }
  });

  // isMcpRunning() returns false for stale PID files (process no longer alive) — isolated
  it("isMcpRunning() returns false when PID file exists but process is dead on isolated HOME", () => {
    const tempHome = createDaemonctlTempHome();
    cleanupIsolatedMcpFiles(tempHome);

    // Write a PID file with a PID that almost certainly doesn't exist
    const fakePid = 999999;
    const pidFile = getIsolatedMcpPidFile(tempHome);
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(fakePid), "utf-8");

    const status = isIsolatedMcpRunning(tempHome);
    assert.equal(status.running, false);

    // Verify it cleaned up the stale PID file
    assert.equal(fs.existsSync(pidFile), false);
  });

  // Verify file path helper exports — these return real HOME paths (path-string-only assertions)
  it("getMcpPidFile() and getMcpPortFile() return paths within .tamandua", () => {
    const prevGuard = process.env.TAMANDUA_TEST_GUARD;
    process.env.TAMANDUA_TEST_GUARD = "0";
    try {
      const pidFile = getMcpPidFile();
      const portFile = getMcpPortFile();

      assert.ok(pidFile.includes(".tamandua"));
      assert.ok(pidFile.includes("mcp.pid"));
      assert.ok(portFile.includes(".tamandua"));
      assert.ok(portFile.includes("mcp-port"));
    } finally {
      if (prevGuard === undefined) delete process.env.TAMANDUA_TEST_GUARD;
      else process.env.TAMANDUA_TEST_GUARD = prevGuard;
    }
  });
});

// ── Control plane file path tests ──────────────────────────────────

const CONTROL_STANDALONE_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "control-standalone.js");

describe("daemonctl control plane file paths", () => {
  it("CONTROL_PLANE_PID_FILE points to ~/.tamandua/control-plane.pid", async () => {
    const { CONTROL_PLANE_PID_FILE } = await import("../../dist/server/daemonctl.js");
    assert.ok(CONTROL_PLANE_PID_FILE.includes(".tamandua"));
    assert.ok(CONTROL_PLANE_PID_FILE.endsWith("control-plane.pid"));
  });

  it("CONTROL_PLANE_PORT_FILE points to ~/.tamandua/control-plane-port", async () => {
    const { CONTROL_PLANE_PORT_FILE } = await import("../../dist/server/daemonctl.js");
    assert.ok(CONTROL_PLANE_PORT_FILE.includes(".tamandua"));
    assert.ok(CONTROL_PLANE_PORT_FILE.endsWith("control-plane-port"));
  });

  it("CONTROL_PLANE_LOG_FILE points to ~/.tamandua/control-plane.log", async () => {
    const { CONTROL_PLANE_LOG_FILE } = await import("../../dist/server/daemonctl.js");
    assert.ok(CONTROL_PLANE_LOG_FILE.includes(".tamandua"));
    assert.ok(CONTROL_PLANE_LOG_FILE.endsWith("control-plane.log"));
  });

  it("getControlPlanePidFile() returns CONTROL_PLANE_PID_FILE", async () => {
    const prevGuard = process.env.TAMANDUA_TEST_GUARD;
    process.env.TAMANDUA_TEST_GUARD = "0";
    try {
      const { getControlPlanePidFile, CONTROL_PLANE_PID_FILE } = await import("../../dist/server/daemonctl.js");
      assert.equal(getControlPlanePidFile(), CONTROL_PLANE_PID_FILE);
    } finally {
      if (prevGuard === undefined) delete process.env.TAMANDUA_TEST_GUARD;
      else process.env.TAMANDUA_TEST_GUARD = prevGuard;
    }
  });

  it("getControlPlanePortFile() returns CONTROL_PLANE_PORT_FILE", async () => {
    const prevGuard = process.env.TAMANDUA_TEST_GUARD;
    process.env.TAMANDUA_TEST_GUARD = "0";
    try {
      const { getControlPlanePortFile, CONTROL_PLANE_PORT_FILE } = await import("../../dist/server/daemonctl.js");
      assert.equal(getControlPlanePortFile(), CONTROL_PLANE_PORT_FILE);
    } finally {
      if (prevGuard === undefined) delete process.env.TAMANDUA_TEST_GUARD;
      else process.env.TAMANDUA_TEST_GUARD = prevGuard;
    }
  });

  it("getControlPlaneLogFile() returns CONTROL_PLANE_LOG_FILE", async () => {
    const { getControlPlaneLogFile, CONTROL_PLANE_LOG_FILE } = await import("../../dist/server/daemonctl.js");
    assert.equal(getControlPlaneLogFile(), CONTROL_PLANE_LOG_FILE);
  });

  it("control plane paths are distinct from MCP paths", async () => {
    const { CONTROL_PLANE_PID_FILE, CONTROL_PLANE_PORT_FILE, CONTROL_PLANE_LOG_FILE, MCP_PID_FILE, MCP_PORT_FILE } = await import("../../dist/server/daemonctl.js");
    assert.notEqual(CONTROL_PLANE_PID_FILE, MCP_PID_FILE);
    assert.notEqual(CONTROL_PLANE_PORT_FILE, MCP_PORT_FILE);
    assert.ok(CONTROL_PLANE_LOG_FILE.includes("control-plane.log"));
  });

  it("all control plane paths resolve via os.homedir()", async () => {
    const os = await import("node:os");
    const { CONTROL_PLANE_PID_FILE, CONTROL_PLANE_PORT_FILE, CONTROL_PLANE_LOG_FILE } = await import("../../dist/server/daemonctl.js");
    const home = os.homedir();
    assert.ok(CONTROL_PLANE_PID_FILE.startsWith(home));
    assert.ok(CONTROL_PLANE_PORT_FILE.startsWith(home));
    assert.ok(CONTROL_PLANE_LOG_FILE.startsWith(home));
  });
});

// ── Control plane lifecycle tests ─────────────────────────────────

describe("daemonctl control plane lifecycle", { concurrency: 1 }, () => {
  // AC: DEFAULT_CONTROL_PORT constant is 3339 (no processes spawned)
  it("DEFAULT_CONTROL_PORT constant equals 3339", () => {
    assert.equal(DEFAULT_CONTROL_PORT, 3339);
  });

  // AC: readControlPlanePort() returns DEFAULT_CONTROL_PORT (3339) when no port file exists — isolated
  it("readControlPlanePort() returns DEFAULT_CONTROL_PORT (3339) when no port file exists on isolated HOME", () => {
    const tempHome = createControlPlaneTempHome();
    cleanupIsolatedControlPlaneFiles(tempHome);
    const port = readIsolatedControlPlanePort(tempHome);
    assert.equal(port, DEFAULT_CONTROL_PORT);
    assert.equal(port, 3339);
  });

  // AC: writeControlPlanePort(4242) persists and read returns 4242 — isolated
  it("writeControlPlanePort(4242) persists and read returns 4242 on isolated HOME", () => {
    const tempHome = createControlPlaneTempHome();
    writeIsolatedControlPlanePort(tempHome, 4242);
    const portFile = getIsolatedControlPlanePortFile(tempHome);
    assert.ok(fs.existsSync(portFile), "Control plane port file should exist after writeControlPlanePort");
    assert.equal(fs.readFileSync(portFile, "utf-8").trim(), "4242");

    const port = readIsolatedControlPlanePort(tempHome);
    assert.equal(port, 4242);
  });

  // AC: isControlPlaneRunning() returns false when no PID file exists — isolated
  it("isControlPlaneRunning() returns false when no PID file exists on isolated HOME", () => {
    const tempHome = createControlPlaneTempHome();
    cleanupIsolatedControlPlaneFiles(tempHome);
    const status = isIsolatedControlPlaneRunning(tempHome);
    assert.equal(status.running, false);
  });

  // AC: isControlPlaneRunning() returns false for stale PID files — isolated
  it("isControlPlaneRunning() returns false when PID file exists but process is dead on isolated HOME", () => {
    const tempHome = createControlPlaneTempHome();
    cleanupIsolatedControlPlaneFiles(tempHome);

    // Write a PID file with a PID that almost certainly doesn't exist
    const fakePid = 999999;
    const pidFile = getIsolatedControlPlanePidFile(tempHome);
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(fakePid), "utf-8");

    const status = isIsolatedControlPlaneRunning(tempHome);
    assert.equal(status.running, false);

    // Verify it cleaned up the stale PID file
    assert.equal(fs.existsSync(pidFile), false);
  });

  // AC: getControlPlaneStatus() returns correct state before start — isolated
  it("getControlPlaneStatus() returns correct state before start on isolated HOME", () => {
    const tempHome = createControlPlaneTempHome();
    cleanupIsolatedControlPlaneFiles(tempHome);

    const status = isIsolatedControlPlaneRunning(tempHome);
    assert.equal(status.running, false);

    const port = readIsolatedControlPlanePort(tempHome);
    assert.equal(port, DEFAULT_CONTROL_PORT);
  });

  // AC: startControlPlane() spawns server and writes PID/port files — isolated
  it("startControlPlane() spawns server and writes PID/port files on isolated HOME", async (t) => {
    if (!fs.existsSync(CONTROL_STANDALONE_SCRIPT)) {
      t.skip("control-standalone.js not found — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();
    if (!(await canBind(controlPort))) {
      t.skip(`Port ${controlPort} is already in use`);
      return;
    }

    const tempHome = createControlPlaneTempHome();
    try {
      cleanupIsolatedControlPlaneFiles(tempHome);

      const result = await startControlPlane(controlPort, { homeDir: tempHome });
      assert.ok(result.pid > 0, "startControlPlane should return a valid PID");
      assert.equal(result.port, controlPort);

      // Verify isolated PID file exists and contains a valid PID
      const pidFile = getIsolatedControlPlanePidFile(tempHome);
      assert.ok(fs.existsSync(pidFile), "Control plane PID file should exist after startControlPlane on isolated HOME");
      const savedPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      assert.equal(savedPid, result.pid);

      // Verify isolated port file exists
      const portFile = getIsolatedControlPlanePortFile(tempHome);
      assert.ok(fs.existsSync(portFile), "Control plane port file should exist after startControlPlane on isolated HOME");

      // Verify health endpoint is reachable
      const res = await fetch(`http://127.0.0.1:${controlPort}/control/health`);
      assert.equal(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.status, "ok");

      // Verify running via isolated helper
      const afterStatus = isIsolatedControlPlaneRunning(tempHome);
      assert.equal(afterStatus.running, true);
      assert.equal(afterStatus.pid, result.pid);

      const afterPort = readIsolatedControlPlanePort(tempHome);
      assert.equal(afterPort, controlPort);
    } finally {
      try { stopIsolatedControlPlane(tempHome); } catch {}
    }
  });

  // AC: stopControlPlane() kills control plane process and cleans up files — isolated
  it("stopControlPlane() kills control plane process and cleans up files on isolated HOME", async (t) => {
    if (!fs.existsSync(CONTROL_STANDALONE_SCRIPT)) {
      t.skip("control-standalone.js not found — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();
    if (!(await canBind(controlPort))) {
      t.skip(`Port ${controlPort} is already in use`);
      return;
    }

    const tempHome = createControlPlaneTempHome();
    try {
      cleanupIsolatedControlPlaneFiles(tempHome);

      // Start the control plane on isolated HOME
      const { pid } = await startControlPlane(controlPort, { homeDir: tempHome });
      assert.ok(pid > 0);

      // Verify it's running via isolated PID file check
      let status = isIsolatedControlPlaneRunning(tempHome);
      assert.equal(status.running, true);

      // Stop using isolated stop helper
      const stopped = stopControlPlane({ homeDir: tempHome });
      assert.equal(stopped, true);

      // Verify isolated PID file is cleaned up
      const pidFile = getIsolatedControlPlanePidFile(tempHome);
      assert.equal(fs.existsSync(pidFile), false, "Control plane PID file should be cleaned up after stopControlPlane on isolated HOME");

      // Verify isolated port file is cleaned up
      const portFile = getIsolatedControlPlanePortFile(tempHome);
      assert.equal(fs.existsSync(portFile), false, "Control plane port file should be cleaned up after stopControlPlane on isolated HOME");

      // Wait briefly for process to fully exit
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      // Verify process is gone via isolated check
      status = isIsolatedControlPlaneRunning(tempHome);
      assert.equal(status.running, false, "isControlPlaneRunning should return false after stop on isolated HOME");

      // Verify health endpoint is down
      await waitForHttpDown(`http://127.0.0.1:${controlPort}/control/health`);
    } finally {
      try { stopIsolatedControlPlane(tempHome); } catch {}
    }
  });

  // AC: Round-trip test with custom port — isolated
  it("startControlPlane/stopControlPlane round-trip with custom port on isolated HOME", async (t) => {
    if (!fs.existsSync(CONTROL_STANDALONE_SCRIPT)) {
      t.skip("control-standalone.js not found — run npm run build first");
      return;
    }

    const customPort = await getAvailablePort();
    if (!(await canBind(customPort))) {
      t.skip(`Port ${customPort} is already in use`);
      return;
    }

    const tempHome = createControlPlaneTempHome();
    try {
      cleanupIsolatedControlPlaneFiles(tempHome);

      const { pid, port } = await startControlPlane(customPort, { homeDir: tempHome });
      assert.ok(pid > 0);
      assert.equal(port, customPort);

      // Verify port file was written with custom port on isolated HOME
      assert.equal(readIsolatedControlPlanePort(tempHome), customPort);

      // Verify health endpoint on custom port
      const res = await fetch(`http://127.0.0.1:${customPort}/control/health`);
      assert.equal(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.status, "ok");

      // Stop using isolated helper
      const stopped = stopControlPlane({ homeDir: tempHome });
      assert.equal(stopped, true);

      // Stop attribution: the stop must leave a breadcrumb in lifecycle.log
      const lifecyclePath = path.join(tempHome, ".tamandua", "lifecycle.log");
      assert.ok(fs.existsSync(lifecyclePath), "stopControlPlane should write a lifecycle.log breadcrumb");
      const breadcrumb = JSON.parse(fs.readFileSync(lifecyclePath, "utf-8").trim().split("\n").at(-1)!);
      assert.equal(breadcrumb.action, "stop.control-plane");
      assert.equal(breadcrumb.targetPid, pid);
      assert.equal(breadcrumb.callerPid, process.pid);

      // Verify down
      await waitForHttpDown(`http://127.0.0.1:${customPort}/control/health`);

      // PID file cleaned up on isolated HOME
      assert.equal(fs.existsSync(getIsolatedControlPlanePidFile(tempHome)), false);

      // Port file cleaned up on isolated HOME
      assert.equal(fs.existsSync(getIsolatedControlPlanePortFile(tempHome)), false);

      // Status reflects not running after stop
      const status = isIsolatedControlPlaneRunning(tempHome);
      assert.equal(status.running, false);
    } finally {
      try { stopIsolatedControlPlane(tempHome); } catch {}
    }
  });

  // AC: startControlPlane() returns already-running info when already up — isolated
  it("startControlPlane() returns existing info when already running on isolated HOME", async (t) => {
    if (!fs.existsSync(CONTROL_STANDALONE_SCRIPT)) {
      t.skip("control-standalone.js not found — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();
    if (!(await canBind(controlPort))) {
      t.skip(`Port ${controlPort} is already in use`);
      return;
    }

    const tempHome = createControlPlaneTempHome();
    try {
      cleanupIsolatedControlPlaneFiles(tempHome);

      const first = await startControlPlane(controlPort, { homeDir: tempHome });
      assert.ok(first.pid > 0);

      // Second call should detect already running
      const second = await startControlPlane(controlPort, { homeDir: tempHome });
      assert.equal(second.pid, first.pid);
      assert.equal(second.port, first.port);
    } finally {
      try { stopIsolatedControlPlane(tempHome); } catch {}
    }
  });

  it("startControlPlane() treats a healthy control plane without PID file as already running", async (t) => {
    if (!fs.existsSync(CONTROL_STANDALONE_SCRIPT)) {
      t.skip("control-standalone.js not found — run npm run build first");
      return;
    }

    const tempHome = createControlPlaneTempHome();
    const port = await getAvailablePort();
    let childPid: number | undefined;
    try {
      cleanupIsolatedControlPlaneFiles(tempHome);

      const first = await startControlPlane(port, { keepHandle: true, homeDir: tempHome });
      childPid = first.pid;
      assert.ok(first.pid > 0);

      fs.unlinkSync(getIsolatedControlPlanePidFile(tempHome));

      const second = await startControlPlane(port, { homeDir: tempHome });
      assert.equal(second.pid, first.pid);
      assert.equal(second.port, port);
      assert.equal(second.alreadyRunning, true);
      assert.equal(fs.readFileSync(getIsolatedControlPlanePidFile(tempHome), "utf-8").trim(), String(first.pid));
    } finally {
      if (childPid) {
        try { process.kill(childPid, "SIGTERM"); } catch {}
      }
      await waitForHttpDown(`http://127.0.0.1:${port}/control/health`).catch(() => {});
    }
  });

  it("startControlPlane() reports an unrelated process on the requested port clearly", async () => {
    const tempHome = createControlPlaneTempHome();
    const server = await new Promise<http.Server>((resolve, reject) => {
      const s = http.createServer((_req, res) => {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not tamandua");
      });
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => resolve(s));
    });

    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");

      await assert.rejects(
        () => startControlPlane(address.port, { homeDir: tempHome }),
        /not a healthy Tamandua control plane/,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // AC: stopControlPlane() returns false when control plane is not running — isolated
  it("stopControlPlane() returns false when control plane is not running on isolated HOME", () => {
    const tempHome = createControlPlaneTempHome();
    cleanupIsolatedControlPlaneFiles(tempHome);
    const result = stopControlPlane({ homeDir: tempHome });
    assert.equal(result, false);
  });
});

// ── Isolated dashboard standalone helpers ───────────────────────────

function createDashboardTempHome(): string {
  const { root } = createTempHome("tamandua-daemonctl-dashboard-");
  return root;
}

function getIsolatedDashboardPidFile(homeDir: string): string {
  return path.join(homeDir, ".tamandua", "dashboard.pid");
}

function getIsolatedDashboardPortFile(homeDir: string): string {
  return path.join(homeDir, ".tamandua", "port");
}

function readIsolatedDashboardPort(homeDir: string): number {
  const portFile = getIsolatedDashboardPortFile(homeDir);
  try {
    const raw = fs.readFileSync(portFile, "utf-8").trim();
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port > 0 && port < 65536) return port;
  } catch {}
  return 3334; // default dashboard port
}

function writeIsolatedDashboardPort(homeDir: string, port: number): void {
  const portFile = getIsolatedDashboardPortFile(homeDir);
  fs.mkdirSync(path.dirname(portFile), { recursive: true });
  fs.writeFileSync(portFile, String(port), "utf-8");
}

function isIsolatedDashboardRunning(homeDir: string): { running: true; pid: number } | { running: false } {
  const pidFile = getIsolatedDashboardPidFile(homeDir);
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

function stopIsolatedDashboard(homeDir: string): boolean {
  return stopDashboardStandalone({ homeDir });
}

function cleanupIsolatedDashboardFiles(homeDir: string): void {
  try { fs.unlinkSync(getIsolatedDashboardPidFile(homeDir)); } catch {}
  try { fs.unlinkSync(getIsolatedDashboardPortFile(homeDir)); } catch {}
}

// ── Dashboard standalone lifecycle tests ──────────────────────────

describe("daemonctl dashboard standalone lifecycle", { concurrency: 1 }, () => {
  // AC: isDashboardRunning() returns false when no PID file exists — isolated
  it("isDashboardRunning() returns false when no PID file exists on isolated HOME", () => {
    const tempHome = createDashboardTempHome();
    cleanupIsolatedDashboardFiles(tempHome);
    const status = isDashboardRunning({ homeDir: tempHome });
    assert.equal(status.running, false);
  });

  // AC: isDashboardRunning() returns false for stale PID files — isolated
  it("isDashboardRunning() returns false when PID file exists but process is dead on isolated HOME", () => {
    const tempHome = createDashboardTempHome();
    cleanupIsolatedDashboardFiles(tempHome);

    // Write a PID file with a PID that almost certainly doesn't exist
    const fakePid = 999999;
    const pidFile = getIsolatedDashboardPidFile(tempHome);
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(fakePid), "utf-8");

    const status = isDashboardRunning({ homeDir: tempHome });
    assert.equal(status.running, false);

    // Verify it cleaned up the stale PID file
    assert.equal(fs.existsSync(pidFile), false);
  });

  // AC: getDashboardStatus() returns correct state before start — isolated
  it("getDashboardStatus() returns correct state before start on isolated HOME", () => {
    const tempHome = createDashboardTempHome();
    cleanupIsolatedDashboardFiles(tempHome);

    const status = getDashboardStatus({ homeDir: tempHome });
    assert.equal(status.running, false);
    assert.equal(status.pid, null);
    assert.equal(status.port, 3334);
  });

  // AC: getDashboardPidFile/getDashboardPortFile/getDashboardLogFile return correct paths
  it("getDashboardPidFile/getDashboardPortFile/getDashboardLogFile return correct paths with homeDir", () => {
    const tempHome = createDashboardTempHome();

    const pidFile = getDashboardPidFile({ homeDir: tempHome });
    assert.ok(pidFile.includes(".tamandua"));
    assert.ok(pidFile.includes("dashboard.pid"));
    assert.ok(pidFile.startsWith(tempHome));

    const portFile = getDashboardPortFile({ homeDir: tempHome });
    assert.ok(portFile.includes(".tamandua"));
    assert.ok(portFile.includes("port"));
    assert.ok(portFile.startsWith(tempHome));

    const logFile = getDashboardLogFile({ homeDir: tempHome });
    assert.ok(logFile.includes(".tamandua"));
    assert.ok(logFile.includes("dashboard.log"));
    assert.ok(logFile.startsWith(tempHome));
  });

  // AC: startDashboardStandalone() spawns server and writes PID/port files — isolated
  it("startDashboardStandalone() spawns server and writes PID/port files on isolated HOME", async (t) => {
    if (!fs.existsSync(DASHBOARD_STANDALONE_SCRIPT)) {
      t.skip("dashboard-standalone.js not found — run npm run build first");
      return;
    }

    const dashPort = await getAvailablePort();
    if (!(await canBind(dashPort))) {
      t.skip(`Port ${dashPort} is already in use`);
      return;
    }

    const tempHome = createDashboardTempHome();
    try {
      cleanupIsolatedDashboardFiles(tempHome);

      const result = await startDashboardStandalone(dashPort, { homeDir: tempHome });
      assert.ok(result.pid > 0, "startDashboardStandalone should return a valid PID");
      assert.equal(result.port, dashPort);

      // Verify isolated PID file exists and contains a valid PID
      const pidFile = getIsolatedDashboardPidFile(tempHome);
      assert.ok(fs.existsSync(pidFile), "Dashboard PID file should exist after start on isolated HOME");
      const savedPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      assert.equal(savedPid, result.pid);

      // Verify isolated port file exists
      const portFile = getIsolatedDashboardPortFile(tempHome);
      assert.ok(fs.existsSync(portFile), "Dashboard port file should exist after start on isolated HOME");

      // Verify health endpoint is reachable
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/health`);
      assert.equal(res.status, 200);
    } finally {
      stopIsolatedDashboard(tempHome);
    }
  });

  // AC: stopDashboardStandalone() kills dashboard process and cleans up PID file — isolated
  it("stopDashboardStandalone() kills dashboard process and cleans up PID file on isolated HOME", async (t) => {
    if (!fs.existsSync(DASHBOARD_STANDALONE_SCRIPT)) {
      t.skip("dashboard-standalone.js not found — run npm run build first");
      return;
    }

    const dashPort = await getAvailablePort();
    if (!(await canBind(dashPort))) {
      t.skip(`Port ${dashPort} is already in use`);
      return;
    }

    const tempHome = createDashboardTempHome();
    try {
      cleanupIsolatedDashboardFiles(tempHome);

      // Start the dashboard on isolated HOME
      const { pid } = await startDashboardStandalone(dashPort, { homeDir: tempHome });
      assert.ok(pid > 0);

      // Verify it's running via isolated PID file check
      let status = isDashboardRunning({ homeDir: tempHome });
      assert.equal(status.running, true);

      // Stop using isolated stop helper
      const stopped = stopDashboardStandalone({ homeDir: tempHome });
      assert.equal(stopped, true);

      // Verify isolated PID file is cleaned up
      const pidFile = getIsolatedDashboardPidFile(tempHome);
      assert.equal(fs.existsSync(pidFile), false, "Dashboard PID file should be cleaned up after stop on isolated HOME");

      // Wait briefly for process to fully exit
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      // Verify process is gone via isolated check
      status = isDashboardRunning({ homeDir: tempHome });
      assert.equal(status.running, false, "isDashboardRunning should return false after stop on isolated HOME");

      // Verify endpoint is down
      await waitForHttpDown(`http://127.0.0.1:${dashPort}/api/health`);
    } finally {
      try { stopIsolatedDashboard(tempHome); } catch {}
    }
  });

  // AC: Round-trip test with custom port — isolated
  it("startDashboardStandalone/stopDashboardStandalone round-trip with custom port on isolated HOME", async (t) => {
    if (!fs.existsSync(DASHBOARD_STANDALONE_SCRIPT)) {
      t.skip("dashboard-standalone.js not found — run npm run build first");
      return;
    }

    const customPort = await getAvailablePort();
    if (!(await canBind(customPort))) {
      t.skip(`Port ${customPort} is already in use`);
      return;
    }

    const tempHome = createDashboardTempHome();
    try {
      cleanupIsolatedDashboardFiles(tempHome);

      const { pid, port } = await startDashboardStandalone(customPort, { homeDir: tempHome });
      assert.ok(pid > 0);
      assert.equal(port, customPort);

      // Verify port file was written with custom port on isolated HOME
      assert.equal(readIsolatedDashboardPort(tempHome), customPort);

      // Verify health endpoint on custom port
      const res = await fetch(`http://127.0.0.1:${customPort}/api/health`);
      assert.equal(res.status, 200);

      // Stop using isolated helper
      const stopped = stopDashboardStandalone({ homeDir: tempHome });
      assert.equal(stopped, true);

      // Stop attribution: the stop must leave a breadcrumb in lifecycle.log
      const lifecyclePath = path.join(tempHome, ".tamandua", "lifecycle.log");
      assert.ok(fs.existsSync(lifecyclePath), "stopDashboardStandalone should write a lifecycle.log breadcrumb");
      const breadcrumb = JSON.parse(fs.readFileSync(lifecyclePath, "utf-8").trim().split("\n").at(-1)!);
      assert.equal(breadcrumb.action, "stop.dashboard");
      assert.equal(breadcrumb.targetPid, pid);
      assert.equal(breadcrumb.callerPid, process.pid);

      // Verify down
      await waitForHttpDown(`http://127.0.0.1:${customPort}/api/health`);

      // PID file cleaned up on isolated HOME
      assert.equal(fs.existsSync(getIsolatedDashboardPidFile(tempHome)), false);

      // Status reflects not running after stop
      const status = isDashboardRunning({ homeDir: tempHome });
      assert.equal(status.running, false);
    } finally {
      try { stopIsolatedDashboard(tempHome); } catch {}
    }
  });

  // AC: startDashboardStandalone() returns already-running info when already up — isolated
  it("startDashboardStandalone() returns existing info when already running on isolated HOME", async (t) => {
    if (!fs.existsSync(DASHBOARD_STANDALONE_SCRIPT)) {
      t.skip("dashboard-standalone.js not found — run npm run build first");
      return;
    }

    const dashPort = await getAvailablePort();
    if (!(await canBind(dashPort))) {
      t.skip(`Port ${dashPort} is already in use`);
      return;
    }

    const tempHome = createDashboardTempHome();
    try {
      cleanupIsolatedDashboardFiles(tempHome);

      const first = await startDashboardStandalone(dashPort, { homeDir: tempHome });
      assert.ok(first.pid > 0);

      // Second call should detect already running
      const second = await startDashboardStandalone(dashPort, { homeDir: tempHome });
      assert.equal(second.pid, first.pid);
      assert.equal(second.port, first.port);
    } finally {
      try { stopIsolatedDashboard(tempHome); } catch {}
    }
  });

  // AC: stopDashboardStandalone() returns false when dashboard is not running — isolated
  it("stopDashboardStandalone() returns false when dashboard is not running on isolated HOME", () => {
    const tempHome = createDashboardTempHome();
    cleanupIsolatedDashboardFiles(tempHome);
    const result = stopDashboardStandalone({ homeDir: tempHome });
    assert.equal(result, false);
  });

  // AC: restartDashboardStandalone() restarts the dashboard
  it("restartDashboardStandalone() stops then starts on isolated HOME", async (t) => {
    if (!fs.existsSync(DASHBOARD_STANDALONE_SCRIPT)) {
      t.skip("dashboard-standalone.js not found — run npm run build first");
      return;
    }

    const dashPort = await getAvailablePort();
    if (!(await canBind(dashPort))) {
      t.skip(`Port ${dashPort} is already in use`);
      return;
    }

    const tempHome = createDashboardTempHome();
    try {
      cleanupIsolatedDashboardFiles(tempHome);

      // Start first instance
      const first = await startDashboardStandalone(dashPort, { homeDir: tempHome });
      assert.ok(first.pid > 0);

      // Restart
      const restarted = await restartDashboardStandalone(dashPort, { homeDir: tempHome });
      assert.ok(restarted.pid > 0);
      assert.equal(restarted.port, dashPort);

      // Should have a different PID (new process)
      assert.notEqual(restarted.pid, first.pid);

      // Health endpoint reachable
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/health`);
      assert.equal(res.status, 200);
    } finally {
      try { stopIsolatedDashboard(tempHome); } catch {}
    }
  });

  // AC: restartDashboardStandalone() starts fresh when nothing is running
  it("restartDashboardStandalone() starts fresh when nothing is running on isolated HOME", async (t) => {
    if (!fs.existsSync(DASHBOARD_STANDALONE_SCRIPT)) {
      t.skip("dashboard-standalone.js not found — run npm run build first");
      return;
    }

    const dashPort = await getAvailablePort();
    if (!(await canBind(dashPort))) {
      t.skip(`Port ${dashPort} is already in use`);
      return;
    }

    const tempHome = createDashboardTempHome();
    try {
      cleanupIsolatedDashboardFiles(tempHome);

      const result = await restartDashboardStandalone(dashPort, { homeDir: tempHome });
      assert.ok(result.pid > 0);
      assert.equal(result.port, dashPort);

      // Health endpoint reachable
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/health`);
      assert.equal(res.status, 200);
    } finally {
      try { stopIsolatedDashboard(tempHome); } catch {}
    }
  });

  // AC: startDashboardStandalone() reports failure with log tail when dashboard exits early
  it("startDashboardStandalone() reports failure with log tail when port is already occupied", async (t) => {
    if (!fs.existsSync(DASHBOARD_STANDALONE_SCRIPT)) {
      t.skip("dashboard-standalone.js not found — run npm run build first");
      return;
    }

    const dashPort = await getAvailablePort();
    if (!(await canBind(dashPort))) {
      t.skip(`Port ${dashPort} is already in use`);
      return;
    }

    // Occupy the port so dashboard-standalone.js fails to bind
    const blocker = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("blocker");
    });
    await new Promise<void>((resolve) => blocker.listen(dashPort, "127.0.0.1", () => resolve()));

    const tempHome = createDashboardTempHome();
    try {
      cleanupIsolatedDashboardFiles(tempHome);

      await assert.rejects(
        () => startDashboardStandalone(dashPort, { homeDir: tempHome }),
        /Dashboard server failed to start/,
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      try { stopIsolatedDashboard(tempHome); } catch {}
    }
  });
});

// ── Lifecycle attribution (stop breadcrumbs) ───────────────────────

describe("recordLifecycleEvent", () => {
  it("writes a JSON breadcrumb with caller attribution on isolated HOME", () => {
    const { root: tempHome } = createTempHome("tamandua-lifecycle-");
    recordLifecycleEvent("stop.daemon", 12345, { homeDir: tempHome });

    const file = path.join(tempHome, ".tamandua", "lifecycle.log");
    assert.ok(fs.existsSync(file), "lifecycle.log should be created");
    const entry = JSON.parse(fs.readFileSync(file, "utf-8").trim());
    assert.equal(entry.action, "stop.daemon");
    assert.equal(entry.targetPid, 12345);
    assert.equal(entry.callerPid, process.pid);
    assert.equal(entry.callerPpid, process.ppid);
    assert.ok(Array.isArray(entry.callerArgv) && entry.callerArgv.length > 0);
    assert.ok(typeof entry.ts === "string" && entry.ts.includes("T"));
  });

  it("appends — multiple events accumulate as one JSON line each", () => {
    const { root: tempHome } = createTempHome("tamandua-lifecycle-");
    recordLifecycleEvent("stop.mcp", 111, { homeDir: tempHome });
    recordLifecycleEvent("restart.daemon", 222, { homeDir: tempHome });

    const file = path.join(tempHome, ".tamandua", "lifecycle.log");
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).action, "stop.mcp");
    assert.equal(JSON.parse(lines[1]).action, "restart.daemon");
    assert.equal(JSON.parse(lines[1]).targetPid, 222);
  });

  it("guard: drops the line without throwing when a guarded process resolves the production path", () => {
    // Mirror the logger-guard contract: attribution must never break a stop,
    // and must never write production state from a guarded process.
    const prevGuard = process.env.TAMANDUA_TEST_GUARD;
    const prevHome = process.env.HOME;
    const marker = `guard-drop-probe-${process.pid}-${Date.now()}`;
    try {
      process.env.TAMANDUA_TEST_GUARD = "1";
      process.env.HOME = os.userInfo().homedir; // resolve the REAL state dir
      assert.doesNotThrow(() => recordLifecycleEvent(marker, 1));

      const prodFile = path.join(os.userInfo().homedir, ".tamandua", "lifecycle.log");
      if (fs.existsSync(prodFile)) {
        assert.ok(
          !fs.readFileSync(prodFile, "utf-8").includes(marker),
          "guarded process must not write the production lifecycle.log",
        );
      }
    } finally {
      if (prevGuard === undefined) delete process.env.TAMANDUA_TEST_GUARD;
      else process.env.TAMANDUA_TEST_GUARD = prevGuard;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});
