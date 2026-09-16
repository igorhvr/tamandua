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
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_MCP_PORT, MCP_ENDPOINT_PATH } from "./mcp-server.js";
import { DEFAULT_CONTROL_PORT } from "./control-server.js";
import { resolveEffectiveHomeDir, resolveStateDir } from "../lib/tamandua-config.js";
import { Deadline, isOlderThan } from "../lib/instant.js";
import {
  getServiceSocketPath,
  probeIdentitySocket,
  type DaemonIdentity,
} from "./daemon-identity.js";
import {
  isTamanduaServiceCmdline,
  resolvePortHolder,
  type ServiceHolderOptions,
  type ServiceKind,
} from "../lib/service-holder.js";
import { assertStatePathIsolation, spawnChildAttributionEnv, testGuardActive } from "../lib/test-guard.js";
import { logger } from "../lib/logger.js";
import {
  environHasEntry,
  getCmdline,
  getElapsedSeconds,
  getEnvironText,
  hasProcfs,
  processHasOpenFileUnder,
} from "../lib/proc-info.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STARTUP_ERROR_TAIL_LINES = 20;

/**
 * Rule-3 mtime tolerance for the start lock: a lock file whose OS-epoch mtime
 * is older than this is considered abandoned and replaced. Passed as the
 * `toleranceMs` of `isOlderThan(lockMtimeMs, 0, now, START_LOCK_STALE_MS)`,
 * so the decision is exactly the old `Date.now() - mtime > START_LOCK_STALE_MS`
 * (a fresh lock is never stolen — the conservative behavior).
 *
 * File mtimes are OS-epoch instants with no monotonic analogue, so this must
 * NOT be converted to monotonic time. An unparseable/NaN mtime is treated as
 * NOT stale (never steal a lock we cannot age).
 */
export const START_LOCK_STALE_MS = 30_000;

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

export const MCP_PID_FILE = path.join(resolveStateDir(), "mcp.pid");
export const MCP_PORT_FILE = path.join(resolveStateDir(), "mcp-port");

// ── Control plane file paths ──────────────────────────────────────

export const CONTROL_PLANE_PID_FILE = path.join(resolveStateDir(), "control-plane.pid");
export const CONTROL_PLANE_PORT_FILE = path.join(resolveStateDir(), "control-plane-port");
export const CONTROL_PLANE_LOG_FILE = path.join(resolveStateDir(), "control-plane.log");

export interface DaemonctlPathOptions {
  /**
   * When set, use this directory instead of ~/.tamandua for PID, port,
   * and log files. Tests should use this to avoid touching live state.
   */
  homeDir?: string;
}

// ── File path helpers ───────────────────────────────────────────────

