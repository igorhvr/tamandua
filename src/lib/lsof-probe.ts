/**
 * Bounded lsof probe primitive.
 *
 * `lsof` walks kernel process/file tables and, on hosts with a stale FUSE or
 * network mount, can block forever inside the kernel. A blocking `lsof` is
 * unkillable with SIGTERM, so every probe here is:
 *
 *   1. marked `-w` (suppress warnings) and, for fd-type/pid-scoped probes
 *      only, `-b` (avoid kernel blocks),
 *   2. scoped to the pid(s) of interest by the caller,
 *   3. run under a hard timeout with `killSignal: "SIGKILL"` so a wedged
 *      child is killed and reaped when `spawnSync` returns.
 *
 * A timed-out probe is reported as `kind: "timeout"` — NEVER as an empty
 * `ok` result. Callers making destructive decisions must treat anything but
 * a real `ok` as unknown and fail closed.
 *
 * WHY `-b` IS CONDITIONAL. `-b` makes lsof avoid the kernel calls that can
 * block, and on macOS lsof 4.91 it substitutes an EAGAIN stub for lstat(2),
 * stat(2) and readlink(2) (man lsof). PATHNAME selection (an argument list
 * containing `--`) is stat(2)-based, so a `-b` pathname probe always fails with
 * `status error on <path>: Resource temporarily unavailable` and never sees a
 * single open file. The `-b` suppression is not needed for pathname probes in
 * exchange: the SIGKILL timeout below is what actually bounds a blocked
 * filesystem, and a blocked pathname probe lands in the existing `timeout`
 * result. fd-type/pid-scoped probes (`-p`, `-d cwd`) keep `-b` unchanged.
 *
 * macOS (lsof 4.91) and Linux both accept `-w`.
 */
import { spawnSync } from "node:child_process";
import { logger } from "./logger.js";

/** Default hard timeout for a single lsof probe (ms). */
export const LSOF_DEFAULT_TIMEOUT_MS = 5000;
/** Lower clamp bound for the probe timeout (ms). */
export const LSOF_MIN_TIMEOUT_MS = 1;
/** Upper clamp bound for the probe timeout (ms). */
export const LSOF_MAX_TIMEOUT_MS = 60000;
/** Env override for the probe timeout; clamped to [MIN, MAX]. */
export const LSOF_TIMEOUT_ENV = "TAMANDUA_LSOF_TIMEOUT_MS";
/** Env override for the lsof binary (hermetic test seam). */
export const LSOF_BIN_ENV = "TAMANDUA_LSOF_BIN";
/** Default lsof binary name resolved from PATH. */
export const LSOF_DEFAULT_BINARY = "lsof";
/**
 * Default stdout+stderr capture ceiling. `lsof -d cwd` over a whole host can
 * legitimately emit several megabytes, so the cap is deliberately generous.
 */
export const LSOF_DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * How a bounded lsof probe ended.
 *
 * The `error` variant carries the REAL exit status (never rewritten to 0 for a
 * non-zero exit) together with whatever lsof already wrote to stdout: a
 * non-zero exit can still have produced usable output (pathname probes report
 * a missing path on stderr while listing real holders on stdout), so the
 * caller — not this primitive — decides whether that output is an answer.
 */
export type LsofProbeResult =
  | { kind: "ok"; stdout: string; stderr: string; status: 0 }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "unavailable"; error: string }
  | { kind: "error"; status: number | null; stdout: string; stderr: string };

export interface RunLsofOptions {
  /** Binary to execute; overrides `TAMANDUA_LSOF_BIN` and `PATH`. */
  binary?: string;
  /** Hard timeout in ms; clamped to [1, 60000]. Defaults to env/default. */
  timeoutMs?: number;
  /** stdout+stderr capture ceiling in bytes. */
  maxBuffer?: number;
}

/**
 * Build the argv for an lsof probe. `-w` is ALWAYS prepended so no call site
 * can forget it; `-b` is prepended only when the probe does NOT select by
 * pathname.
 *
 * `--` marks a pathname probe, and `-b` is incompatible with it: on macOS lsof
 * 4.91 `-b` stubs lstat/stat/readlink with EAGAIN while pathname selection is
 * stat(2)-based, so every `-b` pathname probe fails before it can match. The
 * condition is on the argument list, never on the platform, because the
 * incompatibility is a property of the flags, not of the host. Every
 * fd-type/pid-scoped probe keeps `-b`.
 *
 * Pure and synchronous — the single place the flag contract is expressed.
 */
