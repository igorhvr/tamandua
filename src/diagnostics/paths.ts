/**
 * Diagnostics path layout (DIAG-PRUNE US-001).
 *
 * Pure, Node-core-only path helpers shared by `tamandua run diagnose` and
 * `tamandua evidence prune`. Nothing here touches the daemon, the SQLite
 * database, or the filesystem: every function is a deterministic spelling of
 * a path under the caller's state dir.
 *
 * Layout (all under the effective state dir):
 *
 *   <state>/diagnostics                       diagnostics bundle root
 *   <state>/diagnostics/<bareRunId>-<ts>      per-run bundle (default)
 *   <state>/runs/<bareRunId>                  per-run evidence dir
 *   <state>/suite-logs                        suite ledger full logs
 *   <state>/tamandua.log[.1..5]               daemon log + rotations
 *
 * Every user-supplied path segment (run id, timestamp) is passed through
 * {@link sanitizeSegment}, which THROWS on `..`/`.` and path separators and
 * maps any remaining unsafe character. That is the only defence needed for
 * the lexical helpers below; they never call `realpath`.
 */
import path from "node:path";
import { nowIso } from "../lib/instant.js";
import { stripIdPrefix } from "../lib/id-prefix.js";

/** Diagnostics bundle directory name under the state dir. */
export const DIAGNOSTICS_DIR_NAME = "diagnostics";
/** Per-run evidence directory name under the state dir. */
export const RUN_EVIDENCE_DIR_NAME = "runs";
/** Suite ledger full-log directory name under the state dir. */
export const SUITE_LOGS_DIR_NAME = "suite-logs";
/** Daemon log file basename under the state dir. */
export const DAEMON_LOG_BASENAME = "tamandua.log";
/** Number of rotated daemon logs kept by the logger (`tamandua.log.1..5`). */
export const MAX_ROTATED_DAEMON_LOGS = 5;

/** Raised by {@link sanitizeSegment} when a segment cannot be a safe path part. */
export class InvalidPathSegmentError extends Error {
  readonly segment: string;
  readonly reason: string;

  constructor(segment: string, reason: string) {
    super(`invalid path segment ${JSON.stringify(segment)}: ${reason}`);
    this.name = "InvalidPathSegmentError";
    this.segment = segment;
    this.reason = reason;
  }
}

/**
 * Strip a presentation `run-` prefix so the bare run id matches the id used
 * in the state-dir layout (`<state>/runs/<bareRunId>`, event file names, …).
 * A bare id is returned unchanged; the input is trimmed first.
 */
export function bareRunId(runId: string): string {
  return stripIdPrefix((runId ?? "").trim());
}

/**
 * Validate a value for use as ONE path segment and map any character that is
 * not `[A-Za-z0-9._-]` to `_`.
 *
 * Rejects (throws {@link InvalidPathSegmentError}):
 *  - the empty string,
 *  - `.` and `..` (path traversal / current-dir),
 *  - `/` and `\` (path separators),
 *  - a NUL byte.
 *
 * The returned string is never empty and never contains a separator, so it is
 * safe to `path.join` into a state-dir-relative location.
 */
export function sanitizeSegment(segment: string): string {
  if (typeof segment !== "string") {
    throw new InvalidPathSegmentError(String(segment), "not a string");
  }
  if (segment.length === 0) {
    throw new InvalidPathSegmentError(segment, "empty segment");
  }
  if (segment === "." || segment === "..") {
    throw new InvalidPathSegmentError(segment, "'.' and '..' are not valid path segments");
  }
  if (segment.includes("/") || segment.includes("\\")) {
    throw new InvalidPathSegmentError(segment, "contains a path separator");
  }
  if (segment.includes("\0")) {
    throw new InvalidPathSegmentError(segment, "contains a NUL byte");
  }
  const mapped = segment.replace(/[^A-Za-z0-9._-]+/g, "_");
  return mapped.length > 0 ? mapped : "_";
}

/** `<stateDir>/diagnostics` — the root of every diagnostics bundle. */
export function resolveDiagnosticsRoot(stateDir: string): string {
  return path.join(stateDir, DIAGNOSTICS_DIR_NAME);
}

export interface DiagnosticsBundleDirOptions {
  stateDir: string;
  runId: string;
  /** Timestamp spelling for the default bundle name; defaults to `nowIso()`. */
  timestamp?: string;
  /** When set, the bundle is `<outRoot>/<bareRunId>` (no timestamp). */
  outRoot?: string;
}

/**
 * Resolve the directory a diagnostics bundle is written to.
 *
 *  - with `outRoot`: `<outRoot>/<bareRunId>`
 *  - otherwise:      `<stateDir>/diagnostics/<bareRunId>-<sanitized-ts>`
 *
 * The run id and timestamp are sanitized, so neither can escape the bundle
 * root or inject a separator.
 */
export function resolveDiagnosticsBundleDir(opts: DiagnosticsBundleDirOptions): string {
  const bare = sanitizeSegment(bareRunId(opts.runId));
  if (opts.outRoot !== undefined) {
    return path.join(opts.outRoot, bare);
  }
  const ts = sanitizeSegment(opts.timestamp ?? nowIso());
  return path.join(resolveDiagnosticsRoot(opts.stateDir), `${bare}-${ts}`);
}

/** `<stateDir>/runs/<bareRunId>` — the run's evidence directory. */
export function resolveRunEvidenceDir(stateDir: string, runId: string): string {
  return path.join(stateDir, RUN_EVIDENCE_DIR_NAME, sanitizeSegment(bareRunId(runId)));
}

/** `<stateDir>/suite-logs` — the suite ledger full-log directory. */
export function resolveSuiteLogsDir(stateDir: string): string {
  return path.join(stateDir, SUITE_LOGS_DIR_NAME);
}

/**
 * The daemon log plus its rotated archives, as
 * `[<stateDir>/tamandua.log, <stateDir>/tamandua.log.1, …, .5]`.
 * The enumeration order is current-first; readers that need oldest-to-newest
 * order iterate it in reverse.
 */
export function resolveDaemonLogFiles(stateDir: string): string[] {
  const base = path.join(stateDir, DAEMON_LOG_BASENAME);
  const files = [base];
  for (let i = 1; i <= MAX_ROTATED_DAEMON_LOGS; i++) {
    files.push(`${base}.${i}`);
  }
  return files;
}

/**
 * Lexical containment test: is `child` strictly inside `parent`?
 *
 * Both paths are resolved to absolute normalized spellings (no filesystem
 * access, no symlink resolution). `parent` itself is NOT "inside" itself —
 * that is what makes this safe for a remove guard, where wiping the state dir
 * root must be refused. A sibling whose name merely shares a prefix
 * (`/a/bc` vs `/a/b`) is correctly rejected.
 */
export function isPathInside(parent: string, child: string): boolean {
  if (!parent || !child) return false;
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  if (resolvedParent === resolvedChild) return false;
  const prefix = resolvedParent.endsWith(path.sep)
    ? resolvedParent
    : resolvedParent + path.sep;
  return resolvedChild.startsWith(prefix);
}