import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { cleanChildEnv, reserveRandomPort, createTempHome } from "../../tests/helpers/test-env.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "daemon.js");

function spawnDaemon(
  homeDir: string,
  controlPort: number,
  extraArgs: string[] = [],
): {
  child: ChildProcess;
  getOutput: () => string;
} {
  let output = "";
  const child = spawn("node", [DAEMON_SCRIPT, ...extraArgs], {
    env: cleanChildEnv({ HOME: homeDir,
      TAMANDUA_CONTROL_PORT: String(controlPort), }),
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

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function waitForExit(child: ChildProcess, timeoutMs = 30000): Promise<number> {
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

async function waitForHttpUp(url: string, timeoutMs = 30000): Promise<Response> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fetch(url);
    } catch (err) {
      lastError = err;
      await sleep(100);
    }
  }

  throw new Error(`Timed out waiting for ${url} to become reachable: ${String(lastError)}`);
}

async function waitForHttpDown(url: string, timeoutMs = 30000): Promise<void> {
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
      await closeServer(server);
    }
  }
}


describe("version check integration", () => {
  it("daemon bootstrap triggers version check and writes version-status.json", async (t) => {
    const controlPort = await reserveRandomPort();
    if (!(await canBind(controlPort))) {
      t.skip(`Port ${controlPort} is already in use`);
      return;
    }

    const { homeDir: tempHome } = createTempHome("tamandua-daemon-home-");
    const { child } = spawnDaemon(tempHome, controlPort);

    try {
      // Wait for daemon control plane to be reachable
      const health = await waitForHttpUp(`http://127.0.0.1:${controlPort}/control/health`);
      assert.equal(health.status, 200);

      // Poll for version-status.json — the fire-and-forget version check may
      // take up to 30s (git fetch timeout) or be near-instantaneous.
      const statusPath = path.join(tempHome, ".tamandua", "version-status.json");
      const maxWaitMs = 35_000;
      const pollStart = Date.now();
      let found = false;
      while (Date.now() - pollStart < maxWaitMs) {
        if (fs.existsSync(statusPath)) {
          found = true;
          break;
        }
        await sleep(500);
      }
      assert.ok(found, "version-status.json should exist after daemon bootstrap");

      const raw = fs.readFileSync(statusPath, "utf-8");
      const status = JSON.parse(raw);
      assert.ok("updateAvailable" in status);
      assert.ok("checkedAt" in status);

      process.kill(child.pid!, "SIGTERM");
      const exitCode = await waitForExit(child);
      assert.equal(exitCode, 0);

      await waitForHttpDown(`http://127.0.0.1:${controlPort}/control/health`);
    } finally {
      await forceKillIfAlive(child);
    }
  });

  it("daemon startup not delayed by version check", async (t) => {
    const controlPort = await reserveRandomPort();
    if (!(await canBind(controlPort))) {
      t.skip(`Port ${controlPort} is already in use`);
      return;
    }

    const { homeDir: tempHome } = createTempHome("tamandua-daemon-home-");

    const startTime = Date.now();
    const { child } = spawnDaemon(tempHome, controlPort);

    try {
      // Daemon control plane should be reachable quickly — version check is fire-and-forget
      const health = await waitForHttpUp(`http://127.0.0.1:${controlPort}/control/health`);
      assert.equal(health.status, 200);

      const elapsedMs = Date.now() - startTime;
      // Daemon startup (including control plane) should finish well under 15s
      // (the git fetch timeout is 30s, but we fire-and-forget so it shouldn't block)
      assert.ok(elapsedMs < 15000, `Daemon startup took ${elapsedMs}ms, expected < 15000ms`);

      process.kill(child.pid!, "SIGTERM");
      const exitCode = await waitForExit(child);
      assert.equal(exitCode, 0);

      await waitForHttpDown(`http://127.0.0.1:${controlPort}/control/health`);
    } finally {
      await forceKillIfAlive(child);
    }
  });

  it("daemon shuts down cleanly even when version check interval is active", async (t) => {
    const controlPort = await reserveRandomPort();
    if (!(await canBind(controlPort))) {
      t.skip(`Port ${controlPort} is already in use`);
      return;
    }

    const { homeDir: tempHome } = createTempHome("tamandua-daemon-home-");
    const { child } = spawnDaemon(tempHome, controlPort);

    try {
      const health = await waitForHttpUp(`http://127.0.0.1:${controlPort}/control/health`);
      assert.equal(health.status, 200);

      // Send SIGTERM — daemon should shut down cleanly within 7s
      process.kill(child.pid!, "SIGTERM");
      const exitCode = await waitForExit(child, 7000);
      assert.equal(exitCode, 0);

      await waitForHttpDown(`http://127.0.0.1:${controlPort}/control/health`);

      // PID file should be cleaned up
      const pidFile = path.join(tempHome, ".tamandua", "tamandua.pid");
      assert.equal(fs.existsSync(pidFile), false);
    } finally {
      await forceKillIfAlive(child);
    }
  });
});

