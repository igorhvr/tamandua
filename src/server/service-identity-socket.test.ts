/**
 * US-003 — standalone dashboard/MCP identity sockets (DPID).
 *
 * The standalone `dashboard-standalone.ts` and `mcp-standalone.ts` servers bind
 * the same state-dir Unix-socket primitive as the daemon (`dashboard.sock` /
 * `mcp.sock`), so liveness/stop on macOS no longer depends on lsof/pidfile
 * parsing; `startDashboardStandalone` / `startMcp` adopt a live socket instead
 * of spawning a duplicate, and a socket advertising a DIFFERENT state dir is
 * never adopted.
 *
 * Serial lane: spawns real dashboard/MCP children (daemonctl spawn sites) and
 * real processes. Private temp HOME + ephemeral ports only — never the live
 * ~/.tamandua or a production port.
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createTempHome } from "../../tests/helpers/test-env.ts";
import { reservePortHandle } from "../../tests/helpers/test-env.ts";
import {
  getDashboardPidFile,
  getDashboardPortFile,
  getMcpPidFile,
  getMcpPortFile,
  resolveLiveDashboard,
  resolveLiveMcp,
  startDashboardStandalone,
  startMcp,
  stopDashboardTakeover,
  stopMcpTakeover,
} from "../../dist/server/daemonctl.js";
import {
  bindIdentitySocket,
  getServiceSocketPath,
  probeIdentitySocket,
  type BoundIdentitySocket,
  type DaemonIdentity,
} from "../../dist/server/daemon-identity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_STANDALONE_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "dashboard-standalone.js");
const MCP_STANDALONE_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "mcp-standalone.js");

/** Reserve a free port and immediately release it for the service to bind. */
async function reservePort(): Promise<number> {
  const handle = await reservePortHandle();
  const port = handle.port;
  await handle.close();
  return port;
}

async function waitForIdentity(socketPath: string, timeoutMs = 10_000): Promise<DaemonIdentity> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const identity = await probeIdentitySocket(socketPath, 300);
    if (identity) return identity;
    await sleep(50);
  }
  throw new Error(`identity socket ${socketPath} never answered`);
}

async function waitForPidGone(pid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(50);
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}

function writePortFile(file: string, port: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(port), "utf-8");
}