function getTamanduaDir(opts?: DaemonctlPathOptions): string {
  return resolveStateDir(opts);
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

/**
 * Rule-3 tolerance for the macOS pidfile provenance check, in seconds. The
 * pidfile is written while the recorded process is alive, so a reused pid
 * pointing at an unrelated (or production) process would have started AFTER
 * the pidfile, i.e. be younger than it. This slack absorbs the normal race
 * between process start and pidfile write, plus coarse mtime granularity.
 */
export const PIDFILE_AGE_SLACK_SECONDS = 120;

/**
 * The complete set of daemon-family pid files written under a tamandua
 * state dir. Both `processHomeMatches` (the env-unavailable provenance
 * fallback) and `stopDaemonFamily` (test teardown) iterate this single source
 * of truth, so family membership can never drift between the guard and the
 * teardown.
 */
export const DAEMON_FAMILY_PID_FILES: readonly string[] = [
  "tamandua.pid",
  "mcp.pid",
  "control-plane.pid",
  "dashboard.pid",
];

/** One pid-file/pid pair in a stopDaemonFamily summary. */
export interface DaemonFamilyStopEntry {
  pidFile: string;
  pid: number | null;
}

/** Result of stopDaemonFamily: every pid file accounted for by category. */
export interface DaemonFamilyStopSummary {
  stopped: DaemonFamilyStopEntry[];
  skippedMissing: DaemonFamilyStopEntry[];
  skippedStale: DaemonFamilyStopEntry[];
  skippedNotSignalable: DaemonFamilyStopEntry[];
  timedOut: DaemonFamilyStopEntry[];
}

/**
 * Whether process-provenance evidence permits sending a signal.
 *
 * Pure and total: only a definitive `true` permits it. `false` (no evidence)
 * and `"unknown"` (a bounded probe timed out / lsof was unavailable) both
 * refuse — the guard only ever loosens into a signal, so a probe that could
 * not answer must fail closed. Exported so the rule is unit-testable without
 * spawning lsof.
 */
export function processEvidencePermitsSignal(evidence: boolean | "unknown"): boolean {
  return evidence === true;
}

/**
 * Rule-3 provenance predicate for macOS: true when the process recorded in a
 * pidfile is NOT younger than that pidfile (within the documented slack).
 *
 * `pidfileMtimeMs` is the pidfile's OS-epoch mtime and
 * `processElapsedSeconds` the process age reported by the OS (`null` when
 * unavailable). The mtime is a file instant with no monotonic analogue, so the
 * comparison keeps OS-epoch semantics and routes through the shared
 * `isOlderThan()` helper: it is stale-for-this-process when the pidfile age
 * exceeds the process age plus the `PIDFILE_AGE_SLACK_SECONDS` tolerance.
 *
 * Unknown inputs refuse the match (the caller falls through to the next
 * pidfile, then the open-file check) rather than loosening the guard.
 */
function pidfileProvenanceMatches(
  pidfileMtimeMs: number,
  processElapsedSeconds: number | null,
  nowMs: number = Date.now(),
): boolean {
  if (processElapsedSeconds === null || !Number.isFinite(processElapsedSeconds)) {
    return false;
  }
  // NaN/Infinity mtime => `isOlderThan` is false => `!false` would MATCH, so
  // refuse explicitly: we never claim provenance from an instant we cannot age.
  if (!Number.isFinite(pidfileMtimeMs)) return false;
  return !isOlderThan(
    pidfileMtimeMs,
    processElapsedSeconds * 1000,
    nowMs,
    PIDFILE_AGE_SLACK_SECONDS * 1000,
  );
}

/**
 * @internal Test seam for {@link pidfileProvenanceMatches} — the OS-epoch
 * mtime-tolerance boundary is asserted per elapsed process age.
 */
export function _pidfileProvenanceMatchesForTest(
  pidfileMtimeMs: number,
  processElapsedSeconds: number | null,
  nowMs: number = Date.now(),
): boolean {
  return pidfileProvenanceMatches(pidfileMtimeMs, processElapsedSeconds, nowMs);
}

function processHomeMatches(pid: number, stateDir: string): boolean {
  // Provenance fallback used only when the candidate's environment cannot be
  // read (native helper not built, other user). Bind by provenance to the
  // EFFECTIVE state dir. Refusing on any lookup failure is intentional — this
  // guard only ever loosens into a signal. Evidence, either of:
  //  (a) the pid is recorded in one of this state dir's service pidfiles AND
  //      the process is not younger than its pidfile (minus slack) — the
  //      pidfile is written while the recorded process is alive, so a
  //      reused pid pointing at an unrelated (or production) process would
  //      have started AFTER the pidfile, i.e. be younger than it; or
  //  (b) the process holds a file open under this state dir (services keep
  //      their log fd open for life) — kernel-verified via lsof, and covers
  //      healthy services whose pidfile was lost.
  // (b) is bounded and tri-state: a timed-out/unavailable lsof probe reports
  // "unknown", which is refused (never treated as "no open files").
  const dir = path.resolve(stateDir);
  for (const name of DAEMON_FAMILY_PID_FILES) {
    try {
      const pidFile = path.join(dir, name);
      const recorded = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      if (recorded !== pid) continue;
      // Rule 3: the pidfile's mtime is an OS-epoch file instant (no monotonic
      // analogue), so `pidfileProvenanceMatches` ages it against the process
      // age via `isOlderThan()` with the documented PIDFILE_AGE_SLACK_SECONDS
      // tolerance. No wall-clock interval math here.
      if (
        pidfileProvenanceMatches(fs.statSync(pidFile).mtimeMs, getElapsedSeconds(pid))
      ) {
        return true;
      }
    } catch {
      // Missing/unreadable pidfile — try the next one.
    }
  }
  const evidence = processHasOpenFileUnder(pid, dir);
  if (!processEvidencePermitsSignal(evidence)) {
    if (evidence === "unknown") {
      logger.warn("processHomeMatches: provenance probe unknown; refusing to signal", {
        pid,
        dir,
      });
    }
    return false;
  }
  return true;
}

/**
 * Whether `pid` provably belongs to the effective Tamandua configuration.
 *
 * A process is OURS when its environment's effective state dir equals ours:
 *  - an explicit `TAMANDUA_STATE_DIR` names the effective state dir exactly
 *    (an explicit non-match is foreign even when `HOME` matches), or
 *  - with no state-dir override, it names our `HOME` and the effective state
 *    dir IS that home's default `.tamandua`.
 *
 * Environ evidence is tested FIRST on every platform: procfs on Linux, and on
 * macOS the native `proc-info env` helper (sysctl KERN_PROCARGS2), which reads
 * a same-user process's environ block even though `ps -E` cannot (US-001).
 * When that evidence is available but does not match, the candidate is foreign
 * and rejected immediately — it is never re-admitted through the weaker
 * provenance path.
 *
 * Only when the environment cannot be read at all (helper not built, other
 * user) do we fall back to pidfile/open-file provenance, bound to the
 * EFFECTIVE STATE DIR returned by `resolveStateDir(opts)` — never a hardcoded
 * `<home>/.tamandua`, so a `TAMANDUA_STATE_DIR` override is honored on darwin
 * exactly as the env check honors it on Linux.
 *
 * This is deliberately NOT conditioned on `opts.homeDir`: a CLI configured
 * only through `HOME` / `TAMANDUA_STATE_DIR` must still reject a daemon that
 * belongs to another state dir (the production daemon on port 3339), which is
 * exactly the defect the old `return true` when `opts.homeDir` was absent
 * caused.
 */
function processBelongsToEffectiveConfig(pid: number, opts?: DaemonctlPathOptions): boolean {
  const effectiveHome = resolveEffectiveHomeDir(opts);
  const effectiveStateDir = path.resolve(resolveStateDir(opts));

  // Exact environ membership is the strongest binding and is available on
  // every platform (procfs on Linux, KERN_PROCARGS2 on macOS) — test it first.
  const environ = getEnvironText(pid);
  if (environ !== null) {
    const entries = new Set(environ.split("\0"));
    // An explicit TAMANDUA_STATE_DIR is authoritative: match it exactly, and
    // an explicit NON-match is foreign even when HOME happens to match.
    const declaredStateDir = [...entries].find((e) => e.startsWith("TAMANDUA_STATE_DIR="));
    if (declaredStateDir !== undefined) return declaredStateDir === `TAMANDUA_STATE_DIR=${effectiveStateDir}`;
    // No state-dir override in the candidate: it owns <effectiveHome>/.tamandua
    // when it names our HOME and that IS the effective state dir.
    if (
      effectiveStateDir === path.resolve(path.join(effectiveHome, ".tamandua")) &&
      entries.has(`HOME=${effectiveHome}`)
    ) {
      return true;
    }
    return false;
  }

  // Environment unavailable (helper not built, other user): provenance
  // binding against the effective state dir.
  return processHomeMatches(pid, effectiveStateDir);
}

/**
 * Home/state-dir binding guard used by every takeover/liveness path: true
 * ONLY when the candidate pid provably belongs to the effective Tamandua
 * state dir. Exported so tests can pin the scoping directly.
 *
 * Callers may still inject `opts.canSignal` on the resolver options to
 * override this default (tests and doctor use that seam).
 */
export function canSignalPid(pid: number, opts?: DaemonctlPathOptions): boolean {
  return processBelongsToEffectiveConfig(pid, opts);
}

/**
 * Whether a probed identity belongs to the effective Tamandua configuration.
 *
 * The identity socket is authoritative for LIVENESS, but a socket can hold a
 * leftover claim from a daemon started under a different state dir. An
 * identity that advertises a `stateDir` (DPID) is accepted only when it equals
 * the effective state dir; identities without one (pre-DPID fixtures and
 * builds) stay valid.
 */
function identityBelongsToEffectiveStateDir(
  identity: DaemonIdentity,
  opts?: DaemonctlPathOptions,
): boolean {
  if (identity.stateDir === undefined) return true;
  return path.resolve(identity.stateDir) === path.resolve(resolveStateDir(opts));
}

/**
 * Probe a service's identity socket for a live process belonging to the
 * effective state dir.
 *
 * Returns the live identity, or `null` when nothing answers, when the answer
 * advertises a DIFFERENT state dir (foreign socket, never adopted), or when the
 * test-isolation guard blocks production path resolution (mirrors the
 * `resolveLiveDaemonForStart` guard handling). Never throws for an expected
 * probe failure.
 */
async function probeLiveServiceIdentity(
  service: ServiceKind,
  opts?: DaemonctlPathOptions,
): Promise<DaemonIdentity | null> {
  let identity: DaemonIdentity | null;
  try {
    identity = await probeIdentitySocket(getServiceSocketPath(service, opts));
  } catch (err) {
    if (isIsolationViolation(err)) return null;
    throw err;
  }
  if (!identity) return null;
  return identityBelongsToEffectiveStateDir(identity, opts) ? identity : null;
}

/**
 * Guard: refuse to signal the daemon that is scheduling the CURRENT agent.
 *
 * Tamandua agents inherit the daemon's environment, including
 * TAMANDUA_DAEMON_PID (the scheduling daemon's own pid; the harness launch
 * wrapper exports the WORKER pid separately as TAMANDUA_WORKER_PID). An
 * agent working on daemon-lifecycle features that runs `tamandua dashboard
 * stop` (or restart) with the real HOME would therefore SIGTERM the very
 * daemon dispatching it — the dying daemon then kills the agent mid-restart
 * and strands the run. Lifecycle testing from inside a run must target an
 * isolated instance instead.
 */
function assertNotSchedulingDaemon(targetPid: number, what: string): void {
  const daemonPid = Number(process.env.TAMANDUA_DAEMON_PID ?? "");
  if (Number.isInteger(daemonPid) && daemonPid > 0 && daemonPid === targetPid) {
    throw new Error(
      `Refusing to stop the ${what} (pid ${targetPid}): it is the daemon scheduling ` +
        `the current tamandua agent run (TAMANDUA_DAEMON_PID matches). Stopping it ` +
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

/**
 * Rule-3 start-lock staleness: true when the lock file's OS-epoch mtime is
 * older than `START_LOCK_STALE_MS` (passed as `isOlderThan`'s tolerance so the
 * constant stays the documented threshold). File mtimes have no monotonic
 * analogue, so this keeps wall/OS-epoch semantics; a NaN/Infinity mtime is
 * never stale (never steal a lock we cannot age).
 */
function startLockIsStale(lockMtimeMs: number, nowMs: number = Date.now()): boolean {
  return isOlderThan(lockMtimeMs, 0, nowMs, START_LOCK_STALE_MS);
}

/**
 * @internal Test seam for {@link startLockIsStale} — the OS-epoch
 * mtime-tolerance boundary.
 */
export function _startLockIsStaleForTest(
  lockMtimeMs: number,
  nowMs: number = Date.now(),
): boolean {
  return startLockIsStale(lockMtimeMs, nowMs);
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
      // Rule 3: the lock file's mtime is an OS-epoch instant, so staleness
      // routes through `startLockIsStale`/`isOlderThan()` with the documented
      // START_LOCK_STALE_MS tolerance — never a `Date.now()` difference.
      if (startLockIsStale(stat.mtimeMs)) {
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

/**
 * @internal Direct seam for the start-lock acquisition behavior: a missing
 * lock file is created, a fresh one is refused (`null`), and a stale one is
 * replaced. Returns the open fd (caller closes/unlinks) or `null`.
 */
export function _acquireStartLockForTest(lockFile: string): number | null {
  return acquireStartLock(lockFile);
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
  const deadline = new Deadline(timeoutMs);
  while (!deadline.expired()) {
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

/** True when an error is the test-isolation guard refusing production state. */
function isIsolationViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes("TEST ISOLATION VIOLATION");
}

/**
 * Resolve a live service from the TCP holder of one of its ports
 * (synchronous).
 *
 * This is the pidfile-less fallback for {@link isRunning} /
 * {@link isDashboardRunning} / {@link isMcpRunning}: it runs the platform's
 * `ss`/`lsof` via {@link resolvePortHolder}, verifies the holder's command line
 * is the named Tamandua service, and then applies the same home-binding guard
 * (`canSignalPid`) the takeover path uses so an isolated caller can never adopt
 * a production process.
 *
 * Returns the holder pid, or null when nothing verified. When the guard is
 * active and no explicit `homeDir` is set the fallback is skipped entirely —
 * resolving by a bare default port would otherwise adopt the live production
 * service (the daemonctl-guard contract).
 */
function resolveServicePortHolder(
  service: ServiceKind,
  readPortFn: (opts?: DaemonctlPathOptions) => number,
  opts?: ResolveLiveDaemonOptions,
): number | null {
  if (!opts?.homeDir && testGuardActive()) return null;

  const canSignal = opts?.canSignal ?? canSignalPid;
  let port: number;
  try {
    port = readPortFn(opts);
  } catch (err) {
    if (isIsolationViolation(err)) return null;
    throw err;
  }

  let holder: { pid: number; cmdline: string } | null;
  try {
    holder = resolvePortHolder(port, service, opts?.holder ?? {});
  } catch (err) {
    if (isIsolationViolation(err)) return null;
    throw err;
  }
  if (!holder) return null;
  if (!canSignal(holder.pid, opts)) return null;
  return holder.pid;
}

/** Daemon-specific shim over {@link resolveServicePortHolder}. */
function resolveDaemonPortHolder(opts?: ResolveLiveDaemonOptions): number | null {
  return resolveServicePortHolder("daemon", readControlPlanePort, opts);
}

/**
 * Dashboard-specific shim over {@link resolveServicePortHolder}, used by the
 * synchronous status fast path (pidfile first, then the verified port holder).
 * The async resolver prefers `dashboard.sock`; this sync fallback still
 * recovers a pidfile-less dashboard on older builds without a socket.
 */
function resolveDashboardPortHolder(opts?: ResolveLiveDaemonOptions): number | null {
  return resolveServicePortHolder("dashboard", readPort, opts);
}

/**
 * MCP-specific shim over {@link resolveServicePortHolder}. A daemon.js holder
 * is accepted too: the daemon hosts MCP in-process, so the MCP port may be
 * held by the daemon process (see isTamanduaServiceCmdline).
 */
function resolveMcpPortHolder(opts?: ResolveLiveDaemonOptions): number | null {
  return resolveServicePortHolder("mcp", readMcpPort, opts);
}

/**
 * Check if the daemon process is running.
 *
 * Keeps the pidfile as a fast path (and informational hint), then falls back
 * to the verified control-port holder so a daemon that lost its pidfile is
 * still reported running (DPID takeover).
 */
export function isRunning(opts?: DaemonctlPathOptions): { running: true; pid: number } | { running: false } {
  let pidFile: string;
  try {
    pidFile = getPidFile(opts);
  } catch (err) {
    if (isIsolationViolation(err)) return { running: false };
    throw err;
  }

  const fromPidFile = checkPidFile(pidFile);
  if (fromPidFile.running) return fromPidFile;

  const holderPid = resolveDaemonPortHolder(opts);
  if (holderPid !== null) return { running: true, pid: holderPid };

  return { running: false };
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

/**
 * Async daemon status that resolves by socket identity → verified port holder
 * → pidfile, so `daemon status` can name both the live pid and HOW it was
 * found even when the pidfile is gone.
 */
export async function getDaemonStatusAsync(opts?: ResolveLiveDaemonOptions): Promise<{
  running: boolean;
  pid: number | null;
  port: number;
  source: LiveServiceSource | null;
  /** A Tamandua daemon on the configured port for another state dir, if any. */
  foreignHolder?: ForeignDaemonHolder | null;
}> {
  let port: number;
  try {
    port = opts?.port ?? readControlPlanePort(opts);
  } catch (err) {
    if (isIsolationViolation(err)) {
      return { running: false, pid: null, port: DEFAULT_CONTROL_PORT, source: null };
    }
    throw err;
  }

  let resolution: LiveDaemonResolution;
  try {
    resolution = await resolveLiveDaemonDetailed(opts);
  } catch (err) {
    if (isIsolationViolation(err)) {
      return { running: false, pid: null, port, source: null };
    }
    throw err;
  }
  const live = resolution.live;
  if (!live) {
    return {
      running: false,
      pid: null,
      port,
      source: null,
      foreignHolder: resolution.foreignHolder,
    };
  }
  return {
    running: true,
    pid: live.pid,
    port: live.port || port,
    source: live.source,
    foreignHolder: null,
  };
}

// ── Child spawn environment ────────────────────────────────────────

/**
 * Build the environment for a spawned tamandua child process.
 *
 * Every tamandua child spawn site in this module (startDaemon, startMcp,
 * startControlPlane, startDashboardStandalone) funnels its env through this
 * helper so that, when the test-isolation guard is active AND the caller sits
 * in a .test. frame, the child inherits TAMANDUA_TEST_GUARD_TEST_FILE naming
 * the spawning test file (see spawnChildAttributionEnv() in
 * src/lib/test-guard.ts). The CHILD's own stack has no .test. frames, so
 * without that env its guard-ledger entries (e.g. a production-port bind)
 * would be orphaned under "(unknown)" in the lane report instead of naming
 * the test that spawned it.
 *
 * Merge order is process env → child-attribution env → `overrides`, so an
 * explicit site override (control port, HOME) can never be clobbered by the
 * attribution var. When the guard is inactive — or active but no .test. frame
 * is derivable, e.g. a daemon spawning a grandchild — the attribution env is
 * {} and the result is byte-identical to the pre-change
 * `{ ...process.env, ...overrides }` merge (production spawns unchanged). A
 * var already present in process.env (a daemon child inheriting it from its
 * own spawner) passes through untouched, chaining attribution to
 * grandchildren.
 */
export function buildSpawnEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...spawnChildAttributionEnv(), ...(overrides ?? {}) };
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

  // Refuse to spawn a colliding daemon when one is already live but its
  // pidfile is gone: resolve by identity socket, then the verified holder of
  // the requested control port.
  const liveBeforeStart = await resolveLiveDaemonForStart(controlPort, opts);
  if (liveBeforeStart) {
    return { pid: liveBeforeStart.pid, port: liveBeforeStart.port };
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

    const liveAfterLock = await resolveLiveDaemonForStart(controlPort, opts);
    if (liveAfterLock) {
      return { pid: liveAfterLock.pid, port: liveAfterLock.port };
    }

    fs.writeFileSync(portFile, String(controlPort), "utf-8");

    const out = fs.openSync(logFile, "a");
    const errFd = fs.openSync(logFile, "a");

    const daemonScript = path.resolve(__dirname, "daemon.js");
    // Route the child env through buildSpawnEnv: under the test guard this
    // merges TAMANDUA_TEST_GUARD_TEST_FILE (naming the spawning test) so
    // child-side guard-ledger entries are attributed instead of "(unknown)".
    const daemonEnv: Record<string, string> = { TAMANDUA_CONTROL_PORT: String(controlPort) };
    if (opts?.homeDir) {
      daemonEnv.HOME = opts.homeDir;
      // Pin the child's effective state dir to the one the parent resolved.
      // resolveStateDir() prefers TAMANDUA_STATE_DIR over HOME, so inheriting
      // a stale override would make the child write its pid/socket somewhere
      // other than getPidFile()/getServiceSocketPath() look.
      daemonEnv.TAMANDUA_STATE_DIR = resolveStateDir(opts);
    }
    const spawnOpts: Parameters<typeof spawn>[2] = {
      detached: true,
      stdio: ["ignore", out, errFd],
      env: buildSpawnEnv(daemonEnv),
    };
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
    // Monotonic deadline (TIME-CLOCKS rule 1): a wall-clock jump cannot make
    // this wait expire early or run past its budget.
    const daemonDeadline = new Deadline(10_000);
    let check = checkPidFile(pidFile);
    while (!check.running && !daemonDeadline.expired()) {
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
 * Signal exactly one resolved, verified daemon pid (shared by the synchronous
 * {@link stopDaemon} and the async takeover path).
 *
 * The only signal ever sent here is SIGTERM to the exact pid; callers are
 * responsible for having verified the pid first. The scheduling-daemon guard
 * runs before any signal so an agent inside a run can never kill its own
 * dispatcher.
 */
function signalDaemonPid(pid: number, opts?: DaemonctlPathOptions, event = "stop.daemon"): void {
  assertNotSchedulingDaemon(pid, "daemon");
  recordLifecycleEvent(event, pid, opts);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process may have already exited
  }
}

/**
 * Stop the daemon (control-plane+motor).
 *
 * Sends SIGTERM to the daemon process and cleans up the PID file.
 * Returns true if a daemon was stopped, false if none was running.
 *
 * Resolution is takeover-aware: {@link isRunning} reports a daemon that lost
 * its pidfile as long as a verified Tamandua process holds the control port.
 */
export function stopDaemon(opts?: DaemonctlPathOptions): boolean {
  if (!opts?.homeDir) {
    assertStatePathIsolation(getPidFile(opts), "stopDaemon()");
  }
  const status = isRunning(opts);
  if (!status.running) return false;
  if (!canSignalPid(status.pid, opts)) return false;

  signalDaemonPid(status.pid, opts);

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

  // Takeover stop resolves by socket identity → verified port holder →
  // pidfile, so a daemon that lost its pidfile is still replaced instead of
  // collided with. It also waits (bounded) for the exact pid to exit and the
  // control port to free before startDaemon() binds again.
  let stopResult: TakeoverResult;
  try {
    stopResult = await stopDaemonTakeover(opts);
  } catch (err) {
    if (!isIsolationViolation(err)) throw err;
    stopResult = { stopped: false, escalated: false, portFree: false };
  }
  if (stopResult.pid !== undefined) {
    recordLifecycleEvent("restart.daemon", stopResult.pid, opts, {
      escalated: stopResult.escalated,
      portFree: stopResult.portFree,
    });
  }

  if (opts) {
    return startDaemon(currentPort, opts);
  }
  return startDaemon(currentPort);
}

// ═══════════════════════════════════════════════════════════════════
// DPID takeover — find and replace a live daemon that has no pidfile
// ═══════════════════════════════════════════════════════════════════
//
// The historical defect: a daemon that lost the control-port bind race
// unlinked the pidfile (which held the LIVE daemon's pid) on its way out,
// leaving a running daemon with no pidfile. `daemon status` then said "not
// running" and restart/update spawned colliding daemons instead of replacing
// it. Resolution below never depends on the pidfile: it prefers the identity
// socket, then the TCP port holder, and only then the pidfile hint.

/** How a live daemon was discovered. */
export type LiveServiceSource = "socket" | "port-holder" | "pidfile";

/** A live Tamandua service located by {@link resolveLiveDaemon}. */
export interface LiveService {
  service: ServiceKind;
  pid: number;
  /** TCP port the service is relevant on (control port for the daemon). */
  port: number;
  source: LiveServiceSource;
  /** Build version — only known from the identity socket. */
  buildVersion?: string;
  /** ISO start time — only known from the identity socket. */
  startedAt?: string;
}

/** Outcome of a {@link stopDaemonTakeover} attempt. */
export interface TakeoverResult {
  /** True when a resolved service died as a result of the takeover. */
  stopped: boolean;
  /** The pid that was resolved and signalled, when one was found. */
  pid?: number;
  /** True when SIGTERM did not suffice and SIGKILL was sent. */
  escalated: boolean;
  /** True only once the control port stopped accepting TCP connections. */
  portFree: boolean;
  /**
   * A Tamandua daemon discovered on the configured control port that belongs
   * to a DIFFERENT state dir (DPID scoping). Present only when nothing of ours
   * was resolved and a foreign holder was proven; it is never signalled.
   */
  foreignHolder?: ForeignDaemonHolder | null;
}

/** Default SIGTERM → SIGKILL grace window (TAMANDUA_TAKEOVER_GRACE_MS). */
export const DEFAULT_TAKEOVER_GRACE_MS = 15_000;
const TAKEOVER_POLL_MS = 100;
const TAKEOVER_KILL_WAIT_MS = 2_000;
const TAKEOVER_PORT_VERIFY_TIMEOUT_MS = 5_000;

/** What a live `/control/health` probe reports about the serving daemon. */
export interface ControlPlaneHealthInfo {
  /** Serving pid, when advertised. */
  pid: number | null;
  /** Serving process's effective state dir, when advertised. */
  stateDir: string | null;
}

/**
 * Options for {@link resolveLiveDaemon} / {@link stopDaemonTakeover}.
 *
 * Extends the usual path options with injectable probes so unit tests can
 * exercise both platform formats and every resolution branch without spawning
 * `ss`/`lsof`/`ps` or touching a real process.
 */
export interface ResolveLiveDaemonOptions extends DaemonctlPathOptions {
  /**
   * Explicit control-plane port override. When set, liveness resolution
   * inspects ONLY this port — the control-plane port file is never read, so a
   * `start --port N` check and its bind target cannot disagree.
   */
  port?: number;
  /** Identity-socket probe override (default: probeIdentitySocket). */
  probeSocket?: (socketPath: string, timeoutMs?: number) => Promise<DaemonIdentity | null>;
  /** Port-holder resolver options (default: real ss/lsof + proc-info). */
  holder?: ServiceHolderOptions;
  /** Home-binding guard override (default: canSignalPid). */
  canSignal?: (pid: number, opts?: DaemonctlPathOptions) => boolean;
  /** Pidfile probe override (default: checkPidFile — kill(0) liveness). */
  checkPid?: (pidFile: string) => { running: true; pid: number } | { running: false };
  /**
   * `/control/health` probe override for the CONFIGURED control port (default:
   * a bounded HTTP GET). Returns null when the endpoint does not answer, so
   * "no evidence" stays distinct from a state-dir mismatch.
   */
  probeHealth?: (port: number) => Promise<ControlPlaneHealthInfo | null>;
}

/** A Tamandua daemon holding the configured port that is NOT ours. */
export interface ForeignDaemonHolder {
  /** Pid holding the configured port. */
  pid: number;
  /** The configured port the holder listens on. */
  port: number;
  /** State dir the holder reported via `/control/health`. */
  stateDir: string;
}

/** Full outcome of {@link resolveLiveDaemonDetailed}. */
export interface LiveDaemonResolution {
  /** Our live daemon, or null when none belongs to the effective config. */
  live: LiveService | null;
  /**
   * A Tamandua daemon holding the configured port that proved it belongs to a
   * DIFFERENT state dir. Distinct from `live: null, foreignHolder: null`,
   * where nothing verified was found at all.
   */
  foreignHolder: ForeignDaemonHolder | null;
}

/** Injectable process/time/filesystem dependencies for {@link stopDaemonTakeover}. */
export interface TakeoverStopDeps {
  /** Signal sender (default: process.kill). */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Liveness probe (default: kill(pid, 0)). */
  isAlive?: (pid: number) => boolean;
  /** Sleep primitive (default: setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic-ish clock (default: Date.now). */
  now?: () => number;
  /** Resolver override (default: resolveLiveDaemon). */
  resolve?: (opts?: ResolveLiveDaemonOptions) => Promise<LiveService | null>;
  /**
   * Detailed resolver override. When set (and `resolve` is not), the foreign
   * holder a detailed resolution surfaces is carried on the result instead of
   * being dropped, so `stop` can report a foreign daemon it never signals.
   */
  resolveDetailed?: (opts?: ResolveLiveDaemonOptions) => Promise<LiveDaemonResolution>;
  /** TCP connect probe (default: isTcpPortOpen). */
  isPortOpen?: (port: number, timeoutMs?: number) => Promise<boolean>;
  /** Best-effort unlink (default: fs.unlinkSync). */
  unlink?: (file: string) => void;
  /** Grace override; takes precedence over TAMANDUA_TAKEOVER_GRACE_MS. */
  graceMs?: number;
  /** Poll interval for the liveness/port loops. */
  pollMs?: number;
  /** Bounded wait after SIGKILL (default 2 s). */
  killWaitMs?: number;
  /** Bounded wait for the control port to free (default 5 s). */
  portVerifyTimeoutMs?: number;
}

/** Resolve the takeover grace window (dept override → env → 15 s default). */
export function readTakeoverGraceMs(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return override;
  }
  const fromEnv = Number(process.env.TAMANDUA_TAKEOVER_GRACE_MS ?? "");
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_TAKEOVER_GRACE_MS;
}

/** kill(pid, 0) liveness probe. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort unlink that never throws. */
function unlinkBestEffort(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone / not allowed — best effort.
  }
}

/**
 * Resolve a live daemon without trusting the pidfile, surfacing foreign holders.
 *
 * Order (mirrors the DPID contract):
 *  (a) probe `<state>/daemon.sock` — authoritative live identity (pid, build,
 *      control port, startedAt);
 *  (b) else the holder of the CONFIGURED control port — `opts.port` when given,
 *      else the control-plane port file — verified as a Tamandua daemon via
 *      its command line. `/control/health` on that same port then proves which
 *      state dir it serves: an equal state dir accepts the holder; a different
 *      one classifies it as a foreign candidate and yields no live service;
 *  (c) else the pidfile hint, accepted only when the pid is alive AND verifies
 *      as a Tamandua daemon.
 *
 * ONLY the configured control port is ever inspected — a Tamandua daemon on
 * any other port is invisible here. Every non-socket candidate must also be
 * within the effective state dir when `/control/health` cannot prove
 * ownership (`canSignalPid`), so a different state dir can never be adopted.
 */
export async function resolveLiveDaemonDetailed(
  opts?: ResolveLiveDaemonOptions,
): Promise<LiveDaemonResolution> {
  const probeSocket = opts?.probeSocket ?? probeIdentitySocket;
  const canSignal = opts?.canSignal ?? canSignalPid;
  const holderOptions: ServiceHolderOptions = opts?.holder ?? {};
  const checkPid = opts?.checkPid ?? checkPidFile;
  const readCmdline = holderOptions.getCmdline ?? getCmdline;
  const probeHealth = opts?.probeHealth ?? probeControlPlaneHealthInfo;

  // (a) Identity socket — the authoritative liveness primitive. An identity
  // advertising a DIFFERENT state dir is not ours (DPID scoping), so it is
  // treated as absent and resolution falls through to the port holder.
  const identity = await probeSocket(getServiceSocketPath("daemon", opts));
  if (identity && identityBelongsToEffectiveStateDir(identity, opts)) {
    return {
      live: {
        service: "daemon",
        pid: identity.pid,
        port: identity.controlPort,
        source: "socket",
        buildVersion: identity.buildVersion,
        startedAt: identity.startedAt,
      },
      foreignHolder: null,
    };
  }

  // The one and only port inspected: an explicit override wins over the file.
  const port = opts?.port ?? readControlPlanePort(opts);
  const effectiveStateDir = path.resolve(resolveStateDir(opts));

  // (b) TCP port holder, verified as a Tamandua daemon.
  const holder = resolvePortHolder(port, "daemon", holderOptions);
  if (holder) {
    // Ask the holder's /control/health (same configured port) which state dir
    // it serves. A reported mismatch proves a foreign daemon; a match accepts
    // the cmdline-verified holder.
    let health: ControlPlaneHealthInfo | null = null;
    try {
      health = await probeHealth(port);
    } catch {
      health = null;
    }
    if (health && health.stateDir !== null && health.stateDir !== "") {
      if (path.resolve(health.stateDir) !== effectiveStateDir) {
        return {
          live: null,
          foreignHolder: { pid: holder.pid, port, stateDir: health.stateDir },
        };
      }
      return {
        live: { service: "daemon", pid: holder.pid, port, source: "port-holder" },
        foreignHolder: null,
      };
    }
    // No health evidence: fall back to the effective-state-dir process guard
    // (US-003). A verified holder failing the guard is never adopted; without
    // advertised state-dir evidence it is not claimed to be foreign either.
    if (!canSignal(holder.pid, opts)) return { live: null, foreignHolder: null };
    return {
      live: { service: "daemon", pid: holder.pid, port, source: "port-holder" },
      foreignHolder: null,
    };
  }

  // (c) Pidfile hint — alive, verified Tamandua daemon, within this home.
  const status = checkPid(getPidFile(opts));
  if (status.running) {
    const cmdline = readCmdline(status.pid);
    if (isTamanduaServiceCmdline(cmdline, "daemon") && canSignal(status.pid, opts)) {
      return {
        live: { service: "daemon", pid: status.pid, port, source: "pidfile" },
        foreignHolder: null,
      };
    }
  }

  return { live: null, foreignHolder: null };
}

/**
 * Resolve a live daemon without trusting the pidfile.
 *
 * Thin wrapper over {@link resolveLiveDaemonDetailed} that returns only our
 * live service (a foreign holder is dropped). Callers that must report a
 * foreign daemon use the detailed resolver.
 */
export async function resolveLiveDaemon(
  opts?: ResolveLiveDaemonOptions,
): Promise<LiveService | null> {
  return (await resolveLiveDaemonDetailed(opts)).live;
}

/**
 * Shared socket → port-holder → pidfile resolution for one Tamandua service.
 *
 *  (a) probe the service identity socket — authoritative live identity;
 *  (b) else the TCP holder of `port`, verified as `service` via cmdline;
 *  (c) else the pidfile hint, accepted only when alive AND verified.
 *
 * Every non-socket candidate must be within the requested home when
 * `opts.homeDir` is set (`canSignalPid`). A verified holder outside the home
 * yields `null` rather than falling through to a possibly-unrelated pidfile.
 */
async function resolveLiveService(
  service: ServiceKind,
  port: number,
  pidFile: string,
  opts?: ResolveLiveDaemonOptions,
): Promise<LiveService | null> {
  const probeSocket = opts?.probeSocket ?? probeIdentitySocket;
  const canSignal = opts?.canSignal ?? canSignalPid;
  const holderOptions: ServiceHolderOptions = opts?.holder ?? {};
  const checkPid = opts?.checkPid ?? checkPidFile;
  const readCmdline = holderOptions.getCmdline ?? getCmdline;

  // (a) Identity socket — the authoritative liveness primitive. A payload
  // advertising a different state dir is not ours; fall through to the scoped
  // port-holder / pidfile stages.
  const identity = await probeSocket(getServiceSocketPath(service, opts));
  if (identity && identityBelongsToEffectiveStateDir(identity, opts)) {
    return {
      service,
      pid: identity.pid,
      port: identity.controlPort,
      source: "socket",
      buildVersion: identity.buildVersion,
      startedAt: identity.startedAt,
    };
  }

  // (b) TCP port holder, verified as this Tamandua service.
  const holder = resolvePortHolder(port, service, holderOptions);
  if (holder) {
    if (!canSignal(holder.pid, opts)) return null; // verified but outside this home
    return { service, pid: holder.pid, port, source: "port-holder" };
  }

  // (c) Pidfile hint — alive, verified Tamandua service, within this home.
  const status = checkPid(pidFile);
  if (status.running) {
    const cmdline = readCmdline(status.pid);
    if (isTamanduaServiceCmdline(cmdline, service) && canSignal(status.pid, opts)) {
      return { service, pid: status.pid, port, source: "pidfile" };
    }
  }

  return null;
}

/**
 * Resolve a live standalone dashboard without trusting the pidfile.
 *
 * Resolution is socket-first (the dashboard binds `dashboard.sock`, DPID), then
 * the verified holder of `readPort(opts)` (default 3334), then the pidfile as a
 * fallback hint for older builds.
 *
 * The test-isolation guard is enforced by the path helpers (socket/port/pidfile
 * resolution throws for the real state dir and is mapped to `null`), NOT by an
 * early return: a CLI configured only through `HOME` / `TAMANDUA_STATE_DIR`
 * (e.g. a test-spawned `tamandua dashboard stop`) must still resolve its own
 * isolated service, mirroring `resolveLiveDaemon`.
 */
export async function resolveLiveDashboard(
  opts?: ResolveLiveDaemonOptions,
): Promise<LiveService | null> {
  try {
    const port = readPort(opts);
    return await resolveLiveService("dashboard", port, getDashboardPidFile(opts), opts);
  } catch (err) {
    if (isIsolationViolation(err)) return null;
    throw err;
  }
}

/**
 * Resolve a live MCP server without trusting the pidfile.
 *
 * Resolution is socket-first (`mcp.sock`, DPID), then the verified holder of
 * the MCP port — a `daemon.js` holder is accepted because the daemon hosts MCP
 * in-process with `--with-mcp`, which is exactly what
 * `isTamanduaServiceCmdline(_, "mcp")` already permits — then the pidfile as a
 * fallback hint for older builds.
 *
 * Like {@link resolveLiveDashboard}, the test-isolation guard lives in the path
 * helpers rather than an early return, so an env-scoped CLI can still resolve
 * its own service while a bare in-process call against the real state dir is
 * mapped to `null`.
 */
export async function resolveLiveMcp(
  opts?: ResolveLiveDaemonOptions,
): Promise<LiveService | null> {
  try {
    const port = readMcpPort(opts);
    return await resolveLiveService("mcp", port, getMcpPidFile(opts), opts);
  } catch (err) {
    if (isIsolationViolation(err)) return null;
    throw err;
  }
}

/**
 * Resolve a live daemon that {@link startDaemon} must not collide with.
 *
 * Unlike {@link resolveLiveDaemon} this checks the identity socket and the
 * holder of the *requested* control port (the caller's argument), not the
 * port file, and never falls through to a pidfile (the caller already checked
 * it). Returns null when nothing verified — including when the test-isolation
 * guard blocks production path resolution.
 */
async function resolveLiveDaemonForStart(
  controlPort: number,
  opts?: ResolveLiveDaemonOptions,
): Promise<LiveService | null> {
  // (a) Identity socket — authoritative when it answers.
  let identity: DaemonIdentity | null = null;
  try {
    identity = await (opts?.probeSocket ?? probeIdentitySocket)(
      getServiceSocketPath("daemon", opts),
    );
  } catch (err) {
    if (isIsolationViolation(err)) return null;
    throw err;
  }
  if (identity && identityBelongsToEffectiveStateDir(identity, opts)) {
    return {
      service: "daemon",
      pid: identity.pid,
      port: identity.controlPort,
      source: "socket",
      buildVersion: identity.buildVersion,
      startedAt: identity.startedAt,
    };
  }

  // (b) Verified holder of the requested control port. Skipped under the guard
  // without an explicit homeDir so a test can never adopt a production daemon
  // listening on the same (default) port.
  if (!opts?.homeDir && testGuardActive()) return null;
  const canSignal = opts?.canSignal ?? canSignalPid;
  let holder: { pid: number; cmdline: string } | null;
  try {
    holder = resolvePortHolder(controlPort, "daemon", opts?.holder ?? {});
  } catch (err) {
    if (isIsolationViolation(err)) return null;
    throw err;
  }
  if (!holder) return null;
  if (!canSignal(holder.pid, opts)) return null;
  return { service: "daemon", pid: holder.pid, port: controlPort, source: "port-holder" };
}

/** Poll `isAlive` until it reports dead, the deadline passes, or attempts cap. */
async function waitForPidExit(
  pid: number,
  timeoutMs: number,
  deps: {
    isAlive: (pid: number) => boolean;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    pollMs: number;
  },
): Promise<void> {
  const deadline = deps.now() + timeoutMs;
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / Math.max(1, deps.pollMs)) + 1);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!deps.isAlive(pid)) return;
    if (deps.now() >= deadline) return;
    await deps.sleep(deps.pollMs);
  }
}

/** Poll the TCP connect probe until the port is free or the deadline passes. */
async function waitForPortFree(
  port: number,
  timeoutMs: number,
  deps: {
    isPortOpen: (port: number, timeoutMs?: number) => Promise<boolean>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    pollMs: number;
  },
): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / Math.max(1, deps.pollMs)) + 1);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!(await deps.isPortOpen(port, 300))) return true;
    if (deps.now() >= deadline) break;
    await deps.sleep(deps.pollMs);
  }
  return !(await deps.isPortOpen(port, 300));
}

