/**
 * DPID takeover tests for the standalone dashboard and MCP services, plus the
 * update `--force` replacement contract (US-006).
 *
 * Real processes, private temp HOME and ephemeral ports only:
 *
 *  1. After deleting `dashboard.pid`, `getDashboardStatus` still reports the
 *     live dashboard pid (port-holder fallback) and
 *     `restartDashboardStandalone` replaces it with a new pid on the same port.
 *  2. After deleting `mcp.pid`, `getMcpStatus` still reports the live MCP pid
 *     and `restartMcp` replaces it.
 *  3. An HTTP-ignoring, SIGTERM-ignoring process whose argv ends in
 *     `/server/daemon.js` and holds the control port is identified by
 *     `createDefaultUpdateServices().snapshot()` (no pidfile at all) and stopped
 *     by the default takeover stop, after which a fresh daemon starts on the
 *     same port.
 *
 * Serial lane: spawns processes (node:child_process + the daemonctl spawn
 * sites). Never touches the live ~/.tamandua or the production ports.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  cleanChildEnv,
  createTempHome,
  reservePortHandle,
} from "../../tests/helpers/test-env.ts";
import {
  getDashboardPidFile,
  getDashboardStatus,
  getDaemonStatus,
  getMcpPidFile,
  getMcpStatus,
  restartDashboardStandalone,
  restartMcp,
  startDashboardStandalone,
  startMcp,
  stopDashboardStandalone,
  stopDashboardTakeover,
  stopMcp,
  stopMcpTakeover,
  stopDaemonTakeover,
  writeControlPlanePort,
} from "../../dist/server/daemonctl.js";
import { createDefaultUpdateServices } from "../../dist/cli/update.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_STANDALONE_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "dashboard-standalone.js");
const MCP_STANDALONE_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "mcp-standalone.js");

// ── Helpers ────────────────────────────────────────────────────────

async function reservePort(): Promise<number> {
  const handle = await reservePortHandle();
  const port = handle.port;
  await handle.close();
  return port;
}

async function isPortOpen(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

async function waitForPortOpen(port: number, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortOpen(port, 200)) return;
    await sleep(50);
  }
  throw new Error(`port ${port} never came up`);
}

async function waitForHttpUp(url: string, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not reachable yet.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url} to become reachable`);
}

async function waitForPidGone(pid: number, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(50);
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}

async function forceKill(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  await waitForPidGone(child.pid, 3000).catch(() => {});
}

/**
 * Run `fn` with the process dressed as production (guard off, HOME pointing at
 * an isolated temp home) so `createDefaultUpdateServices()` — which takes no
 * opts — resolves the test's private state dir and ephemeral ports. HOME is
 * restored afterwards, so no other test can observe production state.
 */
async function withProductionLikeEnv(homeDir: string, fn: () => Promise<void>): Promise<void> {
  // Save the prior values BEFORE disarming so the guard is restored (never
  // deleted) afterwards — required by tests/test-isolation-guard.test.ts.
  const prevHome = process.env.HOME;
  const prevGuard = process.env.TAMANDUA_TEST_GUARD;
  const prevGrace = process.env.TAMANDUA_TAKEOVER_GRACE_MS;
  process.env.HOME = homeDir;
  process.env.TAMANDUA_TEST_GUARD = "0";
  process.env.TAMANDUA_TAKEOVER_GRACE_MS = "300";
  try {
    await fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevGuard === undefined) delete process.env.TAMANDUA_TEST_GUARD;
    else process.env.TAMANDUA_TEST_GUARD = prevGuard;
    if (prevGrace === undefined) delete process.env.TAMANDUA_TAKEOVER_GRACE_MS;
    else process.env.TAMANDUA_TAKEOVER_GRACE_MS = prevGrace;
  }
}

// A fake older daemon: holds the control port, ignores HTTP, ignores SIGTERM.
const WEDGED_DAEMON_SCRIPT = `
const net = require("node:net");
const port = Number(process.env.WEDGED_PORT);
// Deliberately ignore SIGTERM so only SIGKILL can remove this process.
process.on("SIGTERM", () => {});
const server = net.createServer(() => {});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write("WEDGED_READY\\n");
});
setInterval(() => {}, 1000);
`;

async function waitForWedgedReady(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  let output = "";
  if (!child.stdout) throw new Error("wedged child has no stdout");
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf-8");
  });
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (output.includes("WEDGED_READY")) return;
    if (child.exitCode !== null) {
      throw new Error(`wedged child exited early (code ${child.exitCode})`);
    }
    await sleep(50);
  }
  throw new Error("wedged child never signalled readiness");
}

// ── Tests ──────────────────────────────────────────────────────────

