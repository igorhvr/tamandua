/**
 * Portable process-introspection helpers.
 *
 * Linux exposes everything through procfs, which is cheap and exact, so it
 * is always tried first. macOS/BSD have no /proc; there the helpers fall
 * back to the native `proc-info` sysctl helper (`ps`/`lsof` only when it was
 * not built). The fallbacks only see same-user processes — sufficient for
 * every process tamandua manages, since the daemon, harnesses, and CLI all
 * run as the same user.
 *
 * macOS environment note: `/bin/ps -E` prints nothing for processes it did
 * not inherit, which is why this used to treat other processes' environments
 * as kernel-hidden. That is wrong: sysctl KERN_PROCARGS2 DOES return the
 * environ block for same-user processes, so the native helper's `env`
 * subcommand supplies it and environ-based evidence
 * (getEnvironText/environHasEntry) works on macOS exactly as on Linux.
 *
 * Every macOS `lsof` probe here is routed through the bounded
 * `src/lib/lsof-probe.ts` primitive, so no probe can block forever on a
 * stale FUSE mount. Because a timed-out or unavailable probe is NOT the same
 * as "the process has nothing open", the open-file probe is explicitly
 * tri-state (`boolean | "unknown"`) and destructive callers must fail closed
 * on "unknown".
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveClockTicksPerSecond } from "./process-start-identity.js";
import { logger } from "./logger.js";
import { instantAgeMs } from "./instant.js";
import { runLsof, type LsofProbeResult } from "./lsof-probe.js";

/** Definite open-file evidence, or "unknown" when the probe could not tell. */
export type OpenFileEvidence = boolean | "unknown";

/** Tri-state result of a process cwd probe. */
export type ProcessCwdProbe =
  | { status: "ok"; cwd: string }
  | { status: "missing" }
  | { status: "unknown"; reason: string };

/** Human-readable reason for a non-ok lsof probe result. */
function lsofFailureReason(result: Exclude<LsofProbeResult, { kind: "ok" }>): string {
  switch (result.kind) {
    case "timeout":
      return `lsof timed out after ${result.timeoutMs}ms`;
    case "unavailable":
      return `lsof unavailable: ${result.error}`;
    case "error":
      return `lsof exited with status ${result.status === null ? "null" : result.status}`;
  }
}

let procfsChecked = false;
let procfsAvailable = false;

/** Whether procfs is present and readable (true on Linux, false on macOS). */
export function hasProcfs(): boolean {
  if (!procfsChecked) {
    procfsChecked = true;
    try {
      fs.accessSync("/proc/self", fs.constants.R_OK);
      procfsAvailable = true;
    } catch {
      procfsAvailable = false;
    }
  }
  return procfsAvailable;
}

/**
 * True when `candidate` IS the procfs root or a path beneath it. This is a
 * pure path-shape check (no procfs read), used by host-source/mount
 * admission to refuse `/proc` aliases portably: on a host without procfs the
 * literal simply never matches a real path, so no platform branch is needed.
 * Centralised here so Linux-only path literals stay inside the allow-listed
 * process-introspection module (portability lint).
 */
export function isProcfsPath(candidate: string): boolean {
  return candidate === "/proc" || candidate.startsWith("/proc/");
}

/** Run ps with the given args; null on any failure (including missing ps). */
function ps(args: string[]): string | null {
  try {
    const r = spawnSync("ps", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status === 0 && typeof r.stdout === "string") return r.stdout;
  } catch {
    // ps unavailable — nothing portable left to try.
  }
  return null;
}

// ── Sandbox-safe native process metadata (MPSX follow-on) ────────────
//
// Inside the macOS Seatbelt signal profile /bin/ps is EPERM (it is setuid),
// so the ps fallbacks below silently degrade. The compiled `dist/native/
// proc-info` helper reads the same metadata through sysctl(2), which the
// profile permits. It is preferred over ps whenever it is present; ps stays
// as the fallback for hosts/tests where the helper was not built.

/** Basename of the compiled darwin process-metadata helper. */
export const PROC_INFO_HELPER_BASENAME = "proc-info";

/** Env override selecting an explicit helper binary (test/ops seam). */
export const PROC_INFO_HELPER_ENV = "TAMANDUA_PROC_INFO_HELPER";