describe("service identity sockets (DPID US-003)", { concurrency: 1 }, () => {
  it("standalone dashboard binds dashboard.sock; resolve is socket-first and stop removes it", async (t) => {
    if (!fs.existsSync(DASHBOARD_STANDALONE_SCRIPT)) {
      t.skip("dashboard-standalone.js not found — run npm run build first");
      return;
    }

    const { homeDir } = createTempHome("tamandua-sid-dashboard-");
    const socketPath = getServiceSocketPath("dashboard", { homeDir });
    const port = await reservePort();
    let startedPid: number | undefined;

    try {
      const started = await startDashboardStandalone(port, { homeDir });
      startedPid = started.pid;

      const identity = await waitForIdentity(socketPath);
      assert.equal(identity.pid, started.pid, "socket pid must match the started dashboard");
      assert.equal(identity.controlPort, port, "socket controlPort must be the dashboard port");
      assert.equal(
        path.resolve(identity.stateDir ?? ""),
        path.join(homeDir, ".tamandua"),
        "socket must advertise the effective state dir",
      );

      // The defect shape: the pidfile disappears while the service keeps serving.
      fs.unlinkSync(getDashboardPidFile({ homeDir }));
      const live = await resolveLiveDashboard({ homeDir });
      assert.ok(live, "resolveLiveDashboard must find the pidfile-less dashboard");
      assert.equal(live.source, "socket", "the identity socket must be the resolution source");
      assert.equal(live.pid, started.pid);
      assert.equal(live.port, port);

      // A second start must adopt the live socket instead of spawning a duplicate.
      const adopted = await startDashboardStandalone(port, { homeDir });
      assert.equal(adopted.pid, started.pid, "start must not spawn a duplicate dashboard");
      assert.equal(adopted.port, port);

      const stop = await stopDashboardTakeover({ homeDir });
      assert.equal(stop.stopped, true, "the socket-resolved dashboard must be stopped");
      assert.equal(fs.existsSync(socketPath), false, "stop must remove dashboard.sock");
      await waitForPidGone(started.pid);
      startedPid = undefined;
    } finally {
      if (startedPid !== undefined) {
        try {
          await stopDashboardTakeover({ homeDir });
        } catch {
          // Best effort.
        }
        await waitForPidGone(startedPid).catch(() => {});
      }
    }
  });

  it("standalone MCP binds mcp.sock; resolve is socket-first and stop removes it", async (t) => {
    if (!fs.existsSync(MCP_STANDALONE_SCRIPT)) {
      t.skip("mcp-standalone.js not found — run npm run build first");
      return;
    }

    const { homeDir } = createTempHome("tamandua-sid-mcp-");
    const socketPath = getServiceSocketPath("mcp", { homeDir });
    const port = await reservePort();
    let startedPid: number | undefined;

    try {
      const started = await startMcp(port, { homeDir });
      startedPid = started.pid;

      const identity = await waitForIdentity(socketPath);
      assert.equal(identity.pid, started.pid, "socket pid must match the started MCP server");
      assert.equal(identity.controlPort, port, "socket controlPort must be the MCP port");
      assert.equal(
        path.resolve(identity.stateDir ?? ""),
        path.join(homeDir, ".tamandua"),
        "socket must advertise the effective state dir",
      );

      fs.unlinkSync(getMcpPidFile({ homeDir }));
      const live = await resolveLiveMcp({ homeDir });
      assert.ok(live, "resolveLiveMcp must find the pidfile-less MCP server");
      assert.equal(live.source, "socket", "the identity socket must be the resolution source");
      assert.equal(live.pid, started.pid);
      assert.equal(live.port, port);

      const adopted = await startMcp(port, { homeDir });
      assert.equal(adopted.pid, started.pid, "start must not spawn a duplicate MCP server");
      assert.equal(adopted.port, port);

      const stop = await stopMcpTakeover({ homeDir });
      assert.equal(stop.stopped, true, "the socket-resolved MCP server must be stopped");
      assert.equal(fs.existsSync(socketPath), false, "stop must remove mcp.sock");
      await waitForPidGone(started.pid);
      startedPid = undefined;
    } finally {
      if (startedPid !== undefined) {
        try {
          await stopMcpTakeover({ homeDir });
        } catch {
          // Best effort.
        }
        await waitForPidGone(startedPid).catch(() => {});
      }
    }
  });

  it("adopts a matching-stateDir socket but never a socket advertising another state dir", async () => {
    const { homeDir } = createTempHome("tamandua-sid-scope-");
    const ownStateDir = path.join(homeDir, ".tamandua");
    const foreignStateDir = path.join(homeDir, "foreign-state");
    fs.mkdirSync(foreignStateDir, { recursive: true });

    const bound: BoundIdentitySocket[] = [];
    try {
      // A matching-stateDir socket is ours.
      const dashboardPort = await reservePort();
      const ownDashboard = await bindIdentitySocket(
        getServiceSocketPath("dashboard", { homeDir }),
        {
          pid: process.pid,
          buildVersion: "test",
          controlPort: dashboardPort,
          startedAt: new Date().toISOString(),
          stateDir: ownStateDir,
        },
      );
      bound.push(ownDashboard);

      const dashboardLive = await resolveLiveDashboard({ homeDir });
      assert.ok(dashboardLive, "a matching-stateDir dashboard socket must be adopted");
      assert.equal(dashboardLive.source, "socket");
      assert.equal(dashboardLive.pid, process.pid);
      assert.equal(dashboardLive.port, dashboardPort);

      // A foreign-stateDir socket is not ours, even on the same socket path.
      await ownDashboard.close();
      const foreignDashboard = await bindIdentitySocket(
        getServiceSocketPath("dashboard", { homeDir }),
        {
          pid: process.pid,
          buildVersion: "test",
          controlPort: dashboardPort,
          startedAt: new Date().toISOString(),
          stateDir: foreignStateDir,
        },
      );
      bound.push(foreignDashboard);
      // Point the dashboard port file at a free port so the port-holder stage
      // cannot accidentally resolve anything either.
      writePortFile(getDashboardPortFile({ homeDir }), await reservePort());
      assert.equal(
        await resolveLiveDashboard({ homeDir }),
        null,
        "a socket advertising a different state dir must not be adopted",
      );

      // Same contract for MCP.
      const mcpPort = await reservePort();
      const ownMcp = await bindIdentitySocket(getServiceSocketPath("mcp", { homeDir }), {
        pid: process.pid,
        buildVersion: "test",
        controlPort: mcpPort,
        startedAt: new Date().toISOString(),
        stateDir: ownStateDir,
      });
      bound.push(ownMcp);

      const mcpLive = await resolveLiveMcp({ homeDir });
      assert.ok(mcpLive, "a matching-stateDir MCP socket must be adopted");
      assert.equal(mcpLive.source, "socket");
      assert.equal(mcpLive.pid, process.pid);
      assert.equal(mcpLive.port, mcpPort);

      await ownMcp.close();
      const foreignMcp = await bindIdentitySocket(getServiceSocketPath("mcp", { homeDir }), {
        pid: process.pid,
        buildVersion: "test",
        controlPort: mcpPort,
        startedAt: new Date().toISOString(),
        stateDir: foreignStateDir,
      });
      bound.push(foreignMcp);
      writePortFile(getMcpPortFile({ homeDir }), await reservePort());
      assert.equal(
        await resolveLiveMcp({ homeDir }),
        null,
        "a socket advertising a different state dir must not be adopted",
      );

      // The live (foreign) socket must still answer — we never unlinked it.
      assert.ok(await probeIdentitySocket(getServiceSocketPath("mcp", { homeDir }), 300));
    } finally {
      for (const socket of bound) {
        await socket.close().catch(() => {});
      }
    }
  });
});
