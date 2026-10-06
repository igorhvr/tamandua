/**
 * MTLK-ISO-SLICE2 — probe the installed matchlock binary for `--swap`
 * support.
 *
 * Admission (and the daemon's per-round execution boundary) uses this to
 * decide, before launching anything, whether the resolved matchlock runtime
 * can honour the run's requested guest swap size: the qualified runtime
 * advertises `--swap` in `matchlock run --help`. An older binary that does not
 * list the flag would silently drop `swap_mb` and boot a VM without the swap
 * the operator asked for, so a run must be refused with the typed
 * `matchlock_swap_unsupported` vocabulary instead.
 *
 * The probe is deliberately bounded and side-effect-free: it only READS the
 * binary's help output (and, best-effort, its `--version`), never creates,
 * mutates or removes anything. The subprocess runner is fully injectable so
 * tests never need a real matchlock installation, and a missing binary is a
 * reported result — never a thrown error.
 *
 * This module is a LEAF (only node builtins): admission and the daemon round
 * path import it without any dependency cycle.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** The literal CLI flag a supporting matchlock lists in `run --help`. */
export const MATCHLOCK_SWAP_FLAG = "--swap";

/**
 * Operator env override for the matchlock rpc CLI binary. Mirrors
 * `MATCHLOCK_RPC_BIN_ENV` in admission.ts — duplicated here (rather than
 * imported) so this module stays a leaf and admission can import the probe
 * without a cycle.
 */
export const MATCHLOCK_RPC_BIN_ENV = "TAMANDUA_MATCHLOCK_RPC_BIN";

/** Wall-clock bound (ms) for each probe subprocess. */
export const MATCHLOCK_SWAP_PROBE_TIMEOUT_MS = 10_000;

/**
 * Typed refusal code carried by the interactive admission path when the
 * resolved runtime does not advertise `--swap` (INTEGRATION-NOTES.md GAP-02).
 */
export const MATCHLOCK_SWAP_UNSUPPORTED_CODE = "matchlock_swap_unsupported" as const;

/** Cap on captured help/version output (characters). */
const MATCHLOCK_SWAP_PROBE_MAX_OUTPUT = 4 * 1024 * 1024;

/** Raw result of one bounded `matchlock run --help` (or injected fake) run. */
export interface MatchlockSwapHelpResult {
  /** Process exit code (null when the child was killed by a signal). */
  exitCode: number | null;
  /** Combined help text (stdout then stderr) the command produced. */
  output: string;
  /** Installed matchlock version when the runner could determine one. */
  version?: string;
  /** Set when the command could not be launched or produced no usable help. */
  error?: string;
  /** True when the binary itself was not found (ENOENT). */
  missingBinary?: boolean;
}

/** Bounded, injectable runner that executes `<binaryPath> run --help`. */
export type MatchlockSwapHelpRunner = (
  binaryPath: string,
) => MatchlockSwapHelpResult | Promise<MatchlockSwapHelpResult>;

/**
 * Back-compat aliases for the payload-era names. The interactive line imported
 * `MatchlockSwapRunHelpResult`/`MatchlockSwapRunHelpRunner`; both names refer to
 * the single reconciled leaf implementation above.
 */
export type MatchlockSwapRunHelpResult = MatchlockSwapHelpResult;
export type MatchlockSwapRunHelpRunner = MatchlockSwapHelpRunner;

/**
 * Injectable probe seam: receives the resolved matchlock binary path and
 * returns the {@link MatchlockSwapSupport} result. Production uses
 * {@link probeMatchlockSwapSupport}; tests inject a supporting/refusing fake
 * (and journal argv) so they never spawn a real binary.
 */
export type MatchlockSwapSupportProbe = (
  binaryPath: string,
) => MatchlockSwapSupport | Promise<MatchlockSwapSupport>;

/** Why {@link MatchlockSwapSupport.supported} is false. */
export type MatchlockSwapSupportReason =
  | "missing_binary"
  | "unsupported"
  | "probe_failed";

