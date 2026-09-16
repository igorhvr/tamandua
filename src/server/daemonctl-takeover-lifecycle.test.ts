/**
 * DPID takeover lifecycle tests (US-005).
 *
 * End-to-end proofs that the daemon lifecycle commands use takeover
 * resolution, against REAL processes with a private temp HOME and ephemeral
 * control ports:
 *
 *  1. Deleting the pidfile of a running daemon does not hide it:
 *     getDaemonStatus/isRunning still report the live pid (port-holder
 *     fallback) and getDaemonStatusAsync resolves it by socket identity.
 *  2. restartDaemon replaces that pidfile-less daemon with a NEW pid on the
 *     same port.
 *  3. `startDaemon` returns the live daemon instead of spawning a second one,
 *     both by socket identity and (with the socket file removed) by the
 *     verified control-port holder.
 *  4. A SIGTERM-ignoring child whose argv ends in `/server/daemon.js` and
 *     which holds the control port is removed by stopDaemonTakeover via
 *     SIGKILL within grace + a small bound, and the port is free afterwards.
 *  5. `tamandua daemon stop` (the real CLI, subprocess) stops that
 *     pidfile-less daemon through the takeover path.
 *
 * Serial lane: spawns processes (node:child_process + the daemonctl spawn
 * sites). Every test uses a private temp HOME and ephemeral ports; the live
 * ~/.tamandua and the production daemon are never touched.
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
  getDaemonStatus,
  getDaemonStatusAsync,
  getPidFile,
  isRunning,
  restartDaemon,
  startDaemon,
  stopDaemon,
  stopDaemonAsync,
  stopDaemonTakeover,
  writeControlPlanePort,
} from "../../dist/server/daemonctl.js";
import {
  getServiceSocketPath,
  probeIdentitySocket,
} from "../../dist/server/daemon-identity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "cli", "cli.js");

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
      env: cleanChildEnv({ HOME: homeDir }),
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
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

async function waitForSocket(
  socketPath: string,
  timeoutMs = 15_000,
): Promise<{ pid: number } | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const identity = await probeIdentitySocket(socketPath, 250);
    if (identity) return identity;
    await sleep(50);
  }
  return null;
}

async function reservePort(): Promise<number> {
  const handle = await reservePortHandle();
  const port = handle.port;
  await handle.close();
  return port;
}

/** pidfile-less daemon cleanup: best-effort exact-pid stop + force kill. */
async function cleanupDaemon(homeDir: string): Promise<void> {
  try {
    await stopDaemonAsync({ homeDir });
  } catch {
    // Best effort.
  }
  try {
    stopDaemon({ homeDir });
  } catch {
    // Best effort.
  }
}