const PROC_INFO_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the compiled process-metadata helper:
 *   1. the `TAMANDUA_PROC_INFO_HELPER` env override (test/ops seam),
 *   2. `<moduleDir>/../native/proc-info` (the packaged dist layout),
 *   3. `<cwd>/dist/native/proc-info` (running from a source checkout).
 * Returns null when no executable candidate exists.
 */
export function resolveProcInfoHelperPath(
  env: NodeJS.ProcessEnv = process.env,
  moduleDir: string = PROC_INFO_MODULE_DIR,
  cwd: string = process.cwd(),
): string | null {
  const override = env[PROC_INFO_HELPER_ENV];
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  const candidates = [
    path.resolve(moduleDir, "..", "native", PROC_INFO_HELPER_BASENAME),
    path.resolve(cwd, "dist", "native", PROC_INFO_HELPER_BASENAME),
  ];
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** One TAB-separated helper record. */
interface ProcInfoRecord {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
  startSec: number;
  startUsec: number;
  cmdline: string;
}

function parseProcInfoRecord(line: string): ProcInfoRecord | null {
  const fields = line.split("\t");
  if (fields.length < 7) return null;
  const pid = Number(fields[0]);
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const state = fields[3];
  const startSec = Number(fields[4]);
  const startUsec = Number(fields[5]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(ppid) || ppid < 0) return null;
  if (!Number.isInteger(pgid) || pgid < 0) return null;
  if (!Number.isSafeInteger(startSec) || startSec <= 0) return null;
  if (!Number.isSafeInteger(startUsec) || startUsec < 0) return null;
  return { pid, ppid, pgid, state, startSec, startUsec, cmdline: fields.slice(6).join("\t") };
}

/** Run the native helper; null when it is unavailable or fails. */
function runProcInfo(args: string[]): string | null {
  const helperPath = resolveProcInfoHelperPath();
  if (helperPath === null) return null;
  try {
    const r = spawnSync(helperPath, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10_000,
    });
    if (r.status === 0 && typeof r.stdout === "string") return r.stdout;
  } catch {
    // Helper unavailable — fall back to ps.
  }
  return null;
}

/** Native record for one pid, or null when the helper cannot supply it. */
function nativeRecord(pid: number): ProcInfoRecord | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const out = runProcInfo(["pid", String(pid)]);
  if (out === null) return null;
  const line = out.split("\n").find((l) => l.trim() !== "");
  if (line === undefined) return null;
  return parseProcInfoRecord(line);
}

/**
 * State letter of a pid (`Z` zombie, `X` dead) or null when gone/unreadable.
 * procfs on Linux; the native helper on macOS; `ps -p <pid> -o state=`
 * otherwise.
 */
export function getProcessState(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (hasProcfs()) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
      const state = afterComm.trim().split(/\s+/)[0];
      return state && state.length > 0 ? state[0] : null;
    } catch {
      return null;
    }
  }
  const native = nativeRecord(pid);
  if (native !== null) return native.state || null;
  const out = ps(["-p", String(pid), "-o", "state="]);
  const state = out?.trim();
  return state && state.length > 0 ? state[0] : null;
}

/** One process observation for bulk consumers (pgid/state/cmdline). */
export interface ProcessDetails {
  pid: number;
  ppid: number;
  pgid: number;
  /** Single state letter (`R`/`S`/`T`/`Z`/...); `?` when unknown. */
  state: string;
  cmdline: string;
}

/**
 * Bulk process table: pgid, state and command line for every visible pid.
 *
 * procfs on Linux; ONE native-helper `dump` call on macOS (sandbox-safe);
 * a `ps -eo pid=,ppid=,pgid=,stat=,args=` scan as the last resort.
 */
export function listProcessDetails(): ProcessDetails[] {
  if (hasProcfs()) {
    const result: ProcessDetails[] = [];
    for (const pid of listPids()) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
        const afterComm = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
        const ppid = Number(afterComm[1]);
        const pgid = Number(afterComm[2]);
        const state = afterComm[0]?.[0] ?? "?";
        let cmdline = "";
        try {
          cmdline = fs
            .readFileSync(`/proc/${pid}/cmdline`, "utf-8")
            .replaceAll("\0", " ")
            .trim();
        } catch {
          // process vanished between the stat and cmdline read
        }
        result.push({
          pid,
          ppid: Number.isInteger(ppid) ? ppid : 0,
          pgid: Number.isInteger(pgid) ? pgid : 0,
          state,
          cmdline,
        });
      } catch {
        // process vanished
      }
    }
    return result;
  }

  const nativeOut = runProcInfo(["dump"]);
  if (nativeOut !== null) {
    const result: ProcessDetails[] = [];
    for (const line of nativeOut.split("\n")) {
      if (line.trim() === "") continue;
      const record = parseProcInfoRecord(line);
      if (record !== null) result.push(record);
    }
    return result;
  }

  const out = ps(["-eo", "pid=,ppid=,pgid=,stat=,args="]);
  if (!out) return [];
  const result: ProcessDetails[] = [];
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) continue;
    result.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      state: match[4][0] ?? "?",
      cmdline: match[5] ?? "",
    });
  }
  return result;
}

