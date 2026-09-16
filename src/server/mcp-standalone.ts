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
 * - Writes PID file on start (~/.tamandua/mcp.pid)
 * - Writes port file on start (~/.tamandua/mcp-port)
 * - Cleans up PID file on exit
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../lib/tamandua-config.js";
import {
  DEFAULT_MCP_PORT,
  startTamanduaMcpServer,
  stopTamanduaMcpServer,
  type TamanduaMcpServer,
} from "./mcp-server.js";

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
let isShuttingDown = false;

async function shutdown(signal: string, exitCode: number): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`Tamandua MCP server received ${signal}, shutting down...`);

  if (mcpServer) {
    const current = mcpServer;
    mcpServer = undefined;
    await stopTamanduaMcpServer(current).catch(() => {});
  }

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
  cleanupPidFile();
  cleanupPortFile();
});

async function bootstrap(): Promise<void> {
  const port = resolvePort();

  writePidFile();
  writePortFile(port);

  try {
    mcpServer = await startTamanduaMcpServer(port);
  } catch (err) {
    console.error(`Failed to start MCP server on port ${port}: ${err instanceof Error ? err.message : String(err)}`);
    cleanupPidFile();
    process.exit(1);
  }

  console.log(`Tamandua MCP server started on port ${port} (pid ${process.pid})`);
}

void bootstrap();
