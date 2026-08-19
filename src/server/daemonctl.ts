/**
 * Tamandua Daemon Lifecycle Controller
 *
 * Manages the lifecycle of the tamandua daemon process (control-plane+motor)
 * and the standalone dashboard UI process.
 *
 * - PID file:         ~/.tamandua/tamandua.pid
 * - Control port file: ~/.tamandua/control-plane-port
 * - Dashboard PID:     ~/.tamandua/dashboard.pid
 * - Dashboard port:    ~/.tamandua/port
 * - Log file:          ~/.tamandua/dashboard.log
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_MCP_PORT, MCP_ENDPOINT_PATH } from "./mcp-server.js";
import { DEFAULT_CONTROL_PORT } from "./control-server.js";
import { assertStatePathIsolation } from "../lib/test-guard.js";
import { environHasEntry, getCmdline, getElapsedSeconds, hasProcfs, processHasOpenFileUnder } from "../lib/proc-info.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STARTUP_ERROR_TAIL_LINES = 20;
const START_LOCK_STALE_MS = 30_000;

// ── Lifecycle attribution ──────────────────────────────────────────

/**
 * Append a stop-attribution breadcrumb to <state>/lifecycle.log before any
 * intentional service stop (and on daemon shutdown). Records who is doing
 * the stopping — this process's pid/argv/cwd plus the parent's cmdline — so
 * an unexplained daemon death is a one-grep diagnosis instead of a forensic
 * dead end (2026-07-05: a production daemon SIGTERM at 21:43 could not be
 * attributed because nothing recorded the sender).
 *
 * Best-effort by contract: never throws, and never writes production state
 * from a guarded process (the line is dropped, mirroring the logger guard).
 */
export function recordLifecycleEvent(
  action: string,
  targetPid: number | null,
  opts?: DaemonctlPathOptions,
  extra?: Record<string, unknown>,
): void {
  try {
    const file = path.join(getTamanduaDir(opts), "lifecycle.log");
    if (!opts?.homeDir) {
      try {
        assertStatePathIsolation(file, "recordLifecycleEvent()");
      } catch {
        return; // guarded process resolving production paths: drop the line
      }
    }
    // procfs on Linux, `ps` on macOS; "" when the parent is already gone.
    const parentCmdline = getCmdline(process.ppid);
    let callerCwd = "?";
    try {
      callerCwd = process.cwd();
    } catch {}
    const entry = {
      ts: new Date().toISOString(),
      action,
      targetPid,
      callerPid: process.pid,
      callerPpid: process.ppid,
      callerArgv: process.argv.slice(0, 6),
      callerCwd,
      parentCmdline,
      // Optional extra fields (e.g. daemon version / config fingerprint on
      // daemon.start, signal / exitCode on daemon.shutdown) ride along in the
      // same one-line JSON entry. Merged AFTER the base fields so callers can
      // never overwrite attribution facts. Backward compatible: callers that
      // pass only (action, targetPid, opts) get the entry they always did.
      ...extra,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Attribution must never break a stop or a shutdown.
  }
}

// ── MCP file paths ─────────────────────────────────────────────────

function defaultTamanduaDir(): string {
  return path.join(process.env.HOME?.trim() || os.homedir(), ".tamandua");
}

export const MCP_PID_FILE = path.join(defaultTamanduaDir(), "mcp.pid");
export const MCP_PORT_FILE = path.join(defaultTamanduaDir(), "mcp-port");

// ── Control plane file paths ──────────────────────────────────────

export const CONTROL_PLANE_PID_FILE = path.join(defaultTamanduaDir(), "control-plane.pid");
export const CONTROL_PLANE_PORT_FILE = path.join(defaultTamanduaDir(), "control-plane-port");
export const CONTROL_PLANE_LOG_FILE = path.join(defaultTamanduaDir(), "control-plane.log");

export interface DaemonctlPathOptions {
  /**
   * When set, use this directory instead of ~/.tamandua for PID, port,
   * and log files. Tests should use this to avoid touching live state.
   */
  homeDir?: string;
}

// ── File path helpers ───────────────────────────────────────────────

function getTamanduaDir(opts?: DaemonctlPathOptions): string {
  return opts?.homeDir ? path.join(opts.homeDir, ".tamandua") : defaultTamanduaDir();
}

export function getPidFile(opts?: DaemonctlPathOptions): string {
  const filePath = path.join(getTamanduaDir(opts), "tamandua.pid");
  if (!opts?.homeDir) {
    assertStatePathIsolation(filePath, "getPidFile()");
  }
  return filePath;
}

export function getPortFile(opts?: DaemonctlPathOptions): string {
  const filePath = path.join(getTamanduaDir(opts), "port");
  if (!opts?.homeDir) {
    assertStatePathIsolation(filePath, "getPortFile()");
  }
  return filePath;
}

export function getLogFile(opts?: DaemonctlPathOptions): string {
  return path.join(getTamanduaDir(opts), "dashboard.log");
}

function getStartLockFile(opts?: DaemonctlPathOptions): string {
  return path.join(getTamanduaDir(opts), "daemon-start.lock");
}

export function getMcpPidFile(opts?: DaemonctlPathOptions): string {
  const filePath = path.join(getTamanduaDir(opts), "mcp.pid");
  if (!opts?.homeDir) {
    assertStatePathIsolation(filePath, "getMcpPidFile()");
  }
  return filePath;
}

export function getMcpPortFile(opts?: DaemonctlPathOptions): string {
  const filePath = path.join(getTamanduaDir(opts), "mcp-port");
  if (!opts?.homeDir) {
    assertStatePathIsolation(filePath, "getMcpPortFile()");
  }
  return filePath;
}

function getMcpLogFile(opts?: DaemonctlPathOptions): string {
  return path.join(getTamanduaDir(opts), "mcp.log");
}

export function getControlPlanePidFile(opts?: DaemonctlPathOptions): string {
  const filePath = path.join(getTamanduaDir(opts), "control-plane.pid");
  if (!opts?.homeDir) {
    assertStatePathIsolation(filePath, "getControlPlanePidFile()");
  }
  return filePath;
}

export function getControlPlanePortFile(opts?: DaemonctlPathOptions): string {
  const filePath = path.join(getTamanduaDir(opts), "control-plane-port");
  if (!opts?.homeDir) {
    assertStatePathIsolation(filePath, "getControlPlanePortFile()");
  }
  return filePath;
}

export function getControlPlaneLogFile(opts?: DaemonctlPathOptions): string {
  return path.join(getTamanduaDir(opts), "control-plane.log");
}

export function readLogTail(logPath: string = getLogFile(), lines = STARTUP_ERROR_TAIL_LINES): string {
  try {
    if (!fs.existsSync(logPath)) return "";
    const content = fs.readFileSync(logPath, "utf-8").trim();
    if (!content) return "";
    return content.split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

// ── Port management ─────────────────────────────────────────────────

export function readPort(opts?: DaemonctlPathOptions): number {
  if (!opts?.homeDir) {
    assertStatePathIsolation(getPortFile(opts), "readPort()");
  }
  try {
    const raw = fs.readFileSync(getPortFile(opts), "utf-8").trim();
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      return port;
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return 3334; // default
}

export function writePort(port: number, opts?: DaemonctlPathOptions): void {
  const tamanduaDir = getTamanduaDir(opts);
  if (!opts?.homeDir) {
    assertStatePathIsolation(tamanduaDir, "writePort()");
  }
  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(getPortFile(opts), String(port), "utf-8");
}

// ── Process status ──────────────────────────────────────────────────

/**
 * Check if a process is running by reading its PID file and testing
 * with kill(0). Cleans up stale PID files on mismatch.
 */
function checkPidFile(pidFile: string): { running: true; pid: number } | { running: false } {
  if (!fs.existsSync(pidFile)) return { running: false };

  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid)) return { running: false };
  } catch {
    return { running: false };
  }

  try {
    // kill(pid, 0) doesn't send a signal — it just checks if the process exists
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    // Process doesn't exist — clean up stale PID file
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // Best effort
    }
    return { running: false };
  }
}

