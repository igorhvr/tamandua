import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../src/lib/temp-dir.ts";

export interface TempHome {
  /** Top-level temp directory (e.g. /tmp/tamandua-test-XXXXX).  rmSync this to clean up. */
  root: string;
  /** HOME directory inside root (root/home). */
  homeDir: string;
  /** .tamandua config directory inside homeDir (homeDir/.tamandua). */
  tamanduaDir: string;
}

// Module-level registry: all temp dirs created by createTempHome.
// Process-level cleanup fires at exit (also on SIGINT/SIGTERM) so
// the helper works from any context — module top, describe body,
// beforeEach, or it() — without leaking /tmp entries.
const _cleanupDirs = new Set<string>();
let _cleanupRegistered = false;

function _registerProcessCleanup() {
  if (_cleanupRegistered) return;
  _cleanupRegistered = true;

  const cleanup = () => {
    for (const dir of _cleanupDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    _cleanupDirs.clear();
  };

  // clean exit (process.exit, normal termination)
  process.on("exit", cleanup);

  // kill signals — Node won't run 'exit' for these, so we handle them explicitly
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      cleanup();
      process.exit(1);
    });
  }
}

/**
 * Create an isolated temp HOME directory under /tmp.  Cleanup is automatic
 * via process-level handlers (exit + SIGINT/SIGTERM), so this helper works
 * from any context — module top, describe body, beforeEach, or it().
 *
 * The returned object follows the same shape as the e2e smoke-helpers
 * createTempHome, making it easy to share patterns between the two tiers.
 */
export function createTempHome(prefix?: string): TempHome {
  _registerProcessCleanup();

  const root = tamanduaTempDir(prefix ?? "tamandua-test-");
  _cleanupDirs.add(root);

  const homeDir = path.join(root, "home");
  const tamanduaDir = path.join(homeDir, ".tamandua");
  fs.mkdirSync(tamanduaDir, { recursive: true });

  return { root, homeDir, tamanduaDir };
}

const BASE_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "TMPDIR",
  "TEMP",
  "TMP",
  "CI",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TERM",
  "SSH_AUTH_SOCK",
  "GIT_SSH_COMMAND",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  // Harness binary pins pass through so the npm-test-level
  // TAMANDUA_PI_BINARY=/usr/bin/false safety net reaches spawned daemons and
  // scripts. Tiers that need a real or scripted harness set their own
  // value (explicit overrides win over the passthrough).
  "TAMANDUA_PI_BINARY",
  "TAMANDUA_HERMES_BINARY",
  // Isolation guard: npm test sets TAMANDUA_TEST_GUARD=1 so any spawned
  // daemon/script that reaches the real ~/.tamandua or a production port
  // fails loudly instead of silently interfering with the live instance.
  "TAMANDUA_TEST_GUARD",
];

export function cleanChildEnv(
  overrides: Record<string, string | undefined> = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of BASE_ENV_KEYS) {
    const value = baseEnv[key];
    if (value !== undefined) env[key] = value;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const homeDir = env.HOME?.trim();
  const configuredStateDir = env.TAMANDUA_STATE_DIR?.trim();
  const stateDir = configuredStateDir || (homeDir ? path.join(homeDir, ".tamandua") : undefined);
  if (stateDir) {
    env.TAMANDUA_STATE_DIR = stateDir;
    env.TAMANDUA_DB_PATH = env.TAMANDUA_DB_PATH?.trim() || path.join(stateDir, "tamandua.db");
    env.TAMANDUA_WORKTREE_ROOT =
      env.TAMANDUA_WORKTREE_ROOT?.trim() || path.join(stateDir, "worktrees");
  }

  return env;
}

/** A handle that holds a port reservation. Call close() to release. */
export interface PortHandle {
  port: number;
  close(): Promise<void>;
}

/**
 * Reserve a random port by binding an HTTP server and keeping it bound.
 * The port stays owned until the caller invokes handle.close().
 * This avoids the TOCTOU race of bind-close-return patterns.
 */
export async function reservePortHandle(): Promise<PortHandle> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to reserve a random TCP port");
  }
  const port = address.port;
  server.unref();
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Reserve multiple ports held by handles. */
export async function reservePortHandles(count: number): Promise<PortHandle[]> {
  const handles: PortHandle[] = [];
  for (let i = 0; i < count; i++) {
    handles.push(await reservePortHandle());
  }
  return handles;
}

/**
 * Wait for a process to exit by polling process.kill(pid, 0).
 * Returns true if the process exited before the deadline, false otherwise.
 *
 * This helper performs non-mutating observation only — it never kills,
 * never scans by name, never signals arbitrary PIDs.
 */
export async function waitForPidExit(pid: number, deadlineMs: number = 10000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // process is gone
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false; // still alive after deadline
}

/**
 * Reserve `count` distinct ports, call `fn(ports)`, then release all ports
 * in a finally block. This is the preferred pattern for daemon/control-plane
 * tests that need guaranteed port ownership for their duration.
 */
export async function withReservedPorts<T>(
  count: number,
  fn: (ports: number[]) => Promise<T>,
): Promise<T> {
  const handles = await reservePortHandles(count);
  try {
    return await fn(handles.map((h) => h.port));
  } finally {
    await Promise.all(handles.map((h) => h.close()));
  }
}
