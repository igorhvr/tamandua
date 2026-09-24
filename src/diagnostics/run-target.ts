/**
 * Run target resolution for `tamandua run diagnose` (DIAG-PRUNE US-002).
 *
 * Resolves the `<run-id|run-number>` selector the operator supplied into a
 * typed run target. This module is READ-ONLY: it issues SELECT statements
 * only, opens no daemon connection, and never writes to the database. It
 * accepts an injected db-like object so unit tests need no real database
 * (mirroring `lookupRunIdByNumber` in src/cli/logs-selector.ts).
 *
 * Selector forms:
 *  - `#<N>` / bare integer  -> single run-number lookup
 *  - full run id            -> exact match
 *  - unambiguous id prefix  -> prefix match; ambiguous prefixes are refused
 *
 * Not-found and ambiguous selectors raise typed errors so the CLI can print a
 * clear message and exit non-zero without string-sniffing a message.
 *
 * The run context JSON is parsed locally (never through
 * `parseRunContext` from step-ops) so this module — and its tests — pull in
 * no `node:child_process` dependency and stay in the parallel test lane. A
 * corrupt context degrades to `harnessType: null`; it is never fatal.
 */
import { getDb } from "../db.js";
import { stripIdPrefix } from "../lib/id-prefix.js";

/** Columns projected for the run target (an explicit, stable list). */
const RUN_TARGET_COLUMNS = [
  "id",
  "run_number",
  "workflow_id",
  "task",
  "status",
  "scheduling_status",
  "scheduling_error",
  "context",
  "created_at",
  "updated_at",
  "tokens_spent",
  "worker_lost_count",
  "ceiling_expiry_count",
  "instant_fail_count",
  "matchlock_policy",
].join(", ");

/** Minimal read-only db surface this module needs (injectable for tests). */
export interface RunTargetStatement {
  get(...params: (string | number | null)[]): unknown;
  all(...params: (string | number | null)[]): unknown[];
}

export interface RunTargetDb {
  prepare(sql: string): RunTargetStatement;
}

/** The raw `runs` row, projection-limited to the target columns. */
export interface RunTargetRow {
  id: string;
  run_number?: number | null;
  workflow_id?: string | null;
  task?: string | null;
  status?: string | null;
  scheduling_status?: string | null;
  scheduling_error?: string | null;
  context?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  tokens_spent?: number | null;
  worker_lost_count?: number | null;
  ceiling_expiry_count?: number | null;
  instant_fail_count?: number | null;
  matchlock_policy?: string | null;
  [key: string]: unknown;
}

/** A resolved run target: the selector turned into concrete run facts. */
export interface ResolvedRunTarget {
  runId: string;
  bareRunId: string;
  runNumber: number | null;
  status: string | null;
  schedulingStatus: string | null;
  workflowId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Harness the run was launched with (`context.harness_type`); null if unknown. */
  harnessType: string | null;
  /** Managed worktree path when the run has a `run_worktrees` row; else null. */
  worktreePath: string | null;
  /** The raw, projected run row. */
  row: RunTargetRow;
}

/** Raised when no run matches the selector. */
export class RunNotFoundError extends Error {
  readonly selector: string;

  constructor(selector: string) {
    super(`No run found matching ${JSON.stringify(selector)}`);
    this.name = "RunNotFoundError";
    this.selector = selector;
  }
}

/** Raised when an id prefix matches more than one run. */
export class AmbiguousRunError extends Error {
  readonly selector: string;
  readonly matches: string[];

  constructor(selector: string, matches: string[]) {
    super(
      `Ambiguous run selector ${JSON.stringify(selector)} matches ${matches.length} runs: ` +
        `${matches.join(", ")}. Use a longer prefix or the full run id.`,
    );
    this.name = "AmbiguousRunError";
    this.selector = selector;
    this.matches = matches;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parse `harness_type` out of a run-context JSON string.
 * A missing/corrupt context or a non-string value yields null; never throws.
 */
export function parseHarnessTypeFromContext(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const value = (parsed as Record<string, unknown>).harness_type;
      if (typeof value === "string" && value.length > 0) return value;
    }
  } catch {
    // Corrupt run context: the target still resolves, harness is unknown.
  }
  return null;
}

