import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { logger } from "../lib/logger.js";
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

// ── Types ────────────────────────────────────────────────────────────

export interface RunCleanupResult {
  runId: string;
  worktreePath: string;
  scannedPids: number;
  killedPids: number[];
  evidence: Record<number, string>;
}

export interface SweepOptions {
  /** PID that must never be killed (typically the daemon). */
  daemonPid?: number;
  /** Process groups to spare (in-grace harness groups; leak guard owns them). */
  excludePgids?: number[];
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
 * Evidence matcher over already-collected process observations.
 * Returns the evidence string (which check matched), or null if no match.
 *
 * Channels (a)–(d) are exact when the underlying reader is available. On
 * macOS environ is read through the native KERN_PROCARGS2 helper (never
 * `ps -E`), so (b)/(c) fire there too when a same-user process is inspected;
 * (a) cwd and (d) cmdline remain the broadest evidence — harness argv contains
 * the run/agent ids, and run children get their cwd set inside the worktree.
 */
export function matchRunEvidence(
  entry: Pick<ProcessSnapshotEntry, "cwd" | "environ" | "cmdline">,
  runId: string,
  worktreePath: string,
): string | null {
  const { cwd, environ, cmdline } = entry;

  // (a) cwd resolves to or under worktreePath (realpath both sides: lsof
  // reports canonical paths while callers may hold the symlinked spelling)
  if (cwd) {
    const resolvedCwd = safeRealpath(cwd);
    const resolvedWorktree = safeRealpath(worktreePath);
    if (resolvedCwd === resolvedWorktree || resolvedCwd.startsWith(resolvedWorktree + path.sep)) {
      return `cwd under worktree: ${cwd}`;
    }
  }

  // (b) environ contains the string worktreePath
  if (environ && environ.includes(worktreePath)) {
    return `environ contains worktree path: ${worktreePath}`;
  }

  // (c) environ contains TAMANDUA_WORKER_JOB_ID=... with runId as substring
  if (environ) {
    const m = environ.match(/TAMANDUA_WORKER_JOB_ID=([^\0\s]*)/);
    if (m && m[1].includes(runId)) {
      return `TAMANDUA_WORKER_JOB_ID contains runId: ${m[1]}`;
    }
  }

  // (d) command line names the worktree or the run id (run ids are UUIDs,
  // so a substring hit is unambiguous)
  if (cmdline) {
    if (cmdline.includes(worktreePath)) {
      return `cmdline contains worktree path: ${worktreePath}`;
    }
    if (cmdline.includes(runId)) {
      return `cmdline contains runId: ${runId}`;
    }
  }

  return null;
}

/**
 * Check if a process belongs to the run by inspecting its cwd, environ,
 * and command line. Returns the evidence string, or null if no match.
 */
export function processBelongsToRun(
  pid: number,
  runId: string,
  worktreePath: string,
): string | null {
  return matchRunEvidence(
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
 * One observation per visible process. On Linux this walks procfs per pid.
 * On macOS per-pid reads would spawn one subprocess per process, so the whole
 * command-line table is captured with ONE sandbox-safe `listProcessDetails()`
 * call (the native sysctl helper, or ps where the helper is absent) and ONE
 * `lsof -d cwd` call; environ stays null there (unreadable).
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

  const cwdByPid = new Map<number, string>();
  try {
    const r = spawnSync("lsof", ["-d", "cwd", "-Fpn"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (typeof r.stdout === "string") {
      let currentPid: number | null = null;
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("p")) currentPid = Number(line.slice(1)) || null;
        else if (line.startsWith("n") && currentPid !== null) {
          cwdByPid.set(currentPid, line.slice(1));
        }
      }
    }
  } catch {
    // lsof unavailable — cwd evidence channel stays empty.
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
 * A process belongs to the run when:
 *  - its cwd resolves to or under `worktreePath`, OR
 *  - its environ contains the string `worktreePath`, OR
 *  - its environ contains `TAMANDUA_WORKER_JOB_ID=...` where `runId` is a substring
 *
 * Never kills: pid 1 (init), our own process (process.pid), the daemonPid (if provided).
 *
 * Logs every kill via `logger.info` with pid and evidence, and emits a
 * `run.process_cleanup` event summarizing the sweep.
 */
export function sweepRunProcesses(
  runId: string,
  worktreePath: string,
  options?: SweepOptions,
): RunCleanupResult {
  const skipPids = new Set<number>([1, process.pid]);
  if (options?.daemonPid !== undefined) {
    skipPids.add(options.daemonPid);
  }
  const excludePgids = new Set<number>(options?.excludePgids ?? []);

  const killedPids: number[] = [];
  const evidence: Record<number, string> = {};
  let scannedPids = 0;

  const snapshot = collectProcessSnapshot();

  for (const entry of snapshot) {
    const pid = entry.pid;
    if (skipPids.has(pid)) continue;
    scannedPids++;

    try {
      // Spare in-grace harness groups: the run's final work round may still
      // be flushing its token usage (HARNESS_TEARDOWN_GRACE_MS); the
      // scheduler's leak guard kills those groups after the grace window.
      if (excludePgids.size > 0) {
        const pgid = getPgid(pid);
        if (pgid !== null && excludePgids.has(pgid)) continue;
      }
      const matchReason = matchRunEvidence(entry, runId, worktreePath);
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
      scannedPids,
      killedPids,
      evidence,
    }),
  });

  return { runId, worktreePath, scannedPids, killedPids, evidence };
}
