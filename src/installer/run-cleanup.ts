import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { logger } from "../lib/logger.js";
import { runLsof } from "../lib/lsof-probe.js";
import { emitEvent } from "./events.js";
import {
  getCmdline,
  getEnvironText,
  getPgid,
  getProcessCwd,
  hasProcfs,
  listPids,
  listProcessDetails,
} from "../lib/proc-info.js";
import { matchesSweepOwnership } from "./sweep-ownership.js";

// ── Types ────────────────────────────────────────────────────────────

export interface RunCleanupResult {
  runId: string;
  /** Recorded working directory (worktree or direct-mode dir); null when unknown. */
  worktreePath: string | null;
  scannedPids: number;
  killedPids: number[];
  evidence: Record<number, string>;
}

export interface SweepOptions {
  /** PID that must never be killed (typically the daemon). */
  daemonPid?: number;
  /** Process groups to spare (in-grace harness groups; leak guard owns them). */
  excludePgids?: number[];
  /**
   * Process groups provably owned by the run (harness pgids). A process whose
   * pgid is in this set is run-owned regardless of cwd/environ/cmdline.
   */
  pgids?: number[];
  /**
   * THIS daemon instance's ownership token (`getDaemonInstanceToken()`). The
   * daemon-scoped marker channel is enabled only when this is a non-empty
   * string; null/undefined disables it so the pgid channel is the only proof.
   */
  daemonInstance?: string | null;
}

