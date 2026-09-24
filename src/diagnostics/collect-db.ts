/**
 * DB row collector for diagnostics bundles (DIAG-PRUNE US-003).
 *
 * Produces the run/step/story/abandonment/worktree rows section of a
 * diagnostics bundle. It is READ-ONLY: it issues SELECT statements only,
 * opens no daemon connection, and never writes to the database.
 *
 * Two safety rules are encoded here:
 *
 *  1. Every query projects an EXPLICIT column list. A future column added to
 *     one of these tables can therefore never silently leak into the bundle
 *     (e.g. a BLOB-backed Buffer, or a BigInt that JSON.stringify refuses).
 *     The projection is also defensively sanitized: a Buffer becomes a base64
 *     string and a BigInt a number/string, so a schema drift cannot produce
 *     non-JSON output.
 *
 *  2. A missing row, a missing table or any query error is reported as
 *     `status: 'absent'` with an `absenceReason`; the collector NEVER throws.
 *     The bundle's "no source is ever an exception" contract depends on this.
 *
 * The raw `runs.matchlock_policy` JSON is deliberately NOT embedded here: the
 * presence flag is enough for this section, and US-008 owns the policy
 * (parsed, redacted) under `matchlock.json`.
 */
import { getDb } from "../db.js";
import type { DbRowsCollection, JsonObject, SourceStatus } from "./types.js";

/** Minimal read-only db surface this module needs (injectable for tests). */
export interface DiagnosticsDbStatement {
  all(...params: (string | number | null)[]): unknown[];
  get(...params: (string | number | null)[]): unknown;
}

export interface DiagnosticsDb {
  prepare(sql: string): DiagnosticsDbStatement;
}

export interface CollectDbRowsOptions {
  /** Injected read-only db. Defaults to the process database. */
  db?: DiagnosticsDb;
  /** Full requested run id (possibly `run-` prefixed). */
  runId: string;
  /** Id as stored in the database (the `run-` prefix stripped). */
  bareRunId: string;
}

/**
 * Columns projected for the run row. `matchlock_policy` is selected only to
 * derive its presence; the raw JSON is dropped from the returned row.
 */
const RUN_COLUMNS = [
  "id",
  "run_number",
  "workflow_id",
  "task",
  "status",
  "context",
  "tokens_spent",
  "parent_run_id",
  "scheduling_status",
  "scheduling_requested_at",
  "scheduling_error",
  "worker_lost_count",
  "ceiling_expiry_count",
  "instant_fail_count",
  "harness_probe_status",
  "harness_probe_at",
  "test_cmd_established",
  "test_cmd_source",
  "matchlock_policy",
  "created_at",
  "updated_at",
] as const;

const STEP_COLUMNS = [
  "id",
  "run_id",
  "step_id",
  "agent_id",
  "step_index",
  "status",
  "type",
  "current_story_id",
  "retry_count",
  "max_retries",
  "abandoned_count",
  "reroute_count",
  "terminal_reroute_count",
  "target_moved_reroute_count",
  "preclaim_death_count",
  "ledger_concession_count",
  "claim_job_id",
  "claim_pid",
  "claim_pgid",
  "claim_updated_at",
  "claim_invalidated_by",
  "conditional_condition",
  "auto_completed",
  "auto_complete_reason",
  "output",
  "created_at",
  "updated_at",
] as const;

const STORY_COLUMNS = [
  "id",
  "run_id",
  "story_index",
  "story_id",
  "title",
  "description",
  "acceptance_criteria",
  "status",
  "retry_count",
  "max_retries",
  "abandoned_count",
  "resume_reset_count",
  "output",
  "created_at",
  "updated_at",
] as const;

const STORY_ABANDONMENT_COLUMNS = [
  "id",
  "story_id",
  "run_id",
  "reason",
  "abandoned_count",
  "step_id",
  "created_at",
] as const;

const RUN_WORKTREE_COLUMNS = [
  "run_id",
  "worktree_origin_repository",
  "worktree_origin_git_common_dir",
  "worktree_path",
  "worktree_origin_ref",
  "worktree_origin_sha",
  "original_branch",
  "status",
  "cleanup_policy",
  "created_at",
  "removed_at",
  "error",
] as const;

