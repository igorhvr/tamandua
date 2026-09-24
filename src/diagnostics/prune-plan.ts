/**
 * Evidence prune planner (DIAG-PRUNE US-013).
 *
 * Produces a DRY-RUN plan for `tamandua evidence prune --older-than <days>`.
 * This module NEVER deletes anything and NEVER writes to the database: it
 * only reads the filesystem layout and issues read-only SELECTs. Executing an
 * approved plan is US-014 (`prune-exec.ts`).
 *
 * Scope (the only things a plan can ever mark `remove`):
 *
 *   - `<state>/runs/<bareRunId>`                         evidence dirs
 *   - `<state>/diagnostics/<bareRunId>-<ts>`             diagnostics bundles
 *   - `<state>/suite-logs/<row id>.log`                  suite ledger logs
 *   - `run_worktrees` rows with status 'removed' whose `worktree_path` exists
 *
 * Eligibility is deliberately conservative. A run may be pruned only when
 * ALL hold:
 *
 *   1. its terminal instant (`runs.updated_at`) is STRICTLY older than the
 *      requested threshold, compared numerically through
 *      `isOlderThan()` — never as a string. An unparseable/missing instant
 *      is NEVER old.
 *   2. it is not live: `status IN ('running','paused','pending')` or
 *      `scheduling_status IN ('pending_register','queued','waiting',
 *      'draining_pause','active')` keeps every one of its artifacts.
 *
 * Anything that cannot be mapped to a known run (an orphan diagnostics dir, a
 * suite-log file with no ledger row, a `.pending-*.log` leftover) is listed as
 * `action: 'keep'` with a reason and is never removed.
 *
 * The module imports only Node-core (`fs`/`path`), `src/lib/instant.ts`, the
 * pure path helpers, and a type-only `DiagnosticsDb` surface, so its unit
 * test stays in the parallel lane.
 */
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db.js";
import { isOlderThan, parseInstant, type InstantInput } from "../lib/instant.js";
import { stripIdPrefix } from "../lib/id-prefix.js";
import { isPathInside, resolveDiagnosticsRoot, resolveSuiteLogsDir } from "./paths.js";
import type { DiagnosticsDb } from "./collect-db.js";
import type {
  PruneItem,
  PruneItemKind,
  PrunePlan,
  PruneRefusal,
  PruneTotals,
} from "./types.js";

/** Read-only db surface the planner needs; injectable for tests. */
export type PrunePlanDb = DiagnosticsDb;

export interface PlanEvidencePruneOptions {
  /** Prune runs whose terminal instant is older than this many milliseconds. */
  olderThanMs: number;
  /** Effective tamandua state dir (evidence/diagnostics/suite-logs root). */
  stateDir: string;
  /** Injected read-only db. Defaults to the process database. */
  db?: PrunePlanDb;
  /** Injected wall epoch (ms) used for the age comparison; defaults to now. */
  now?: number;
}

/** Run statuses that mean the run is not terminal. */
const NON_TERMINAL_RUN_STATUSES = new Set(["running", "paused", "pending"]);

/** Scheduling statuses that mean the daemon still owns the run. */
const LIVE_SCHEDULING_STATUSES = new Set([
  "pending_register",
  "queued",
  "waiting",
  "draining_pause",
  "active",
]);

const RUNS_COLUMNS = ["id", "status", "scheduling_status", "updated_at"] as const;
const WORKTREE_COLUMNS = ["run_id", "worktree_path", "status"] as const;
const SUITE_LEDGER_COLUMNS = ["id", "run_id", "log_path"] as const;