/** Slack for comparing process age against pidfile age (seconds). */
const PIDFILE_AGE_SLACK_SECONDS = 120;

function processHomeMatches(pid: number, homeDir: string): boolean {
  // Linux: exact HOME= entry match via procfs — the strongest binding.
  if (hasProcfs()) {
    return environHasEntry(pid, "HOME", homeDir);
  }

  // macOS: the kernel hides other processes' environments, so bind the pid
  // to this homeDir by provenance instead. Refusing on any lookup failure
  // is intentional — this guard only ever loosens into a signal. Evidence,
  // either of:
  //  (a) the pid is recorded in one of this homeDir's service pidfiles AND
  //      the process is not younger than its pidfile (minus slack) — the
  //      pidfile is written while the recorded process is alive, so a
  //      reused pid pointing at an unrelated (or production) process would
  //      have started AFTER the pidfile, i.e. be younger than it; or
  //  (b) the process holds a file open under this homeDir's .tamandua dir
  //      (services keep their log fd open for life) — kernel-verified via
  //      lsof, and covers healthy services whose pidfile was lost.
  const dir = path.join(homeDir, ".tamandua");
  for (const name of ["tamandua.pid", "mcp.pid", "control-plane.pid", "dashboard.pid"]) {
    try {
      const pidFile = path.join(dir, name);
      const recorded = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      if (recorded !== pid) continue;
      const pidfileAgeSeconds = (Date.now() - fs.statSync(pidFile).mtimeMs) / 1000;
      const elapsed = getElapsedSeconds(pid);
      if (elapsed !== null && elapsed + PIDFILE_AGE_SLACK_SECONDS >= pidfileAgeSeconds) {
        return true;
      }
    } catch {
      // Missing/unreadable pidfile — try the next one.
    }
  }
  return processHasOpenFileUnder(pid, dir);
}

function canSignalPid(pid: number, opts?: DaemonctlPathOptions): boolean {
  return !opts?.homeDir || processHomeMatches(pid, opts.homeDir);
}

/**
 * Guard: refuse to signal the daemon that is scheduling the CURRENT agent.
 *
 * Tamandua agents inherit the daemon's environment, including
 * TAMANDUA_WORKER_PID (the scheduling daemon's own pid). An agent working
 * on daemon-lifecycle features that runs `tamandua dashboard stop` (or
 * restart) with the real HOME would therefore SIGTERM the very daemon
 * dispatching it — the dying daemon then kills the agent mid-restart and
 * strands the run. Lifecycle testing from inside a run must target an
 * isolated instance instead.
 */