interface TableResult {
  rows: JsonObject[];
  error?: string;
}

/** Convert a projected value to a JSON-safe one (defense in depth). */
function sanitizeValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  return value;
}

/** Copy only the explicitly selected columns out of a raw row. */
function projectRow(row: unknown, columns: readonly string[]): JsonObject {
  const out: JsonObject = {};
  if (row === null || typeof row !== "object") return out;
  const source = row as Record<string, unknown>;
  for (const column of columns) {
    out[column] = sanitizeValue(source[column]);
  }
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Query one table, returning projected rows or a recorded error. Never
 * throws: a missing table (or any SQL error) becomes `error`.
 */
function queryTable(
  db: DiagnosticsDb,
  table: string,
  columns: readonly string[],
  where: string,
  params: (string | number | null)[],
  project: (row: unknown) => JsonObject,
): TableResult {
  try {
    const statement = db.prepare(
      `SELECT ${columns.join(", ")} FROM ${table} WHERE ${where}`,
    );
    const raw = statement.all(...params);
    if (!Array.isArray(raw)) return { rows: [] };
    return { rows: raw.map(project) };
  } catch (error) {
    return { rows: [], error: `${table}: ${errorMessage(error)}` };
  }
}

/**
 * Collect the run/step/story/abandonment/worktree rows for one run.
 *
 * Returns a `DbRowsCollection` whose `status` is `'absent'` when the run row
 * is missing or any table is unavailable. Partial arrays are still returned
 * for tables that answered; the absent source is always named in
 * `absenceReason`.
 */
export function collectDbRows(
  options: CollectDbRowsOptions,
): DbRowsCollection {
  const db =
    options.db ?? (getDb() as unknown as DiagnosticsDb);
  const runId = options.runId;
  const bareRunId = options.bareRunId;
  const runParams: (string | number | null)[] = [bareRunId, runId];

  const absenceReasons: string[] = [];

  const runResult = queryTable(
    db,
    "runs",
    RUN_COLUMNS,
    "id = ? OR id = ?",
    runParams,
    (row) => {
      const projected = projectRow(row, RUN_COLUMNS);
      const policyPresent =
        typeof projected.matchlock_policy === "string" &&
        projected.matchlock_policy.length > 0;
      delete projected.matchlock_policy;
      projected.matchlock_policy_present = policyPresent;
      return projected;
    },
  );
  if (runResult.error) {
    absenceReasons.push(runResult.error);
  } else if (runResult.rows.length === 0) {
    absenceReasons.push(`run ${bareRunId} not found`);
  }

  const stepResult = queryTable(
    db,
    "steps",
    STEP_COLUMNS,
    "run_id = ? OR run_id = ?",
    runParams,
    (row) => projectRow(row, STEP_COLUMNS),
  );
  if (stepResult.error) absenceReasons.push(stepResult.error);

  const storyResult = queryTable(
    db,
    "stories",
    STORY_COLUMNS,
    "run_id = ? OR run_id = ?",
    runParams,
    (row) => projectRow(row, STORY_COLUMNS),
  );
  if (storyResult.error) absenceReasons.push(storyResult.error);

  const abandonmentResult = queryTable(
    db,
    "story_abandonments",
    STORY_ABANDONMENT_COLUMNS,
    "run_id = ? OR run_id = ?",
    runParams,
    (row) => projectRow(row, STORY_ABANDONMENT_COLUMNS),
  );
  if (abandonmentResult.error) absenceReasons.push(abandonmentResult.error);

  const worktreeResult = queryTable(
    db,
    "run_worktrees",
    RUN_WORKTREE_COLUMNS,
    "run_id = ? OR run_id = ?",
    runParams,
    (row) => projectRow(row, RUN_WORKTREE_COLUMNS),
  );
  if (worktreeResult.error) absenceReasons.push(worktreeResult.error);

  const status: SourceStatus = absenceReasons.length > 0 ? "absent" : "present";

  return {
    status,
    ...(absenceReasons.length > 0
      ? { absenceReason: absenceReasons.join("; ") }
      : {}),
    runs: runResult.rows,
    steps: stepResult.rows,
    stories: storyResult.rows,
    story_abandonments: abandonmentResult.rows,
    run_worktrees: worktreeResult.rows,
  };
}