/** One run row classified for pruning. */
interface RunRecord {
  runId: string;
  bareRunId: string;
  status: string | null;
  schedulingStatus: string | null;
  updatedAt: InstantInput;
  eligible: boolean;
  /** Why the run is or is not eligible (a stable, human-readable reason). */
  reason: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A trimmed non-empty string, or null. */
function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Copy only the projected columns out of a raw row. */
function projected(row: unknown, columns: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (row === null || typeof row !== "object") return out;
  const source = row as Record<string, unknown>;
  for (const column of columns) out[column] = source[column];
  return out;
}

/** Run one read-only SELECT, degrading to an explicit error instead of throwing. */
function queryAll(
  db: PrunePlanDb,
  table: string,
  columns: readonly string[],
  where = "1 = 1",
): { rows: Record<string, unknown>[]; error?: string } {
  try {
    const statement = db.prepare(
      `SELECT ${columns.join(", ")} FROM ${table} WHERE ${where}`,
    );
    const raw = statement.all();
    if (!Array.isArray(raw)) return { rows: [] };
    return { rows: raw.map((row) => projected(row, columns)) };
  } catch (error) {
    return { rows: [], error: `${table}: ${errorMessage(error)}` };
  }
}

/** Classify one run row's eligibility for pruning. */
function classifyRun(row: Record<string, unknown>, olderThanMs: number, nowMs: number): RunRecord {
  const rawId = asText(row.id) ?? "";
  const bare = stripIdPrefix(rawId);
  const status = asText(row.status);
  const schedulingStatus = asText(row.scheduling_status);
  const updatedAt = row.updated_at as InstantInput;

  const live =
    (status !== null && NON_TERMINAL_RUN_STATUSES.has(status)) ||
    (schedulingStatus !== null && LIVE_SCHEDULING_STATUSES.has(schedulingStatus));

  if (live) {
    return {
      runId: rawId,
      bareRunId: bare,
      status,
      schedulingStatus,
      updatedAt,
      eligible: false,
      reason:
        `run is live: status=${status ?? "unknown"} ` +
        `scheduling_status=${schedulingStatus ?? "unknown"}`,
    };
  }

  if (parseInstant(updatedAt) === undefined) {
    return {
      runId: rawId,
      bareRunId: bare,
      status,
      schedulingStatus,
      updatedAt,
      eligible: false,
      reason: `run terminal instant is missing or unparseable (${String(updatedAt)}); treated as not old`,
    };
  }

  if (!isOlderThan(updatedAt, olderThanMs, nowMs, 0)) {
    return {
      runId: rawId,
      bareRunId: bare,
      status,
      schedulingStatus,
      updatedAt,
      eligible: false,
      reason: `run terminal instant is not older than the threshold (${String(updatedAt)})`,
    };
  }

  return {
    runId: rawId,
    bareRunId: bare,
    status,
    schedulingStatus,
    updatedAt,
    eligible: true,
    reason: "terminal run older than the threshold and not live",
  };
}

/** Build the bare-run-id -> classified run map (read-only). */
function collectRuns(
  db: PrunePlanDb,
  olderThanMs: number,
  nowMs: number,
): Map<string, RunRecord> {
  const result = queryAll(db, "runs", RUNS_COLUMNS);
  const runs = new Map<string, RunRecord>();
  for (const row of result.rows) {
    const record = classifyRun(row, olderThanMs, nowMs);
    if (record.bareRunId.length > 0) runs.set(record.bareRunId, record);
  }
  return runs;
}

/** A suite ledger row projected for mapping a suite-log file to its run. */
interface SuiteLedgerRef {
  id: string;
  runId: string | null;
  logPath: string | null;
}

/** Build suite-ledger lookups by absolute log path and by row id. */
function collectSuiteLedgerRefs(db: PrunePlanDb): {
  byPath: Map<string, SuiteLedgerRef>;
  byId: Map<string, SuiteLedgerRef>;
} {
  const byPath = new Map<string, SuiteLedgerRef>();
  const byId = new Map<string, SuiteLedgerRef>();
  const result = queryAll(db, "suite_results", SUITE_LEDGER_COLUMNS);
  for (const row of result.rows) {
    const ref: SuiteLedgerRef = {
      id: String(row.id ?? ""),
      runId: asText(row.run_id),
      logPath: asText(row.log_path),
    };
    if (ref.id.length > 0) byId.set(ref.id, ref);
    if (ref.logPath !== null) byPath.set(path.resolve(ref.logPath), ref);
  }
  return { byPath, byId };
}

/** Recursively sum regular-file byte sizes under a path (never follows symlinks). */
function measurePath(target: string): { exists: boolean; isDirectory: boolean; sizeBytes: number } {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return { exists: false, isDirectory: false, sizeBytes: 0 };
  }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    return { exists: true, isDirectory: true, sizeBytes: directorySize(target) };
  }
  if (stat.isFile()) {
    return { exists: true, isDirectory: false, sizeBytes: stat.size };
  }
  // Symlink / FIFO / socket / device: never traversed; the link's own size is
  // the only attributable byte count.
  return { exists: true, isDirectory: false, sizeBytes: stat.size };
}

