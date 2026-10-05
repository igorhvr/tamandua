/**
 * MTLK-ALLOW-PRIVATE — probe the installed matchlock binary for
 * `--allow-private` support.
 *
 * `tamandua doctor` uses this to tell an operator, before launching, whether an
 * allow-private run can be accepted: the installed matchlock fork advertises the
 * flag in `matchlock run --help` (the private-IP exemption
 * `--allow-private <entry>`, mapped to the wire field `network.allow_private`).
 * An older binary simply does not list it — and admission must then refuse an
 * allow-private run rather than silently dropping the field (US-008).
 *
 * The probe is deliberately bounded and side-effect-free: it only READS the
 * binary's help output (and, best-effort, its `--version`), never creates,
 * mutates or removes anything. The subprocess runner is fully injectable so
 * tests never need a real matchlock installation, and a missing binary is a
 * reported result — never a thrown error.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** The literal CLI flag a supporting matchlock lists in `run --help`. */
export const MATCHLOCK_ALLOW_PRIVATE_FLAG = "--allow-private";

/**
 * Operator env override for the matchlock rpc CLI binary. Mirrors
 * `MATCHLOCK_RPC_BIN_ENV` in admission.ts — duplicated here (rather than
 * imported) so this module stays a leaf and admission can import the probe
 * without a cycle.
 */
export const MATCHLOCK_RPC_BIN_ENV = "TAMANDUA_MATCHLOCK_RPC_BIN";

/** Wall-clock bound (ms) for each probe subprocess. */
export const MATCHLOCK_ALLOW_PRIVATE_PROBE_TIMEOUT_MS = 10_000;

/** Cap on captured help/version output (characters). */
const MATCHLOCK_ALLOW_PRIVATE_PROBE_MAX_OUTPUT = 4 * 1024 * 1024;