/** One process observation: pid plus the evidence channels we match on. */
export interface ProcessSnapshotEntry {
  pid: number;
  cwd: string | null;
  /** NUL-separated env text (Linux only — unreadable on macOS). */
  environ: string | null;
  /** Full command line ("" unknown). Primary evidence channel on macOS. */
  cmdline: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Current working directory of a process (procfs on Linux, lsof on macOS).
 * Returns the absolute path, or null if the process is gone or unreadable.
 */
export function readProcCwd(pid: number): string | null {
  return getProcessCwd(pid);
}

/**
 * Environment text of a process (NUL-separated entries, or null).
 *
 * procfs on Linux; on macOS the native `proc-info env` helper reads the
 * same-user environ block via sysctl KERN_PROCARGS2 (the kernel hands it out
 * even though `ps -E` cannot — see src/lib/proc-info.ts).
 */
export function readProcEnviron(pid: number): string | null {
  return getEnvironText(pid);
}

/**
 * Resolve symlinks when possible (macOS tempdirs live behind the
 * /var → /private/var symlink); fall back to plain resolution for paths
 * that no longer exist.
 */
function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * DIAGNOSTIC matcher over already-collected process observations: the broad
 * channels used by `tamandua doctor` to REPORT likely leaks. It never kills.
 * Returns the evidence string (which check matched), or null if no match.
 *
 * Channels (a)–(e) are exact when the underlying reader is available. On
 * macOS environ is read through the native KERN_PROCARGS2 helper (never
 * `ps -E`), so (b)/(c)/(e) fire there too when a same-user process is
 * inspected; (a) cwd and (d) cmdline remain the broadest evidence — harness
 * argv contains the run/agent ids, and run children get their cwd set inside
 * the worktree.
 *
 * `worktreePath` may be null for direct-mode runs with no worktree: the
 * path-based channels (a), (b) and the path half of (d) are then skipped,
 * while the marker/cmdline channels (c), (e) and the runId half of (d) still
 * apply. Pgid ownership is evaluated by `sweepRunProcesses` (it needs the
 * live pgid per pid).
 *
 * NEVER use this to decide a kill. These channels are not exclusive: a nested
 * daemon started from inside a run's worktree inherits the OUTER round's
 * `TAMANDUA_RUN_ID`, and "cwd under the working directory" then matches the
 * enclosing harness round itself (bead tamandua-6sy.77 — 14 processes from
 * another run were SIGKILLed). The kill gate is {@link matchRunEvidence}.
 */
export function matchDiagnosticRunEvidence(
  entry: Pick<ProcessSnapshotEntry, "cwd" | "environ" | "cmdline">,
  runId: string,
  worktreePath: string | null,
): string | null {
  const { cwd, environ, cmdline } = entry;

  // (a) cwd resolves to or under worktreePath (realpath both sides: lsof
  // reports canonical paths while callers may hold the symlinked spelling)
  if (worktreePath && cwd) {
    const resolvedCwd = safeRealpath(cwd);
    const resolvedWorktree = safeRealpath(worktreePath);
    if (resolvedCwd === resolvedWorktree || resolvedCwd.startsWith(resolvedWorktree + path.sep)) {
      return `cwd under worktree: ${cwd}`;
    }
  }

  // (b) environ contains the string worktreePath
  if (worktreePath && environ && environ.includes(worktreePath)) {
    return `environ contains worktree path: ${worktreePath}`;
  }

  // (c) environ contains TAMANDUA_WORKER_JOB_ID=... with runId as substring
  if (environ) {
    const m = environ.match(/TAMANDUA_WORKER_JOB_ID=([^\0\s]*)/);
    if (m && m[1].includes(runId)) {
      return `TAMANDUA_WORKER_JOB_ID contains runId: ${m[1]}`;
    }
  }

  // (e) environ contains an exact TAMANDUA_RUN_ID=<runId> token — the
  // scheduler injects TAMANDUA_RUN_ID into every harness round, so this is
  // the run-ownership marker for direct-mode children.
  if (environ) {
    const m = environ.match(/TAMANDUA_RUN_ID=([^\0\s]*)/);
    if (m && m[1] === runId) {
      return `TAMANDUA_RUN_ID=${runId}`;
    }
  }

  // (d) command line names the worktree or the run id (run ids are UUIDs,
  // so a substring hit is unambiguous)
  if (cmdline) {
    if (worktreePath && cmdline.includes(worktreePath)) {
      return `cmdline contains worktree path: ${worktreePath}`;
    }
    if (cmdline.includes(runId)) {
      return `cmdline contains runId: ${runId}`;
    }
  }

  return null;
}

/**
 * EXCLUSIVE kill matcher (SWEEP-SCOPE): returns the evidence string only when
 * the observed environ carries BOTH the exact `TAMANDUA_RUN_ID=<runId>` token
 * AND the exact `TAMANDUA_DAEMON_INSTANCE=<daemonInstance>` token that THIS
 * daemon instance injected when it spawned the process.
 *
 * cwd, environ mentions of the working directory, `TAMANDUA_WORKER_JOB_ID`
 * and cmdline NEVER create a match here: those channels are inherited or
 * incidental, so an outer run's marker or a process merely living under the
 * run's working directory must survive this matcher. A marker with the right
 * run id but a different (outer) daemon token, or with no token at all, does
 * not match; a null/empty `daemonInstance` disables the channel (the pgid
 * channel is then the only proof of ownership).
 */
export function matchRunEvidence(
  entry: Pick<ProcessSnapshotEntry, "environ">,
  runId: string,
  daemonInstance: string | null | undefined,
): string | null {
  if (!matchesSweepOwnership(entry.environ, runId, daemonInstance)) return null;
  return `daemon-scoped run marker: run=${runId}`;
}

/**
 * Check if a process belongs to the run by inspecting its cwd, environ,
 * and command line. Returns the evidence string, or null if no match.
 * `worktreePath` may be null for direct-mode runs (path channels skipped).
 *
 * This is the DIAGNOSTIC (report-only) question used by `tamandua doctor`;
 * it is deliberately broad and must never gate a kill — see
 * {@link matchDiagnosticRunEvidence}.
 */
export function processBelongsToRun(
  pid: number,
  runId: string,
  worktreePath: string | null,
): string | null {
  return matchDiagnosticRunEvidence(
    { cwd: readProcCwd(pid), environ: readProcEnviron(pid), cmdline: getCmdline(pid) },
    runId,
    worktreePath,
  );
}

/**
 * Get a list of visible numeric PIDs (procfs on Linux, `ps` elsewhere).
 */
export function getProcPids(): number[] {
  return listPids();
}

/**
 * Parse the `-Fpn` field output of `lsof -d cwd` into a pid→cwd map.
 *
 * Each `p<pid>` line opens a process record; the following `n<path>` line is
 * that process's cwd. Lines outside a record (or with a non-positive pid) are
 * ignored. Pure and exported so both platforms can pin the record parsing.
 */
export function parseLsofCwdRecords(stdout: string): Map<number, string> {
  const cwdByPid = new Map<number, string>();
  let currentPid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      currentPid = Number.isInteger(pid) && pid > 0 ? pid : null;
    } else if (line.startsWith("n") && currentPid !== null) {
      cwdByPid.set(currentPid, line.slice(1));
    }
  }
  return cwdByPid;
}