/** Sum the sizes of regular files under a directory (bounded by real dirs). */
function directorySize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) total += directorySize(full);
    else if (stat.isFile()) total += stat.size;
    else total += stat.size;
  }
  return total;
}

/** List a directory's entries, degrading to an empty list. */
function listEntries(dir: string): { name: string; isDirectory: boolean; isFile: boolean }[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { name: string; isDirectory: boolean; isFile: boolean }[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      // Resolve the target only to classify the entry; a broken symlink is
      // still treated as a removable non-directory candidate.
      try {
        const stat = fs.statSync(full);
        isDirectory = stat.isDirectory();
        isFile = stat.isFile();
      } catch {
        isDirectory = false;
        isFile = true;
      }
    }
    out.push({ name: entry.name, isDirectory, isFile });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** Match a diagnostics bundle basename to a known run (`<bareRunId>-<ts>`). */
function matchBundleRun(basename: string, runs: Map<string, RunRecord>): RunRecord | undefined {
  let best: RunRecord | undefined;
  for (const run of runs.values()) {
    if (run.bareRunId.length === 0) continue;
    if (basename === run.bareRunId || basename.startsWith(`${run.bareRunId}-`)) {
      if (best === undefined || run.bareRunId.length > best.bareRunId.length) best = run;
    }
  }
  return best;
}

/**
 * Build a dry-run evidence prune plan.
 *
 * @returns every candidate path with its size, action and reason, plus the
 *          refused runs and aggregate byte totals. Nothing is deleted and the
 *          database is never written.
 */
export function planEvidencePrune(options: PlanEvidencePruneOptions): PrunePlan {
  const stateDir = typeof options.stateDir === "string" ? options.stateDir : "";
  const olderThanMs =
    typeof options.olderThanMs === "number" && Number.isFinite(options.olderThanMs)
      ? options.olderThanMs
      : 0;
  const nowMs =
    typeof options.now === "number" && Number.isFinite(options.now)
      ? options.now
      : Date.now();
  const db = options.db ?? (getDb() as unknown as PrunePlanDb);

  const runs = collectRuns(db, olderThanMs, nowMs);
  const ledger = collectSuiteLedgerRefs(db);

  const items: PruneItem[] = [];
  const refusals: PruneRefusal[] = [];
  const refusedRuns = new Set<string>();

  const recordRefusal = (run: RunRecord): void => {
    if (refusedRuns.has(run.bareRunId)) return;
    refusedRuns.add(run.bareRunId);
    refusals.push({
      runId: run.runId,
      bareRunId: run.bareRunId,
      status: run.status ?? undefined,
      schedulingStatus: run.schedulingStatus ?? undefined,
      reason: run.reason,
    });
  };

  const addItem = (
    kind: PruneItemKind,
    pathValue: string,
    sizeBytes: number,
    run: RunRecord | undefined,
    unmappedReason?: string,
  ): void => {
    if (run === undefined) {
      items.push({
        kind,
        runId: "",
        bareRunId: "",
        path: pathValue,
        sizeBytes,
        action: "keep",
        reason: unmappedReason ?? "unmapped: no run row matches this artifact",
      });
      return;
    }
    if (run.eligible) {
      items.push({
        kind,
        runId: run.runId,
        bareRunId: run.bareRunId,
        path: pathValue,
        sizeBytes,
        action: "remove",
        reason: run.reason,
      });
      return;
    }
    recordRefusal(run);
    items.push({
      kind,
      runId: run.runId,
      bareRunId: run.bareRunId,
      path: pathValue,
      sizeBytes,
      action: "keep",
      reason: run.reason,
    });
  };

  // (a) Evidence directories: `<state>/runs/<bareRunId>`.
  const runsRoot = path.join(stateDir, "runs");
  for (const entry of listEntries(runsRoot)) {
    const full = path.join(runsRoot, entry.name);
    const measured = measurePath(full);
    if (!entry.isDirectory) {
      items.push({
        kind: "evidence-dir",
        runId: "",
        bareRunId: "",
        path: full,
        sizeBytes: measured.sizeBytes,
        action: "keep",
        reason: "not a directory; left untouched",
      });
      continue;
    }
    const bare = stripIdPrefix(entry.name);
    addItem("evidence-dir", full, measured.sizeBytes, runs.get(bare));
  }

  // (b) Diagnostics bundles: `<state>/diagnostics/<bareRunId>-<ts>`.
  const diagnosticsRoot = resolveDiagnosticsRoot(stateDir);
  for (const entry of listEntries(diagnosticsRoot)) {
    const full = path.join(diagnosticsRoot, entry.name);
    const sizeBytes = measurePath(full).sizeBytes;
    if (!entry.isDirectory) {
      items.push({
        kind: "diagnostics-bundle",
        runId: "",
        bareRunId: "",
        path: full,
        sizeBytes,
        action: "keep",
        reason: "not a diagnostics bundle directory; left untouched",
      });
      continue;
    }
    const run = matchBundleRun(entry.name, runs);
    addItem(
      "diagnostics-bundle",
      full,
      sizeBytes,
      run,
      "unmapped diagnostics bundle: basename does not start with a known run id",
    );
  }

  // (c) Suite ledger logs: `<state>/suite-logs/<row id>.log`.
  const suiteLogsRoot = resolveSuiteLogsDir(stateDir);
  for (const entry of listEntries(suiteLogsRoot)) {
    const full = path.join(suiteLogsRoot, entry.name);
    const sizeBytes = measurePath(full).sizeBytes;
    const idMatch = /^(\d+)\.log$/.exec(entry.name);
    const ref =
      ledger.byPath.get(path.resolve(full)) ??
      (idMatch !== null ? ledger.byId.get(idMatch[1]) : undefined);
    if (ref === undefined) {
      items.push({
        kind: "suite-log",
        runId: "",
        bareRunId: "",
        path: full,
        sizeBytes,
        action: "keep",
        reason: "orphan suite log: no suite_results row references this file",
      });
      continue;
    }
    const runId = ref.runId;
    if (runId === null) {
      items.push({
        kind: "suite-log",
        runId: "",
        bareRunId: "",
        path: full,
        sizeBytes,
        action: "keep",
        reason: "suite_results row has no run_id; left untouched",
      });
      continue;
    }
    const bare = stripIdPrefix(runId);
    const run = runs.get(bare);
    if (run === undefined) {
      items.push({
        kind: "suite-log",
        runId,
        bareRunId: bare,
        path: full,
        sizeBytes,
        action: "keep",
        reason: `suite_results row references unknown run ${runId}`,
      });
      continue;
    }
    addItem("suite-log", full, sizeBytes, run);
  }

  // (d) Removed worktrees whose directory still exists.
  const worktreeResult = queryAll(db, "run_worktrees", WORKTREE_COLUMNS, "status = 'removed'");
  for (const row of worktreeResult.rows) {
    const worktreePath = asText(row.worktree_path);
    if (worktreePath === null) continue;
    const measured = measurePath(worktreePath);
    if (!measured.exists) continue;
    const runId = asText(row.run_id);
    if (runId === null) {
      items.push({
        kind: "removed-worktree",
        runId: "",
        bareRunId: "",
        path: worktreePath,
        sizeBytes: measured.sizeBytes,
        action: "keep",
        reason: "run_worktrees row has no run_id; left untouched",
      });
      continue;
    }
    const bare = stripIdPrefix(runId);
    addItem("removed-worktree", worktreePath, measured.sizeBytes, runs.get(bare));
  }

  const removeItems = items.filter((item) => item.action === "remove");
  const keepItems = items.filter((item) => item.action === "keep");
  const removeBytes = removeItems.reduce((sum, item) => sum + item.sizeBytes, 0);
  const keepBytes = keepItems.reduce((sum, item) => sum + item.sizeBytes, 0);
  const totals: PruneTotals = {
    itemCount: items.length,
    removeCount: removeItems.length,
    keepCount: keepItems.length,
    removeBytes,
    keepBytes,
    totalBytes: removeBytes + keepBytes,
  };

  return { olderThanMs, items, refusals, totals };
}

/**
 * True when a path is lexically inside the given state dir. Re-exported here
 * so the CLI and the executor share the exact containment rule the planner
 * assumes.
 */
export function isInsideStateDir(stateDir: string, candidate: string): boolean {
  return isPathInside(stateDir, candidate);
}