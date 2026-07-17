import { getDb } from "../db.js";

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
  // #N run number
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

  // Try exact UUID match first
  const exactRow = db
    .prepare("SELECT id FROM runs WHERE id = ?")
    .get(selector) as { id: string } | undefined;
  if (exactRow) {
    runIds.add(exactRow.id);
    return;
  }

  // Try prefix match
  // Use LIKE to be compatible with SQLite DatabaseSync (no GLOB needed here)
  const prefixRows = db
    .prepare("SELECT id FROM runs WHERE id LIKE ?")
    .all(`${selector}%`) as Array<{ id: string }>;

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