/** Internal description of one service's takeover stop (DPID). */
interface TakeoverServiceSpec {
  /** Human label used by assertNotSchedulingDaemon diagnostics. */
  label: string;
  /** Lifecycle breadcrumb action, e.g. `takeover.daemon`. */
  event: string;
  /** Resolver for the live service (per-service defaults in the wrappers). */
  resolve: (opts?: ResolveLiveDaemonOptions) => Promise<LiveService | null>;
  /**
   * Optional detailed resolver. When present (and no explicit `deps.resolve`),
   * resolution goes through it so a proven foreign holder is carried on the
   * result rather than silently dropped.
   */
  resolveDetailed?: (opts?: ResolveLiveDaemonOptions) => Promise<LiveDaemonResolution>;
  /** Identity socket path (lazy: evaluation may hit the isolation guard). */
  socketPath: (opts?: DaemonctlPathOptions) => string;
  /** Informational pidfile path (lazy). */
  pidFile: (opts?: DaemonctlPathOptions) => string;
  /**
   * Optional configured-port file (lazy). After a successful stop it is
   * unlinked alongside the socket/pidfile so the next start is not misled into
   * reusing a stale port — but only AFTER the owning pid is gone.
   */
  portFile?: (opts?: DaemonctlPathOptions) => string;
}

