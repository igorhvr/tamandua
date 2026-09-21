/**
 * Matchlock Hermes mapped-store reader.
 *
 * MTLK-HERMES US-001: read token accounting for a *mapped* Hermes session
 * store. The store directory is passed explicitly by the controller (the host
 * path backing the guest mount) — this module NEVER derives it from
 * `process.env.HERMES_HOME` or the process home, and never falls back to a host
 * default. When evidence is unavailable, ambiguous or truncated it returns
 * `{ status: "unavailable" | "ambiguous" | "truncated" }` with evidence, never
 * a fabricated zero.
 *
 * Token total = input_tokens + output_tokens + cache_write_tokens
 * (cache_read_tokens and reasoning are excluded, matching the existing Hermes
 * usage semantics — cache-read is re-read every API call and inflates totals).
 *
 * Synthetic/local tests do NOT prove cross-VM SQLite locking; any live
 * SQLite/VFS compatibility claim remains an integration gate until real VM
 * proof. This reader is deliberately conservative about evidence.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type HermesStoreStatus = "ok" | "unavailable" | "ambiguous" | "truncated";

export interface HermesStoreScanInput {
  /** Explicit mapped host store dir backing the guest `HERMES_HOME`. */
  storeDir: string;
  /** Session id returned by the launch (the `session_id:` trailer). */
  sessionRef: string;
}

export interface HermesStoreScan {
  status: HermesStoreStatus;
  /** Input+output+cache-write tokens (excludes cache-read), when status is ok. */
  tokens?: number;
  evidence: string[];
}

/** Columns required to compute the total (cache_read excluded by design). */
const SUM_COLUMNS = ["input_tokens", "output_tokens", "cache_write_tokens"] as const;

/**
 * Compute the token total from a row with the established semantics:
 * input+output+cache_write (cache_read/reasoning excluded), clamp negatives to 0,
 * round to integer. Returns NaN when any summed field is non-finite or
 * non-numeric — such a row is incomplete evidence, NOT a verified zero.
 */
export function computeHermesTokenTotal(row: Record<string, unknown>): number {
  let sum = 0;
  for (const col of SUM_COLUMNS) {
    const v = row[col];
    if (typeof v !== "number" || !Number.isFinite(v)) return NaN;
    sum += Math.max(0, v);
  }
  return Math.round(sum);
}

/**
 * Lexical containment: is `target` at or under `scope`? (Symlink escape
 * resistance requires realpath — a VFS integration gate, not assumed here.)
 */
export function storeDirWithinScope(storeDir: string, scopeDir: string): boolean {
  const rel = path.relative(scopeDir, storeDir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Scan the explicit mapped store for a session's token accounting. Read-only;
 * never creates or modifies the store. Returns structured evidence instead of
 * throwing into the dispatch path.
 */
export function scanHermesStoreTokens(
  input: HermesStoreScanInput,
): HermesStoreScan {
  const dbPath = path.join(input.storeDir, "state.db");
  if (!fs.existsSync(dbPath)) {
    return {
      status: "unavailable",
      evidence: [`state.db not found at ${dbPath}`],
    };
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });

    const columns = db
      .prepare("SELECT name FROM pragma_table_info('sessions')")
      .all() as Array<{ name: string }>;
    if (columns.length === 0) {
      return {
        status: "unavailable",
        evidence: [`state.db at ${dbPath} has no sessions table`],
      };
    }

    const colSet = new Set(columns.map((c) => c.name));
    const missingSum = SUM_COLUMNS.filter((c) => !colSet.has(c));
    if (missingSum.length > 0) {
      return {
        status: "unavailable",
        evidence: [`sessions table missing required columns: ${missingSum.join(", ")}`],
      };
    }

    const row = db
      .prepare(
        "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM sessions WHERE id = ?",
      )
      .get(input.sessionRef) as
      | Record<string, unknown>
      | undefined;

    if (!row) {
      return {
        status: "unavailable",
        evidence: [`session ${input.sessionRef} not found in state.db`],
      };
    }

    // NULL token columns are ambiguous evidence, not a verified zero.
    if (
      row.input_tokens === null ||
      row.output_tokens === null ||
      row.cache_write_tokens === null
    ) {
      return {
        status: "ambiguous",
        evidence: [`session ${input.sessionRef} has NULL token columns; count is unverified`],
      };
    }

    // Non-finite / non-numeric summed fields are incomplete evidence, never a
    // verified zero (and never silently clamped). The token total is unavailable.
    const total = computeHermesTokenTotal(row);
    if (!Number.isFinite(total)) {
      return {
        status: "unavailable",
        evidence: [
          `session ${input.sessionRef} has non-finite or non-numeric token fields; count is unverified`,
        ],
      };
    }

    return {
      status: "ok",
      tokens: total,
      evidence: [`session ${input.sessionRef} read from ${dbPath}`],
    };
  } catch (err) {
    // A read failure (corruption / WAL inconsistency) is truncated evidence.
    return {
      status: "truncated",
      evidence: [
        `state.db read error: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }
}
