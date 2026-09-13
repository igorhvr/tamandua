import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { logger } from "../lib/logger.js";
import { sumBillableTokens } from "./token-usage-policy.js";

const REQUIRED_COLUMNS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
] as const;

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 700;

/**
 * Resolve the hermes home directory from the given env (falls back to
 * process.env, then ~/.hermes).
 */
function resolveHermesHome(env?: NodeJS.ProcessEnv): string {
  return (
    env?.HERMES_HOME ??
    process.env.HERMES_HOME ??
    path.join(os.homedir(), ".hermes")
  );
}

/**
 * Probe the hermes state.db schema contract without invoking hermes or
 * spending tokens.
 *
 * Checks that `$HERMES_HOME/state.db` exists, opens read-only, and has a
 * `sessions` table with all required token accounting columns
 * (input_tokens, output_tokens, cache_read_tokens, cache_write_tokens).
 *
 * This is synchronous — it only does stat + open, no hermes invocation.
 *
 * @returns `{ ok: true }` when the contract holds, or
 *          `{ ok: false, reason: "..." }` with a descriptive reason.
 */
export function probeHermesStateContract(
  env?: NodeJS.ProcessEnv,
): { ok: boolean; reason?: string } {
  const hermesHome = resolveHermesHome(env);
  const dbPath = path.join(hermesHome, "state.db");

  if (!fs.existsSync(dbPath)) {
    return { ok: false, reason: `hermes state.db not found at ${dbPath}` };
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });

    const schemaResult = db
      .prepare("SELECT name FROM pragma_table_info('sessions')")
      .all() as Array<{ name: string }>;

    if (schemaResult.length === 0) {
      return {
        ok: false,
        reason: "hermes state.db has no sessions table",
      };
    }

    const columnNames = new Set(schemaResult.map((col) => col.name));
    const missing = REQUIRED_COLUMNS.filter((col) => !columnNames.has(col));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `hermes state.db sessions table missing columns: ${missing.join(", ")}`,
      };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `hermes state.db read error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }
}

/**
 * Look up token usage for a hermes session from its state.db.
 *
 * Resolves `$HERMES_HOME/state.db` from the provided `env` (falling back
 * to `process.env.HERMES_HOME`, then `~/.hermes/state.db`). Opens the DB
 * **read-only** — it never creates or writes the file.
 *
 * Token total = input_tokens + output_tokens + cache_write_tokens
 * (excludes reasoning_tokens AND cache_read_tokens).
 * cache_read_tokens are excluded because hermes re-reads the entire
 * context from cache on every API call, inflating totals 10–30× and
 * making them incomparable to pi's per-round token attribution.
 * Negatives are clamped to 0, total is rounded to integer.
 *
 * Retries the row lookup up to 3 attempts (~2 s total) to tolerate
 * hermes WAL writer lag. On **any** failure (file missing, table/columns
 * missing, row not found, schema change) returns `null` and logs ONE
 * clear warning — it never throws into the dispatch path.
 *
 * @returns Total tokens used for the session, or `null` if unavailable.
 */
export async function lookupHermesSessionTokens(
  sessionRef: string,
  env?: NodeJS.ProcessEnv,
): Promise<number | null> {
  const hermesHome = resolveHermesHome(env);
  const dbPath = path.join(hermesHome, "state.db");

  // Use the contract probe to validate the schema before attempting
  // row lookups.
  const contract = probeHermesStateContract(env);
  if (!contract.ok) {
    logger.warn("Hermes session token lookup failed", {
      sessionRef,
      reason: contract.reason,
    });
    return null;
  }

  let lastReason: string | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });

      // ── Row lookup ───────────────────────────────────────────
      const row = db
        .prepare(
          "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM sessions WHERE id = ?",
        )
        .get(sessionRef) as
        | {
            input_tokens: number;
            output_tokens: number;
            cache_read_tokens: number;
            cache_write_tokens: number;
          }
        | undefined;

      if (row) {
        // Shared harness policy (token-usage-policy.ts): input + output +
        // cache_write, cache_read excluded. Kept in lockstep with pi and dsh.
        return sumBillableTokens({
          input: row.input_tokens,
          output: row.output_tokens,
          cacheWrite: row.cache_write_tokens,
        });
      }

      lastReason = `hermes session ${sessionRef} not found in state.db`;
      // Row not found — retry (WAL writer may not have committed yet)
    } catch (err) {
      lastReason = `hermes state.db read error: ${err instanceof Error ? err.message : String(err)}`;
      // Retry on transient read errors
    } finally {
      try {
        db?.close();
      } catch {
        // ignore close errors
      }
    }

    if (attempt < MAX_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  // ── Log ONE clear warning ─────────────────────────────────────
  if (lastReason) {
    logger.warn("Hermes session token lookup failed", {
      sessionRef,
      reason: lastReason,
    });
  }

  return null;
}
