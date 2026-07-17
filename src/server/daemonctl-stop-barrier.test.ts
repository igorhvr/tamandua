/**
 * Tests for stop-barrier helpers: waitForDashboardStop, waitForMcpStop,
 * waitForDaemonStop.
 *
 * These helpers poll PID liveness + TCP port liveness after a stop call.
 * Tests verify:
 *   1. Barriers return immediately when service is not running (no/dangling PID file).
 *   2. Barriers time out after ~10s with a clear error naming the service when
 *      the process and port both remain alive.
 */

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createTempHome } from "../../tests/helpers/test-env.ts";
import {
  waitForDashboardStop,
  waitForMcpStop,
  waitForDaemonStop,
  stopDashboardStandalone,
  stopMcp,
  stopDaemon,
} from "../../dist/server/daemonctl.js";

// ── Low-level helpers ──────────────────────────────────────────────

/** Reserve a random free port. */
function reserveRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
  });
}

/** Start a minimal HTTP server that stays alive until server.close() is called. */
function startKeepAliveServer(
  port: number,
): Promise<{ server: http.Server }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server }));
  });
}

/** Write service pid/port files inside a temp homeDir. */
function writeServiceFiles(
  homeDir: string,
  pidFile: string,
  portFile: string,
  pid: number,
  port: number,
): void {
  const tamDir = path.join(homeDir, ".tamandua");
  fs.mkdirSync(tamDir, { recursive: true });
  fs.writeFileSync(path.join(tamDir, pidFile), String(pid), "utf-8");
  fs.writeFileSync(path.join(tamDir, portFile), String(port), "utf-8");
}

// ── Test suite ─────────────────────────────────────────────────────

describe("stop-barrier helpers", () => {
  describe("no-running-service fast path", () => {
    let tempHome: string;

    beforeEach(() => {
      const { homeDir } = createTempHome("tamandua-barrier-");
      tempHome = homeDir;
      fs.mkdirSync(path.join(tempHome, ".tamandua"), { recursive: true });
    });

    afterEach(() => {
      try { stopDashboardStandalone({ homeDir: tempHome }); } catch {}
      try { stopMcp({ homeDir: tempHome }); } catch {}
      try { stopDaemon({ homeDir: tempHome }); } catch {}
      try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
    });

    it("waitForDashboardStop returns when no PID file", async () => {
      await waitForDashboardStop({ homeDir: tempHome });
    });

    it("waitForDashboardStop returns when PID is not alive", async () => {
      writeServiceFiles(tempHome, "dashboard.pid", "port", 99999, 3334);
      await waitForDashboardStop({ homeDir: tempHome });
    });

    it("waitForMcpStop returns when no PID file", async () => {
      await waitForMcpStop({ homeDir: tempHome });
    });

    it("waitForMcpStop returns when PID is not alive", async () => {
      writeServiceFiles(tempHome, "mcp.pid", "mcp-port", 99999, 3338);
      await waitForMcpStop({ homeDir: tempHome });
    });

    it("waitForDaemonStop returns when no PID file", async () => {
      await waitForDaemonStop({ homeDir: tempHome });
    });

    it("waitForDaemonStop returns when PID is not alive", async () => {
      writeServiceFiles(tempHome, "tamandua.pid", "control-plane-port", 99999, 3339);
      await waitForDaemonStop({ homeDir: tempHome });
    });
  });

  describe("timeout behavior — service does not stop", () => {
    // These tests each take ~10s because the barrier polls for 10s before
    // timing out. We run one per service type to keep the suite reasonable.

    it("waitForDashboardStop times out and error names dashboard", async () => {
      const { homeDir } = createTempHome("tamandua-barrier-");
      fs.mkdirSync(path.join(homeDir, ".tamandua"), { recursive: true });

      const port = await reserveRandomPort();
      const { server } = await startKeepAliveServer(port);

      // Write files pointing at our live process + open port.
      writeServiceFiles(homeDir, "dashboard.pid", "port", process.pid, port);

      let barrierError: Error | null = null;
      try {
        await waitForDashboardStop({ homeDir });
      } catch (err) {
        barrierError = err as Error;
      } finally {
        server.close();
        try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
      }

      assert.ok(barrierError !== null, "expected waitForDashboardStop to throw on timeout");
      assert.match(barrierError!.message, /dashboard/i, "error should name the dashboard");
      assert.match(barrierError!.message, /10s|within/i, "error should mention the timeout");
    });

    it("waitForMcpStop times out and error names MCP server", async () => {
      const { homeDir } = createTempHome("tamandua-barrier-");
      fs.mkdirSync(path.join(homeDir, ".tamandua"), { recursive: true });

      const port = await reserveRandomPort();
      const { server } = await startKeepAliveServer(port);

      writeServiceFiles(homeDir, "mcp.pid", "mcp-port", process.pid, port);

      let barrierError: Error | null = null;
      try {
        await waitForMcpStop({ homeDir });
      } catch (err) {
        barrierError = err as Error;
      } finally {
        server.close();
        try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
      }

      assert.ok(barrierError !== null, "expected waitForMcpStop to throw on timeout");
      assert.match(barrierError!.message, /mcp/i, "error should name the MCP server");
      assert.match(barrierError!.message, /10s|within/i, "error should mention the timeout");
    });

    it("waitForDaemonStop times out and error names daemon", async () => {
      const { homeDir } = createTempHome("tamandua-barrier-");
      fs.mkdirSync(path.join(homeDir, ".tamandua"), { recursive: true });

      const port = await reserveRandomPort();
      const { server } = await startKeepAliveServer(port);

      writeServiceFiles(homeDir, "tamandua.pid", "control-plane-port", process.pid, port);

      let barrierError: Error | null = null;
      try {
        await waitForDaemonStop({ homeDir });
      } catch (err) {
        barrierError = err as Error;
      } finally {
        server.close();
        try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
      }

      assert.ok(barrierError !== null, "expected waitForDaemonStop to throw on timeout");
      assert.match(barrierError!.message, /daemon/i, "error should name the daemon");
      assert.match(barrierError!.message, /10s|within/i, "error should mention the timeout");
    });
  });
});