/**
 * Stop the live service described by `spec` by identity: SIGTERM the exact
 * resolved pid, wait up to the grace window, SIGKILL when it survives, then
 * verify its TCP port is free. The stale identity socket/pidfile are unlinked
 * only AFTER the pid is gone, so a live owner's files are never removed.
 *
 * Refuses — via {@link assertNotSchedulingDaemon} — to stop the daemon that is
 * scheduling the current agent, and never signals a pid that failed
 * verification (resolution only returns verified services).
 *
 * All process/time/filesystem primitives are injectable so unit tests need no
 * real processes and no 15 s wait.
 */
async function stopServiceTakeover(
  spec: TakeoverServiceSpec,
  opts?: ResolveLiveDaemonOptions,
  deps?: TakeoverStopDeps,
): Promise<TakeoverResult> {
  const kill = deps?.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const isAlive = deps?.isAlive ?? isPidAlive;
  const sleepFn = deps?.sleep ?? sleep;
  const now = deps?.now ?? Date.now;
  const isPortOpen = deps?.isPortOpen ?? isTcpPortOpen;
  const unlink = deps?.unlink ?? unlinkBestEffort;
  const pollMs = deps?.pollMs ?? TAKEOVER_POLL_MS;
  const graceMs = readTakeoverGraceMs(deps?.graceMs);
  const killWaitMs = deps?.killWaitMs ?? TAKEOVER_KILL_WAIT_MS;
  const portVerifyTimeoutMs = deps?.portVerifyTimeoutMs ?? TAKEOVER_PORT_VERIFY_TIMEOUT_MS;

  // Prefer an explicit resolver override; otherwise use a detailed resolver
  // when one is available so a proven foreign holder is not silently dropped.
  const explicitResolve = deps?.resolve;
  const detailedResolve = deps?.resolveDetailed ?? (explicitResolve ? undefined : spec.resolveDetailed);
  let live: LiveService | null;
  let foreignHolder: ForeignDaemonHolder | null = null;
  if (explicitResolve) {
    live = await explicitResolve(opts);
  } else if (detailedResolve) {
    const resolution = await detailedResolve(opts);
    live = resolution.live;
    foreignHolder = resolution.foreignHolder;
  } else {
    live = await spec.resolve(opts);
  }

  if (!live) {
    // Nothing resolved: nothing to stop and no port we can claim is held. A
    // proven foreign holder is surfaced (never signalled) so the CLI can say
    // which daemon on the configured port belongs to another state dir.
    if (foreignHolder) {
      return { stopped: false, escalated: false, portFree: true, foreignHolder };
    }
    return { stopped: false, escalated: false, portFree: true };
  }

  assertNotSchedulingDaemon(live.pid, spec.label);
  recordLifecycleEvent(spec.event, live.pid, opts, {
    source: live.source,
    port: live.port,
    buildVersion: live.buildVersion,
  });

  let escalated = false;
  try {
    kill(live.pid, "SIGTERM");
  } catch {
    // Process may have already exited.
  }

  await waitForPidExit(live.pid, graceMs, { isAlive, sleep: sleepFn, now, pollMs });

  if (isAlive(live.pid)) {
    escalated = true;
    try {
      kill(live.pid, "SIGKILL");
    } catch {
      // Already gone between the check and the signal.
    }
    await waitForPidExit(live.pid, killWaitMs, { isAlive, sleep: sleepFn, now, pollMs });
  }

  const portFree = await waitForPortFree(live.port, portVerifyTimeoutMs, {
    isPortOpen,
    sleep: sleepFn,
    now,
    pollMs,
  });

  const stopped = !isAlive(live.pid);
  if (stopped) {
    // Only after the owner pid is gone: unlink the now-stale socket, pidfile
    // and configured-port file so the next start is not misled.
    try {
      unlink(spec.socketPath(opts));
      unlink(spec.pidFile(opts));
      if (spec.portFile) unlink(spec.portFile(opts));
    } catch {
      // Path resolution must never turn a successful stop into a failure.
    }
  }

  return { stopped, pid: live.pid, escalated, portFree };
}

