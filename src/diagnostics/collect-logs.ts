/**
 * Daemon log collector (DIAG-PRUNE US-005).
 *
 * Assembles the daemon log lines that mention ONE run so a bug report can
 * carry the operator-visible daemon-side story (dispatch decisions, retries,
 * force-fails, sweep decisions, …).
 *
 * Contract:
 *
 *  1. READ-ONLY. No file is created, truncated or re-written; no daemon is
 *     contacted. The collector works while the daemon is running and while it
 *     is stopped.
 *  2. Sources are scanned oldest-rotated to current:
 *     `<stateDir>/tamandua.log.5` … `.1`, then `<stateDir>/tamandua.log`.
 *     Entries are emitted in that scan order, so the result is chronologically
 *     oldest-to-newest. `line` is the 1-based line number WITHIN its file.
 *  3. A line matches when it contains the bare run id, its `run-`-prefixed
 *     spelling, or the 8-character short id used in daemon log prefixes.
 *  4. The retained entry list is bounded (`maxLines`, default
 *     {@link DEFAULT_MAX_DAEMON_LOG_LINES}). When more lines match than fit,
 *     the MOST RECENT lines are retained (still emitted oldest-to-newest) and
 *     `truncated` is set — the collector never throws and never silently
 *     drops the bound.
 *  5. A missing log file is not an error; when no log file exists the
 *     collection is `status: 'absent'`. A file that exists but yields no
 *     matching line makes the collection `'empty'`. An unreadable file is
 *     reported in `files` (with its error) and never thrown.
 */
import fs from "node:fs";
import { stripIdPrefix } from "../lib/id-prefix.js";
import { resolveDaemonLogFiles } from "./paths.js";
import type {
  DaemonLogCollection,
  DaemonLogEntry,
  DaemonLogSource,
  SourceStatus,
} from "./types.js";

/** Default cap on retained matching daemon log lines. */
export const DEFAULT_MAX_DAEMON_LOG_LINES = 5000;

export interface CollectDaemonLogOptions {
  /** Effective tamandua state dir (contains `tamandua.log[.N]`). */
  stateDir: string;
  /** Run id as stored/displayed; a `run-` prefix is tolerated and stripped. */
  runId?: string;
  /** Bare run id, when the caller already has it. */
  bareRunId?: string;
  /** Maximum retained matching lines (default 5000). */
  maxLines?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The selector strings a line may contain to be attributed to the run:
 * the bare id, its `run-`-prefixed spelling and the 8-char short id. Empty
 * selectors (an empty bare id) are omitted so a blank run never matches every
 * line.
 */
function buildSelectors(bareIds: string[]): string[] {
  const selectors: string[] = [];
  const add = (value: string): void => {
    if (value.length > 0 && !selectors.includes(value)) selectors.push(value);
  };
  for (const raw of bareIds) {
    const bare = stripIdPrefix((raw ?? "").trim());
    if (bare.length === 0) continue;
    add(bare);
    add(`run-${bare}`);
    // The 8-char short id is how daemon log prefixes reference a run.
    add(bare.slice(0, 8));
  }
  return selectors;
}

function normalizeMaxLines(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_DAEMON_LOG_LINES;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_DAEMON_LOG_LINES;
  return Math.floor(value);
}

/**
 * Collect the daemon log lines mentioning one run across the current log and
 * every rotated archive. Read-only and total: every failure mode is reported
 * in the result, never thrown.
 */
export function collectDaemonLog(
  options: CollectDaemonLogOptions,
): DaemonLogCollection {
  const stateDir = options.stateDir ?? "";
  const selectors = buildSelectors([options.bareRunId ?? "", options.runId ?? ""]);
  const maxLines = normalizeMaxLines(options.maxLines);

  const files: DaemonLogSource[] = [];
  const matched: DaemonLogEntry[] = [];
  const reasons: string[] = [];

  // resolveDaemonLogFiles returns current-first; scanning the reverse gives
  // oldest-rotation-first so the entries come out chronologically.
  const candidates = [...resolveDaemonLogFiles(stateDir)].reverse();

  const matches = (text: string): boolean =>
    selectors.some((selector) => text.includes(selector));

  for (const filePath of candidates) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      files.push({ path: filePath, status: "absent", lines: 0, error: errorMessage(error) });
      reasons.push(`${filePath}: ${errorMessage(error)}`);
      continue;
    }
    if (!stat.isFile()) continue;

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (error) {
      files.push({ path: filePath, status: "absent", lines: 0, error: errorMessage(error) });
      reasons.push(`${filePath}: ${errorMessage(error)}`);
      continue;
    }

    let fileMatches = 0;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const text = lines[index];
      if (text.length === 0) continue;
      if (!matches(text)) continue;
      fileMatches++;
      matched.push({ file: filePath, line: index + 1, text });
    }
    files.push({ path: filePath, status: "present", lines: fileMatches });
  }

  const truncated = matched.length > maxLines;
  const entries = truncated ? matched.slice(matched.length - maxLines) : matched;

  const status: SourceStatus =
    files.length === 0 ? "absent" : entries.length === 0 ? "empty" : "present";

  if (files.length === 0) {
    reasons.push(
      `no daemon log files present under ${stateDir || "."}`,
    );
  }

  return {
    status,
    ...(reasons.length > 0 ? { absenceReason: reasons.join("; ") } : {}),
    files,
    entries,
    truncated,
  };
}