/** Outcome of probing an installed matchlock for swap support. */
export interface MatchlockSwapSupport {
  /** True only when `run --help` exited 0 and lists `--swap`. */
  supported: boolean;
  /** The binary path that was probed (an absolute path when resolved from PATH). */
  binaryPath: string;
  /** Installed matchlock version, when the probe could determine one. */
  version?: string;
  /** Human-readable explanation when support is false (or a probe note). */
  reason?: string;
  /** Typed discriminator for the admission/execution-boundary refusal paths. */
  reasonCode?: MatchlockSwapSupportReason;
}

/** Options for {@link probeMatchlockSwapSupport}. */
export interface ProbeMatchlockSwapSupportOptions {
  /**
   * Binary to probe. Defaults to `TAMANDUA_MATCHLOCK_RPC_BIN`, else `matchlock`
   * resolved on PATH, else the bare name `matchlock`.
   */
  binaryPath?: string;
  /** Environment used for default binary resolution and the version probe. */
  env?: NodeJS.ProcessEnv;
  /** Injectable bounded runner (tests). Defaults to a real spawnSync runner. */
  runHelp?: MatchlockSwapHelpRunner;
  /** Per-subprocess wall bound in ms (default {@link MATCHLOCK_SWAP_PROBE_TIMEOUT_MS}). */
  timeoutMs?: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the matchlock CLI binary to probe: `TAMANDUA_MATCHLOCK_RPC_BIN` when
 * set (trimmed), else the first executable `matchlock` on `PATH`, else the bare
 * name `matchlock` (so the probe reports a missing binary instead of guessing).
 *
 * MTLK-ISO2-CORRECTIVE: the resolved path is absolute and mirrors exactly how
 * the launch primitive (`child_process.spawn`) searches `PATH`: an EMPTY PATH
 * component means the child's current working directory, and a relative
 * component is resolved against it. The old `if (!dir) continue` skipped the
 * empty component, so the probe could qualify a different binary than the one
 * the RPC transport launched.
 */
export function resolveMatchlockSwapBinaryPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[MATCHLOCK_RPC_BIN_ENV]?.trim();
  if (override) return path.resolve(override);
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    // POSIX PATH semantics: an empty component is the current directory.
    const candidate = path.resolve(dir === "" ? "." : dir, "matchlock");
    if (isExecutableFile(candidate)) return candidate;
  }
  return "matchlock";
}

/**
 * True only when `helpText` lists the EXACT `--swap` flag token. A bare
 * substring match is deliberately NOT used: a build that only advertises a
 * longer near-miss such as `--swap-size` does not support `--swap` and must be
 * refused. The token must be delimited by start-of-text/whitespace on the left
 * and whitespace/`=`/end-of-text on the right, so `--swap-size`, `--swapfoo`,
 * `--matchlock-swap` and `foo--swap` never count while `--swap=512` does.
 */
export function helpListsMatchlockSwapFlag(helpText: string): boolean {
  return /(^|\s)--swap(?:\s|=|$)/m.test(helpText);
}

/** Parse a version out of `<binary> --version` output (e.g. "matchlock version 0.2.17"). */
function parseMatchlockVersion(text: string): string | undefined {
  const match = /(\d+\.\d+(?:\.\d+)?[0-9A-Za-z.+-]*)/.exec(text);
  return match ? match[1] : undefined;
}

