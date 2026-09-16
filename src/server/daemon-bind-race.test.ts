/**
 * DPID bind-first daemon startup tests (US-003).
 *
 * Every test spawns `dist/server/daemon.js` with a private temp HOME and an
 * ephemeral control port, so the live ~/.tamandua state (and the live daemon on
 * port 3339) is never touched. This file is spawn-capable and therefore listed
 * in tests/serial-files.txt.
 *
 * The defect being pinned: the daemon used to write its pidfile BEFORE binding
 * the control port. A losing bind-race daemon then unlinked the file (which
 * contained its own pid) on the way out, stranding a LIVE daemon with no
 * pidfile. The contract now is: bind the identity socket, bind the TCP port,
 * and only then write the pidfile — a loser leaves no file behind.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { cleanChildEnv, createTempHome, reservePortHandle } from "../../tests/helpers/test-env.ts";
import {
  getServiceSocketPath,
  probeIdentitySocket,
} from "../../dist/server/daemon-identity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "daemon.js");
const DAEMON_SOURCE = path.resolve(__dirname, "daemon.ts");

interface SpawnedDaemon {
  child: ChildProcess;
  getOutput: () => string;
}

function spawnDaemon(
  homeDir: string,
  controlPort: number,
  extraEnv: Record<string, string> = {},
): SpawnedDaemon {
  let output = "";
  const child = spawn("node", [DAEMON_SCRIPT], {
    env: cleanChildEnv({
      HOME: homeDir,
      TAMANDUA_CONTROL_PORT: String(controlPort),
      ...extraEnv,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf-8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf-8");
  });

  return { child, getOutput: () => output };
}

async function waitForExit(child: ChildProcess, timeoutMs = 30_000): Promise<number> {
  if (child.exitCode !== null) return child.exitCode;

  return await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for daemon process ${child.pid} to exit`));
    }, timeoutMs);

    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code ?? 0);
    });
  });
}

async function forceKillIfAlive(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || !child.pid) return;
  try {
    process.kill(child.pid, 0);
  } catch {
    return;
  }
  child.kill("SIGKILL");
  await waitForExit(child, 2000).catch(() => {});
}

async function waitForHttpUp(url: string, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
      lastError = new Error(`unexpected status ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url} to become reachable: ${String(lastError)}`);
}

async function waitForHttpDown(url: string, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(url);
      await sleep(100);
    } catch {
      return;
    }
  }
  throw new Error(`Timed out waiting for ${url} to become unreachable`);
}

/** Wait until a probe answers an identity, or null after the timeout. */
async function waitForLiveIdentity(
  socketPath: string,
  timeoutMs = 10_000,
): Promise<{ pid: number; controlPort: number } | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const identity = await probeIdentitySocket(socketPath, 250);
    if (identity) return identity;
    await sleep(50);
  }
  return null;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