const WEDGED_SCRIPT = `
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

async function forceKill(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  await waitForPidGone(child.pid, 3000).catch(() => {});
}

describe("daemonctl pidfile-less takeover lifecycle (DPID)", { concurrency: 1 }, () => {
  it("reports a pidfile-less daemon by port holder and by socket identity", async () => {
    const { homeDir } = createTempHome("tamandua-dpid-lifecycle-status-");
    const port = await reservePort();
    const started = await startDaemon(port, { homeDir });

    try {
      await waitForHttpUp(`http://127.0.0.1:${port}/control/health`);
      const pidFile = getPidFile({ homeDir });
      assert.equal(fs.readFileSync(pidFile, "utf-8").trim(), String(started.pid));

      // The defect: the pidfile disappears while the daemon keeps serving.
      fs.unlinkSync(pidFile);

      const sync = isRunning({ homeDir });
      assert.equal(sync.running, true, "isRunning must find the pidfile-less daemon");
      assert.equal(sync.running === true && sync.pid, started.pid);

      const status = getDaemonStatus({ homeDir });
      assert.equal(status.running, true);
      assert.equal(status.pid, started.pid);
      assert.equal(status.port, port);

      const detailed = await getDaemonStatusAsync({ homeDir });
      assert.equal(detailed.running, true);
      assert.equal(detailed.pid, started.pid);
      assert.equal(detailed.source, "socket");

      // The socket still answers authoritatively.
      const identity = await probeIdentitySocket(getServiceSocketPath("daemon", { homeDir }), 500);
      assert.ok(identity);
      assert.equal(identity.pid, started.pid);
    } finally {
      await cleanupDaemon(homeDir);
    }
  });

  it("restartDaemon replaces a pidfile-less daemon with a different pid on the same port", async () => {
    const { homeDir } = createTempHome("tamandua-dpid-lifecycle-restart-");
    const port = await reservePort();
    const first = await startDaemon(port, { homeDir });
    let restartedPid: number | undefined;

    try {
      await waitForHttpUp(`http://127.0.0.1:${port}/control/health`);
      fs.unlinkSync(getPidFile({ homeDir }));

      const result = await restartDaemon(port, { homeDir });
      restartedPid = result.pid;
      assert.equal(result.port, port, "restart must reuse the same control port");
      assert.notEqual(result.pid, first.pid, "restart must spawn a new process");
      await waitForHttpUp(`http://127.0.0.1:${port}/control/health`);

      // The fresh start re-wrote the pidfile hint.
      assert.equal(
        fs.readFileSync(getPidFile({ homeDir }), "utf-8").trim(),
        String(result.pid),
      );
      const identity = await waitForSocket(getServiceSocketPath("daemon", { homeDir }));
      assert.ok(identity);
      assert.equal(identity.pid, result.pid);

      // The old pid is gone.
      await waitForPidGone(first.pid);
    } finally {
      await cleanupDaemon(homeDir);
      if (restartedPid !== undefined) await waitForPidGone(restartedPid).catch(() => {});
    }
  });

  it("startDaemon never spawns a second daemon when one is already live (socket + port holder)", async () => {
    const { homeDir } = createTempHome("tamandua-dpid-lifecycle-collision-");
    const port = await reservePort();
    const first = await startDaemon(port, { homeDir });

    try {
      await waitForHttpUp(`http://127.0.0.1:${port}/control/health`);

      // (a) Socket path: a second start returns the live pid.
      const second = await startDaemon(port, { homeDir });
      assert.equal(second.pid, first.pid, "socket resolution must prevent a second spawn");

      // (b) Port-holder path: remove BOTH hints (pidfile + socket file) and
      // start again — only ss/lsof can find the live holder now.
      fs.unlinkSync(getPidFile({ homeDir }));
      const socketFile = getServiceSocketPath("daemon", { homeDir });
      if (fs.existsSync(socketFile)) fs.unlinkSync(socketFile);

      const third = await startDaemon(port, { homeDir });
      assert.equal(third.pid, first.pid, "port-holder resolution must prevent a second spawn");
      assert.equal(third.port, port);

      // Still exactly the one original process serving.
      assert.equal(await isPortOpen(port), true);
      const status = getDaemonStatus({ homeDir });
      assert.equal(status.running, true);
      assert.equal(status.pid, first.pid);
    } finally {
      await cleanupDaemon(homeDir);
      await waitForPidGone(first.pid).catch(() => {});
    }
  });

  it("escalates to SIGKILL for a SIGTERM-ignoring Tamandua holder and frees the port", async () => {
    const { root, homeDir } = createTempHome("tamandua-dpid-lifecycle-wedged-");
    const port = await reservePort();

    // argv script path ends with /server/daemon.js → passes the Tamandua
    // cmdline verification, exactly like an older/wedged daemon build.
    const scriptDir = path.join(root, "server");
    fs.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, "daemon.js");
    fs.writeFileSync(scriptPath, WEDGED_SCRIPT, "utf-8");

    // The takeover resolves the port via readControlPlanePort(opts).
    writeControlPlanePort(port, { homeDir });

    const child = spawn("node", [scriptPath], {
      env: cleanChildEnv({ HOME: homeDir, WEDGED_PORT: String(port) }),
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForWedgedReady(child);
      await waitForPortOpen(port);
      assert.ok(child.pid, "wedged child must have a pid");

      const startedAt = Date.now();
      const result = await stopDaemonTakeover(
        // canSignal override keeps this test platform-independent (no procfs
        // HOME binding requirement) while still exercising real signals.
        { homeDir, canSignal: () => true },
        { graceMs: 700, pollMs: 50, killWaitMs: 3000, portVerifyTimeoutMs: 5000 },
      );
      const elapsed = Date.now() - startedAt;

      assert.equal(result.stopped, true);
      assert.equal(result.pid, child.pid);
      assert.equal(result.escalated, true, "a SIGTERM-ignoring process must be SIGKILLed");
      assert.equal(result.portFree, true, "the control port must be free after takeover");
      await waitForPidGone(child.pid);
      assert.equal(await isPortOpen(port), false, "port must not accept connections");
      assert.ok(
        elapsed < 700 + 6000,
        `takeover must finish within grace + a small bound (took ${elapsed}ms)`,
      );
    } finally {
      await forceKill(child);
    }
  });

  it("`tamandua daemon stop` stops a pidfile-less daemon via the takeover path (real CLI)", async () => {
    const { homeDir } = createTempHome("tamandua-dpid-lifecycle-cli-stop-");
    const port = await reservePort();
    const started = await startDaemon(port, { homeDir });

    try {
      await waitForHttpUp(`http://127.0.0.1:${port}/control/health`);
      fs.unlinkSync(getPidFile({ homeDir }));

      const result = await runCli(["daemon", "stop"], homeDir);
      assert.equal(
        result.exitCode,
        0,
        `daemon stop must exit 0; stderr=${result.stderr}`,
      );
      assert.match(result.stdout, /stopped \(PID \d+/);
      assert.match(result.stdout, /port free/);

      // The exact resolved pid was stopped, the port freed, socket gone.
      await waitForPidGone(started.pid);
      assert.equal(await isPortOpen(port), false);
      assert.equal(
        await probeIdentitySocket(getServiceSocketPath("daemon", { homeDir }), 250),
        null,
        "the identity socket must stop answering after the CLI stop",
      );
    } finally {
      await cleanupDaemon(homeDir);
      await waitForPidGone(started.pid).catch(() => {});
    }
  });
});