/**
 * Stop the live daemon by identity (socket → verified control-port holder →
 * pidfile), escalating SIGTERM → SIGKILL → control-port-free verification.
 */
export async function stopDaemonTakeover(
  opts?: ResolveLiveDaemonOptions,
  deps?: TakeoverStopDeps,
): Promise<TakeoverResult> {
  return stopServiceTakeover(
    {
      label: "daemon",
      event: "takeover.daemon",
      resolve: deps?.resolve ?? resolveLiveDaemon,
      // Keep the foreign holder a detailed resolution proves (never signalled).
      resolveDetailed: resolveLiveDaemonDetailed,
      socketPath: (o) => getServiceSocketPath("daemon", o),
      pidFile: (o) => getPidFile(o),
    },
    opts,
    deps,
  );
}

/**
 * Stop the live standalone dashboard by identity (identity socket if present,
 * else the verified holder of the dashboard port), escalating SIGTERM →
 * SIGKILL → port-free verification. This lets update/restart replace a
 * dashboard whose pidfile is gone or that ignores HTTP. On success the stale
 * `dashboard.sock`, `dashboard.pid` and `port` files are unlinked (only after
 * the owner pid is gone) so the next start is not misled.
 */
export async function stopDashboardTakeover(
  opts?: ResolveLiveDaemonOptions,
  deps?: TakeoverStopDeps,
): Promise<TakeoverResult> {
  return stopServiceTakeover(
    {
      label: "dashboard server",
      event: "takeover.dashboard",
      resolve: deps?.resolve ?? resolveLiveDashboard,
      socketPath: (o) => getServiceSocketPath("dashboard", o),
      pidFile: (o) => getDashboardPidFile(o),
      portFile: (o) => getDashboardPortFile(o),
    },
    opts,
    deps,
  );
}