/** Best-effort `--version` probe; any failure yields undefined. */
function probeMatchlockVersion(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): string | undefined {
  try {
    const result = spawnSync(binaryPath, ["--version"], {
      env,
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: MATCHLOCK_SWAP_PROBE_MAX_OUTPUT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) return undefined;
    return parseMatchlockVersion(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  } catch {
    return undefined;
  }
}

/**
 * Default bounded runner: spawn `<binaryPath> run --help` (stdout+stderr),
 * classify a launch failure, and best-effort attach the binary's reported
 * version. Never throws — a spawn failure is reported via `error`.
 */
function defaultRunMatchlockHelp(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): MatchlockSwapHelpResult {
  let result;
  try {
    result = spawnSync(binaryPath, ["run", "--help"], {
      env,
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: MATCHLOCK_SWAP_PROBE_MAX_OUTPUT,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return {
      exitCode: null,
      output: "",
      error: `failed to run "${binaryPath} run --help": ${errorMessage(err)}`,
    };
  }

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const missingBinary = code === "ENOENT";
    return {
      exitCode: result.status ?? null,
      output,
      missingBinary,
      error: missingBinary
        ? `matchlock binary not found: ${binaryPath}`
        : `failed to run "${binaryPath} run --help": ${result.error.message}`,
    };
  }

  return {
    exitCode: result.status ?? null,
    output,
    version: probeMatchlockVersion(binaryPath, env, timeoutMs),
  };
}

/**
 * Probe an installed matchlock for `--swap` support.
 *
 * Support is reported `true` ONLY when `<binaryPath> run --help` exits 0 and
 * its text lists the exact `--swap` token. A missing binary, a non-zero exit,
 * a spawn error, a killed/timeout child, an unparseable (empty) help text, or
 * an injected-runner failure all yield `supported: false` with a typed
 * {@link MatchlockSwapSupport.reasonCode} and a human-readable `reason` — this
 * function never throws for those cases. Every result carries the resolved
 * binary path.
 */
export async function probeMatchlockSwapSupport(
  opts: ProbeMatchlockSwapSupportOptions = {},
): Promise<MatchlockSwapSupport> {
  const env = opts.env ?? process.env;
  const binaryPath =
    opts.binaryPath?.trim() || resolveMatchlockSwapBinaryPath(env);
  const timeoutMs = opts.timeoutMs ?? MATCHLOCK_SWAP_PROBE_TIMEOUT_MS;
  const runHelp =
    opts.runHelp ?? ((bin: string) => defaultRunMatchlockHelp(bin, env, timeoutMs));

  let result: MatchlockSwapHelpResult;
  try {
    result = await runHelp(binaryPath);
  } catch (err) {
    return {
      supported: false,
      binaryPath,
      reasonCode: "probe_failed",
      reason: `failed to run "${binaryPath} run --help": ${errorMessage(err)}`,
    };
  }

  const version = result.version;

  if (result.error) {
    return {
      supported: false,
      binaryPath,
      ...(version ? { version } : {}),
      reasonCode: result.missingBinary ? "missing_binary" : "probe_failed",
      reason: result.error,
    };
  }

  if (result.exitCode === null) {
    return {
      supported: false,
      binaryPath,
      ...(version ? { version } : {}),
      reasonCode: "probe_failed",
      reason: `"${binaryPath} run --help" did not exit (killed by a signal or timed out)`,
    };
  }

  if (result.exitCode !== 0) {
    return {
      supported: false,
      binaryPath,
      ...(version ? { version } : {}),
      reasonCode: "probe_failed",
      reason: `"${binaryPath} run --help" exited with code ${result.exitCode}`,
    };
  }

  if (result.output.trim() === "") {
    return {
      supported: false,
      binaryPath,
      ...(version ? { version } : {}),
      reasonCode: "probe_failed",
      reason: `"${binaryPath} run --help" produced no usable output`,
    };
  }

  if (!helpListsMatchlockSwapFlag(result.output)) {
    return {
      supported: false,
      binaryPath,
      ...(version ? { version } : {}),
      reasonCode: "unsupported",
      reason:
        `"${binaryPath} run --help" does not list ${MATCHLOCK_SWAP_FLAG} ` +
        "(the installed matchlock predates swap support)",
    };
  }

  return {
    supported: true,
    binaryPath,
    ...(version ? { version } : {}),
  };
}
