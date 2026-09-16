/**
 * Canonical, timezone-independent process-start identity (TZPI US-002).
 *
 * WHY
 * ---
 * A pid alone is not a stable handle: the kernel reuses pids, so "is pid N
 * still the process I recorded?" must also compare the process's START time.
 * The previous implementation used the TEXT of `ps -p <pid> -o lstart=` on
 * macOS, which ps(1) formats in the CALLER's local timezone: a parent running
 * with TZ=UTC and a child with a local TZ produced different strings for the
 * SAME live pid, so the suite single-flight waiter concluded the owner was
 * dead, reclaimed the key, and ran concurrently with the live owner (which
 * then waited forever). Separately, under the macOS Seatbelt signal profile
 * used for per-execution isolation, `/bin/ps` (setuid) cannot be executed at
 * all (EPERM), so the probe failed inside sandboxed harness rounds.
 *
 * FORMAT (versioned)
 * ------------------
 *   v2:<pid>:<startEpochMs>
 *     <pid>          positive decimal pid.
 *     <startEpochMs> integer milliseconds since the Unix epoch (UTC),
 *                    derived from the KERNEL's start time — never from
 *                    localized text. No calendar/TZ formatting anywhere.
 *
 *   v2u:<pid>
 *     EXPLICIT non-comparable fallback, used ONLY on platforms where neither
 *     kernel source below exists (e.g. win32). `v2u` values are NEVER
 *     comparable. A value is never silently emitted in a different shape.
 *
 *   null
 *     A genuinely unreadable/absent process — or a platform that normally
 *     has a kernel source but cannot read it (missing native helper) —
 *     returns null, never v2u.
 *
 * PER-PLATFORM SOURCES
 * --------------------
 *   linux   procfs: `<pid>/stat` field 22 (starttime, clock ticks since boot)
 *           plus the `btime` line of the system stat file (boot epoch
 *           seconds), composed as:
 *             startEpochMs = btime * 1000 + round(starttime * 1000 / hz)
 *           `hz` is the kernel's real CLK_TCK, resolved ONCE and cached from
 *           AT_CLKTCK in `/proc/self/auxv` (the kernel's own answer), then
 *           `getconf CLK_TCK`, then the portable USER_HZ default of 100 — the
 *           tick rate is never hardcoded, so a CLK_TCK != 100 host (and the
 *           elapsed-time reader in src/lib/proc-info.ts, which shares the same
 *           resolved value) stays correct and byte-stable across re-reads.
 *           Parsing slices after the LAST ')' of the stat line so a comm
 *           containing spaces or parentheses cannot shift the fields.
 *   darwin  the compiled helper `dist/native/proc-starttime` (source
 *           native/proc-starttime.c), which reports
 *           `sysctl(CTL_KERN, KERN_PROC, KERN_PROC_PID, pid)` →
 *           `kp_proc.p_starttime` as `<sec>.<usec>`; converted with
 *             startEpochMs = sec * 1000 + floor(usec / 1000)
 *           It works inside the Seatbelt signal sandbox where ps(1) is EPERM.
 *           This module NEVER runs ps for identity; src/lib/proc-info.ts owns
 *           the general ps fallbacks.
 *   other   v2u:<pid> (non-comparable).
 *
 * COMPARISON
 * ----------
 * compareProcessStartIdentities(expected, actual) returns:
 *   'unknown'   when either side is null/undefined/empty/malformed, is a
 *               legacy `ps:`/`proc:` value, or is a `v2u:` value. Callers
 *               MUST treat 'unknown' as "cannot prove the process died" and
 *               NEVER reclaim a claim / signal a process on it.
 *   'same'      when both sides are well-formed v2, the pids match, and the
 *               absolute start-epoch delta is <=
 *               PROCESS_START_IDENTITY_TOLERANCE_MS.
 *   'different' when both sides are well-formed v2 and either the pids differ
 *               or the delta exceeds the tolerance — the only safe
 *               "pid was reused / owner is dead" signal.
 *
 * TOLERANCE
 * ---------
 * PROCESS_START_IDENTITY_TOLERANCE_MS = 1000 (1 second). Source granularity
 * differs (procfs USER_HZ = 100 → 10 ms; darwin timeval usec → 1 µs) and a
 * round-trip through kernels/virtualization can jitter, so an exact match is
 * too strict for a same-process check. One second is far below any realistic
 * pid-reuse interval while comfortably absorbing granularity.
 *
 * LEGACY PERSISTED VALUES
 * -----------------------
 * State written by older builds holds `ps:<lstart text>` (darwin, TZ-dependent)
 * or `proc:<ticks-since-boot>` (linux, not anchored to a boot time). Neither
 * is comparable to v2, so parseProcessStartIdentity() rejects them and
 * comparison returns 'unknown'. An upgraded reader therefore never reclaims a
 * live owner recorded with a legacy value — it waits instead of racing.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Maximum absolute start-epoch delta (ms) still considered the same process.
 * See the module header for the documented clock-granularity rationale.
 */