function lookupExact(db: RunTargetDb, id: string): RunTargetRow | undefined {
  return db
    .prepare(`SELECT ${RUN_TARGET_COLUMNS} FROM runs WHERE id = ?`)
    .get(id) as RunTargetRow | undefined;
}

function lookupPrefix(db: RunTargetDb, prefix: string): RunTargetRow[] {
  const rows = db
    .prepare(`SELECT ${RUN_TARGET_COLUMNS} FROM runs WHERE id LIKE ?`)
    .all(`${prefix}%`) as RunTargetRow[];
  return Array.isArray(rows) ? rows : [];
}

function lookupByRunNumber(db: RunTargetDb, runNumber: number): RunTargetRow | undefined {
  return db
    .prepare(`SELECT ${RUN_TARGET_COLUMNS} FROM runs WHERE run_number = ?`)
    .get(runNumber) as RunTargetRow | undefined;
}

function readWorktreePath(db: RunTargetDb, runId: string): string | null {
  try {
    const row = db
      .prepare("SELECT worktree_path FROM run_worktrees WHERE run_id = ?")
      .get(runId) as { worktree_path?: unknown } | undefined;
    return row ? asString(row.worktree_path) ?? null : null;
  } catch {
    // A db without the run_worktrees table (or a missing row) is not fatal.
    return null;
  }
}

function toTarget(row: RunTargetRow, worktreePath: string | null): ResolvedRunTarget {
  const runId = row.id;
  return {
    runId,
    bareRunId: stripIdPrefix(runId),
    runNumber: asNumberOrNull(row.run_number),
    status: asString(row.status),
    schedulingStatus: asString(row.scheduling_status),
    workflowId: asString(row.workflow_id),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    harnessType: parseHarnessTypeFromContext(asString(row.context)),
    worktreePath,
    row,
  };
}

/**
 * Resolve a `run diagnose` selector into a typed run target.
 *
 * @throws {RunNotFoundError} when nothing matches the selector.
 * @throws {AmbiguousRunError} when an id prefix matches multiple runs.
 */
export function resolveRunTarget(
  selector: string,
  db: RunTargetDb = getDb() as unknown as RunTargetDb,
): ResolvedRunTarget {
  const raw = typeof selector === "string" ? selector.trim() : "";
  if (raw.length === 0) {
    throw new RunNotFoundError(selector);
  }

  // Run-number selectors: `#N` or a bare integer.
  const numberMatch = /^#?(\d+)$/.exec(raw);
  if (numberMatch) {
    const runNumber = Number.parseInt(numberMatch[1], 10);
    const row = lookupByRunNumber(db, runNumber);
    if (!row) throw new RunNotFoundError(raw);
    return toTarget(row, readWorktreePath(db, row.id));
  }

  const bare = stripIdPrefix(raw);

  // Exact id: try the stripped (bare) id first; DB ids are stored bare.
  const exact = lookupExact(db, bare);
  if (exact) return toTarget(exact, readWorktreePath(db, exact.id));

  // Legacy/edge case: the original spelling is itself an exact id.
  if (bare !== raw) {
    const exactRaw = lookupExact(db, raw);
    if (exactRaw) return toTarget(exactRaw, readWorktreePath(db, exactRaw.id));
  }

  // Unambiguous id prefix.
  let matches = lookupPrefix(db, bare);
  if (matches.length === 0 && bare !== raw) {
    matches = lookupPrefix(db, raw);
  }

  if (matches.length === 1) {
    return toTarget(matches[0], readWorktreePath(db, matches[0].id));
  }
  if (matches.length > 1) {
    throw new AmbiguousRunError(raw, matches.map((row) => row.id));
  }
  throw new RunNotFoundError(raw);
}