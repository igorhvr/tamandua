import { getDb } from "../db.js";
import { stripIdPrefix } from "../lib/id-prefix.js";

export interface RunSelectorResult {
  runIds: string[];
  warnings?: string[];
}

/**
 * Resolve run selectors to concrete run IDs.
 *
 * Accepted selector formats:
 * - Full UUID: exact match against runs.id
 * - Prefix: LIKE match; throws if ambiguous (multiple matches)
 * - #N: run number lookup (e.g. "#42")
 * - --all: returns all non-terminal (running, paused) runs at invocation time
 *
 * Multiple selectors are resolved independently and the union is returned.
 *
 * Throws with descriptive messages for:
 * - Selector not found (includes selector text)
 * - Ambiguous prefix (lists matching run IDs)
 */
export function resolveRunSelectors(
  selectors: string[],
  opts: { all?: boolean } = {},
): RunSelectorResult {
  const db = getDb();
  const runIds = new Set<string>();
  const warnings: string[] = [];

  if (opts.all) {
    const rows = db
      .prepare(
        "SELECT id FROM runs WHERE status IN ('running', 'paused') ORDER BY created_at ASC",
      )
      .all() as Array<{ id: string }>;
    for (const row of rows) {
      runIds.add(row.id);
    }
  }

  for (const selector of selectors) {
    resolveOne(selector, db, runIds, warnings);
  }

  return {
    runIds: Array.from(runIds),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function resolveOne(
  selector: string,
  db: ReturnType<typeof getDb>,
  runIds: Set<string>,
  warnings: string[],
): void {
  // #N run number — never prefixed, so check selector directly.
  if (/^#\d+$/.test(selector)) {
    const runNumber = parseInt(selector.slice(1), 10);
    const row = db
      .prepare("SELECT id FROM runs WHERE run_number = ?")
      .get(runNumber) as { id: string } | undefined;
    if (!row) {
      throw new Error(`No run found with run number: ${selector}`);
    }
    runIds.add(row.id);
    return;
  }

  // Strip run- prefix for the lookup. If stripping produces a different
  // value, try the original first (handles run IDs that happen to start
  // with "run-" but aren't prefixed UUIDs), then fall back to the
  // stripped form.
  const bare = stripIdPrefix(selector);

  // Try exact match with original selector first
  const exactRow = db
    .prepare("SELECT id FROM runs WHERE id = ?")
    .get(selector) as { id: string } | undefined;
  if (exactRow) {
    runIds.add(exactRow.id);
    return;
  }

  // If stripped is different, try exact match with stripped
  if (bare !== selector) {
    const strippedRow = db
      .prepare("SELECT id FROM runs WHERE id = ?")
      .get(bare) as { id: string } | undefined;
    if (strippedRow) {
      runIds.add(strippedRow.id);
      return;
    }
  }

  // Try prefix match with original selector
  let prefixRows = db
    .prepare("SELECT id FROM runs WHERE id LIKE ?")
    .all(`${selector}%`) as Array<{ id: string }>;

  // If stripped is different and no match, try prefix match with stripped
  if (prefixRows.length === 0 && bare !== selector) {
    prefixRows = db
      .prepare("SELECT id FROM runs WHERE id LIKE ?")
      .all(`${bare}%`) as Array<{ id: string }>;
  }

  if (prefixRows.length === 1) {
    runIds.add(prefixRows[0].id);
    return;
  }

  if (prefixRows.length > 1) {
    throw new Error(
      `Ambiguous selector "${selector}" matches ${prefixRows.map((r) => r.id).join(", ")}. Use a longer prefix or the full UUID.`,
    );
  }

  // Not found
  throw new Error(`No run found matching "${selector}"`);
}