export const PROCESS_START_IDENTITY_TOLERANCE_MS = 1000;

/** Basename of the compiled darwin kernel start-time helper. */
export const PROC_STARTTIME_HELPER_BASENAME = "proc-starttime";

/** Env override selecting an explicit helper binary (test/ops seam). */
export const PROC_STARTTIME_HELPER_ENV = "TAMANDUA_PROC_STARTTIME_HELPER";

const V2_PREFIX = "v2:";
const V2U_PREFIX = "v2u:";

/** Bound on the darwin helper spawn; a hung helper must never wedge a caller. */
const DARWIN_HELPER_TIMEOUT_MS = 5000;

/** auxv entry type carrying the kernel clock-tick rate (`AT_CLKTCK`). */
export const AUXV_AT_CLKTCK = 17;

/** Portable Linux USER_HZ fallback when neither auxv nor getconf answers. */
export const DEFAULT_CLOCK_TICKS_PER_SECOND = 100;

/** Bound on the `getconf CLK_TCK` fallback spawn. */
const GETCONF_TIMEOUT_MS = 5000;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function isPositivePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

/** Compose the canonical `v2:<pid>:<startEpochMs>` identity string. */
export function formatProcessStartIdentity(pid: number, startEpochMs: number): string {
  return `${V2_PREFIX}${pid}:${Math.trunc(startEpochMs)}`;
}

/** Parsed canonical v2 identity (pid plus absolute kernel start epoch, ms). */
export interface ParsedProcessStartIdentity {
  pid: number;
  startEpochMs: number;
}

/**
 * Parse a canonical `v2:<pid>:<startEpochMs>` identity. Returns null for
 * EVERY non-comparable input: null/undefined, empty, malformed, legacy
 * `ps:`/`proc:` values, and `v2u:` values. Callers must treat null as
 * 'unknown' (never reclaim / never signal).
 */
export function parseProcessStartIdentity(
  value: string | null | undefined,
): ParsedProcessStartIdentity | null {
  if (typeof value !== "string") return null;
  const match = /^v2:(\d+):(\d+)$/.exec(value.trim());
  if (!match) return null;
  const pid = Number(match[1]);
  const startEpochMs = Number(match[2]);
  if (!isPositivePid(pid)) return null;
  if (!Number.isSafeInteger(startEpochMs) || startEpochMs < 0) return null;
  return { pid, startEpochMs };
}

/**
 * Parse the `AT_CLKTCK` entry out of a raw auxv buffer.
 *
 * auxv is an array of (type, value) pairs of native unsigned-long words:
 * 8 bytes per word on 64-bit kernels and 4 on 32-bit, in the host's byte
 * order. Pure and fixture-testable — no I/O. Returns null when the buffer
 * holds no valid positive AT_CLKTCK entry (wrong word size, truncated,
 * absent, or a non-positive value).
 */
export function parseAuxvClockTicksPerSecond(
  auxv: Uint8Array,
  wordSize: 4 | 8,
  littleEndian: boolean,
): number | null {
  if (wordSize !== 4 && wordSize !== 8) return null;
  if (!(auxv instanceof Uint8Array) || auxv.byteLength === 0) return null;
  const buf = Buffer.isBuffer(auxv)
    ? auxv
    : Buffer.from(auxv.buffer as ArrayBuffer, auxv.byteOffset, auxv.byteLength);
  const pairBytes = wordSize * 2;
  for (let offset = 0; offset + pairBytes <= buf.byteLength; offset += pairBytes) {
    const type = readAuxvWord(buf, offset, wordSize, littleEndian);
    if (type === null) return null;
    if (type !== AUXV_AT_CLKTCK) continue;
    const value = readAuxvWord(buf, offset + wordSize, wordSize, littleEndian);
    if (value === null || !Number.isInteger(value) || value <= 0) return null;
    return value;
  }
  return null;
}

