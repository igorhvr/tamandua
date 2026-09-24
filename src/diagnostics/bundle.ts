/**
 * Diagnostics bundle orchestrator (DIAG-PRUNE US-010).
 *
 * Assembles ONE bundle per run from the already-built collectors
 * (US-003..US-008) plus the summary builder (US-009). The bundle is the
 * artifact an operator attaches to a bug report:
 *
 *   <bundle>/run.json               projected `runs` row(s)
 *   <bundle>/steps.json             projected `steps` rows
 *   <bundle>/stories.json           projected `stories` rows
 *   <bundle>/story_abandonments.json projected `story_abandonments` rows
 *   <bundle>/run_worktrees.json     projected `run_worktrees` rows
 *   <bundle>/events.jsonl           the run's event stream, in order
 *   <bundle>/daemon-log.txt         daemon log lines mentioning the run
 *   <bundle>/session-paths.json     pi/dsh/hermes session-store PATHS only
 *   <bundle>/evidence.json          evidence-dir listing + suite-ledger refs
 *   <bundle>/suite-ledger.json      suite ledger rows (log_path, no bodies)
 *   <bundle>/matchlock.json         redacted policy, VM ids, error records
 *   <bundle>/summary.json           the structured summary
 *   <bundle>/SUMMARY.md             the human-readable summary
 *
 * Contract:
 *
 *  1. READ-ONLY with respect to the daemon and the database. The daemon is
 *     never started or contacted; the DB is only SELECTed from. A stopped or a
 *     running daemon are both tolerated. The only writes are the bundle files.
 *  2. TOTAL. Every missing source is recorded as an explicit `"absent"` marker
 *     in the relevant file (with an `absenceReason`) — never an exception and
 *     never a silent omission. A missing run row, a missing table, an
 *     unreadable log and an empty session store all degrade the same way.
 *  3. NO SECRETS. Host-owned Matchlock policy/error JSON is redacted by the
 *     US-008 collector before it reaches `matchlock.json`; session stores
 *     contribute paths/sizes only, never contents.
 *  4. The bundle directory is `<state>/diagnostics/<bareRunId>-<ts>` by
 *     default, or `<outRoot>/<bareRunId>` when `outRoot` is supplied. An
 *     existing bundle directory is overwritten file-by-file (idempotent), not
 *     wiped.
 *
 * This module transitively imports `src/installer/dsh-usage.ts` (through the
 * session-path collector), so its test file is registered in
 * `tests/serial-files.txt`.
 */
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db.js";
import { nowIso } from "../lib/instant.js";
import type { DiagnosticsDb } from "./collect-db.js";
import { collectDbRows } from "./collect-db.js";
import { collectRunEvents } from "./collect-events.js";
import { collectDaemonLog } from "./collect-logs.js";
import { collectEvidence } from "./collect-evidence.js";
import { collectMatchlock } from "./collect-matchlock.js";
import { collectSessionPaths } from "./collect-sessions.js";
import type { RunTargetDb } from "./run-target.js";
import { resolveRunTarget } from "./run-target.js";
import { buildDiagnosticsSummary, renderSummaryMarkdown } from "./summary.js";
import {
  bareRunId as toBareRunId,
  resolveDiagnosticsBundleDir,
} from "./paths.js";
import type {
  DbRowsCollection,
  DiagnosticsBundle,
  DiagnosticsSummary,
  JsonObject,
} from "./types.js";

/** The read-only db surface the orchestrator and its collectors share. */
export type DiagnosticsBundleDb = DiagnosticsDb & RunTargetDb;

export interface CreateDiagnosticsBundleOptions {
  /** Run id (or unambiguous prefix) to diagnose. */
  runId: string;
  /** Effective tamandua state dir (evidence/events/logs/diagnostics root). */
  stateDir: string;
  /** When set, the bundle is `<outRoot>/<bareRunId>` instead of the default. */
  outRoot?: string;
  /** Injected read-only db. Defaults to the process database. */
  db?: DiagnosticsBundleDb;
  /** Bundle timestamp spelling; defaults to the current UTC instant. */
  timestamp?: string;
  /**
   * Environment used to resolve the harness session homes. Defaults to the
   * ambient process env; tests pass explicit empty homes so no real session
   * store is consulted.
   */
  homes?: NodeJS.ProcessEnv;
}