export function lsofProbeArgv(args: readonly string[]): string[] {
  // `--` marks a pathname probe; `-b` would stub out the stat(2) it needs.
  if (args.includes("--")) return ["-w", ...args];
  return ["-b", "-w", ...args];
}

/** Clamp a raw timeout value into [LSOF_MIN_TIMEOUT_MS, LSOF_MAX_TIMEOUT_MS]. */
export function clampLsofTimeoutMs(value: number): number {
  if (!Number.isFinite(value)) return LSOF_DEFAULT_TIMEOUT_MS;
  const int = Math.trunc(value);
  if (int < LSOF_MIN_TIMEOUT_MS) return LSOF_MIN_TIMEOUT_MS;
  if (int > LSOF_MAX_TIMEOUT_MS) return LSOF_MAX_TIMEOUT_MS;
  return int;
}

/** Parse `TAMANDUA_LSOF_TIMEOUT_MS` (or any raw string) into a clamped ms value. */
export function parseLsofTimeoutMs(raw: string | undefined | null): number {
  if (raw === undefined || raw === null) return LSOF_DEFAULT_TIMEOUT_MS;
  const trimmed = raw.trim();
  if (trimmed === "") return LSOF_DEFAULT_TIMEOUT_MS;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return LSOF_DEFAULT_TIMEOUT_MS;
  return clampLsofTimeoutMs(parsed);
}

/** Resolve the effective probe timeout from the environment. */
export function lsofTimeoutMsFromEnv(): number {
  return parseLsofTimeoutMs(process.env[LSOF_TIMEOUT_ENV]);
}

/** Resolve the effective lsof binary (explicit override > env > `lsof`). */
export function resolveLsofBinary(override?: string): string {
  if (override !== undefined && override.trim() !== "") return override.trim();
  const fromEnv = process.env[LSOF_BIN_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  return LSOF_DEFAULT_BINARY;
}

/**
 * Run a bounded, pid-scoped lsof probe.
 *
 * Prepends `-w` (and `-b` unless the probe selects by pathname — see
 * {@link lsofProbeArgv}) and imposes a hard SIGKILL timeout. On expiry the
 * child is killed and reaped before this returns, so callers can never leak a
 * kernel-blocked lsof process.
 *
 * A non-zero exit is returned as `kind: "error"` with its real status and its
 * stdout preserved; it is never flattened to an empty `ok`.
 */
export function runLsof(
  args: readonly string[],
  opts: RunLsofOptions = {},
): LsofProbeResult {
  const timeoutMs =
    opts.timeoutMs === undefined
      ? lsofTimeoutMsFromEnv()
      : clampLsofTimeoutMs(opts.timeoutMs);
  const binary = resolveLsofBinary(opts.binary);
  const maxBuffer = opts.maxBuffer ?? LSOF_DEFAULT_MAX_BUFFER;
  const argv = lsofProbeArgv(args);

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(binary, argv, {
      encoding: "utf-8",
      timeout: timeoutMs,
      // SIGTERM does not interrupt an lsof wedged in the kernel; SIGKILL does.
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn("lsof probe unavailable", { args, binary, error });
    return { kind: "unavailable", error };
  }

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT" || result.signal === "SIGKILL") {
      // A timed-out probe is NEVER an empty ok result.
      logger.warn("lsof probe timed out", { args, timeoutMs });
      return { kind: "timeout", timeoutMs };
    }
    const error = result.error.message;
    logger.warn("lsof probe unavailable", { args, binary, error });
    return { kind: "unavailable", error };
  }

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (result.status === 0) {
    return { kind: "ok", stdout, stderr, status: 0 };
  }
  // The real status is kept and stdout is preserved: a non-zero exit can still
  // carry usable output, and only the caller knows whether it can.
  return { kind: "error", status: result.status, stdout, stderr };
}