/** Read one native unsigned-long auxv word, or null when out of range. */
function readAuxvWord(
  buf: Buffer,
  offset: number,
  wordSize: 4 | 8,
  littleEndian: boolean,
): number | null {
  if (wordSize === 8) {
    const raw = littleEndian ? buf.readBigUInt64LE(offset) : buf.readBigUInt64BE(offset);
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  }
  return littleEndian ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
}

/**
 * Native auxv word size: 64-bit kernels use 8-byte words, 32-bit use 4.
 * `process.arch` names a 64-bit ISA either with a "64" suffix (arm64, x64,
 * loong64, ppc64, riscv64, mips64el) or as `s390x` (64-bit System z).
 */
function nativeAuxvWordSize(): 4 | 8 {
  return process.arch === "s390x" || process.arch.endsWith("64") ? 8 : 4;
}

/** Cached kernel tick rate; resolved once per process. */
let clockTicksPerSecondCache: number | null = null;

function readAuxvClockTicksPerSecond(): number | null {
  try {
    return parseAuxvClockTicksPerSecond(
      fs.readFileSync("/proc/self/auxv"),
      nativeAuxvWordSize(),
      os.endianness() === "LE",
    );
  } catch {
    return null;
  }
}

function readGetconfClockTicksPerSecond(): number | null {
  try {
    const result = spawnSync("getconf", ["CLK_TCK"], {
      encoding: "utf-8",
      timeout: GETCONF_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
    const rate = Number(result.stdout.trim());
    return Number.isInteger(rate) && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

/**
 * Clock-tick rate (ticks per second) of the running kernel, resolved once and
 * cached so every read of the same live process uses a byte-identical
 * divisor. Resolution order:
 *   1. `AT_CLKTCK` from `/proc/self/auxv` (the kernel's own answer),
 *   2. `getconf CLK_TCK`,
 *   3. the portable USER_HZ default of 100.
 * The tick rate is never a hardcoded assumption when the kernel can tell us.
 */
export function resolveClockTicksPerSecond(): number {
  if (clockTicksPerSecondCache !== null) return clockTicksPerSecondCache;
  const resolved =
    readAuxvClockTicksPerSecond() ??
    readGetconfClockTicksPerSecond() ??
    DEFAULT_CLOCK_TICKS_PER_SECOND;
  clockTicksPerSecondCache = resolved;
  return resolved;
}

/**
 * Pure linux reader: compose a v2 identity from the text of the per-pid stat
 * file (field 22 = starttime, ticks since boot) and the system stat file
 * (its `btime` line = boot epoch seconds). Fixture-testable; no I/O.
 *
 * `ticksPerSecond` is the kernel clock-tick rate (CLK_TCK). It defaults to
 * the portable USER_HZ value of 100 so fixture callers keep the documented
 * historical result; production callers pass the resolved kernel rate.
 */
export function parseLinuxStartIdentity(
  pid: number,
  statText: string,
  procStatText: string,
  ticksPerSecond: number = DEFAULT_CLOCK_TICKS_PER_SECOND,
): string | null {
  if (!isPositivePid(pid)) return null;
  if (typeof statText !== "string" || typeof procStatText !== "string") return null;
  if (!Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) return null;

  // Slice after the LAST ')' so a comm with spaces/parens is harmless. The
  // fields that follow begin with the process state at index 0, so field 22
  // (starttime) sits at index 22 - 3 = 19.
  const closeParen = statText.lastIndexOf(")");
  if (closeParen === -1) return null;
  const fields = statText.slice(closeParen + 2).trim().split(/\s+/);
  const startTicksText = fields[19];
  if (!/^\d+$/.test(startTicksText ?? "")) return null;

  const btimeMatch = /^btime\s+(\d+)\s*$/m.exec(procStatText);
  if (!btimeMatch) return null;

  const startTicks = Number(startTicksText);
  const bootEpochSeconds = Number(btimeMatch[1]);
  if (!Number.isSafeInteger(startTicks) || !Number.isSafeInteger(bootEpochSeconds)) {
    return null;
  }
  if (bootEpochSeconds <= 0) return null;

  // starttime is expressed in kernel clock ticks: convert with the resolved
  // tick rate rather than assuming the 100 Hz USER_HZ convention.
  return formatProcessStartIdentity(
    pid,
    bootEpochSeconds * 1000 + Math.round((startTicks * 1000) / ticksPerSecond),
  );
}

/**
 * Pure darwin reader: parse the native helper's `<sec>.<usec>` stdout into a
 * v2 identity (sec * 1000 + floor(usec / 1000)). Fixture-testable; no I/O.
 */
export function parseDarwinStartIdentity(pid: number, helperText: string): string | null {
  if (!isPositivePid(pid)) return null;
  if (typeof helperText !== "string") return null;
  const match = /^(\d+)\.(\d{1,6})$/.exec(helperText.trim());
  if (!match) return null;
  const sec = Number(match[1]);
  const usec = Number(match[2]);
  if (!Number.isSafeInteger(sec) || sec <= 0) return null;
  if (!Number.isSafeInteger(usec)) return null;
  return formatProcessStartIdentity(pid, sec * 1000 + Math.floor(usec / 1000));
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the compiled darwin start-time helper:
 *   1. the `TAMANDUA_PROC_STARTTIME_HELPER` env override (test/ops seam),
 *   2. `<moduleDir>/../native/proc-starttime` (the packaged dist layout),
 *   3. `<cwd>/dist/native/proc-starttime` (running from a source checkout).
 * Returns null when no executable candidate exists.
 */
export function resolveProcStarttimeHelperPath(
  env: NodeJS.ProcessEnv = process.env,
  moduleDir: string = MODULE_DIR,
  cwd: string = process.cwd(),
): string | null {
  const override = env[PROC_STARTTIME_HELPER_ENV];
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  const candidates = [
    path.resolve(moduleDir, "..", "native", PROC_STARTTIME_HELPER_BASENAME),
    path.resolve(cwd, "dist", "native", PROC_STARTTIME_HELPER_BASENAME),
  ];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function readLinuxStartIdentity(pid: number): string | null {
  try {
    const statText = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    const procStatText = fs.readFileSync("/proc/stat", "utf-8");
    return parseLinuxStartIdentity(pid, statText, procStatText, resolveClockTicksPerSecond());
  } catch {
    return null;
  }
}

function readDarwinStartIdentity(pid: number): string | null {
  const helperPath = resolveProcStarttimeHelperPath();
  if (helperPath === null) return null;
  let stdout: string;
  try {
    const result = spawnSync(helperPath, [String(pid)], {
      encoding: "utf-8",
      timeout: DARWIN_HELPER_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      return null;
    }
    stdout = result.stdout;
  } catch {
    return null;
  }
  return parseDarwinStartIdentity(pid, stdout);
}

/**
 * Kernel-derived, timezone-independent start identity for `pid`:
 *   linux/darwin -> `v2:<pid>:<startEpochMs>` (or null when the process is
 *                   absent/unreadable),
 *   other        -> `v2u:<pid>` (explicitly non-comparable fallback).
 */
export function getProcessStartIdentity(pid: number): string | null {
  if (!isPositivePid(pid)) return null;
  if (process.platform === "linux") return readLinuxStartIdentity(pid);
  if (process.platform === "darwin") return readDarwinStartIdentity(pid);
  return `${V2U_PREFIX}${pid}`;
}

export type ProcessStartIdentityComparison = "same" | "different" | "unknown";

/**
 * Compare a recorded identity (expected) with a freshly read one (actual).
 * Only two well-formed v2 values can ever yield 'same' or 'different'; every
 * legacy/fallback/malformed/absent case yields 'unknown' (never reclaim).
 */
export function compareProcessStartIdentities(
  expected: string | null | undefined,
  actual: string | null | undefined,
): ProcessStartIdentityComparison {
  const expectedParsed = parseProcessStartIdentity(expected);
  const actualParsed = parseProcessStartIdentity(actual);
  if (expectedParsed === null || actualParsed === null) return "unknown";
  if (expectedParsed.pid !== actualParsed.pid) return "different";
  const delta = Math.abs(expectedParsed.startEpochMs - actualParsed.startEpochMs);
  return delta <= PROCESS_START_IDENTITY_TOLERANCE_MS ? "same" : "different";
}