/**
 * Stop the live MCP server by identity (identity socket if present, else the
 * verified holder of the MCP port — a daemon.js holder counts because the
 * daemon hosts MCP in-process), escalating SIGTERM → SIGKILL → port-free. On
 * success the stale `mcp.sock`, `mcp.pid` and `mcp-port` files are unlinked
 * (only after the owner pid is gone) so the next start is not misled.
 */
export async function stopMcpTakeover(
  opts?: ResolveLiveDaemonOptions,
  deps?: TakeoverStopDeps,
): Promise<TakeoverResult> {
  return stopServiceTakeover(
    {
      label: "MCP server",
      event: "takeover.mcp",
      resolve: deps?.resolve ?? resolveLiveMcp,
      socketPath: (o) => getServiceSocketPath("mcp", o),
      pidFile: (o) => getMcpPidFile(o),
      portFile: (o) => getMcpPortFile(o),
    },
    opts,
    deps,
  );
}

/**
 * Async daemon stop used by `tamandua daemon stop` and update: the takeover
 * stop (SIGTERM the exact verified pid → bounded grace → SIGKILL → port-free
 * verification), so a daemon that lost its pidfile or ignores HTTP/IPC is
 * still replaced. Alias of {@link stopDaemonTakeover}.
 */
export const stopDaemonAsync = stopDaemonTakeover;