/** All visible pids: /proc entries on Linux, `ps -axo pid=` elsewhere. */
export function listPids(): number[] {
  if (hasProcfs()) {
    const pids: number[] = [];
    let entries: string[];
    try {
      entries = fs.readdirSync("/proc");
    } catch {
      return pids;
    }
    for (const entry of entries) {
      const pid = parseInt(entry, 10);
      if (pid > 0 && pid.toString() === entry) pids.push(pid);
    }
    return pids;
  }
  const out = ps(["-axo", "pid="]);
  if (!out) return [];
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const pid = parseInt(line.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/** Parse the pgrp field out of /proc/<pid>/stat content. */
function parsePgrpFromStat(stat: string): number | null {
  // Fields after the parenthesized comm (which may contain spaces):
  // state(0) ppid(1) pgrp(2) ...
  const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
  const pgrp = Number(afterComm.split(" ")[2]);
  return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : null;
}

/** Process-group id of a pid. Null when the process is gone or unreadable. */
export function getPgid(pid: number): number | null {
  if (hasProcfs()) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      return parsePgrpFromStat(stat);
    } catch {
      return null;
    }
  }
  const native = nativeRecord(pid);
  if (native !== null) {
    return Number.isInteger(native.pgid) && native.pgid > 0 ? native.pgid : null;
  }
  const out = ps(["-o", "pgid=", "-p", String(pid)]);
  if (!out) return null;
  const pgid = Number(out.trim());
  return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
}

/**
 * Probe a pid's current working directory.
 *
 * - `ok`      — the cwd is known (procfs readlink, or a bounded lsof answer).
 * - `missing` — the probe definitively answered and there is no cwd (the
 *               process is gone, or lsof listed no cwd record).
 * - `unknown` — the probe could not tell: it timed out, lsof is unavailable,
 *               or procfs/lsof failed for a reason other than "gone".
 *
 * `unknown` is never collapsed into `missing`.
 */
export function probeProcessCwd(pid: number): ProcessCwdProbe {
  if (hasProcfs()) {
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (typeof cwd === "string" && cwd.length > 0) return { status: "ok", cwd };
      return { status: "missing" };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return { status: "missing" };
      return {
        status: "unknown",
        reason: `procfs cwd read failed: ${code ?? String(err)}`,
      };
    }
  }
  // macOS/BSD: bounded, pid-scoped lsof probe (see src/lib/lsof-probe.ts).
  const result = runLsof(["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  if (result.kind !== "ok") {
    return { status: "unknown", reason: lsofFailureReason(result) };
  }
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("n") && line.length > 1) return { status: "ok", cwd: line.slice(1) };
  }
  return { status: "missing" };
}

/** Current working directory of a pid. Null when gone, unreadable, or unknown. */
export function getProcessCwd(pid: number): string | null {
  const probe = probeProcessCwd(pid);
  return probe.status === "ok" ? probe.cwd : null;
}

/**
 * Raw environment text of a pid (NUL-separated entries), or null.
 *
 * procfs on Linux; the native helper's `env` subcommand (sysctl
 * KERN_PROCARGS2) on macOS, where the kernel hands the environ block to
 * same-user callers even though `ps -E` cannot. Never throws: any failure
 * (helper absent, pid gone, other user) degrades to null.
 */
export function getEnvironText(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (hasProcfs()) {
    try {
      const buf = fs.readFileSync(`/proc/${pid}/environ`);
      return buf.toString("utf-8");
    } catch {
      return null;
    }
  }
  return runProcInfo(["env", String(pid)]);
}

/**
 * Exact `NAME=value` membership test against a pid's environment.
 * Works on Linux (procfs) and macOS (native helper); false on any failure.
 */
export function environHasEntry(pid: number, name: string, value: string): boolean {
  const environ = getEnvironText(pid);
  if (environ === null) return false;
  return environ.split("\0").includes(`${name}=${value}`);
}

