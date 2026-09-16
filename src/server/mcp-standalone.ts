#!/usr/bin/env node
/**
 * Tamandua MCP Standalone Server
 *
 * Starts just the MCP server as a detached process (outside the dashboard daemon).
 *
 * Usage: node dist/server/mcp-standalone.js [port]
 *
 * Port resolution order:
 *   1. CLI argument (process.argv[2])
 *   2. TAMANDUA_MCP_PORT env var
 *   3. Default: 3338 (DEFAULT_MCP_PORT)
 *
 * - Binds the identity socket on start (~/.tamandua/mcp.sock)
 * - Writes PID file on start (~/.tamandua/mcp.pid)
 * - Writes port file on start (~/.tamandua/mcp-port)
 * - Cleans up PID file + identity socket on exit
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../lib/tamandua-config.js";
import { getBuildVersion } from "../lib/version.js";
import {
  DEFAULT_MCP_PORT,
  startTamanduaMcpServer,
  stopTamanduaMcpServer,
  type TamanduaMcpServer,
} from "./mcp-server.js";
import {
  bindIdentitySocket,
  getServiceSocketPath,
  IdentitySocketInUseError,
  type BoundIdentitySocket,
} from "./daemon-identity.js";

const MCP_PID_FILE = path.join(resolveStateDir(), "mcp.pid");
const MCP_PORT_FILE = path.join(resolveStateDir(), "mcp-port");

function resolvePort(): number {
  // 1. CLI argument
  const argPort = parseInt(process.argv[2], 10);
  if (!isNaN(argPort) && argPort > 0 && argPort < 65536) {
    return argPort;
  }

  // 2. Environment variable
  const envPort = parseInt(process.env.TAMANDUA_MCP_PORT ?? "", 10);
  if (!isNaN(envPort) && envPort > 0 && envPort < 65536) {
    return envPort;
  }

  // 3. Default
  return DEFAULT_MCP_PORT;
}

function writePidFile(): void {
  const dir = path.dirname(MCP_PID_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MCP_PID_FILE, String(process.pid), "utf-8");
}

function writePortFile(port: number): void {
  const dir = path.dirname(MCP_PORT_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MCP_PORT_FILE, String(port), "utf-8");
}

function cleanupPidFile(): void {
  try {
    if (fs.existsSync(MCP_PID_FILE)) {
      const saved = parseInt(fs.readFileSync(MCP_PID_FILE, "utf-8").trim(), 10);
      if (saved === process.pid) {
        fs.unlinkSync(MCP_PID_FILE);
      }
    }
  } catch {
    // Best effort
  }
}

function cleanupPortFile(): void {
  try {
    if (fs.existsSync(MCP_PORT_FILE)) {
      fs.unlinkSync(MCP_PORT_FILE);
    }
  } catch {
    // Best effort
  }
}

let mcpServer: TamanduaMcpServer | undefined;
let identitySocket: BoundIdentitySocket | undefined;
let isShuttingDown = false;

/**
 * Close and unlink the identity socket this process bound.
 *
 * `BoundIdentitySocket.close()` unlinks ONLY the socket file this process
 * created, so a losing bind-race process can never remove the live owner's
 * socket. Idempotent: the reference is cleared first.
 */
async function closeIdentitySocket(): Promise<void> {
  const current = identitySocket;
  identitySocket = undefined;
  if (!current) return;
  try {
    await current.close();
  } catch {
    // Best-effort teardown.
  }
}

/**
 * Synchronous identity-socket teardown for the `process.on("exit")` handler,
 * which cannot await. Safe to call after {@link closeIdentitySocket}: the
 * reference is cleared, so this is a no-op then.
 */
function closeIdentitySocketSync(): void {
  const current = identitySocket;
  identitySocket = undefined;
  if (!current) return;
  try {
    current.server.close();
  } catch {
    // Best-effort teardown.
  }
  try {
    fs.unlinkSync(current.socketPath);
  } catch {
    // Already gone or never created.
  }
}

async function shutdown(signal: string, exitCode: number): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`Tamandua MCP server received ${signal}, shutting down...`);

  if (mcpServer) {
    const current = mcpServer;
    mcpServer = undefined;
    await stopTamanduaMcpServer(current).catch(() => {});
  }

  await closeIdentitySocket();
  cleanupPidFile();
  cleanupPortFile();
  process.exit(exitCode);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM", 0);
});
process.on("SIGINT", () => {
  void shutdown("SIGINT", 0);
});
process.on("SIGHUP", () => {
  void shutdown("SIGHUP", 0);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection in MCP server:", reason);
  void shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception in MCP server:", err);
  void shutdown("uncaughtException", 1);
});

process.on("exit", () => {
  closeIdentitySocketSync();
  cleanupPidFile();
  cleanupPortFile();
});

async function bootstrap(): Promise<void> {
  const port = resolvePort();

  // Bind-first (DPID): claim the identity socket BEFORE writing any pidfile so
  // a losing bind race leaves no trace and can never unlink the live owner's
  // files. The socket is the authoritative liveness primitive on every
  // platform (no lsof/pidfile parsing needed on macOS).
  try {
    identitySocket = await bindIdentitySocket(getServiceSocketPath("mcp"), {
      pid: process.pid,
      buildVersion: getBuildVersion(),
      controlPort: port,
      startedAt: new Date().toISOString(),
      stateDir: resolveStateDir(),
    });
  } catch (err) {
    if (err instanceof IdentitySocketInUseError) {
      console.error(
        `Failed to start MCP server: another MCP server is already live (pid ${err.pid}, ` +
          `control port ${err.identity.controlPort}). Refusing to start.`,
      );
      process.exit(1);
      return;
    }
    console.error(
      `Failed to start MCP server: could not bind identity socket: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
    return;
  }

  writePidFile();
  writePortFile(port);

  try {
    mcpServer = await startTamanduaMcpServer(port);
  } catch (err) {
    console.error(`Failed to start MCP server on port ${port}: ${err instanceof Error ? err.message : String(err)}`);
    cleanupPidFile();
    await closeIdentitySocket();
    process.exit(1);
  }

  console.log(`Tamandua MCP server started on port ${port} (pid ${process.pid})`);
}

void bootstrap();