/**
 * Async dashboard stop alias used by update (takeover-aware).
 */
export const stopDashboardAsync = stopDashboardTakeover;

/**
 * Async MCP stop alias used by update (takeover-aware).
 */
export const stopMcpAsync = stopMcpTakeover;

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
 *
 * Keeps the pidfile as a fast path (and informational hint), then falls back to
 * the verified holder of the MCP port so an MCP server that lost its pidfile is
 * still reported running (DPID takeover). A `daemon.js` holder counts: the
 * daemon hosts MCP in-process.
 */
export function isMcpRunning(opts?: DaemonctlPathOptions): { running: true; pid: number } | { running: false } {
  let pidFile: string;
  try {
    pidFile = getMcpPidFile(opts);
  } catch (err) {
    if (isIsolationViolation(err)) return { running: false };
    throw err;
  }

  const fromPidFile = checkPidFile(pidFile);
  if (fromPidFile.running) return fromPidFile;

  const holderPid = resolveMcpPortHolder(opts);
  if (holderPid !== null) return { running: true, pid: holderPid };

  return { running: false };
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

  // Refuse to spawn a duplicate when a live MCP server lost its pidfile: the
  // identity socket (DPID) is authoritative, so darwin no longer depends on
  // pidfile/lsof parsing. A socket advertising another state dir is not ours.
  const liveBySocket = await probeLiveServiceIdentity("mcp", opts);
  if (liveBySocket) {
    return { pid: liveBySocket.pid, port: liveBySocket.controlPort };
  }

  const mcpPort = port ?? DEFAULT_MCP_PORT;

  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(mcpPortFile, String(mcpPort), "utf-8");

  const out = fs.openSync(mcpLogFile, "a");
  const errFd = fs.openSync(mcpLogFile, "a");

  const standaloneScript = resolveStandaloneScript();
  // Always pass an explicit env via buildSpawnEnv (previously env was omitted
  // unless homeDir was set): under the test guard this merges
  // TAMANDUA_TEST_GUARD_TEST_FILE so child-side guard-ledger entries are
  // attributed to the spawning test file instead of "(unknown)". When the
  // guard is inactive the env is a plain copy of process.env — exactly what
  // the child would inherit with the option omitted.
  const mcpEnv: Record<string, string> = {};
  if (opts?.homeDir) {
    mcpEnv.HOME = opts.homeDir;
    // Keep the child's effective state dir pinned to the parent's (see
    // startDaemon for the TAMANDUA_STATE_DIR precedence rationale).
    mcpEnv.TAMANDUA_STATE_DIR = resolveStateDir(opts);
  }
  const spawnOpts: Parameters<typeof spawn>[2] = {
    detached: true,
    stdio: ["ignore", out, errFd],
    env: buildSpawnEnv(mcpEnv),
  };
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
  // node startup can take well over a second. Monotonic deadline
  // (TIME-CLOCKS rule 1) so a wall jump cannot shorten it.
  const deadline = new Deadline(10_000);
  let check = checkPidFile(mcpPidFile);
  while (!check.running && !deadline.expired()) {
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
  const mcpTcpDeadline = new Deadline(10_000);
  let mcpTcpOk = false;
  while (!mcpTcpOk && !mcpTcpDeadline.expired()) {
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
 * Takeover-aware: the running MCP server is resolved by identity socket → the
 * verified holder of the MCP port → pidfile, stopped with SIGTERM → bounded
 * grace → SIGKILL → port-free verification, then a new server is started on the
 * previously configured port (or the port argument). If no MCP server is
 * running, starts one on the given port (default DEFAULT_MCP_PORT=3338).
 *
 * Returns { pid, port } like startMcp.
 */
export async function restartMcp(port?: number, opts?: StartOptions): Promise<{ pid: number; port: number }> {
  const currentPort = port ?? readMcpPort(opts);

  let stopResult: TakeoverResult;
  try {
    stopResult = await stopMcpTakeover(opts);
  } catch (err) {
    if (!isIsolationViolation(err)) throw err;
    stopResult = { stopped: false, escalated: false, portFree: false };
  }
  if (stopResult.pid !== undefined) {
    recordLifecycleEvent("restart.mcp", stopResult.pid, opts, {
      escalated: stopResult.escalated,
      portFree: stopResult.portFree,
    });
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
  const deadline = new Deadline(timeoutMs);
  while (!deadline.expired()) {
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

async function fetchControlPlaneHealth(
  port: number,
  timeoutMs = 1000,
): Promise<
  | { healthy: true; pid: number | null; stateDir: string | null }
  | { healthy: false; status?: number }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${CONTROL_PLANE_HEALTH_ENDPOINT}`, {
      signal: controller.signal,
    });
    if (!res.ok) return { healthy: false, status: res.status };
    let pid: number | null = null;
    let stateDir: string | null = null;
    try {
      const body = await res.json() as { pid?: unknown; stateDir?: unknown };
      if (typeof body.pid === "number" && Number.isFinite(body.pid) && body.pid > 0) {
        pid = body.pid;
      }
      if (typeof body.stateDir === "string" && body.stateDir.trim() !== "") {
        stateDir = body.stateDir.trim();
      }
    } catch {
      // Treat a 2xx health response as healthy even if the body is malformed.
    }
    return { healthy: true, pid, stateDir };
  } catch {
    return { healthy: false };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Probe `/control/health` on `port` for the daemon's own state-dir claim.
 *
 * Returns null when the endpoint does not answer (or answers non-2xx), so a
 * caller can distinguish "no evidence" from a reported state-dir mismatch.
 */
async function probeControlPlaneHealthInfo(
  port: number,
  timeoutMs = 1000,
): Promise<ControlPlaneHealthInfo | null> {
  const health = await fetchControlPlaneHealth(port, timeoutMs);
  if (!health.healthy) return null;
  return { pid: health.pid, stateDir: health.stateDir };
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
  // Route the child env through buildSpawnEnv (see startMcp for the rationale:
  // test-guard child attribution, byte-identical when the guard is inactive).
  const cpEnv: Record<string, string> = {};
  if (opts?.homeDir) {
    cpEnv.HOME = opts.homeDir;
    // Keep the child's effective state dir pinned to the parent's (see
    // startDaemon for the TAMANDUA_STATE_DIR precedence rationale).
    cpEnv.TAMANDUA_STATE_DIR = resolveStateDir(opts);
  }
  const spawnOpts: Parameters<typeof spawn>[2] = {
    detached: true,
    stdio: ["ignore", out, errFd],
    env: buildSpawnEnv(cpEnv),
  };
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
  // Monotonic deadline (TIME-CLOCKS rule 1) so a wall jump cannot shorten it.
  const cpDeadline = new Deadline(10_000);
  let check = checkPidFile(cpPidFile);
  while (!check.running && !cpDeadline.expired()) {
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
 *
 * Keeps the pidfile as a fast path (and informational hint), then falls back to
 * the verified holder of the dashboard port so a dashboard that lost its
 * pidfile is still reported running (DPID takeover).
 */
export function isDashboardRunning(opts?: DaemonctlPathOptions): { running: true; pid: number } | { running: false } {
  let pidFile: string;
  try {
    pidFile = getDashboardPidFile(opts);
  } catch (err) {
    if (isIsolationViolation(err)) return { running: false };
    throw err;
  }

  const fromPidFile = checkPidFile(pidFile);
  if (fromPidFile.running) return fromPidFile;

  const holderPid = resolveDashboardPortHolder(opts);
  if (holderPid !== null) return { running: true, pid: holderPid };

  return { running: false };
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
 * Async dashboard status resolved socket-first (identity socket → verified
 * port holder → pidfile), mirroring {@link getMcpStatusAsync}.
 *
 * This is what `tamandua dashboard status` uses so a live dashboard that lost
 * its `dashboard.pid` (and/or `port`) file is still reported through
 * `dashboard.sock` by pid and — when the socket advertises it — its port. The
 * synchronous {@link getDashboardStatus} remains for API callers.
 */
export async function getDashboardStatusAsync(opts?: ResolveLiveDaemonOptions): Promise<{
  running: boolean;
  pid: number | null;
  port: number;
}> {
  const port = readPort(opts);
  const live = await resolveLiveDashboard(opts);
  if (live) {
    return { running: true, pid: live.pid, port: live.port };
  }
  return { running: false, pid: null, port };
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

  // Refuse to spawn a duplicate when a live dashboard lost its pidfile: the
  // identity socket (DPID) is authoritative, so darwin no longer depends on
  // pidfile/lsof parsing. A socket advertising another state dir is not ours.
  const liveBySocket = await probeLiveServiceIdentity("dashboard", opts);
  if (liveBySocket) {
    return { pid: liveBySocket.pid, port: liveBySocket.controlPort };
  }

  const dashPort = port ?? DEFAULT_DASHBOARD_PORT;

  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(dashPortFile, String(dashPort), "utf-8");

  const out = fs.openSync(dashLogFile, "a");
  const errFd = fs.openSync(dashLogFile, "a");

  const standaloneScript = resolveDashboardStandaloneScript();
  // Route the child env through buildSpawnEnv (see startMcp for the rationale:
  // test-guard child attribution, byte-identical when the guard is inactive).
  const dashEnv: Record<string, string> = {};
  if (opts?.homeDir) {
    dashEnv.HOME = opts.homeDir;
    // Keep the child's effective state dir pinned to the parent's (see
    // startDaemon for the TAMANDUA_STATE_DIR precedence rationale).
    dashEnv.TAMANDUA_STATE_DIR = resolveStateDir(opts);
  }
  const spawnOpts: Parameters<typeof spawn>[2] = {
    detached: true,
    stdio: ["ignore", out, errFd],
    env: buildSpawnEnv(dashEnv),
  };
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
  // Monotonic deadline (TIME-CLOCKS rule 1) so a wall jump cannot shorten it.
  const deadline = new Deadline(10_000);
  let check = checkPidFile(dashPidFile);
  while (!check.running && !deadline.expired()) {
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
 * Takeover-aware: the running dashboard is resolved by identity socket → the
 * verified holder of the dashboard port → pidfile, stopped with SIGTERM →
 * bounded grace → SIGKILL → port-free verification, then a new server is
 * started on the previously configured port (or the port argument). If no
 * dashboard is running, starts one on the given port (default 3334).
 *
 * Returns { pid, port } like startDashboardStandalone.
 */
export async function restartDashboardStandalone(port?: number, opts?: StartOptions): Promise<{ pid: number; port: number }> {
  const currentPort = port ?? readPort(opts);

  let stopResult: TakeoverResult;
  try {
    stopResult = await stopDashboardTakeover(opts);
  } catch (err) {
    if (!isIsolationViolation(err)) throw err;
    stopResult = { stopped: false, escalated: false, portFree: false };
  }
  if (stopResult.pid !== undefined) {
    recordLifecycleEvent("restart.dashboard", stopResult.pid, opts, {
      escalated: stopResult.escalated,
      portFree: stopResult.portFree,
    });
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
  // Monotonic stop-barrier deadline (TIME-CLOCKS rule 1): a wall-clock jump
  // must not shorten or extend this 10s poll.
  const deadline = new Deadline(10_000);

  while (!deadline.expired()) {
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
  // Monotonic stop-barrier deadline (TIME-CLOCKS rule 1): a wall-clock jump
  // must not shorten or extend this 10s poll.
  const deadline = new Deadline(10_000);

  while (!deadline.expired()) {
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
  // Monotonic stop-barrier deadline (TIME-CLOCKS rule 1): a wall-clock jump
  // must not shorten or extend this 10s poll.
  const deadline = new Deadline(10_000);

  while (!deadline.expired()) {
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

// ═══════════════════════════════════════════════════════════════════
// Daemon-family teardown helper
// ═══════════════════════════════════════════════════════════════════

type StopFamilyFn = (opts?: DaemonctlPathOptions) => boolean;

/** Map every daemon-family pid file to its existing stop function. */
const DAEMON_FAMILY_STOP_FNS: Readonly<Record<string, StopFamilyFn>> = {
  "tamandua.pid": stopDaemon,
  "mcp.pid": stopMcp,
  "control-plane.pid": stopControlPlane,
  "dashboard.pid": stopDashboardStandalone,
};

/** Event-driven pid-exit poll (kill(pid, 0)); bounded, never a fixed sleep. */
async function waitForFamilyPidExit(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = new Deadline(timeoutMs);
  while (!deadline.expired()) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(100);
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/**
 * Stop and await every daemon-family process recorded in a tamandua state
 * dir's pid files.
 *
 * Reads exactly DAEMON_FAMILY_PID_FILES under getTamanduaDir(opts), captures
 * the valid positive pids before stopping, then calls the matching existing
 * stop function (which re-runs canSignalPid + assertNotSchedulingDaemon) and
 * waits event-driven for each pid to exit. Missing, stale, and non-signalable
 * entries are skipped and reported rather than signalled.
 *
 * @param opts Optional homeDir; when unset the real state dir is resolved and
 *             the same test-isolation guard as the individual stop functions
 *             applies.
 */
export async function stopDaemonFamily(opts?: DaemonctlPathOptions): Promise<DaemonFamilyStopSummary> {
  const dir = getTamanduaDir(opts);
  if (!opts?.homeDir) {
    assertStatePathIsolation(dir, "stopDaemonFamily()");
  }

  const summary: DaemonFamilyStopSummary = {
    stopped: [],
    skippedMissing: [],
    skippedStale: [],
    skippedNotSignalable: [],
    timedOut: [],
  };

  // First pass: capture only pids that are valid, positive, and alive right
  // now. Never derive a pid from anywhere but these pid files.
  const liveTargets: { pidFile: string; pid: number }[] = [];
  for (const pidFileName of DAEMON_FAMILY_PID_FILES) {
    const pidFile = path.join(dir, pidFileName);
    if (!fs.existsSync(pidFile)) {
      summary.skippedMissing.push({ pidFile: pidFileName, pid: null });
      continue;
    }

    let pid: number;
    try {
      pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    } catch {
      try { fs.unlinkSync(pidFile); } catch {}
      summary.skippedStale.push({ pidFile: pidFileName, pid: null });
      continue;
    }

    if (!Number.isInteger(pid) || pid <= 0) {
      try { fs.unlinkSync(pidFile); } catch {}
      summary.skippedStale.push({ pidFile: pidFileName, pid: null });
      continue;
    }

    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (!alive) {
      try { fs.unlinkSync(pidFile); } catch {}
      summary.skippedStale.push({ pidFile: pidFileName, pid });
      continue;
    }

    liveTargets.push({ pidFile: pidFileName, pid });
  }

  // Second pass: stop each captured pid and wait for it to exit.
  for (const target of liveTargets) {
    if (!canSignalPid(target.pid, opts)) {
      summary.skippedNotSignalable.push({ pidFile: target.pidFile, pid: target.pid });
      continue;
    }

    const stop = DAEMON_FAMILY_STOP_FNS[target.pidFile];
    if (!stop) {
      // Defensive only: DAEMON_FAMILY_PID_FILES is the single source of truth
      // and every entry has a mapping above.
      summary.skippedNotSignalable.push({ pidFile: target.pidFile, pid: target.pid });
      continue;
    }

    stop(opts);

    if (await waitForFamilyPidExit(target.pid)) {
      summary.stopped.push({ pidFile: target.pidFile, pid: target.pid });
    } else {
      summary.timedOut.push({ pidFile: target.pidFile, pid: target.pid });
    }
  }

  return summary;
}
