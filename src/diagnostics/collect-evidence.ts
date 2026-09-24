/**
 * Evidence directory and suite-ledger collector (DIAG-PRUNE US-006).
 *
 * Produces the evidence section of a diagnostics bundle:
 *
 *  - a recursive listing of the run's evidence directory
 *    (`<state>/runs/<bareRunId>`) with relative paths and byte sizes, and
 *  - the `suite_results` ledger rows for the run, with their `log_path` and a
 *    `log_tail` PRESENCE flag — the full log bodies are never read here.
 *
 * Contract:
 *
 *  1. READ-ONLY. No file is created, mutated or deleted; no daemon is
 *     contacted; the database is only SELECTed from.
 *  2. A missing evidence directory is `status: 'absent'` with an
 *     `absenceReason`, never a thrown exception. An unreadable directory or
 *     file is likewise reported, never thrown.
 *  3. Symlinks are never followed OUT of the evidence directory: a symlink is
 *     only traversed when its resolved target is still inside the evidence
 *     root (compared by realpath, so a symlinked state dir does not defeat the
 *     guard). A visited-realpath set prevents symlink cycles.
 *  4. The suite-ledger query projects an EXPLICIT column list; only
 *     `log_tail` presence is derived and the raw body is dropped. A missing
 *     table or query error degrades `suiteLedgerStatus` to `'absent'` without
 *     touching the evidence listing.
 */
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db.js";
import { stripIdPrefix } from "../lib/id-prefix.js";
import { isPathInside, resolveRunEvidenceDir } from "./paths.js";
import type { DiagnosticsDb } from "./collect-db.js";
import type {
  EvidenceCollection,
  EvidenceFileEntry,
  SourceStatus,
  SuiteLedgerRow,
} from "./types.js";

export interface CollectEvidenceOptions {
  /** Effective tamandua state dir (contains the `runs/` evidence root). */
  stateDir: string;
  /** Run id as stored/displayed; a `run-` prefix is tolerated and stripped. */
  runId?: string;
  /** Bare run id, when the caller already has it. */
  bareRunId?: string;
  /** Injected read-only db. Defaults to the process database. */
  db?: DiagnosticsDb;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A JSON-safe string projection (non-strings degrade to null, never throw). */
function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return String(value);
}

/** A JSON-safe numeric projection for the ledger's integer columns. */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") {
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    return null;
  }
  return null;
}

/** A non-empty `log_tail` (string or blob) counts as present. */
function hasLogTail(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (value instanceof Uint8Array) return value.byteLength > 0;
  return value !== null && value !== undefined;
}

interface WalkResult {
  entries: EvidenceFileEntry[];
  totalBytes: number;
  reasons: string[];
}

/** The realpath of a directory, falling back to its lexical resolution. */
function realDirOrNull(dir: string): string | null {
  try {
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

/**
 * Recursively list regular files under `root`. Symlinks are traversed only
 * when their resolved target stays inside `root` (realpath comparison); a
 * `visited` realpath set guards against cycles. Failures on descendants are
 * recorded as reasons rather than thrown.
 */
function walkEvidenceDir(root: string): WalkResult {
  const entries: EvidenceFileEntry[] = [];
  const reasons: string[] = [];
  const visited = new Set<string>();
  const rootReal = realDirOrNull(root) ?? path.resolve(root);

  const walk = (dir: string): void => {
    const realDir = realDirOrNull(dir);
    if (realDir === null) {
      reasons.push(`${dir}: could not resolve`);
      return;
    }
    if (!isPathInside(rootReal, realDir)) {
      // The root itself is handled explicitly by the caller; any descendant
      // whose realpath escaped the evidence root is skipped, never followed.
      if (realDir !== rootReal) return;
    }
    if (visited.has(realDir)) return;
    visited.add(realDir);

    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      reasons.push(`${dir}: ${errorMessage(error)}`);
      return;
    }

    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      let isFile = dirent.isFile();
      let isDir = dirent.isDirectory();

      if (dirent.isSymbolicLink()) {
        const real = realDirOrNull(full);
        if (real === null || !isPathInside(rootReal, real)) continue;
        try {
          const stat = fs.statSync(full);
          isFile = stat.isFile();
          isDir = stat.isDirectory();
        } catch (error) {
          reasons.push(`${full}: ${errorMessage(error)}`);
          continue;
        }
      }

      if (isFile) {
        let sizeBytes = 0;
        try {
          sizeBytes = fs.statSync(full).size;
        } catch (error) {
          reasons.push(`${full}: ${errorMessage(error)}`);
          continue;
        }
        entries.push({
          path: path.relative(root, full) || dirent.name,
          sizeBytes,
        });
      } else if (isDir) {
        walk(full);
      }
      // Other node kinds (fifo/socket/device) are skipped: not "files".
    }
  };

  walk(root);

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  return { entries, totalBytes, reasons };
}

