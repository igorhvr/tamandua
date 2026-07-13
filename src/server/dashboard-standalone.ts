#!/usr/bin/env node
/**
 * Tamandua Dashboard Standalone Server
 *
 * Starts just the dashboard HTTP server as a detached process (outside the daemon).
 *
 * Usage: node dist/server/dashboard-standalone.js [port]
 *
 * Port resolution order:
 *   1. CLI argument (process.argv[2])
 *   2. TAMANDUA_DASHBOARD_PORT env var
 *   3. Default: 3334
 *
 * - Writes PID file on start (~/.tamandua/dashboard.pid)
 * - Writes port file on start (~/.tamandua/port)
 * - Cleans up PID file on exit
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDashboardServer } from "./dashboard.js";

const DASHBOARD_PID_FILE = path.join(os.homedir(), ".tamandua", "dashboard.pid");
const DASHBOARD_PORT_FILE = path.join(os.homedir(), ".tamandua", "port");
const DEFAULT_DASHBOARD_PORT = 3334;

function resolvePort(): number {
  // 1. CLI argument
  const argPort = parseInt(process.argv[2], 10);
  if (!isNaN(argPort) && argPort > 0 && argPort < 65536) {
    return argPort;
  }

  // 2. Environment variable
  const envPort = parseInt(process.env.TAMANDUA_DASHBOARD_PORT ?? "", 10);
  if (!isNaN(envPort) && envPort > 0 && envPort < 65536) {
    return envPort;
  }

  // 3. Default
  return DEFAULT_DASHBOARD_PORT;
}

function writePidFile(): void {
  const dir = path.dirname(DASHBOARD_PID_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DASHBOARD_PID_FILE, String(process.pid), "utf-8");
}

function writePortFile(port: number): void {
  const dir = path.dirname(DASHBOARD_PORT_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DASHBOARD_PORT_FILE, String(port), "utf-8");
}

function cleanupPidFile(): void {
  try {
    if (fs.existsSync(DASHBOARD_PID_FILE)) {
      const saved = parseInt(fs.readFileSync(DASHBOARD_PID_FILE, "utf-8").trim(), 10);
      if (saved === process.pid) {
        fs.unlinkSync(DASHBOARD_PID_FILE);
      }
    }
  } catch {
    // Best effort
  }
}

function cleanupPortFile(): void {
  try {
    if (fs.existsSync(DASHBOARD_PORT_FILE)) {
      fs.unlinkSync(DASHBOARD_PORT_FILE);
    }
  } catch {
    // Best effort
  }
}

let dashboardServer: ReturnType<typeof createDashboardServer> | undefined;
let isShuttingDown = false;

async function shutdown(signal: string, exitCode: number): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`Tamandua dashboard server received ${signal}, shutting down...`);

  if (dashboardServer) {
    await new Promise<void>((resolve) => {
      dashboardServer!.close(() => resolve());
    });
    dashboardServer = undefined;
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
  console.error("Unhandled rejection in dashboard server:", reason);
  void shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception in dashboard server:", err);
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
    dashboardServer = createDashboardServer(port);
  } catch (err) {
    console.error(`Failed to start dashboard server on port ${port}: ${err instanceof Error ? err.message : String(err)}`);
    cleanupPidFile();
    process.exit(1);
  }

  // Do not advertise readiness until the socket is actually accepting requests.
  // createDashboardServer starts listening asynchronously before it returns.
  if (!dashboardServer.listening) {
    await new Promise<void>((resolve) => {
      dashboardServer!.once("listening", resolve);
    });
  }

  console.log(`Tamandua dashboard server started on port ${port} (pid ${process.pid})`);
}

void bootstrap();