describe("daemon bind-first startup and bind-race loser (DPID)", { concurrency: 1 }, () => {
  it("binds the identity socket before writing the pidfile (source order)", () => {
    const source = fs.readFileSync(DAEMON_SOURCE, "utf-8");
    const bootstrapStart = source.indexOf("async function bootstrap()");
    assert.ok(bootstrapStart !== -1, "bootstrap() must exist");

    const bootstrap = source.slice(bootstrapStart);
    const bindIdentity = bootstrap.indexOf("bindIdentitySocket(");
    const startControl = bootstrap.indexOf("startControlServer(");
    // The call site, not the function definition.
    const writePid = bootstrap.indexOf("writePidFile();");

    assert.ok(bindIdentity !== -1, "bootstrap must bind the identity socket");
    assert.ok(startControl !== -1, "bootstrap must start the control server");
    assert.ok(writePid !== -1, "bootstrap must write the pidfile");
    assert.ok(
      bindIdentity < startControl,
      "identity socket must be bound before the control-port bind",
    );
    assert.ok(
      startControl < writePid,
      "pidfile must be written only after the control port binds",
    );
    assert.ok(
      !/bootstrap\(\)\s*\{\s*\n\s*writePidFile\(\);/.test(bootstrap),
      "bootstrap must not call writePidFile() first",
    );
  });

  it("after a successful isolated start the identity socket answers with the daemon pid and control port", async () => {
    const portHandle = await reservePortHandle();
    const controlPort = portHandle.port;
    const { homeDir } = createTempHome("tamandua-dpid-bind-race-ok-");
    await portHandle.close();

    const daemon = spawnDaemon(homeDir, controlPort);
    const socketPath = getServiceSocketPath("daemon", { homeDir });
    const pidFile = path.join(homeDir, ".tamandua", "tamandua.pid");

    try {
      await waitForHttpUp(`http://127.0.0.1:${controlPort}/control/health`);

      // The socket must answer with this exact daemon's pid + control port.
      const identity = await waitForLiveIdentity(socketPath);
      assert.ok(identity, "daemon.sock must answer an identity probe after startup");
      assert.equal(identity.pid, daemon.child.pid);
      assert.equal(identity.controlPort, controlPort);

      // The pidfile is written too (informational hint).
      assert.ok(fs.existsSync(pidFile), "pidfile should exist after a successful start");
      assert.equal(fs.readFileSync(pidFile, "utf-8").trim(), String(daemon.child.pid));

      // Clean shutdown removes both the socket and the pidfile.
      daemon.child.kill("SIGTERM");
      const exitCode = await waitForExit(daemon.child);
      assert.equal(exitCode, 0);
      await waitForHttpDown(`http://127.0.0.1:${controlPort}/control/health`);

      assert.equal(await probeIdentitySocket(socketPath, 250), null, "socket must be gone");
      assert.equal(fs.existsSync(socketPath), false, "socket file must be unlinked");
      assert.equal(fs.existsSync(pidFile), false, "pidfile must be cleaned up");
    } finally {
      await forceKillIfAlive(daemon.child);
    }
  });

  it("a losing bind-race daemon exits non-zero, writes no pidfile, and leaves no answering socket", async () => {
    // A plain TCP listener already holds the control port; no daemon.sock exists.
    const blockerHandle = await reservePortHandle();
    const controlPort = blockerHandle.port;
    const blocker = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("occupied");
    });
    await blockerHandle.close();
    await new Promise<void>((resolve) => blocker.listen(controlPort, "127.0.0.1", () => resolve()));

    const { homeDir } = createTempHome("tamandua-dpid-bind-race-loser-");
    const daemon = spawnDaemon(homeDir, controlPort);
    const socketPath = getServiceSocketPath("daemon", { homeDir });
    const pidFile = path.join(homeDir, ".tamandua", "tamandua.pid");

    try {
      const exitCode = await waitForExit(daemon.child);
      assert.notEqual(exitCode, 0, "the bind-race loser must exit non-zero");

      const output = daemon.getOutput();
      assert.match(output, /control plane/i);
      assert.match(output, /already in use/i);
      assert.match(output, /Refusing to start/i);

      // A loser must leave NO pidfile and NO answering socket.
      assert.equal(fs.existsSync(pidFile), false, "loser must not create a pidfile");
      assert.equal(
        await probeIdentitySocket(socketPath, 250),
        null,
        "loser's socket must not answer",
      );
      assert.equal(fs.existsSync(socketPath), false, "loser must unlink the socket it created");
    } finally {
      await forceKillIfAlive(daemon.child);
      await closeServer(blocker);
    }
  });

  it("refuses to start when another live daemon owns the identity socket and never touches its pidfile", async () => {
    const portHandleA = await reservePortHandle();
    const controlPortA = portHandleA.port;
    const { homeDir } = createTempHome("tamandua-dpid-identity-in-use-");
    await portHandleA.close();

    const daemonA = spawnDaemon(homeDir, controlPortA);
    const socketPath = getServiceSocketPath("daemon", { homeDir });
    const pidFile = path.join(homeDir, ".tamandua", "tamandua.pid");
    let daemonB: SpawnedDaemon | undefined;

    try {
      await waitForHttpUp(`http://127.0.0.1:${controlPortA}/control/health`);
      const identityA = await waitForLiveIdentity(socketPath);
      assert.ok(identityA, "daemon A socket must answer");
      assert.equal(identityA.pid, daemonA.child.pid);

      // Daemon B: same HOME, different control port → it loses the socket race.
      const portHandleB = await reservePortHandle();
      const controlPortB = portHandleB.port;
      await portHandleB.close();
      daemonB = spawnDaemon(homeDir, controlPortB);

      const exitCodeB = await waitForExit(daemonB.child);
      assert.notEqual(exitCodeB, 0, "daemon B must refuse to start");
      assert.match(daemonB.getOutput(), /already owned by a live daemon/i);
      assert.match(daemonB.getOutput(), new RegExp(`pid ${daemonA.child.pid}\\b`));

      // The live daemon's files are untouched: pidfile still names A, socket
      // still answers with A's identity.
      assert.equal(fs.existsSync(pidFile), true, "live daemon's pidfile must survive");
      assert.equal(fs.readFileSync(pidFile, "utf-8").trim(), String(daemonA.child.pid));
      const identityAfter = await probeIdentitySocket(socketPath, 500);
      assert.ok(identityAfter, "live daemon's socket must still answer");
      assert.equal(identityAfter.pid, daemonA.child.pid);

      daemonA.child.kill("SIGTERM");
      const exitCodeA = await waitForExit(daemonA.child);
      assert.equal(exitCodeA, 0);
    } finally {
      if (daemonB) await forceKillIfAlive(daemonB.child);
      await forceKillIfAlive(daemonA.child);
    }
  });

  it("SIGKILL leaves a stale socket file; the next daemon on the same state dir rebinds it", async () => {
    const { homeDir } = createTempHome("tamandua-dpid-stale-socket-");
    const socketPath = getServiceSocketPath("daemon", { homeDir });

    const portHandleA = await reservePortHandle();
    const controlPortA = portHandleA.port;
    await portHandleA.close();
    const daemonA = spawnDaemon(homeDir, controlPortA);
    let daemonB: SpawnedDaemon | undefined;

    try {
      await waitForHttpUp(`http://127.0.0.1:${controlPortA}/control/health`);
      const identityA = await waitForLiveIdentity(socketPath);
      assert.ok(identityA, "daemon A socket must answer");

      // SIGKILL bypasses the exit handler → the socket FILE survives.
      daemonA.child.kill("SIGKILL");
      await waitForExit(daemonA.child);
      assert.equal(fs.existsSync(socketPath), true, "SIGKILL must leave the stale socket file");
      assert.equal(
        await probeIdentitySocket(socketPath, 250),
        null,
        "a stale socket must not answer",
      );

      // Daemon B: same state dir, different control port → rebinds the stale path.
      const portHandleB = await reservePortHandle();
      const controlPortB = portHandleB.port;
      await portHandleB.close();
      daemonB = spawnDaemon(homeDir, controlPortB);
      await waitForHttpUp(`http://127.0.0.1:${controlPortB}/control/health`);

      const identityB = await waitForLiveIdentity(socketPath);
      assert.ok(identityB, "rebound socket must answer");
      assert.equal(identityB.pid, daemonB.child.pid);
      assert.equal(identityB.controlPort, controlPortB);

      daemonB.child.kill("SIGTERM");
      const exitCodeB = await waitForExit(daemonB.child);
      assert.equal(exitCodeB, 0);
    } finally {
      if (daemonB) await forceKillIfAlive(daemonB.child);
      await forceKillIfAlive(daemonA.child);
    }
  });
});