interface SuiteLedgerResult {
  status: SourceStatus;
  rows: SuiteLedgerRow[];
  absenceReason?: string;
}

/**
 * Suite-ledger columns projected for the bundle. `log_tail` is selected only
 * to derive its presence; the raw (up to 20 KB) body is dropped so the bundle
 * carries a pointer rather than a copy.
 */
const SUITE_LEDGER_COLUMNS = [
  "id",
  "run_id",
  "step_id",
  "cmd_display",
  "exit_code",
  "duration_ms",
  "log_tail",
  "log_path",
  "created_at",
] as const;

/**
 * Query the suite ledger for the run. Explicit projection only; never throws
 * — a missing table or query error becomes `status: 'absent'` with the reason.
 */
function querySuiteLedger(
  db: DiagnosticsDb,
  bareRunId: string,
  runId: string,
): SuiteLedgerResult {
  try {
    const statement = db.prepare(
      `SELECT ${SUITE_LEDGER_COLUMNS.join(", ")} FROM suite_results ` +
        `WHERE run_id = ? OR run_id = ? ORDER BY created_at ASC, id ASC`,
    );
    const raw = statement.all(bareRunId, runId);
    if (!Array.isArray(raw)) {
      return { status: "empty", rows: [] };
    }
    const rows: SuiteLedgerRow[] = raw.map((value) => {
      const row = (value ?? {}) as Record<string, unknown>;
      return {
        id: toText(row.id) ?? "",
        runId: toText(row.run_id) ?? "",
        stepId: toText(row.step_id),
        cmdDisplay: toText(row.cmd_display),
        exitCode: toNumber(row.exit_code),
        durationMs: toNumber(row.duration_ms),
        createdAt: toText(row.created_at),
        logPath: toText(row.log_path),
        hasLogTail: hasLogTail(row.log_tail),
      };
    });
    return { status: rows.length > 0 ? "present" : "empty", rows };
  } catch (error) {
    return {
      status: "absent",
      rows: [],
      absenceReason: `suite_results: ${errorMessage(error)}`,
    };
  }
}

/**
 * Collect the run's evidence directory listing and suite-ledger rows.
 *
 * The top-level `status` describes the evidence directory only
 * (`'present'`/`'empty'`/`'absent'`). The suite ledger reports its own
 * `suiteLedgerStatus`, so a present evidence dir with an unavailable ledger is
 * still fully described. Never throws.
 */
export function collectEvidence(
  options: CollectEvidenceOptions,
): EvidenceCollection {
  const stateDir = options.stateDir ?? "";
  const bare = stripIdPrefix((options.bareRunId ?? options.runId ?? "").trim());
  const runId = options.runId && options.runId.length > 0 ? options.runId : bare;
  const evidenceDir = resolveRunEvidenceDir(stateDir, bare);

  const reasons: string[] = [];
  let entries: EvidenceFileEntry[] = [];
  let totalBytes = 0;
  let dirStatus: SourceStatus = "absent";

  let isDirectory = false;
  try {
    isDirectory = fs.statSync(evidenceDir).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    reasons.push(
      code === "ENOENT" || code === "ENOTDIR"
        ? `evidence directory not found: ${evidenceDir}`
        : `${evidenceDir}: ${errorMessage(error)}`,
    );
  }

  if (isDirectory) {
    const walked = walkEvidenceDir(evidenceDir);
    entries = walked.entries;
    totalBytes = walked.totalBytes;
    reasons.push(...walked.reasons);
    dirStatus = entries.length > 0 ? "present" : "empty";
  } else if (reasons.length === 0) {
    // statAsync succeeded but the path is not a directory.
    reasons.push(`evidence path is not a directory: ${evidenceDir}`);
  }

  const ledger = querySuiteLedger(
    options.db ?? (getDb() as unknown as DiagnosticsDb),
    bare,
    runId,
  );

  return {
    status: dirStatus,
    ...(reasons.length > 0 ? { absenceReason: reasons.join("; ") } : {}),
    evidenceDir,
    entries,
    totalBytes,
    suiteLedger: ledger.rows,
    suiteLedgerStatus: ledger.status,
  };
}