/** The bundle files, in write order. */
export const DIAGNOSTICS_BUNDLE_FILES: readonly string[] = Object.freeze([
  "run.json",
  "steps.json",
  "stories.json",
  "story_abandonments.json",
  "run_worktrees.json",
  "events.jsonl",
  "daemon-log.txt",
  "session-paths.json",
  "evidence.json",
  "suite-ledger.json",
  "matchlock.json",
  "summary.json",
  "SUMMARY.md",
]);

/** A JSON row envelope with an explicit source status. */
interface RowsEnvelope {
  status: "present" | "absent";
  absenceReason?: string;
  rows: JsonObject[];
}

/**
 * Build a row envelope. Rows present => `present`; no rows => `absent` with a
 * reason. The aggregate DB status is not used here: a table that answered is
 * reported `present` even when a sibling table is unavailable.
 */
function rowsEnvelope(rows: JsonObject[] | undefined, reason: string): RowsEnvelope {
  if (Array.isArray(rows) && rows.length > 0) {
    return { status: "present", rows };
  }
  return { status: "absent", absenceReason: reason, rows: [] };
}

/** Write one JSON file (pretty-printed, newline-terminated). */
function writeJsonFile(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Write one text file (newline-terminated). */
function writeTextFile(file: string, content: string): void {
  fs.writeFileSync(file, content.endsWith("\n") ? content : `${content}\n`);
}

/** A trimmed non-empty string, or `undefined`. */
function textOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Loosely-parsed run-context fields used to locate the harness workdir. */
interface RunContextLike {
  working_directory_for_harness?: unknown;
  worktree_path?: unknown;
  cwd?: unknown;
  repo?: unknown;
}

/** Parse a run-context JSON string; a corrupt value yields `{}`. */
function parseRunContextLoose(raw: unknown): RunContextLike {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as RunContextLike)
      : {};
  } catch {
    return {};
  }
}

/**
 * The workdir whose session stores are referenced by the run: the managed
 * worktree path when present, else the run context's
 * `working_directory_for_harness` / `worktree_path` / `cwd` / `repo`.
 */
function deriveWorkdir(
  target: ReturnType<typeof resolveRunTarget> | null,
  dbRows: DbRowsCollection,
): string {
  const worktreeRow = dbRows.run_worktrees.find(
    (row) => textOrUndefined(row.worktree_path) !== undefined,
  );
  const fromRows = textOrUndefined(worktreeRow?.worktree_path);
  if (fromRows !== undefined) return fromRows;
  const fromTarget = textOrUndefined(target?.worktreePath);
  if (fromTarget !== undefined) return fromTarget;
  const ctx = parseRunContextLoose(target?.row?.context);
  return (
    textOrUndefined(ctx.working_directory_for_harness) ??
    textOrUndefined(ctx.worktree_path) ??
    textOrUndefined(ctx.cwd) ??
    textOrUndefined(ctx.repo) ??
    ""
  );
}

