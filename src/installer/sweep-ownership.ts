/**
 * Daemon-instance-scoped leaked-process sweep ownership markers (SWEEP-SCOPE US-001).
 *
 * WHY
 * ---
 * The post-grace leaked-process sweep used to treat "cwd under the run's
 * working directory" (and environ/cmdline path or run-id substrings) as
 * SUFFICIENT proof of run ownership. A test daemon started from INSIDE a
 * Tamandua run's worktree inherited the enclosing harness round's environment
 * (including the OUTER run's `TAMANDUA_RUN_ID`) and used the enclosing
 * checkout as its own scripted run's working directory. Its sweep therefore
 * matched — and SIGKILLed — 14 processes that belonged to the enclosing run:
 * the real dsh harness round (the process running the test suite) and the
 * test runner's own ancestors, plus rounds of a sibling run.
 *
 * Ownership must be EXCLUSIVE: a process (or its process group) is owned by a
 * run only when THIS daemon instance spawned it for THIS run. Two independent,
 * daemon-provable pieces of evidence establish that:
 *
 *   1. a process-group id (pgid) recorded at spawn time by the daemon, and
 *   2. a marker the daemon itself injected into the child environment:
 *        TAMANDUA_RUN_ID=<exact run id>
 *        TAMANDUA_DAEMON_INSTANCE=<opaque per-daemon-instance token>
 *
 * The token is derived from the daemon's effective state directory plus the
 * kernel process-start identity of the daemon process (pid + start epoch), so
 * it is stable for the life of one daemon and different for every other
 * daemon instance — even one started from a nested harness round that
 * inherited the same `TAMANDUA_RUN_ID`. A marker carrying the right run id but
 * a different (outer) token, or no token at all, is NOT ownership. The path
 * and cmdline channels may at most NARROW a marker/pgid match (a lazy environ
 * confirmation); they never create one.
 *
 * This module is PURE resolution/parsing: it reads no process snapshot, kills
 * nothing, and mutates no environment. The scheduler injects the marker
 * (US-002) and the sweep consumes it (US-003/US-004).
 *
 * MARKER HYGIENE
 * --------------
 * `parseSweepOwnership` reads the FIRST non-empty value for each key from the
 * NUL-separated environ text. An inherited outer marker is never treated as a
 * fresh one: the daemon overwrites both keys for every round it launches, and
 * `matchesSweepOwnership` requires BOTH the exact run id and the exact
 * daemon-instance token, so a nested daemon's inherited run id alone cannot
 * match its own sweep.
 */
import { createHash } from "node:crypto";
import path from "node:path";

import { getProcessStartIdentity } from "../lib/process-start-identity.js";

/** Env var carrying the exact run id the daemon stamps onto its children. */
export const SWEEP_RUN_ID_ENV = "TAMANDUA_RUN_ID";

/** Env var carrying the opaque per-daemon-instance ownership token. */
export const SWEEP_DAEMON_INSTANCE_ENV = "TAMANDUA_DAEMON_INSTANCE";

/** Env override naming the effective Tamandua state directory. */
export const SWEEP_STATE_DIR_ENV = "TAMANDUA_STATE_DIR";

/** Home environment variable consulted when no state-dir override is present. */
const HOME_ENV = "HOME";

/** Basename of the default state directory under HOME. */
const DEFAULT_STATE_DIR_BASENAME = ".tamandua";

/**
 * Separator between the state dir and the start identity in the hash preimage.
 * NUL cannot appear in either component, so two different (stateDir,
 * startIdentity) pairs can never concatenate to the same preimage.
 */
const TOKEN_PREIMAGE_SEPARATOR = "\0";

/** A defined, non-whitespace string value. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** First (leftmost) NON-EMPTY value for `key` in NUL-separated environ text. */
function firstEnvValue(environ: string, key: string): string | null {
  const prefix = `${key}=`;
  for (const token of environ.split("\0")) {
    if (!token.startsWith(prefix)) continue;
    const value = token.slice(prefix.length);
    if (value !== "") return value;
  }
  return null;
}

/**
 * Resolve the effective Tamandua state directory from `env`:
 *   1. `TAMANDUA_STATE_DIR` (trimmed, resolved) when non-empty,
 *   2. `<HOME>/.tamandua` (trimmed HOME),
 *   3. null when neither is available.
 *
 * Returning null (rather than falling back to `os.homedir()`) is deliberate:
 * an unknown state dir means the daemon-instance token cannot be computed, so
 * the marker channel must be DISABLED rather than silently keyed on a
 * different machine-wide home.
 */
export function resolveSweepStateDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env[SWEEP_STATE_DIR_ENV];
  if (isNonEmptyString(override)) return path.resolve(override.trim());
  const home = env[HOME_ENV];
  if (isNonEmptyString(home)) {
    return path.resolve(path.join(home.trim(), DEFAULT_STATE_DIR_BASENAME));
  }
  return null;
}

