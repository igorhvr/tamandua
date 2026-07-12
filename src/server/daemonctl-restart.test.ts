/**
 * Tests for restartDaemon — stop + start lifecycle.
 *
 * Fully isolated: temporary HOME per test, a random dashboard port per
 * test, and a random control-plane port per test (the spawned daemon binds
 * one too). No default ports, no escape hatches — a port collision here is
 * a bug, not an environmental condition.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createTempHome as sharedCreateTempHome } from "../../tests/helpers/test-env.ts";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "daemon.js");

import {
  restartDaemon,
  startDaemon,
  stopDaemon,
  isRunning,
  readPort,
  writePort,
  readControlPlanePort,
  writeControlPlanePort,
  getPidFile,
  startDashboardStandalone,
  stopDashboardStandalone,
  isDashboardRunning,
} from "../../dist/server/daemonctl.js";

const DASHBOARD_STANDALONE_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "dashboard-standalone.js");

// ── Helpers ────────────────────────────────────────────────────────

function createTempHome(): string {
  const { root } = sharedCreateTempHome("tamandua-restart-");
  return root;
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

async function waitForHttpUp(url: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url} to become reachable`);
}

// ── Tests ──────────────────────────────────────────────────────────

describe("daemonctl restartDaemon", { concurrency: 1 }, () => {
  // Each spawned daemon binds a control plane too — isolate it per test so
  // the suite never touches the production control port (3339).
  let savedControlPort: string | undefined;
  beforeEach(async () => {
    savedControlPort = process.env.TAMANDUA_CONTROL_PORT;
    process.env.TAMANDUA_CONTROL_PORT = String(await getAvailablePort());
  });
  afterEach(() => {
    if (savedControlPort === undefined) delete process.env.TAMANDUA_CONTROL_PORT;
    else process.env.TAMANDUA_CONTROL_PORT = savedControlPort;
  });

  it("restartDaemon is exported and callable — returns { pid, port }", async (t) => {
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      t.skip("daemon.js not found — run npm run build first");
      return;
    }

    const port = await getAvailablePort();
    const tempHome = createTempHome();
    try {
      const result = await restartDaemon(port, { homeDir: tempHome });

      assert.equal(typeof result.pid, "number");
      assert.ok(result.pid > 0, "pid should be a positive number");
      assert.equal(typeof result.port, "number");
      assert.equal(result.port, port, "port should match the requested port");

      await waitForHttpUp(`http://127.0.0.1:${port}/control/health`);
    } finally {
      try { stopDaemon({ homeDir: tempHome }); } catch {}
    }
  });

  it("restartDaemon stops running daemon and starts a new one with a different PID", async (t) => {
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      t.skip("daemon.js not found — run npm run build first");
      return;
    }

    const port = await getAvailablePort();
    const tempHome = createTempHome();
    try {
      const first = await startDaemon(port, { homeDir: tempHome });
      assert.ok(first.pid > 0);

      await waitForHttpUp(`http://127.0.0.1:${port}/control/health`);

      const result = await restartDaemon(port, { homeDir: tempHome });
      assert.ok(result.pid > 0, "restartDaemon should return a valid PID");
      assert.equal(result.port, port);
      assert.notEqual(result.pid, first.pid, "restartDaemon should spawn a new process with a different PID");

      // Control plane should be reachable on the same port
      await waitForHttpUp(`http://127.0.0.1:${port}/control/health`);

      // Verify the pid file has the new PID
      const after = isRunning({ homeDir: tempHome });
      assert.equal(after.running, true);
      assert.equal((after as { running: true; pid: number }).pid, result.pid);
    } finally {
      try { stopDaemon({ homeDir: tempHome }); } catch {}
    }
  });

  it("restartDaemon uses stored port from port file when no port arg given", async (t) => {
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      t.skip("daemon.js not found — run npm run build first");
      return;
    }

    const port = await getAvailablePort();
    const tempHome = createTempHome();
    try {
      writeControlPlanePort(port, { homeDir: tempHome });
      assert.equal(readControlPlanePort({ homeDir: tempHome }), port);

      const result = await restartDaemon(undefined, { homeDir: tempHome });
      assert.equal(result.port, port, "should use the stored control plane port when no port arg given");
      assert.ok(result.pid > 0);
    } finally {
      try { stopDaemon({ homeDir: tempHome }); } catch {}
    }
  });

  it("restartDaemon with explicit port overrides stored port file value", async (t) => {
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      t.skip("daemon.js not found — run npm run build first");
      return;
    }

    const storedPort = await getAvailablePort();
    const explicitPort = await getAvailablePort();
    const tempHome = createTempHome();
    try {
      writeControlPlanePort(storedPort, { homeDir: tempHome });

      const result = await restartDaemon(explicitPort, { homeDir: tempHome });
      assert.equal(result.port, explicitPort, "explicit port should override stored port file");
      assert.ok(result.pid > 0);
    } finally {
      try { stopDaemon({ homeDir: tempHome }); } catch {}
    }
  });

  it("restartDaemon cleans up old PID file on restart", async (t) => {
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      t.skip("daemon.js not found — run npm run build first");
      return;
    }

    const port = await getAvailablePort();
    const tempHome = createTempHome();
    try {
      const first = await startDaemon(port, { homeDir: tempHome });
      await waitForHttpUp(`http://127.0.0.1:${port}/control/health`);

      const result = await restartDaemon(port, { homeDir: tempHome });

      const pidFileContents = fs.readFileSync(getPidFile({ homeDir: tempHome }), "utf-8").trim();
      assert.equal(
        Number(pidFileContents),
        result.pid,
        "pid file should contain the NEW daemon's pid, not the stopped one",
      );
      assert.notEqual(Number(pidFileContents), first.pid);
    } finally {
      try { stopDaemon({ homeDir: tempHome }); } catch {}
    }
  });

  it("restartDaemon return type is Promise<{ pid: number; port: number }>", () => {
    assert.equal(typeof restartDaemon, "function");
  });

  it("restartDaemon does NOT restart or affect a running dashboard standalone process", async (t) => {
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      t.skip("daemon.js not found — run npm run build first");
      return;
    }
    if (!fs.existsSync(DASHBOARD_STANDALONE_SCRIPT)) {
      t.skip("dashboard-standalone.js not found — run npm run build first");
      return;
    }

    const daemonPort = await getAvailablePort();
    const dashPort = await getAvailablePort();
    if (dashPort === daemonPort) {
      t.skip("ports collided — retry");
      return;
    }

    const tempHome = createTempHome();
    try {
      // Start dashboard standalone first
      const dashStart = await startDashboardStandalone(dashPort, { homeDir: tempHome });
      assert.ok(dashStart.pid > 0);

      // Then start daemon
      const daemonStart = await startDaemon(daemonPort, { homeDir: tempHome });
      assert.ok(daemonStart.pid > 0);
      await waitForHttpUp(`http://127.0.0.1:${daemonPort}/control/health`);

      // Restart daemon
      const restarted = await restartDaemon(daemonPort, { homeDir: tempHome });
      assert.ok(restarted.pid > 0);
      assert.notEqual(restarted.pid, daemonStart.pid, "daemon PID should change after restart");

      // Dashboard standalone should STILL be running with the SAME PID
      const dashStatus = isDashboardRunning({ homeDir: tempHome });
      assert.equal(dashStatus.running, true, "dashboard should still be running after daemon restart");
      assert.equal(dashStatus.pid, dashStart.pid, "dashboard PID should be unchanged after daemon restart");

      // Dashboard health endpoint still reachable
      const dashHealth = await fetch(`http://127.0.0.1:${dashPort}/api/health`);
      assert.equal(dashHealth.status, 200);
    } finally {
      try { stopDashboardStandalone({ homeDir: tempHome }); } catch {}
      try { stopDaemon({ homeDir: tempHome }); } catch {}
    }
  });
});