/** The raw `runs.matchlock_policy` value for the target, when available. */
function policyJsonFor(
  target: ReturnType<typeof resolveRunTarget> | null,
): string | null {
  const raw = target?.row?.matchlock_policy;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * Serialize the collected run events as JSONL. When no event was collected an
 * explicit absent marker line is written instead of an empty file.
 */
function renderEventsJsonl(events: ReturnType<typeof collectRunEvents>): string {
  const lines = events.events.map((event) => JSON.stringify(event));
  if (lines.length === 0) {
    lines.push(
      JSON.stringify({
        absent: true,
        source: "events",
        status: events.status,
        reason: events.absenceReason ?? "no run events collected",
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Serialize the matched daemon log entries; absent is explicit. */
function renderDaemonLog(log: ReturnType<typeof collectDaemonLog>): string {
  const lines = log.entries.map(
    (entry) => `${entry.file}:${entry.line}: ${entry.text}`,
  );
  if (lines.length === 0) {
    lines.push(
      `# absent: ${log.absenceReason ?? "no daemon log lines mention this run"}`,
    );
  } else if (log.truncated) {
    lines.unshift("# truncated: retained the most recent matching lines only");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Assemble one diagnostics bundle for a run.
 *
 * @returns the bundle path, its written file list and the structured summary.
 */
export function createDiagnosticsBundle(
  options: CreateDiagnosticsBundleOptions,
): DiagnosticsBundle {
  const stateDir = options.stateDir;
  const inputRunId = typeof options.runId === "string" ? options.runId : "";
  const db = options.db ?? (getDb() as unknown as DiagnosticsBundleDb);
  const timestamp = options.timestamp ?? nowIso();

  // Resolve the target defensively: a missing run row or an unusable db must
  // not prevent a (partial) bundle from being written.
  let target: ReturnType<typeof resolveRunTarget> | null = null;
  try {
    target = resolveRunTarget(inputRunId, db);
  } catch {
    target = null;
  }
  const runId = target?.runId ?? inputRunId;
  const bare = target?.bareRunId ?? toBareRunId(inputRunId);
  const pathRunId = bare.length > 0 ? bare : "unknown";

  const dbRows = collectDbRows({ db, runId, bareRunId: bare });
  const events = collectRunEvents({ stateDir, bareRunId: bare });
  const logs = collectDaemonLog({ stateDir, runId, bareRunId: bare });
  const evidence = collectEvidence({ stateDir, runId, bareRunId: bare, db });
  const matchlock = collectMatchlock({
    stateDir,
    runId,
    bareRunId: bare,
    policyJson: policyJsonFor(target),
  });

  const workdir = deriveWorkdir(target, dbRows);
  const sessions = collectSessionPaths({
    workdir,
    ...(options.homes !== undefined ? { homes: options.homes } : {}),
  });

  const summary: DiagnosticsSummary = buildDiagnosticsSummary({
    runId,
    bareRunId: bare,
    db: dbRows,
    events,
    logs,
    evidence,
    sessions,
    matchlock,
    generatedAt: timestamp,
  });

  const bundlePath = resolveDiagnosticsBundleDir({
    stateDir,
    runId: pathRunId,
    timestamp,
    ...(options.outRoot !== undefined ? { outRoot: options.outRoot } : {}),
  });
  fs.mkdirSync(bundlePath, { recursive: true });

  const file = (name: string): string => path.join(bundlePath, name);

  writeJsonFile(
    file("run.json"),
    rowsEnvelope(dbRows.runs, `no run row for ${pathRunId}`),
  );
  writeJsonFile(
    file("steps.json"),
    rowsEnvelope(dbRows.steps, `no step rows for ${pathRunId}`),
  );
  writeJsonFile(
    file("stories.json"),
    rowsEnvelope(dbRows.stories, `no story rows for ${pathRunId}`),
  );
  writeJsonFile(
    file("story_abandonments.json"),
    rowsEnvelope(
      dbRows.story_abandonments,
      `no story_abandonment rows for ${pathRunId}`,
    ),
  );
  writeJsonFile(
    file("run_worktrees.json"),
    rowsEnvelope(dbRows.run_worktrees, `no run_worktree rows for ${pathRunId}`),
  );
  writeTextFile(file("events.jsonl"), renderEventsJsonl(events));
  writeTextFile(file("daemon-log.txt"), renderDaemonLog(logs));
  writeJsonFile(file("session-paths.json"), sessions);
  writeJsonFile(file("evidence.json"), evidence);
  writeJsonFile(file("suite-ledger.json"), {
    status: evidence.suiteLedgerStatus,
    ...(evidence.suiteLedgerStatus !== "present"
      ? {
          absenceReason:
            evidence.suiteLedger.length === 0
              ? `no suite ledger rows for ${pathRunId}`
              : undefined,
        }
      : {}),
    rows: evidence.suiteLedger,
  });
  writeJsonFile(file("matchlock.json"), matchlock);
  writeJsonFile(file("summary.json"), summary);
  writeTextFile(file("SUMMARY.md"), renderSummaryMarkdown(summary));

  return {
    runId,
    bareRunId: bare,
    bundlePath,
    createdAt: summary.generatedAt,
    files: [...DIAGNOSTICS_BUNDLE_FILES],
    summary,
  };
}