/** Inputs to the deterministic daemon-instance token. */
export interface DaemonInstanceTokenInput {
  /** Effective state directory (see {@link resolveSweepStateDir}). */
  stateDir: string | null | undefined;
  /** Kernel process-start identity of the daemon process. */
  startIdentity: string | null | undefined;
}

/**
 * Deterministic, opaque per-daemon-instance token: the sha256 hex digest of
 * `<stateDir>\0<startIdentity>`. Returns null when either component is
 * missing/empty, because a partial token would not be exclusive.
 *
 * The token is intentionally opaque: callers compare it for exact equality
 * only and must never parse it or persist it as a durable lease.
 */
export function computeDaemonInstanceToken(
  input: DaemonInstanceTokenInput,
): string | null {
  const stateDir = isNonEmptyString(input?.stateDir) ? input.stateDir.trim() : "";
  const startIdentity = isNonEmptyString(input?.startIdentity)
    ? input.startIdentity.trim()
    : "";
  if (stateDir === "" || startIdentity === "") return null;
  return createHash("sha256")
    .update(`${stateDir}${TOKEN_PREIMAGE_SEPARATOR}${startIdentity}`)
    .digest("hex");
}

/** Inputs accepted by {@link resolveDaemonInstanceToken}. */
export interface ResolveDaemonInstanceTokenInput {
  /** Explicit effective state dir; falls back to `env`/process.env resolution. */
  stateDir?: string | null;
  /** Process whose start identity to read; defaults to the current process. */
  pid?: number;
  /** Explicit start identity (test seam); skips the kernel read when non-empty. */
  startIdentity?: string | null;
  /** Environment consulted for the state dir; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the current daemon instance's ownership token from an effective
 * state dir and a kernel process-start identity. Every component is
 * injectable, so tests can exercise the resolution without touching the real
 * process table; production callers pass nothing.
 *
 * Returns null when either component is unavailable (no state dir, or an
 * unreadable start identity) — the marker channel is then disabled.
 */
export function resolveDaemonInstanceToken(
  input: ResolveDaemonInstanceTokenInput = {},
): string | null {
  const stateDir =
    typeof input.stateDir === "string" && isNonEmptyString(input.stateDir)
      ? input.stateDir
      : resolveSweepStateDir(input.env ?? process.env);
  const startIdentity = isNonEmptyString(input.startIdentity)
    ? input.startIdentity
    : getProcessStartIdentity(input.pid ?? process.pid);
  return computeDaemonInstanceToken({ stateDir, startIdentity });
}

/**
 * Cached per-process wrapper used by production callers: the daemon's
 * instance token never changes for the life of the process, so the kernel
 * start-identity read happens at most once. An unavailable token (null) is
 * NOT cached — a transient unreadable start identity can be retried.
 */
let cachedDaemonInstanceToken: string | null = null;

export function getDaemonInstanceToken(): string | null {
  if (cachedDaemonInstanceToken !== null) return cachedDaemonInstanceToken;
  const token = resolveDaemonInstanceToken();
  if (token !== null) cachedDaemonInstanceToken = token;
  return token;
}

/** Parsed ownership marker extracted from a process's environ text. */
export interface SweepOwnership {
  /** Exact `TAMANDUA_RUN_ID` value, or null when absent/empty. */
  runId: string | null;
  /** Exact `TAMANDUA_DAEMON_INSTANCE` value, or null when absent/empty. */
  daemonInstance: string | null;
}

/**
 * Parse the sweep ownership marker out of NUL-separated environ text. Both
 * keys are matched EXACTLY (no prefix/substring matching) and the first
 * non-empty value wins; empty values are rejected so a stripped marker cannot
 * shadow a later fresh one.
 */
export function parseSweepOwnership(
  environ: string | null | undefined,
): SweepOwnership {
  if (typeof environ !== "string" || environ === "") {
    return { runId: null, daemonInstance: null };
  }
  return {
    runId: firstEnvValue(environ, SWEEP_RUN_ID_ENV),
    daemonInstance: firstEnvValue(environ, SWEEP_DAEMON_INSTANCE_ENV),
  };
}

/**
 * Exclusive ownership predicate: true ONLY when the environ carries BOTH the
 * exact expected run id and the exact expected daemon-instance token.
 *
 * A marker with the expected run id but a different (inherited outer) daemon
 * token does not match; a marker with no daemon token at all does not match;
 * and a null/empty expected token can never match. This is the kill gate — the
 * shared "does this process belong to my sweep?" question, answered only from
 * daemon-injected evidence.
 */
export function matchesSweepOwnership(
  environ: string | null | undefined,
  runId: string | null | undefined,
  daemonInstance: string | null | undefined,
): boolean {
  if (!isNonEmptyString(runId)) return false;
  if (!isNonEmptyString(daemonInstance)) return false;
  const parsed = parseSweepOwnership(environ);
  return parsed.runId === runId && parsed.daemonInstance === daemonInstance;
}
