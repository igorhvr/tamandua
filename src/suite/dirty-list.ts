/**
 * Bounded dirty-list formatter for TSTX drift guard output.
 *
 * Pure function — no git calls, no I/O. Returns a bounded multi-line
 * string of at most `cap` verbatim path lines, one per line, each
 * prefixed with a single space. If the input exceeds the cap, appends
 * a summary line.
 */

/**
 * Format a list of porcelain paths into a bounded multi-line string.
 *
 * Each entry is preserved verbatim (no re-parsing). At most `cap` path
 * lines are emitted, each prefixed with a single space. If the input
 * contains more than `cap` entries, a single summary line is appended:
 *
 *   `… and N more tracked files not listed here (T total).`
 *
 * where N = paths.length - cap and T = paths.length.
 *
 * No FAILURE/ACTION banners — just the bounded list body.
 *
 * @param paths - Array of porcelain path lines (e.g. " M src/foo.ts").
 * @param cap - Maximum path lines to emit (default 32).
 * @returns Bounded multi-line string.
 */
export function formatTrackedDirtyList(
  paths: string[],
  cap: number = 32,
): string {
  const lines: string[] = [];

  const limit = Math.min(paths.length, cap);
  for (let i = 0; i < limit; i++) {
    lines.push(` ${paths[i]}`);
  }

  if (paths.length > cap) {
    const n = paths.length - cap;
    const t = paths.length;
    lines.push(`… and ${n} more tracked files not listed here (${t} total).`);
  }

  return lines.join("\n");
}