/**
 * One observation per visible process. On Linux this walks procfs per pid.
 * On macOS per-pid reads would spawn one subprocess per process, so the whole
 * command-line table is captured with ONE sandbox-safe `listProcessDetails()`
 * call (the native sysctl helper, or ps where the helper is absent) and ONE
 * `lsof -d cwd` call; the bulk snapshot keeps environ null there to avoid one
 * native-helper spawn per pid (per-pid callers such as `processBelongsToRun`
 * still read environ through the KERN_PROCARGS2 helper on macOS).
 *
 * The bulk lsof call goes through the bounded `runLsof` primitive: it always
 * carries `-b -w` and a hard SIGKILL timeout, so the survivor sweep cannot
 * hang on a stale FUSE mount. When the probe cannot answer (timeout,
 * unavailable, error) the cwd channel stays EMPTY and a warning is logged —
 * absent cwd evidence matches nothing, so the sweep fails closed and never
 * kills on a false cwd match.
 */
export function collectProcessSnapshot(): ProcessSnapshotEntry[] {
  if (hasProcfs()) {
    return getProcPids().map((pid) => ({
      pid,
      cwd: readProcCwd(pid),
      environ: readProcEnviron(pid),
      cmdline: getCmdline(pid),
    }));
  }

  const cmdlineByPid = new Map<number, string>();
  try {
    for (const detail of listProcessDetails()) {
      cmdlineByPid.set(detail.pid, detail.cmdline);
    }
  } catch {
    // process metadata unavailable — snapshot stays empty for cmdline.
  }

  let cwdByPid = new Map<number, string>();
  // This is the one bulk, non-pid-scoped probe; runLsof keeps it bounded
  // (`-b -w` plus a SIGKILL timeout) so it can never wedge on a stale mount.
  const lsofResult = runLsof(["-d", "cwd", "-Fpn"]);
  if (lsofResult.kind === "ok") {
    cwdByPid = parseLsofCwdRecords(lsofResult.stdout);
  } else {
    // No cwd evidence: log and leave the channel empty. The sweep's cwd
    // matcher then cannot fire, so a probe that could not answer kills
    // nothing for that channel (fail-closed, never a false match).
    logger.warn("run-cleanup: bulk lsof cwd snapshot unavailable; cwd evidence empty", {
      kind: lsofResult.kind,
      ...(lsofResult.kind === "timeout" ? { timeoutMs: lsofResult.timeoutMs } : {}),
    });
  }

  const pids = new Set<number>([...cmdlineByPid.keys(), ...cwdByPid.keys()]);
  return [...pids].map((pid) => ({
    pid,
    cwd: cwdByPid.get(pid) ?? null,
    environ: null,
    cmdline: cmdlineByPid.get(pid) ?? "",
  }));
}

// ── Main export ──────────────────────────────────────────────────────