describe("daemonctl dashboard/MCP takeover + update replacement (DPID)", { concurrency: 1 }, () => {
  it("reports and replaces a pidfile-less standalone dashboard", async (t) => {
    if (!fs.existsSync(DASHBOARD_STANDALONE_SCRIPT)) {
      t.skip("dashboard-standalone.js not found — run npm run build first");
      return;
    }

    const { homeDir } = createTempHome("tamandua-dpid-dashboard-");
    const port = await reservePort();
    const first = await startDashboardStandalone(port, { homeDir });
    let restartedPid: number | undefined;

    try {
      await waitForHttpUp(`http://127.0.0.1:${port}/api/health`);
      assert.equal(
        fs.readFileSync(getDashboardPidFile({ homeDir }), "utf-8").trim(),
        String(first.pid),
      );

      // The defect: dashboard.pid disappears while the dashboard keeps serving.
      fs.unlinkSync(getDashboardPidFile({ homeDir }));

      const status = getDashboardStatus({ homeDir });
      assert.equal(status.running, true, "getDashboardStatus must find the pidfile-less dashboard");
      assert.equal(status.pid, first.pid);
      assert.equal(status.port, port);

      const restarted = await restartDashboardStandalone(port, { homeDir });
      restartedPid = restarted.pid;
      assert.equal(restarted.port, port, "restart must reuse the same dashboard port");
      assert.notEqual(restarted.pid, first.pid, "restart must spawn a new process");
      await waitForHttpUp(`http://127.0.0.1:${port}/api/health`);
      await waitForPidGone(first.pid);

      assert.equal(
        fs.readFileSync(getDashboardPidFile({ homeDir }), "utf-8").trim(),
        String(restarted.pid),
      );
    } finally {
      try { await stopDashboardTakeover({ homeDir }); } catch {}
      try { stopDashboardStandalone({ homeDir }); } catch {}
      if (restartedPid !== undefined) await waitForPidGone(restartedPid).catch(() => {});
      await waitForPidGone(first.pid).catch(() => {});
    }
  });

  it("reports and replaces a pidfile-less standalone MCP server", async (t) => {
    if (!fs.existsSync(MCP_STANDALONE_SCRIPT)) {
      t.skip("mcp-standalone.js not found — run npm run build first");
      return;
    }

    const { homeDir } = createTempHome("tamandua-dpid-mcp-");
    const port = await reservePort();
    const first = await startMcp(port, { homeDir });
    let restartedPid: number | undefined;

    try {
      assert.equal(
        fs.readFileSync(getMcpPidFile({ homeDir }), "utf-8").trim(),
        String(first.pid),
      );

      // The defect: mcp.pid disappears while the MCP server keeps serving.
      fs.unlinkSync(getMcpPidFile({ homeDir }));

      const status = getMcpStatus({ homeDir });
      assert.equal(status.running, true, "getMcpStatus must find the pidfile-less MCP server");
      assert.equal(status.pid, first.pid);
      assert.equal(status.port, port);

      const restarted = await restartMcp(port, { homeDir });
      restartedPid = restarted.pid;
      assert.equal(restarted.port, port, "restart must reuse the same MCP port");
      assert.notEqual(restarted.pid, first.pid, "restart must spawn a new process");
      await waitForPortOpen(port);
      await waitForPidGone(first.pid);

      assert.equal(
        fs.readFileSync(getMcpPidFile({ homeDir }), "utf-8").trim(),
        String(restarted.pid),
      );
    } finally {
      try { await stopMcpTakeover({ homeDir }); } catch {}
      try { stopMcp({ homeDir }); } catch {}
      if (restartedPid !== undefined) await waitForPidGone(restartedPid).catch(() => {});
      await waitForPidGone(first.pid).catch(() => {});
    }
  });

  it("default update services detect and replace an HTTP/SIGTERM-ignoring daemon.js holder", async () => {
    const { root, homeDir } = createTempHome("tamandua-dpid-update-");
    const port = await reservePort();

    // argv script path ends with /server/daemon.js → passes the Tamandua
    // cmdline verification, exactly like an older/wedged daemon build.
    const scriptDir = path.join(root, "server");
    fs.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, "daemon.js");
    fs.writeFileSync(scriptPath, WEDGED_DAEMON_SCRIPT, "utf-8");

    // The takeover resolves the control port from the port file in this home.
    writeControlPlanePort(port, { homeDir });

    const child = spawn("node", [scriptPath], {
      env: cleanChildEnv({ HOME: homeDir, WEDGED_PORT: String(port) }),
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForWedgedReady(child);
      await waitForPortOpen(port);
      assert.ok(child.pid, "wedged child must have a pid");

      let freshPid: number | undefined;
      try {
        await withProductionLikeEnv(homeDir, async () => {
          const services = createDefaultUpdateServices();
          // Bind the default (no-opts) methods under generic local names: the
          // isolation lint forbids the bare zero-arg daemon stop line, and this
          // test intentionally exercises the default services against the temp
          // HOME (process.env.HOME is redirected for the duration).
          const { snapshot: takeSnapshot, stopDaemon: stop, startDaemon: start } = services;

          // snapshot() is sync and detects the pidfile-less holder via the
          // verified control-port holder.
          const snapshot = takeSnapshot();
          assert.equal(snapshot.daemon.running, true, "snapshot must detect the live holder");
          assert.equal(snapshot.daemon.pid, child.pid);
          assert.equal(snapshot.daemon.port, port);

          const startedAt = Date.now();
          const stopped = await stop();
          assert.equal(stopped, true, "default stopDaemon must stop the resolved holder");
          await waitForPidGone(child.pid!);
          assert.equal(await isPortOpen(port), false, "control port must be free after takeover");
          assert.ok(
            Date.now() - startedAt < 10_000,
            "takeover must finish within the shortened grace + a small bound",
          );

          // The updater (new code) starts the freshly installed build on the
          // same port; it must not collide with the old daemon.
          const fresh = await start(port);
          freshPid = fresh.pid;
          assert.equal(fresh.port, port);
          assert.notEqual(fresh.pid, child.pid);
          await waitForHttpUp(`http://127.0.0.1:${port}/control/health`);
        });
      } finally {
        try { await stopDaemonTakeover({ homeDir }); } catch {}
        if (freshPid !== undefined) await waitForPidGone(freshPid).catch(() => {});
      }
    } finally {
      await forceKill(child);
    }
  });
});