function assertNotSchedulingDaemon(targetPid: number, what: string): void {
  const workerPid = Number(process.env.TAMANDUA_WORKER_PID ?? "");
  if (Number.isInteger(workerPid) && workerPid > 0 && workerPid === targetPid) {
    throw new Error(
      `Refusing to stop the ${what} (pid ${targetPid}): it is the daemon scheduling ` +
        `the current tamandua agent run (TAMANDUA_WORKER_PID matches). Stopping it ` +
        `would kill this agent and strand the run. To exercise daemon lifecycle from ` +
        `inside a run, start an ISOLATED instance: point HOME/TAMANDUA_STATE_DIR at a ` +
        `temp directory and use non-default ports (TAMANDUA_CONTROL_PORT plus a custom ` +
        `dashboard/MCP port), then stop/restart that instance.`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function acquireStartLock(lockFile: string): number | null {
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    return fs.openSync(lockFile, "wx", 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;

    try {
      const stat = fs.statSync(lockFile);
      if (Date.now() - stat.mtimeMs > START_LOCK_STALE_MS) {
        fs.unlinkSync(lockFile);
        return fs.openSync(lockFile, "wx", 0o600);
      }
    } catch {
      try {
        return fs.openSync(lockFile, "wx", 0o600);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function releaseStartLock(fd: number | null, lockFile: string): void {
  if (fd === null) return;
  try { fs.closeSync(fd); } catch { /* ignore */ }
  try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
}

async function waitForDaemonPid(
  pidFile: string,
  portFile: string,
  requestedPort: number,
  timeoutMs = 10_000,
): Promise<{ pid: number; port: number } | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = checkPidFile(pidFile);
    if (status.running) {
      let existingPort = requestedPort;
      try {
        const raw = fs.readFileSync(portFile, "utf-8").trim();
        const p = parseInt(raw, 10);
        if (!isNaN(p) && p > 0 && p < 65536) existingPort = p;
      } catch {
        // Use requested port.
      }
      return { pid: status.pid, port: existingPort };
    }
    await sleep(100);
  }
  return null;
}

/**
 * Check if the daemon process is running.
 * Uses PID file and kill(0) for existence check.
 */
export function isRunning(opts?: DaemonctlPathOptions): { running: true; pid: number } | { running: false } {
  if (!opts?.homeDir) {
    try {
      return checkPidFile(getPidFile(opts));
    } catch (err) {
      if (err instanceof Error && err.message.includes("TEST ISOLATION VIOLATION")) {
        return { running: false };
      }
      throw err;
    }
  }
  return checkPidFile(getPidFile(opts));
}

/**
 * Get daemon status (dashboard only — MCP is independently managed).
 */
export function getDaemonStatus(opts?: DaemonctlPathOptions): { running: false; pid: null; port: number } | { running: true; pid: number; port: number } {
  const status = isRunning(opts);
  const port = readControlPlanePort(opts);
  if (!status.running) {
    return { running: false, pid: null, port };
  }

  return {
    running: true,
    pid: status.pid,
    port,
  };
}

// ── Lifecycle ───────────────────────────────────────────────────────

/** Options for startDaemon / startMcp. */
export interface StartOptions extends DaemonctlPathOptions {
  /**
   * When true, skips child.unref() and includes the ChildProcess handle
   * in the return value. Callers can use child.kill() for direct cleanup.
   * Default: false (production detached/unref behavior).
   */
  keepHandle?: boolean;
  /**
   * When set, also passed as HOME to the spawned child process.
   */
}

export type StartControlPlaneResult = {
  pid: number;
  port: number;
  alreadyRunning?: boolean;
};

/**
 * Start the daemon (control-plane+motor).
 *
 * Spawns a detached node process running dist/server/daemon.js.
 * Writes the control plane port to ~/.tamandua/control-plane-port before spawning.
 *
 * If the daemon is already running, returns its info without restarting.
 *
 * @param port  Control plane port (default: TAMANDUA_CONTROL_PORT env or 3339).
 * @param opts  When keepHandle is true, returns the ChildProcess handle.
 */
export async function startDaemon(port?: number): Promise<{ pid: number; port: number }>;
export async function startDaemon(port: number, opts: StartOptions): Promise<{ pid: number; port: number }>;
export async function startDaemon(port: number, opts: StartOptions & { keepHandle: true }): Promise<{ pid: number; port: number; child: ChildProcess }>;
export async function startDaemon(port?: number, opts?: StartOptions): Promise<{ pid: number; port: number } | { pid: number; port: number; child: ChildProcess }> {
  // Resolve the control plane port (env → arg → default 3339).
  const controlPort = port ?? (parseInt(process.env.TAMANDUA_CONTROL_PORT ?? "", 10) || DEFAULT_CONTROL_PORT);

  // When homeDir is set, compute isolated paths for all filesystem operations.
  const tamanduaDir = getTamanduaDir(opts);
  const pidFile = getPidFile(opts);
  const portFile = getControlPlanePortFile(opts);
  const logFile = getLogFile(opts);
  const lockFile = getStartLockFile(opts);

  const status = checkPidFile(pidFile);
  if (status.running) {
    let existingPort = controlPort;
    try {
      const raw = fs.readFileSync(portFile, "utf-8").trim();
      const p = parseInt(raw, 10);
      if (!isNaN(p) && p > 0 && p < 65536) existingPort = p;
    } catch {
      // File missing or unreadable — use the requested port
    }
    return { pid: status.pid, port: existingPort };
  }

  fs.mkdirSync(tamanduaDir, { recursive: true });
  const lockFd = acquireStartLock(lockFile);
  if (lockFd === null) {
    const existing = await waitForDaemonPid(pidFile, portFile, controlPort);
    if (existing) return existing;
    throw new Error("Timed out waiting for another daemon start attempt to finish.");
  }

  try {
    const recheck = checkPidFile(pidFile);
    if (recheck.running) {
      let existingPort = controlPort;
      try {
        const raw = fs.readFileSync(portFile, "utf-8").trim();
        const p = parseInt(raw, 10);
        if (!isNaN(p) && p > 0 && p < 65536) existingPort = p;
      } catch {
        // Use requested port.
      }
      return { pid: recheck.pid, port: existingPort };
    }

    fs.writeFileSync(portFile, String(controlPort), "utf-8");

    const out = fs.openSync(logFile, "a");
    const errFd = fs.openSync(logFile, "a");

    const daemonScript = path.resolve(__dirname, "daemon.js");
    const spawnOpts: Parameters<typeof spawn>[2] = {
      detached: true,
      stdio: ["ignore", out, errFd],
      env: { ...process.env, TAMANDUA_CONTROL_PORT: String(controlPort) },
    };
    if (opts?.homeDir) {
      spawnOpts.env = { ...spawnOpts.env, HOME: opts.homeDir };
    }
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", daemonScript], spawnOpts);

    if (opts?.keepHandle) {
      // Caller wants the ChildProcess handle for direct cleanup (e.g. tests).
      // Don't unref — the handle keeps the event loop alive, which is fine
      // because the caller is responsible for killing the child.
    } else {
      child.unref();
    }

    // Wait for the daemon to start and write its PID file. Poll instead of a
    // single fixed sleep: under heavy load node startup can exceed a second.
    const daemonDeadline = Date.now() + 10_000;
    let check = checkPidFile(pidFile);
    while (!check.running && Date.now() < daemonDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      check = checkPidFile(pidFile);
    }
    if (!check.running) {
      const logTail = readLogTail(logFile);
      if (logTail) {
        throw new Error(`Daemon failed to start. Recent daemon log:\n${logTail}`);
      }

      throw new Error("Daemon failed to start. Check " + logFile);
    }

    // Verify the daemon responds to its control plane health endpoint before returning.
    // A PID file write followed by an immediate crash leaves update --force
    // thinking the service restarted successfully (2026-07-05 incident).
    await waitForHealthEndpoint(`http://127.0.0.1:${controlPort}${CONTROL_PLANE_HEALTH_ENDPOINT}`);

    if (opts?.keepHandle) {
      return { pid: check.pid, port: controlPort, child };
    }

    return { pid: check.pid, port: controlPort };
  } finally {
    releaseStartLock(lockFd, lockFile);
  }
}

/**
 * Stop the daemon (control-plane+motor).
 *
 * Sends SIGTERM to the daemon process and cleans up the PID file.
 * Returns true if a daemon was stopped, false if none was running.
 */
export function stopDaemon(opts?: DaemonctlPathOptions): boolean {
  if (!opts?.homeDir) {
    assertStatePathIsolation(getPidFile(opts), "stopDaemon()");
  }
  const status = isRunning(opts);
  if (!status.running) return false;
  if (!canSignalPid(status.pid, opts)) return false;
  assertNotSchedulingDaemon(status.pid, "daemon");

  recordLifecycleEvent("stop.daemon", status.pid, opts);
  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    // Process may have already exited
  }

  // Clean up PID file — the daemon also cleans up on exit,
  // but we do it here as a safety measure
  try {
    fs.unlinkSync(getPidFile(opts));
  } catch {
    // Best effort
  }

  // Clean up control plane port file so a fresh start can pick a different port
  try {
    fs.unlinkSync(getControlPlanePortFile(opts));
  } catch {
    // Best effort
  }

  return true;
}

/**
 * Restart the daemon (control-plane+motor).
 *
 * If the daemon is currently running, stops it first, then starts a new
 * daemon on the previously configured control plane port (or the port argument).
 * If no daemon is running, starts one on the given port (default from env or 3339).
 *
 * Returns { pid, port } like startDaemon.
 */
export async function restartDaemon(port?: number, opts?: StartOptions): Promise<{ pid: number; port: number }> {
  const currentPort = port ?? readControlPlanePort(opts);

  const runningStatus = isRunning(opts);
  if (runningStatus.running) {
    recordLifecycleEvent("restart.daemon", runningStatus.pid ?? null, opts);
    stopDaemon(opts);
    // Brief pause to let the port be released and process fully exit
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (opts) {
    return startDaemon(currentPort, opts);
  }
  return startDaemon(currentPort);
}

// ═══════════════════════════════════════════════════════════════════
// MCP standalone lifecycle management
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve the mcp-standalone.js path.
 * In production (compiled JS), the file lives alongside daemonctl.js in dist/server/.
 * In development (tsx on-the-fly transpilation), the compiled output is in dist/server/.
 */
function resolveStandaloneScript(): string {
  // Production: same directory as daemonctl.js (dist/server/)
  const prodPath = path.resolve(__dirname, "mcp-standalone.js");
  if (fs.existsSync(prodPath)) return prodPath;

  // Development (tsx): compiled output lives in dist/server/
  const devPath = path.resolve(__dirname, "..", "..", "dist", "server", "mcp-standalone.js");
  if (fs.existsSync(devPath)) return devPath;

  // Fallback: return prodPath so the caller gets a clear error
  return prodPath;
}

/**
 * Read the MCP port from the MCP port file.
 * Returns DEFAULT_MCP_PORT (3338) when no port file exists.
 */
export function readMcpPort(opts?: DaemonctlPathOptions): number {
  if (!opts?.homeDir) {
    assertStatePathIsolation(getMcpPortFile(opts), "readMcpPort()");
  }
  try {
    const raw = fs.readFileSync(getMcpPortFile(opts), "utf-8").trim();
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      return port;
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return DEFAULT_MCP_PORT;
}

/**
 * Write the MCP port to the MCP port file.
 */
export function writeMcpPort(port: number, opts?: DaemonctlPathOptions): void {
  const tamanduaDir = getTamanduaDir(opts);
  if (!opts?.homeDir) {
    assertStatePathIsolation(tamanduaDir, "writeMcpPort()");
  }
  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(getMcpPortFile(opts), String(port), "utf-8");
}

/**
 * Check if the standalone MCP server is running.
 * Uses the MCP PID file and kill(0) for existence check.
 */
export function isMcpRunning(opts?: DaemonctlPathOptions): { running: true; pid: number } | { running: false } {
  if (!opts?.homeDir) {
    try {
      return checkPidFile(getMcpPidFile(opts));
    } catch (err) {
      if (err instanceof Error && err.message.includes("TEST ISOLATION VIOLATION")) {
        return { running: false };
      }
      throw err;
    }
  }
  return checkPidFile(getMcpPidFile(opts));
}

/**
 * Get full MCP status.
 */
export function getMcpStatus(opts?: DaemonctlPathOptions): {
  running: boolean;
  pid: number | null;
  port: number;
  endpoint: string;
} {
  const status = isMcpRunning(opts);
  const port = readMcpPort(opts);
  return {
    running: status.running,
    pid: status.running ? status.pid : null,
    port,
    endpoint: MCP_ENDPOINT_PATH,
  };
}

/**
 * Start the standalone MCP server.
 *
 * Spawns a detached node process running dist/server/mcp-standalone.js.
 * Writes PID and port files that the spawned process also updates.
 * Waits for startup and checks health.
 *
 * If the MCP server is already running, returns its info without restarting.
 */
export async function startMcp(port?: number): Promise<{ pid: number; port: number }>;
export async function startMcp(port: number, opts: StartOptions): Promise<{ pid: number; port: number }>;
export async function startMcp(port: number, opts: StartOptions & { keepHandle: true }): Promise<{ pid: number; port: number; child: ChildProcess }>;
export async function startMcp(port?: number, opts?: StartOptions): Promise<{ pid: number; port: number } | { pid: number; port: number; child: ChildProcess }> {
  // When homeDir is set, compute isolated paths for all filesystem operations.
  const tamanduaDir = getTamanduaDir(opts);
  const mcpPidFile = getMcpPidFile(opts);
  const mcpPortFile = getMcpPortFile(opts);
  const mcpLogFile = getMcpLogFile(opts);

  const status = checkPidFile(mcpPidFile);
  if (status.running) {
    let existingPort: number = DEFAULT_MCP_PORT;
    try {
      const raw = fs.readFileSync(mcpPortFile, "utf-8").trim();
      const p = parseInt(raw, 10);
      if (!isNaN(p) && p > 0 && p < 65536) existingPort = p;
    } catch {
      // File missing or unreadable — use default
    }
    return { pid: status.pid, port: existingPort };
  }

  const mcpPort = port ?? DEFAULT_MCP_PORT;

  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(mcpPortFile, String(mcpPort), "utf-8");

  const out = fs.openSync(mcpLogFile, "a");
  const errFd = fs.openSync(mcpLogFile, "a");

  const standaloneScript = resolveStandaloneScript();
  const spawnOpts: Parameters<typeof spawn>[2] = {
    detached: true,
    stdio: ["ignore", out, errFd],
  };
  if (opts?.homeDir) {
    spawnOpts.env = { ...process.env, HOME: opts.homeDir };
  }
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", standaloneScript, String(mcpPort)], spawnOpts);

  if (opts?.keepHandle) {
    // Caller wants the ChildProcess handle for direct cleanup (e.g. tests).
    // Don't unref — the handle keeps the event loop alive, which is fine
    // because the caller is responsible for killing the child.
  } else {
    child.unref();
  }

  // Wait for the MCP server to start and write its PID file. Poll instead
  // of a single fixed sleep: under heavy load (e.g. the parallel test suite)
  // node startup can take well over a second.
  const deadline = Date.now() + 10_000;
  let check = checkPidFile(mcpPidFile);
  while (!check.running && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    check = checkPidFile(mcpPidFile);
  }
  if (!check.running) {
    const logTail = readLogTail(mcpLogFile);
    if (logTail) {
      throw new Error(`MCP server failed to start. Recent MCP log:\n${logTail}`);
    }
    throw new Error("MCP server failed to start. Check " + mcpLogFile);
  }

  // Verify the MCP server is actually accepting connections on its port.
  // The /mcp endpoint uses Streamable HTTP transport (not a simple GET), so
  // we probe via TCP connect instead of a health endpoint fetch.
  const mcpTcpDeadline = Date.now() + 10_000;
  let mcpTcpOk = false;
  while (!mcpTcpOk && Date.now() < mcpTcpDeadline) {
    mcpTcpOk = await isTcpPortOpen(mcpPort, 500);
    if (!mcpTcpOk) await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  if (!mcpTcpOk) {
    throw new Error(
      `MCP server PID file written but port ${mcpPort} is not accepting TCP connections. ` +
      `The process may have crashed after writing the PID file. Check ${mcpLogFile}`,
    );
  }

  if (opts?.keepHandle) {
    return { pid: check.pid, port: mcpPort, child };
  }

  return { pid: check.pid, port: mcpPort };
}

/**
 * Restart the standalone MCP server.
 *
 * If the MCP server is currently running, stops it first, then starts a new
 * server on the previously configured port (or the port argument).
 * If no MCP server is running, starts one on the given port (default DEFAULT_MCP_PORT=3338).
 *
 * Returns { pid, port } like startMcp.
 */
export async function restartMcp(port?: number, opts?: StartOptions): Promise<{ pid: number; port: number }> {
  const currentPort = port ?? readMcpPort(opts);

  if (isMcpRunning(opts).running) {
    stopMcp(opts);
    // Brief pause to let the port be released and process fully exit
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (opts) {
    return startMcp(currentPort, opts);
  }
  return startMcp(currentPort);
}

/**
 * Stop the standalone MCP server.
 *
 * Sends SIGTERM to the MCP process and cleans up the PID file.
 * Returns true if an MCP server was stopped, false if none was running.
 */
export function stopMcp(opts?: DaemonctlPathOptions): boolean {
  if (!opts?.homeDir) {
    assertStatePathIsolation(getMcpPidFile(opts), "stopMcp()");
  }
  const status = isMcpRunning(opts);
  if (!status.running) return false;
  if (!canSignalPid(status.pid, opts)) return false;
  assertNotSchedulingDaemon(status.pid, "MCP server");

  recordLifecycleEvent("stop.mcp", status.pid, opts);
  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    // Process may have already exited
  }

  // Clean up PID file — the MCP process also cleans up on exit,
  // but we do it here as a safety measure
  try {
    fs.unlinkSync(getMcpPidFile(opts));
  } catch {
    // Best effort
  }

  // Clean up port file so a fresh start can pick a different port
  try {
    fs.unlinkSync(getMcpPortFile(opts));
  } catch {
    // Best effort
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Control plane standalone lifecycle management
// ═══════════════════════════════════════════════════════════════════

const CONTROL_PLANE_HEALTH_ENDPOINT = "/control/health";

/**
 * Resolve the control-standalone.js path.
 * In production (compiled JS), the file lives alongside daemonctl.js in dist/server/.
 * In development (tsx on-the-fly transpilation), the compiled output is in dist/server/.
 */
function resolveControlStandaloneScript(): string {
  // Production: same directory as daemonctl.js (dist/server/)
  const prodPath = path.resolve(__dirname, "control-standalone.js");
  if (fs.existsSync(prodPath)) return prodPath;

  // Development (tsx): compiled output lives in dist/server/
  const devPath = path.resolve(__dirname, "..", "..", "dist", "server", "control-standalone.js");
  if (fs.existsSync(devPath)) return devPath;

  // Fallback: return prodPath so the caller gets a clear error
  return prodPath;
}

async function waitForHealthEndpoint(url: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Server not reachable yet
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for health endpoint: ${url}`);
}

async function isTcpPortOpen(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

async function fetchControlPlaneHealth(port: number, timeoutMs = 1000): Promise<{ healthy: true; pid: number | null } | { healthy: false; status?: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${CONTROL_PLANE_HEALTH_ENDPOINT}`, {
      signal: controller.signal,
    });
    if (!res.ok) return { healthy: false, status: res.status };
    let pid: number | null = null;
    try {
      const body = await res.json() as { pid?: unknown };
      if (typeof body.pid === "number" && Number.isFinite(body.pid) && body.pid > 0) {
        pid = body.pid;
      }
    } catch {
      // Treat a 2xx health response as healthy even if the body is malformed.
    }
    return { healthy: true, pid };
  } catch {
    return { healthy: false };
  } finally {
    clearTimeout(timeout);
  }
}

/** Probe the MCP server's HTTP endpoint to verify it is alive.
 *
 * The MCP server has no dedicated health endpoint; its only HTTP route is
 * the streaming `/mcp` endpoint. Any HTTP response (even a 400 for missing
 * session ID) proves the server is accepting connections and responding.
 * This mirrors the control-plane health-probe pattern for consistency. */
async function fetchMcpHealth(port: number, timeoutMs = 2000): Promise<{ healthy: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`http://127.0.0.1:${port}${MCP_ENDPOINT_PATH}`, {
      signal: controller.signal,
    });
    // Any response (even non-2xx) means the server is alive and responding.
    return { healthy: true };
  } catch {
    return { healthy: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function detectExistingControlPlane(
  port: number,
  pidFile: string,
  portFile: string,
  opts?: DaemonctlPathOptions,
): Promise<StartControlPlaneResult | null> {
  const health = await fetchControlPlaneHealth(port);
  if (health.healthy) {
    if (health.pid !== null && !canSignalPid(health.pid, opts)) {
      throw new Error(
        `Port ${port} is already used by a Tamandua control plane outside the requested HOME. ` +
        `Stop the other process or choose a different port.`,
      );
    }
    if (health.pid !== null) {
      try {
        fs.mkdirSync(path.dirname(pidFile), { recursive: true });
        fs.writeFileSync(pidFile, String(health.pid), "utf-8");
        fs.writeFileSync(portFile, String(port), "utf-8");
      } catch {
        // Best effort; returning existing info is still better than spawning.
      }
    }
    return { pid: health.pid ?? 0, port, alreadyRunning: true };
  }

  if (await isTcpPortOpen(port)) {
    const suffix = health.status ? `; health endpoint returned HTTP ${health.status}` : "";
    throw new Error(
      `Port ${port} is already in use, but it is not a healthy Tamandua control plane${suffix}. ` +
      `Stop the other process or choose a different port.`,
    );
  }

  return null;
}

/**
 * Read the control plane port from the control plane port file.
 * Returns DEFAULT_CONTROL_PORT (3339) when no port file exists.
 */
export function readControlPlanePort(opts?: DaemonctlPathOptions): number {
  if (!opts?.homeDir) {
    assertStatePathIsolation(getControlPlanePortFile(opts), "readControlPlanePort()");
  }
  try {
    const raw = fs.readFileSync(getControlPlanePortFile(opts), "utf-8").trim();
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      return port;
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return DEFAULT_CONTROL_PORT;
}

/**
 * Write the control plane port to the control plane port file.
 */
export function writeControlPlanePort(port: number, opts?: DaemonctlPathOptions): void {
  const tamanduaDir = getTamanduaDir(opts);
  if (!opts?.homeDir) {
    assertStatePathIsolation(tamanduaDir, "writeControlPlanePort()");
  }
  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(getControlPlanePortFile(opts), String(port), "utf-8");
}

/**
 * Check if the standalone control plane server is running.
 * Uses the control plane PID file and kill(0) for existence check.
 */
export function isControlPlaneRunning(opts?: DaemonctlPathOptions): { running: true; pid: number } | { running: false } {
  if (!opts?.homeDir) {
    try {
      return checkPidFile(getControlPlanePidFile(opts));
    } catch (err) {
      if (err instanceof Error && err.message.includes("TEST ISOLATION VIOLATION")) {
        return { running: false };
      }
      throw err;
    }
  }
  return checkPidFile(getControlPlanePidFile(opts));
}

/**
 * Get full control plane status.
 */
export function getControlPlaneStatus(opts?: DaemonctlPathOptions): {
  running: boolean;
  pid: number | null;
  port: number;
  endpoint: string;
} {
  const status = isControlPlaneRunning(opts);
  const port = readControlPlanePort(opts);
  return {
    running: status.running,
    pid: status.running ? status.pid : null,
    port,
    endpoint: CONTROL_PLANE_HEALTH_ENDPOINT,
  };
}

/**
 * Async control plane status check that probes the live health endpoint.
 *
 * When the daemon runs the control plane in-process (the default), no
 * control-plane.pid file is written, so the synchronous
 * `getControlPlaneStatus()` always returns DOWN. This variant probes
 * the actual `/control/health` HTTP endpoint with a bounded ~2s timeout
 * and heals stale or missing PID files on success.
 */
export async function getControlPlaneStatusAsync(opts?: DaemonctlPathOptions): Promise<{
  running: boolean;
  pid: number | null;
  port: number;
  endpoint: string;
}> {
  const port = readControlPlanePort(opts);
  const health = await fetchControlPlaneHealth(port, 2000);
  if (health.healthy) {
    // Heal the PID file so the synchronous check also works.
    const pid = health.pid ?? null;
    if (pid !== null) {
      try {
        const pidFile = getControlPlanePidFile(opts);
        fs.mkdirSync(path.dirname(pidFile), { recursive: true });
        fs.writeFileSync(pidFile, String(pid), "utf-8");
      } catch {
        // Best effort.
      }
    }
    return { running: true, pid, port, endpoint: CONTROL_PLANE_HEALTH_ENDPOINT };
  }

  // Health probe failed — fall back to the synchronous PID-file check.
  return getControlPlaneStatus(opts);
}

/**
 * Async MCP status check that probes the live HTTP endpoint.
 *
 * Sends a GET to `/mcp` with a bounded ~2s timeout. Any HTTP response
 * (even an error) proves the server is alive — this mirrors the
 * control-plane health-probe pattern. When the MCP server is alive but
 * no mcp.pid file exists (in-process MCP), we heal by writing the daemon PID.
 */
export async function getMcpStatusAsync(opts?: DaemonctlPathOptions): Promise<{
  running: boolean;
  pid: number | null;
  port: number;
  endpoint: string;
}> {
  const port = readMcpPort(opts);

  // Probe the MCP HTTP endpoint with a production-appropriate timeout.
  const health = await fetchMcpHealth(port, 2000);
  if (health.healthy) {
    // Heal the PID file: if the daemon is running, use its PID.
    let pid: number | null = null;
    const syncStatus = isMcpRunning(opts);
    if (syncStatus.running) {
      pid = syncStatus.pid;
    } else {
      // No PID file — infer from daemon.
      const daemonStatus = isRunning(opts);
      if (daemonStatus.running) {
        pid = daemonStatus.pid;
        try {
          const mcpPidFile = getMcpPidFile(opts);
          fs.mkdirSync(path.dirname(mcpPidFile), { recursive: true });
          fs.writeFileSync(mcpPidFile, String(pid), "utf-8");
        } catch {
          // Best effort.
        }
      }
    }
    return { running: true, pid, port, endpoint: MCP_ENDPOINT_PATH };
  }

  // Health probe failed — fall back to the synchronous PID-file check.
  return getMcpStatus(opts);
}

/**
 * Start the standalone control plane server.
 *
 * Spawns a detached node process running dist/server/control-standalone.js.
 * Writes PID and port files that the spawned process also updates.
 * Waits for startup and checks health endpoint.
 *
 * If the control plane server is already running, returns its info without restarting.
 */
export async function startControlPlane(port?: number): Promise<StartControlPlaneResult>;
export async function startControlPlane(port: number, opts: StartOptions): Promise<StartControlPlaneResult>;
export async function startControlPlane(port: number, opts: StartOptions & { keepHandle: true }): Promise<StartControlPlaneResult & { child: ChildProcess }>;
export async function startControlPlane(port?: number, opts?: StartOptions): Promise<StartControlPlaneResult | (StartControlPlaneResult & { child: ChildProcess })> {
  // When homeDir is set, compute isolated paths for all filesystem operations.
  const tamanduaDir = getTamanduaDir(opts);
  const cpPidFile = getControlPlanePidFile(opts);
  const cpPortFile = getControlPlanePortFile(opts);
  const cpLogFile = getControlPlaneLogFile(opts);

  const status = checkPidFile(cpPidFile);
  if (status.running) {
    let existingPort: number = DEFAULT_CONTROL_PORT;
    try {
      const raw = fs.readFileSync(cpPortFile, "utf-8").trim();
      const p = parseInt(raw, 10);
      if (!isNaN(p) && p > 0 && p < 65536) existingPort = p;
    } catch {
      // File missing or unreadable — use default
    }
    return { pid: status.pid, port: existingPort, alreadyRunning: true };
  }

  const cpPort = port ?? DEFAULT_CONTROL_PORT;

  const existing = await detectExistingControlPlane(cpPort, cpPidFile, cpPortFile, opts);
  if (existing) return existing;

  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(cpPortFile, String(cpPort), "utf-8");

  const out = fs.openSync(cpLogFile, "a");
  const errFd = fs.openSync(cpLogFile, "a");

  const standaloneScript = resolveControlStandaloneScript();
  const spawnOpts: Parameters<typeof spawn>[2] = {
    detached: true,
    stdio: ["ignore", out, errFd],
  };
  if (opts?.homeDir) {
    spawnOpts.env = { ...process.env, HOME: opts.homeDir };
  }
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", standaloneScript, String(cpPort)], spawnOpts);

  if (opts?.keepHandle) {
    // Caller wants the ChildProcess handle for direct cleanup (e.g. tests).
    // Don't unref — the handle keeps the event loop alive, which is fine
    // because the caller is responsible for killing the child.
  } else {
    child.unref();
  }

  // Wait for the control plane to start and write its PID file. Poll instead
  // of a single fixed sleep: under heavy load node startup can exceed a second.
  const cpDeadline = Date.now() + 10_000;
  let check = checkPidFile(cpPidFile);
  while (!check.running && Date.now() < cpDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    check = checkPidFile(cpPidFile);
  }
  if (!check.running) {
    const existingAfterSpawn = await detectExistingControlPlane(cpPort, cpPidFile, cpPortFile, opts);
    if (existingAfterSpawn) return existingAfterSpawn;
    const logTail = readLogTail(cpLogFile);
    if (logTail) {
      throw new Error(`Control plane failed to start. Recent control plane log:\n${logTail}`);
    }
    throw new Error("Control plane failed to start. Check " + cpLogFile);
  }

  // Wait for health endpoint to be reachable
  await waitForHealthEndpoint(`http://127.0.0.1:${cpPort}${CONTROL_PLANE_HEALTH_ENDPOINT}`);

  if (opts?.keepHandle) {
    return { pid: check.pid, port: cpPort, child };
  }

  return { pid: check.pid, port: cpPort };
}

/**
 * Stop the standalone control plane server.
 *
 * Sends SIGTERM to the control plane process and cleans up the PID file.
 * Returns true if a control plane was stopped, false if none was running.
 */
export function stopControlPlane(opts?: DaemonctlPathOptions): boolean {
  if (!opts?.homeDir) {
    assertStatePathIsolation(getControlPlanePidFile(opts), "stopControlPlane()");
  }
  const status = isControlPlaneRunning(opts);
  if (!status.running) return false;
  if (!canSignalPid(status.pid, opts)) return false;
  assertNotSchedulingDaemon(status.pid, "control plane");

  recordLifecycleEvent("stop.control-plane", status.pid, opts);
  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    // Process may have already exited
  }

  // Clean up PID file — the control plane also cleans up on exit,
  // but we do it here as a safety measure
  try {
    fs.unlinkSync(getControlPlanePidFile(opts));
  } catch {
    // Best effort
  }

  // Clean up port file so a fresh start can pick a different port
  try {
    fs.unlinkSync(getControlPlanePortFile(opts));
  } catch {
    // Best effort
  }

  return true;
}

/**
 * Restart the standalone control plane server.
 *
 * If the control plane is currently running, stops it first, then starts a new
 * server on the previously configured port (or the port argument).
 * If no control plane is running, starts one on the given port (default DEFAULT_CONTROL_PORT=3339).
 *
 * Returns { pid, port, alreadyRunning? } like startControlPlane.
 */
export async function restartControlPlane(port?: number, opts?: StartOptions): Promise<StartControlPlaneResult> {
  const currentPort = port ?? readControlPlanePort(opts);

  if (isControlPlaneRunning(opts).running) {
    stopControlPlane(opts);
    // Brief pause to let the port be released and process fully exit
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (opts) {
    return startControlPlane(currentPort, opts);
  }
  return startControlPlane(currentPort);
}

// ═══════════════════════════════════════════════════════════════════
// Dashboard standalone lifecycle management
// ═══════════════════════════════════════════════════════════════════

const DASHBOARD_HEALTH_ENDPOINT = "/api/health";
const DEFAULT_DASHBOARD_PORT = 3334;

/**
 * Resolve the dashboard-standalone.js path.
 * In production (compiled JS), the file lives alongside daemonctl.js in dist/server/.
 * In development (tsx on-the-fly transpilation), the compiled output is in dist/server/.
 */
function resolveDashboardStandaloneScript(): string {
  // Production: same directory as daemonctl.js (dist/server/)
  const prodPath = path.resolve(__dirname, "dashboard-standalone.js");
  if (fs.existsSync(prodPath)) return prodPath;

  // Development (tsx): compiled output lives in dist/server/
  const devPath = path.resolve(__dirname, "..", "..", "dist", "server", "dashboard-standalone.js");
  if (fs.existsSync(devPath)) return devPath;

  // Fallback: return prodPath so the caller gets a clear error
  return prodPath;
}

/**
 * Get the dashboard PID file path.
 * Returns ~/.tamandua/dashboard.pid (or isolated path when homeDir is set).
 */
export function getDashboardPidFile(opts?: DaemonctlPathOptions): string {
  const filePath = path.join(getTamanduaDir(opts), "dashboard.pid");
  if (!opts?.homeDir) {
    assertStatePathIsolation(filePath, "getDashboardPidFile()");
  }
  return filePath;
}

/**
 * Get the dashboard port file path.
 * Same as getPortFile() — the dashboard writes ~/.tamandua/port (existing tooling).
 */
export function getDashboardPortFile(opts?: DaemonctlPathOptions): string {
  return getPortFile(opts);
}

/**
 * Get the dashboard log file path.
 * Returns ~/.tamandua/dashboard.log (or isolated path when homeDir is set).
 */
export function getDashboardLogFile(opts?: DaemonctlPathOptions): string {
  return path.join(getTamanduaDir(opts), "dashboard.log");
}

/**
 * Check if the standalone dashboard server is running.
 * Uses the dashboard PID file and kill(0) for existence check.
 */
export function isDashboardRunning(opts?: DaemonctlPathOptions): { running: true; pid: number } | { running: false } {
  if (!opts?.homeDir) {
    try {
      return checkPidFile(getDashboardPidFile(opts));
    } catch (err) {
      if (err instanceof Error && err.message.includes("TEST ISOLATION VIOLATION")) {
        return { running: false };
      }
      throw err;
    }
  }
  return checkPidFile(getDashboardPidFile(opts));
}

/**
 * Get full dashboard standalone status.
 */
export function getDashboardStatus(opts?: DaemonctlPathOptions): {
  running: boolean;
  pid: number | null;
  port: number;
} {
  const status = isDashboardRunning(opts);
  const port = readPort(opts);
  return {
    running: status.running,
    pid: status.running ? status.pid : null,
    port,
  };
}

/**
 * Start the standalone dashboard server.
 *
 * Spawns a detached node process running dist/server/dashboard-standalone.js.
 * Writes PID and port files that the spawned process also updates.
 * Waits for startup and checks health endpoint (/api/health).
 *
 * If the dashboard server is already running, returns its info without restarting.
 */
export async function startDashboardStandalone(port?: number): Promise<{ pid: number; port: number }>;
export async function startDashboardStandalone(port: number, opts: StartOptions): Promise<{ pid: number; port: number }>;
export async function startDashboardStandalone(port: number, opts: StartOptions & { keepHandle: true }): Promise<{ pid: number; port: number; child: ChildProcess }>;
export async function startDashboardStandalone(port?: number, opts?: StartOptions): Promise<{ pid: number; port: number } | { pid: number; port: number; child: ChildProcess }> {
  const tamanduaDir = getTamanduaDir(opts);
  const dashPidFile = getDashboardPidFile(opts);
  const dashPortFile = getDashboardPortFile(opts);
  const dashLogFile = getDashboardLogFile(opts);

  const status = checkPidFile(dashPidFile);
  if (status.running) {
    let existingPort: number = DEFAULT_DASHBOARD_PORT;
    try {
      const raw = fs.readFileSync(dashPortFile, "utf-8").trim();
      const p = parseInt(raw, 10);
      if (!isNaN(p) && p > 0 && p < 65536) existingPort = p;
    } catch {
      // File missing or unreadable — use default
    }
    return { pid: status.pid, port: existingPort };
  }

  const dashPort = port ?? DEFAULT_DASHBOARD_PORT;

  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(dashPortFile, String(dashPort), "utf-8");

  const out = fs.openSync(dashLogFile, "a");
  const errFd = fs.openSync(dashLogFile, "a");

  const standaloneScript = resolveDashboardStandaloneScript();
  const spawnOpts: Parameters<typeof spawn>[2] = {
    detached: true,
    stdio: ["ignore", out, errFd],
  };
  if (opts?.homeDir) {
    spawnOpts.env = { ...process.env, HOME: opts.homeDir };
  }
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", standaloneScript, String(dashPort)], spawnOpts);

  if (opts?.keepHandle) {
    // Caller wants the ChildProcess handle for direct cleanup (e.g. tests).
    // Don't unref — the handle keeps the event loop alive, which is fine
    // because the caller is responsible for killing the child.
  } else {
    child.unref();
  }

  // Wait for the dashboard to start and write its PID file. Poll instead
  // of a single fixed sleep: under heavy load node startup can exceed a second.
  const deadline = Date.now() + 10_000;
  let check = checkPidFile(dashPidFile);
  while (!check.running && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    check = checkPidFile(dashPidFile);
  }
  if (!check.running) {
    const logTail = readLogTail(dashLogFile);
    if (logTail) {
      throw new Error(`Dashboard server failed to start. Recent dashboard log:\n${logTail}`);
    }
    throw new Error("Dashboard server failed to start. Check " + dashLogFile);
  }

  // Wait for health endpoint to be reachable
  await waitForHealthEndpoint(`http://127.0.0.1:${dashPort}${DASHBOARD_HEALTH_ENDPOINT}`);

  if (opts?.keepHandle) {
    return { pid: check.pid, port: dashPort, child };
  }

  return { pid: check.pid, port: dashPort };
}

/**
 * Stop the standalone dashboard server.
 *
 * Sends SIGTERM to the dashboard process and cleans up the PID file.
 * Returns true if a dashboard was stopped, false if none was running.
 */
export function stopDashboardStandalone(opts?: DaemonctlPathOptions): boolean {
  if (!opts?.homeDir) {
    assertStatePathIsolation(getDashboardPidFile(opts), "stopDashboardStandalone()");
  }
  const status = isDashboardRunning(opts);
  if (!status.running) return false;
  if (!canSignalPid(status.pid, opts)) return false;
  assertNotSchedulingDaemon(status.pid, "dashboard server");

  recordLifecycleEvent("stop.dashboard", status.pid, opts);
  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    // Process may have already exited
  }

  // Clean up PID file — the dashboard also cleans up on exit,
  // but we do it here as a safety measure
  try {
    fs.unlinkSync(getDashboardPidFile(opts));
  } catch {
    // Best effort
  }

  // Clean up port file so a fresh start can pick a different port
  try {
    fs.unlinkSync(getDashboardPortFile(opts));
  } catch {
    // Best effort
  }

  return true;
}

/**
 * Restart the standalone dashboard server.
 *
 * If the dashboard is currently running, stops it first, then starts a new
 * server on the previously configured port (or the port argument).
 * If no dashboard is running, starts one on the given port (default 3334).
 *
 * Returns { pid, port } like startDashboardStandalone.
 */
export async function restartDashboardStandalone(port?: number, opts?: StartOptions): Promise<{ pid: number; port: number }> {
  const currentPort = port ?? readPort(opts);

  if (isDashboardRunning(opts).running) {
    stopDashboardStandalone(opts);
    // Brief pause to let the port be released and process fully exit
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (opts) {
    return startDashboardStandalone(currentPort, opts);
  }
  return startDashboardStandalone(currentPort);
}

// ═══════════════════════════════════════════════════════════════════
// Stop-barrier helpers — poll-until-gone for each service
// ═══════════════════════════════════════════════════════════════════

/**
 * Poll until the dashboard process and port are both gone.
 *
 * Captures the PID from the dashboard PID file, then polls both PID
 * liveness (kill(0)) and TCP port liveness until both are gone.
 * Must be called after (or concurrently with) stopDashboardStandalone().
 * Times out after 10s with a clear error naming the dashboard.
 *
 * @param opts Optional homeDir for isolated testing.
 */
export async function waitForDashboardStop(opts?: DaemonctlPathOptions): Promise<void> {
  const dashPidFile = getDashboardPidFile(opts);
  const dashPort = readPort(opts);

  // Capture PID before stop (stopDashboardStandalone cleans up pidfiles immediately)
  const beforeStatus = checkPidFile(dashPidFile);
  if (!beforeStatus.running) return;

  const pid = beforeStatus.pid;
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    let pidAlive = true;
    try { process.kill(pid, 0); } catch { pidAlive = false; }

    const portOpen = await isTcpPortOpen(dashPort, 300);

    if (!pidAlive && !portOpen) return;

    await sleep(100);
  }

  // Timed out — build a precise diagnostic
  let pidAlive = true;
  try { process.kill(pid, 0); } catch { pidAlive = false; }
  const portOpen = await isTcpPortOpen(dashPort, 300);

  const stuckReasons: string[] = [];
  if (pidAlive) stuckReasons.push("process still alive (pid " + pid + ")");
  if (portOpen) stuckReasons.push("port " + dashPort + " still accepting connections");
  const reason = stuckReasons.length > 0 ? stuckReasons.join("; ") : "unknown reason";

  throw new Error("dashboard failed to stop within 10s: " + reason);
}

/**
 * Poll until the MCP process and port are both gone.
 *
 * Captures the PID from the MCP PID file, then polls both PID liveness
 * (kill(0)) and TCP port liveness until both are gone.
 * Must be called after (or concurrently with) stopMcp().
 * Times out after 10s with a clear error naming the MCP server.
 *
 * @param opts Optional homeDir for isolated testing.
 */
export async function waitForMcpStop(opts?: DaemonctlPathOptions): Promise<void> {
  const mcpPidFile = getMcpPidFile(opts);
  const mcpPort = readMcpPort(opts);

  const beforeStatus = checkPidFile(mcpPidFile);
  if (!beforeStatus.running) return;

  const pid = beforeStatus.pid;
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    let pidAlive = true;
    try { process.kill(pid, 0); } catch { pidAlive = false; }

    const portOpen = await isTcpPortOpen(mcpPort, 300);

    if (!pidAlive && !portOpen) return;

    await sleep(100);
  }

  let pidAlive = true;
  try { process.kill(pid, 0); } catch { pidAlive = false; }
  const portOpen = await isTcpPortOpen(mcpPort, 300);

  const stuckReasons: string[] = [];
  if (pidAlive) stuckReasons.push("process still alive (pid " + pid + ")");
  if (portOpen) stuckReasons.push("port " + mcpPort + " still accepting connections");
  const reason = stuckReasons.length > 0 ? stuckReasons.join("; ") : "unknown reason";

  throw new Error("MCP server failed to stop within 10s: " + reason);
}

/**
 * Poll until the daemon (control-plane) process and port are both gone.
 *
 * Captures the PID from the daemon PID file, then polls both PID liveness
 * (kill(0)) and TCP port liveness until both are gone.
 * Must be called after (or concurrently with) stopDaemon().
 * Times out after 10s with a clear error naming the daemon.
 *
 * @param opts Optional homeDir for isolated testing.
 */
export async function waitForDaemonStop(opts?: DaemonctlPathOptions): Promise<void> {
  const daemonPidFile = getPidFile(opts);
  const daemonPort = readControlPlanePort(opts);

  const beforeStatus = checkPidFile(daemonPidFile);
  if (!beforeStatus.running) return;

  const pid = beforeStatus.pid;
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    let pidAlive = true;
    try { process.kill(pid, 0); } catch { pidAlive = false; }

    const portOpen = await isTcpPortOpen(daemonPort, 300);

    if (!pidAlive && !portOpen) return;

    await sleep(100);
  }

  let pidAlive = true;
  try { process.kill(pid, 0); } catch { pidAlive = false; }
  const portOpen = await isTcpPortOpen(daemonPort, 300);

  const stuckReasons: string[] = [];
  if (pidAlive) stuckReasons.push("process still alive (pid " + pid + ")");
  if (portOpen) stuckReasons.push("port " + daemonPort + " still accepting connections");
  const reason = stuckReasons.length > 0 ? stuckReasons.join("; ") : "unknown reason";

  throw new Error("daemon failed to stop within 10s: " + reason);
}