/**
 * Sweep for surviving processes that belong to a run and kill them with SIGKILL.
 *
 * EXCLUSIVE ownership (SWEEP-SCOPE): a process is killed only when
 *  - its live process group is listed in `options.pgids` (pgids the daemon
 *    itself recorded at spawn time), OR
 *  - its environ carries BOTH the exact `TAMANDUA_RUN_ID=<runId>` token AND
 *    the exact `TAMANDUA_DAEMON_INSTANCE=<options.daemonInstance>` token
 *    (evidence `daemon-scoped run marker: run=<runId>`).
 *
 * `cwd under the working directory` (and environ path mentions,
 * `TAMANDUA_WORKER_JOB_ID`, cmdline naming the run id/path) is NOT sufficient
 * evidence and can never create a match — those channels are inherited or
 * incidental, and using them reaped a nested daemon's enclosing harness round
 * (bead tamandua-6sy.77). cwd may only NARROW a marker match: when the bulk
 * snapshot could not read environ (macOS `lsof`-only snapshot) a pid whose cwd
 * is under `worktreePath` triggers ONE lazy per-pid environ read
 * (`KERN_PROCARGS2`); only an exact daemon-scoped marker then kills.
 *
 * `worktreePath` may be null for direct-mode runs without a worktree: the
 * narrowing channel is then unavailable (macOS), while the pgid channel and
 * Linux environ channel still carry the sweep. Processes are only killed by
 * pid after evidence matched — never by name or glob.
 *
 * Never kills: pid 1 (init), our own process (process.pid), the daemonPid (if
 * provided), and any pid whose pgid is in `excludePgids`.
 *
 * Logs every kill via `logger.info` with pid and evidence, and emits a
 * `run.process_cleanup` event summarizing the sweep.
 */
export function sweepRunProcesses(
  runId: string,
  worktreePath: string | null,
  options?: SweepOptions,
): RunCleanupResult {
  const skipPids = new Set<number>([1, process.pid]);
  if (options?.daemonPid !== undefined) {
    skipPids.add(options.daemonPid);
  }
  const excludePgids = new Set<number>(options?.excludePgids ?? []);
  const ownedPgids = new Set<number>(options?.pgids ?? []);
  const daemonInstance = options?.daemonInstance ?? null;

  const killedPids: number[] = [];
  const evidence: Record<number, string> = {};
  let scannedPids = 0;

  const snapshot = collectProcessSnapshot();

  for (const entry of snapshot) {
    const pid = entry.pid;
    if (skipPids.has(pid)) continue;
    scannedPids++;

    try {
      // Resolve the live pgid once when any pgid decision is needed.
      let pgid: number | null = null;
      if (excludePgids.size > 0 || ownedPgids.size > 0) {
        pgid = getPgid(pid);
      }

      // Spare in-grace harness groups: the run's final work round may still
      // be flushing its token usage (HARNESS_TEARDOWN_GRACE_MS); the
      // scheduler's leak guard kills those groups after the grace window.
      if (pgid !== null && excludePgids.has(pgid)) continue;

      // Exclusive kill gate: a recorded owned pgid, or the daemon-scoped
      // marker. cwd never creates a match — it may only NARROW a marker read
      // when the snapshot could not read environ (macOS bulk snapshot).
      let matchReason: string | null = null;
      if (pgid !== null && ownedPgids.has(pgid)) {
        matchReason = `pgid owned by run: ${pgid}`;
      } else if (daemonInstance !== null) {
        let environ = entry.environ;
        if (environ === null && worktreePath !== null && entry.cwd !== null) {
          const resolvedCwd = safeRealpath(entry.cwd);
          const resolvedWorktree = safeRealpath(worktreePath);
          if (
            resolvedCwd === resolvedWorktree ||
            resolvedCwd.startsWith(resolvedWorktree + path.sep)
          ) {
            environ = readProcEnviron(pid);
          }
        }
        matchReason = matchRunEvidence({ environ }, runId, daemonInstance);
      }

      if (matchReason) {
        process.kill(pid, "SIGKILL");
        killedPids.push(pid);
        evidence[pid] = matchReason;
        logger.info(`Sweep killed process ${pid}`, {
          runId,
          pid,
          evidence: matchReason,
        });
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ESRCH: process already exited between our check and kill — OK
      if (code === "ESRCH") {
        logger.info(`Sweep skipped process ${pid} (already exited)`, {
          runId,
          pid,
        });
      } else {
        logger.warn(`Sweep failed to kill process ${pid}`, {
          runId,
          pid,
          error: String(err),
        });
      }
    }
  }

  // Emit a run event summarizing the sweep
  emitEvent({
    ts: new Date().toISOString(),
    event: "run.process_cleanup",
    runId,
    detail: JSON.stringify({
      worktreePath,
      pgids: [...ownedPgids],
      daemonInstance,
      scannedPids,
      killedPids,
      evidence,
    }),
  });

  return { runId, worktreePath, scannedPids, killedPids, evidence };
}