/** Full command line of a pid ("" unknown). Space-joined on Linux. */
export function getCmdline(pid: number): string {
  if (hasProcfs()) {
    try {
      return fs
        .readFileSync(`/proc/${pid}/cmdline`, "utf-8")
        .replaceAll("\0", " ")
        .trim();
    } catch {
      return "";
    }
  }
  const native = nativeRecord(pid);
  if (native !== null) return native.cmdline;
  const out = ps(["-ww", "-o", "command=", "-p", String(pid)]);
  return out ? out.trim() : "";
}

/**
 * Whether a process has any file open under `dirPath` (cwd counts too).
 * Kernel-verified via a BOUNDED, pid-scoped lsof probe; realpaths the dir
 * first (macOS tempdirs live behind the /var → /private/var symlink and lsof
 * reports canonical paths). Same-user processes only.
 *
 * Tri-state: `true`/`false` only when lsof answered OK. `"unknown"` when the
 * probe timed out, lsof is unavailable, or the directory could not be
 * resolved — a timeout is NEVER reported as "no open files". Destructive
 * callers (daemon signal guards, cleanup sweeps) must treat `"unknown"` as
 * a refusal.
 */
export function processHasOpenFileUnder(pid: number, dirPath: string): OpenFileEvidence {
  let realDir: string;
  try {
    realDir = fs.realpathSync(dirPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    logger.warn("processHasOpenFileUnder: cannot resolve directory; evidence unknown", {
      pid,
      dirPath,
      reason: code ?? String(err),
    });
    return "unknown";
  }
  const result = runLsof(["-p", String(pid), "-Fn"]);
  if (result.kind !== "ok") {
    // Never silently treat a failed probe as "no open files".
    logger.warn("processHasOpenFileUnder: lsof evidence unknown", {
      pid,
      dirPath,
      reason: lsofFailureReason(result),
    });
    return "unknown";
  }
  for (const line of result.stdout.split("\n")) {
    if (!line.startsWith("n")) continue;
    const p = line.slice(1);
    if (p === realDir || p.startsWith(realDir + "/")) return true;
  }
  return false;
}

/** Parse a ps etime value ([[dd-]hh:]mm:ss) into seconds. Null on mismatch. */
export function parseEtimeSeconds(etime: string): number | null {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  return (
    (dd ? Number(dd) * 86400 : 0) +
    (hh ? Number(hh) * 3600 : 0) +
    Number(mm) * 60 +
    Number(ss)
  );
}

/**
 * Elapsed wall-clock seconds since the process started. Null when gone.
 *
 * Derived from the kernel start time whenever available (procfs stat field 22
 * plus `btime` on Linux; the native sysctl helper's `p_starttime` on macOS) —
 * the TZ-independent source that also works inside the Seatbelt signal
 * sandbox where ps is EPERM. Falls back to `ps -o etime=` only where no
 * kernel start-time source exists.
 */
export function getElapsedSeconds(pid: number): number | null {
  if (hasProcfs()) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      const afterComm = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const startTicks = Number(afterComm[19]);
      const btimeMatch = /^btime\s+(\d+)\s*$/m.exec(fs.readFileSync("/proc/stat", "utf-8"));
      if (Number.isSafeInteger(startTicks) && btimeMatch) {
        // The identity reader shares this resolved CLK_TCK so elapsed time and
        // the v2 start identity can never disagree about the tick scale.
        const ticksPerSecond = resolveClockTicksPerSecond();
        const startMs =
          Number(btimeMatch[1]) * 1000 + Math.round((startTicks * 1000) / ticksPerSecond);
        if (startMs > 0) {
          // Rule 3: the kernel start time is an OS-epoch instant with no
          // monotonic analogue, so age it through the shared helper.
          const ageMs = instantAgeMs(startMs);
          return ageMs === undefined ? null : Math.max(0, ageMs / 1000);
        }
      }
    } catch {
      // fall through to the ps fallback
    }
  } else {
    const native = nativeRecord(pid);
    if (native !== null) {
      const startMs = native.startSec * 1000 + Math.floor(native.startUsec / 1000);
      const ageMs = instantAgeMs(startMs);
      return ageMs === undefined ? null : Math.max(0, ageMs / 1000);
    }
  }
  const out = ps(["-o", "etime=", "-p", String(pid)]);
  if (!out) return null;
  return parseEtimeSeconds(out);
}