/** Raw result of one bounded `matchlock run --help` (or injected fake) run. */
export interface MatchlockRunHelpResult {
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
export type MatchlockRunHelpRunner = (
  binaryPath: string,
) => MatchlockRunHelpResult | Promise<MatchlockRunHelpResult>;

/** Why {@link MatchlockAllowPrivateSupport.supported} is false. */
export type MatchlockAllowPrivateSupportReason =
  | "missing_binary"
  | "unsupported"
  | "probe_failed";

/** Outcome of probing an installed matchlock for allow-private support. */
export interface MatchlockAllowPrivateSupport {
  /** True only when `run --help` exited 0 and lists `--allow-private`. */
  supported: boolean;
  /** The binary path that was probed (an absolute path when resolved from PATH). */
  binaryPath: string;
  /** Installed matchlock version, when the probe could determine one. */
  version?: string;
  /** Human-readable explanation when support is false (or a probe note). */
  reason?: string;
  /** Typed discriminator for the doctor/admission refusal paths. */
  reasonCode?: MatchlockAllowPrivateSupportReason;
  /**
   * How {@link binaryPath} was resolved, when the probe resolved it itself.
   * Omitted when the caller supplied an explicit `binaryPath` and no resolution
   * happened.
   */
  resolvedFrom?: MatchlockRpcBinarySource;
  /**
   * True when `TAMANDUA_MATCHLOCK_RPC_BIN` was set (non-empty) for the probe's
   * environment, even when an explicit `binaryPath` was supplied. Doctor's §0
   * Path-2 gate needs this to tell a passive user (unset) from an engaged user
   * whose override is broken.
   */
  envOverrideSet?: boolean;
}

/** Options for {@link probeMatchlockAllowPrivateSupport}. */
export interface ProbeMatchlockAllowPrivateSupportOptions {
  /**
   * Binary to probe. Defaults to `TAMANDUA_MATCHLOCK_RPC_BIN`, else `matchlock`
   * resolved on PATH, else the bare name `matchlock`.
   */
  binaryPath?: string;
  /** Environment used for default binary resolution and the version probe. */
  env?: NodeJS.ProcessEnv;
  /** Injectable bounded runner (tests). Defaults to a real spawnSync runner. */
  runHelp?: MatchlockRunHelpRunner;
  /** Per-subprocess wall bound in ms (default {@link MATCHLOCK_ALLOW_PRIVATE_PROBE_TIMEOUT_MS}). */
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

function pathEntryExists(candidate: string): boolean {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}

/**
 * Bounded launchability probe mirroring the runner's real subprocess launcher.
 *
 * `fs.accessSync(X_OK)` alone is NOT enough: an executable script whose shebang
 * interpreter does not exist passes the permission check but `execve` fails with
 * ENOENT, exactly as the runner's `spawn` would fail. This probe therefore
 * attempts a bounded `version` run and treats only a spawn error as
 * unlaunchable; a non-zero exit still proves the OS launched the file.
 */
export function isLaunchableMatchlockBinary(
  candidate: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isExecutableFile(candidate)) return false;
  try {
    const result = spawnSync(candidate, ["version"], {
      env,
      encoding: "utf-8",
      timeout: MATCHLOCK_ALLOW_PRIVATE_PROBE_TIMEOUT_MS,
      maxBuffer: MATCHLOCK_ALLOW_PRIVATE_PROBE_MAX_OUTPUT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return !result.error;
  } catch {
    return false;
  }
}

/** First launchable / first present-but-unusable hit for a bare PATH lookup. */
interface MatchlockPathSearch {
  /** Absolute path of the first entry the OS can actually launch. */
  launchable?: string;
  /** Absolute path of the first entry that exists but cannot be launched. */
  present?: string;
}

/**
 * Replicate the runner launcher's bare-name PATH resolution for `name`: search
 * each `PATH` entry for `<entry>/<name>`, treating an empty entry as the current
 * working directory (POSIX `execvp` semantics), and return the first entry that
 * is launchable. When none is launchable but an entry exists, report it as
 * present-but-unusable so doctor can warn (Path 2) rather than fall silent.
 */
function searchMatchlockOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
): MatchlockPathSearch {
  const entries = (env.PATH ?? "").split(path.delimiter);
  let present: string | undefined;
  for (const entry of entries) {
    // An empty PATH component means the current working directory, not "skip".
    const candidate = path.resolve(entry === "" ? process.cwd() : entry, name);
    if (isLaunchableMatchlockBinary(candidate, env)) {
      return { launchable: candidate };
    }
    if (present === undefined && pathEntryExists(candidate)) {
      present = candidate;
    }
  }
  return present === undefined ? {} : { present };
}

/**
 * How {@link resolveMatchlockRpcBinary} arrived at a candidate:
 *  - `"override"`       — `TAMANDUA_MATCHLOCK_RPC_BIN` was set (non-empty);
 *  - `"path"`           — an executable `matchlock` was found on `PATH`;
 *  - `"path_unusable"`  — a `matchlock` entry exists on `PATH` but is not an
 *                         executable file (present-but-unusable);
 *  - `"unresolved"`     — nothing was found (the bare name is reported).
 */
export type MatchlockRpcBinarySource =
  | "override"
  | "path"
  | "path_unusable"
  | "unresolved";

/**
 * The runner's binary-resolution result WITH provenance. The §0 doctor gate must
 * tell four states apart — override set, PATH executable found, PATH
 * present-but-unusable, and nothing found — which a bare path string cannot
 * express.
 */
export interface ResolvedMatchlockRpcBinary {
  /** Path (or bare name) the runner would probe. */
  path: string;
  /** How {@link path} was resolved. */
  source: MatchlockRpcBinarySource;
  /** True when `TAMANDUA_MATCHLOCK_RPC_BIN` was set (non-empty after trim). */
  envOverrideSet: boolean;
  /** True when {@link path} is an existing executable file the OS can launch. */
  executable: boolean;
}

/**
 * Resolve the matchlock CLI binary the runners would use, preserving provenance
 * and MIRRORING the runner launcher's OS-level `spawn` resolution:
 *
 *  - a `TAMANDUA_MATCHLOCK_RPC_BIN` containing a path separator is resolved by
 *    the OS relative to the current working directory;
 *  - a BARE override is searched on `PATH` (an empty entry means the cwd),
 *    exactly as the runner hands the bare name to `spawn`;
 *  - with no override, `matchlock` is searched on `PATH`;
 *  - a candidate that exists but cannot actually be launched (e.g. a nonexistent
 *    shebang interpreter, or a non-X_OK file) is never treated as usable.
 *
 * Returns the first launchable entry, else the present-but-unusable one as
 * `path_unusable`, else the bare name `matchlock` (`unresolved`).
 */
export function resolveMatchlockRpcBinary(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMatchlockRpcBinary {
  const override = env[MATCHLOCK_RPC_BIN_ENV]?.trim();
  if (override) {
    // A separator means the runner spawns it as a path (cwd-relative when
    // relative); probe that exact path for launchability.
    if (override.includes("/") || override.includes("\\")) {
      return {
        path: override,
        source: "override",
        envOverrideSet: true,
        executable: isLaunchableMatchlockBinary(override, env),
      };
    }
    // A bare override is resolved by the OS through PATH, never against cwd.
    const found = searchMatchlockOnPath(override, env);
    if (found.launchable !== undefined) {
      return {
        path: found.launchable,
        source: "override",
        envOverrideSet: true,
        executable: true,
      };
    }
    return {
      path: override,
      source: "override",
      envOverrideSet: true,
      executable: false,
    };
  }

  const found = searchMatchlockOnPath("matchlock", env);
  if (found.launchable !== undefined) {
    return { path: found.launchable, source: "path", envOverrideSet: false, executable: true };
  }
  if (found.present !== undefined) {
    return { path: found.present, source: "path_unusable", envOverrideSet: false, executable: false };
  }
  return { path: "matchlock", source: "unresolved", envOverrideSet: false, executable: false };
}

/**
 * String-returning wrapper over {@link resolveMatchlockRpcBinary}. Keeps the
 * historical contract (override or executable PATH hit, else the bare name) so
 * admission and the probe defaults are unchanged; the structured resolver is
 * where the §0 gate reads provenance.
 */
export function resolveMatchlockRpcBinaryPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const resolved = resolveMatchlockRpcBinary(env);
  return resolved.source === "override" || resolved.source === "path"
    ? resolved.path
    : "matchlock";
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
      maxBuffer: MATCHLOCK_ALLOW_PRIVATE_PROBE_MAX_OUTPUT,
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
): MatchlockRunHelpResult {
  let result;
  try {
    result = spawnSync(binaryPath, ["run", "--help"], {
      env,
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: MATCHLOCK_ALLOW_PRIVATE_PROBE_MAX_OUTPUT,
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
 * Probe an installed matchlock for `--allow-private` support.
 *
 * Support is reported `true` ONLY when `<binaryPath> run --help` exits 0 and its
 * text lists the literal `--allow-private`. A missing binary, a non-zero exit,
 * a spawn error, a killed/timeout child, or injected-runner failure all yield
 * `supported: false` with a typed {@link MatchlockAllowPrivateSupport.reasonCode}
 * and a human-readable `reason` — this function never throws for those cases.
 *
 * The result also carries binary-resolution provenance
 * ({@link MatchlockAllowPrivateSupport.resolvedFrom} /
 * {@link MatchlockAllowPrivateSupport.envOverrideSet}) so doctor's §0 gate can
 * distinguish a passive user from a user whose override is set but broken.
 */
export async function probeMatchlockAllowPrivateSupport(
  opts: ProbeMatchlockAllowPrivateSupportOptions = {},
): Promise<MatchlockAllowPrivateSupport> {
  const env = opts.env ?? process.env;
  const resolved = resolveMatchlockRpcBinary(env);
  const result = await probeMatchlockAllowPrivateSupportInner(opts);
  return {
    envOverrideSet: resolved.envOverrideSet,
    ...(opts.binaryPath?.trim() ? {} : { resolvedFrom: resolved.source }),
    ...result,
  };
}

async function probeMatchlockAllowPrivateSupportInner(
  opts: ProbeMatchlockAllowPrivateSupportOptions = {},
): Promise<MatchlockAllowPrivateSupport> {
  const env = opts.env ?? process.env;
  const binaryPath =
    opts.binaryPath?.trim() || resolveMatchlockRpcBinaryPath(env);
  const timeoutMs = opts.timeoutMs ?? MATCHLOCK_ALLOW_PRIVATE_PROBE_TIMEOUT_MS;
  const runHelp =
    opts.runHelp ?? ((bin: string) => defaultRunMatchlockHelp(bin, env, timeoutMs));

  let result: MatchlockRunHelpResult;
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

  if (!result.output.includes(MATCHLOCK_ALLOW_PRIVATE_FLAG)) {
    return {
      supported: false,
      binaryPath,
      ...(version ? { version } : {}),
      reasonCode: "unsupported",
      reason:
        `"${binaryPath} run --help" does not list ${MATCHLOCK_ALLOW_PRIVATE_FLAG} ` +
        "(the installed matchlock predates allow-private support)",
    };
  }

  return {
    supported: true,
    binaryPath,
    ...(version ? { version } : {}),
  };
}
