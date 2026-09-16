#!/usr/bin/env node
/**
 * Tamandua Control Plane Standalone Server
 *
 * Starts just the control plane HTTP server as a detached process (outside the dashboard daemon).
 *
 * Usage: node dist/server/control-standalone.js [port]
 *
 * Port resolution order:
 *   1. CLI argument (process.argv[2])
 *   2. TAMANDUA_CONTROL_PORT env var
 *   3. Default: 3339 (DEFAULT_CONTROL_PORT)
 *
 * - Writes PID file on start (~/.tamandua/control-plane.pid)
 * - Writes port file on start (~/.tamandua/control-plane-port)
 * - Cleans up PID and port files on exit (only if PID matches own process)
 */
import fs from "node:fs";
import { assertPortIsolation } from "../lib/test-guard.js";
import path from "node:path";
import http from "node:http";
import { resolveStateDir } from "../lib/tamandua-config.js";
import {
  DEFAULT_CONTROL_PORT,
  createControlServer,
  ensureDaemonSecret,
  getControlPort,
} from "./control-server.js";

const CONTROL_PLANE_PID_FILE = path.join(resolveStateDir(), "control-plane.pid");
const CONTROL_PLANE_PORT_FILE = path.join(resolveStateDir(), "control-plane-port");

function resolvePort(): number {
  // 1. CLI argument
  const argPort = parseInt(process.argv[2], 10);
  if (!isNaN(argPort) && argPort > 0 && argPort < 65536) {
    return argPort;
  }

  // 2. Environment variable
  const envPort = parseInt(process.env.TAMANDUA_CONTROL_PORT ?? "", 10);
  if (!isNaN(envPort) && envPort > 0 && envPort < 65536) {
    return envPort;
  }

  // 3. Default
  return DEFAULT_CONTROL_PORT;
}

function writePidFile(): void {
  const dir = path.dirname(CONTROL_PLANE_PID_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONTROL_PLANE_PID_FILE, String(process.pid), "utf-8");
}

function writePortFile(port: number): void {
  const dir = path.dirname(CONTROL_PLANE_PORT_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONTROL_PLANE_PORT_FILE, String(port), "utf-8");
}

function cleanupPidFile(): void {
  try {
    if (fs.existsSync(CONTROL_PLANE_PID_FILE)) {
      const saved = parseInt(
        fs.readFileSync(CONTROL_PLANE_PID_FILE, "utf-8").trim(),
        10,
      );
      if (saved === process.pid) {
        fs.unlinkSync(CONTROL_PLANE_PID_FILE);
      }
    }
  } catch {
    // Best effort
  }
}

function cleanupPortFile(): void {
  try {
    if (fs.existsSync(CONTROL_PLANE_PORT_FILE)) {
      fs.unlinkSync(CONTROL_PLANE_PORT_FILE);
    }
  } catch {
    // Best effort
  }
}

let controlServer: http.Server | undefined;
let isShuttingDown = false;

async function shutdown(signal: string, exitCode: number): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(
    `Tamandua control plane received ${signal}, shutting down...`,
  );

  if (controlServer) {
    const current = controlServer;
    controlServer = undefined;
    await new Promise<void>((resolve) => current.close(() => resolve()));
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
  console.error("Unhandled rejection in control plane:", reason);
  void shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception in control plane:", err);
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

  // Ensure daemon secret exists before starting the server
  ensureDaemonSecret();

  // Use a Promise-based listen so we catch async EADDRINUSE errors
  // (http.createServer + server.listen emits errors as events, not sync throws).
  try {
    await new Promise<void>((resolve, reject) => {
      const server = createControlServer({ port, listen: false });

      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      assertPortIsolation(port, "standalone control plane");
      server.listen(port, "127.0.0.1");

      controlServer = server;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `Failed to start control plane on port ${port}: ${msg}`,
    );
    cleanupPidFile();
    cleanupPortFile();
    process.exit(1);
  }

  console.log(`Tamandua control plane started on port ${port} (pid ${process.pid})`);
}

void bootstrap();