describe("daemon (MCP decoupled)", { concurrency: 1 }, () => {
  it("starts daemon control plane by default (no --with-mcp), MCP port is NOT reachable", async (t) => {
    const controlPort = await reserveRandomPort();
    if (!(await canBind(controlPort))) {
      t.skip(`Port ${controlPort} is already in use`);
      return;
    }

    const { homeDir: tempHome } = createTempHome("tamandua-daemon-home-");
    const { child } = spawnDaemon(tempHome, controlPort);

    try {
      const health = await waitForHttpUp(`http://127.0.0.1:${controlPort}/control/health`);
      assert.equal(health.status, 200);

      const mcpPidFile = path.join(tempHome, ".tamandua", "mcp.pid");
      assert.equal(fs.existsSync(mcpPidFile), false, "MCP should not be started without --with-mcp");

      process.kill(child.pid!, "SIGTERM");
      const exitCode = await waitForExit(child);
      assert.equal(exitCode, 0);

      await waitForHttpDown(`http://127.0.0.1:${controlPort}/control/health`);

      const pidFile = path.join(tempHome, ".tamandua", "tamandua.pid");
      assert.equal(fs.existsSync(pidFile), false);
    } finally {
      await forceKillIfAlive(child);
    }
  });

  it("starts daemon + MCP with --with-mcp flag and shuts down both on SIGTERM", async (t) => {
    const controlPort = await reserveRandomPort();
    if (!(await canBind(controlPort))) {
      t.skip(`Port ${controlPort} is already in use`);
      return;
    }
    const mcpPort = await reserveRandomPort();
    if (!(await canBind(mcpPort))) {
      t.skip(`Port ${mcpPort} is already in use`);
      return;
    }

    const { homeDir: tempHome } = createTempHome("tamandua-daemon-home-");
    const { child } = spawnDaemon(tempHome, controlPort, ["--with-mcp", "--mcp-port", String(mcpPort)]);

    try {
      const health = await waitForHttpUp(`http://127.0.0.1:${controlPort}/control/health`);
      assert.equal(health.status, 200);

      const mcp = await waitForHttpUp(`http://127.0.0.1:${mcpPort}/mcp`);
      assert.equal(mcp.status, 400);

      process.kill(child.pid!, "SIGTERM");
      const exitCode = await waitForExit(child);
      assert.equal(exitCode, 0);

      await waitForHttpDown(`http://127.0.0.1:${controlPort}/control/health`);
      await waitForHttpDown(`http://127.0.0.1:${mcpPort}/mcp`);

      const pidFile = path.join(tempHome, ".tamandua", "tamandua.pid");
      assert.equal(fs.existsSync(pidFile), false);
    } finally {
      await forceKillIfAlive(child);
    }
  });

  it("--with-mcp --mcp-port N starts MCP on custom port", async (t) => {
    const customMcpPort = await reserveRandomPort();
    const controlPort = await reserveRandomPort();

    if (!(await canBind(controlPort))) {
      t.skip(`Port ${controlPort} is already in use`);
      return;
    }

    const { homeDir: tempHome } = createTempHome("tamandua-daemon-home-");
    const { child } = spawnDaemon(tempHome, controlPort, [
      "--with-mcp",
      "--mcp-port",
      String(customMcpPort),
    ]);

    try {
      const health = await waitForHttpUp(`http://127.0.0.1:${controlPort}/control/health`);
      assert.equal(health.status, 200);

      const mcp = await waitForHttpUp(`http://127.0.0.1:${customMcpPort}/mcp`);
      assert.equal(mcp.status, 400);

      process.kill(child.pid!, "SIGTERM");
      const exitCode = await waitForExit(child);
      assert.equal(exitCode, 0);

      await waitForHttpDown(`http://127.0.0.1:${controlPort}/control/health`);
      await waitForHttpDown(`http://127.0.0.1:${customMcpPort}/mcp`);
    } finally {
      await forceKillIfAlive(child);
    }
  });

  it("fails startup when MCP port is occupied and --with-mcp is used, daemon is also stopped", async (t) => {
    const blockerPort = await reserveRandomPort();
    const blocker = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("occupied");
    });

    // Bind the wildcard address like the MCP server does: macOS (unlike
    // Linux) lets a wildcard bind coexist with a 127.0.0.1-specific one,
    // so a localhost-only blocker would not produce EADDRINUSE there.
    await new Promise<void>((resolve) => blocker.listen(blockerPort, () => resolve()));

    const controlPort = await reserveRandomPort();

    const { homeDir: tempHome } = createTempHome("tamandua-daemon-home-");
    const { child, getOutput } = spawnDaemon(tempHome, controlPort, ["--with-mcp", "--mcp-port", String(blockerPort)]);

    try {
      const exitCode = await waitForExit(child);
      assert.notEqual(exitCode, 0);

      const output = getOutput();
      assert.match(output, /MCP server on port/i);
      assert.match(output, /already in use|in use/i);

      await waitForHttpDown(`http://127.0.0.1:${controlPort}/control/health`);

      const pidFile = path.join(tempHome, ".tamandua", "tamandua.pid");
      assert.equal(fs.existsSync(pidFile), false);
    } finally {
      await forceKillIfAlive(child);
      await closeServer(blocker);
    }
  });
});
