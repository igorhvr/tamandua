/**
 * TIME-STORAGE US-004 — step-ops.ts writers persist the ONE instant format.
 *
 * Fast-tier/parallel-lane comment-blind source scan: `src/installer/step-ops.ts`
 * is the largest writer of naive instants, so this pins that every former
 * `datetime('now')` writer now interpolates the shared `SQL_NOW_ISO` fragment
 * and that nothing slipped outside a template literal (which would write the
 * literal string `${SQL_NOW_ISO}` into SQL instead of interpolating it).
 *
 * The behavioral half — claim/complete persisting `steps.updated_at` /
 * `steps.claim_updated_at` as ISO-Z — lives in the serial-lane step-ops tests
 * (`tests/claim-ownership-recording.test.ts`,
 * `src/installer/step-ops-complete.test.ts`) because importing step-ops.ts
 * transitively reaches a process-spawning module.
 *
 * Pure (fs + dist/lib) — must stay in the parallel lane; do NOT add it to
 * tests/serial-files.txt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../dist/lib/comment-blind.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STEP_OPS = "src/installer/step-ops.ts";

function readStepOps(): string {
  return fs.readFileSync(path.join(REPO_ROOT, STEP_OPS), "utf8");
}

describe("US-004 step-ops writers: comment-blind source scan", () => {
  it("contains no datetime('now') writer at all", () => {
    const code = stripComments(readStepOps());
    const hits = code.match(/datetime\('now'\)/g) ?? [];
    assert.deepEqual(hits, [], `${STEP_OPS} must interpolate SQL_NOW_ISO instead of writing datetime('now')`);
  });

  it("contains no CURRENT_TIMESTAMP writer", () => {
    const code = stripComments(readStepOps());
    assert.equal((code.match(/CURRENT_TIMESTAMP/gi) ?? []).length, 0, `${STEP_OPS} must not write CURRENT_TIMESTAMP`);
  });

  it("imports SQL_NOW_ISO from the shared instant module", () => {
    const code = stripComments(readStepOps());
    assert.match(
      code,
      /import\s*\{[^}]*\bSQL_NOW_ISO\b[^}]*\}\s*from\s*"\.\.\/lib\/instant\.js"/,
      `${STEP_OPS} must import SQL_NOW_ISO from ../lib/instant.js`,
    );
  });

  it("interpolates SQL_NOW_ISO exactly once per former datetime('now') writer", () => {
    const code = stripComments(readStepOps());
    const interpolations = code.match(/\$\{SQL_NOW_ISO\}/g) ?? [];
    // 127 total occurrences across 124 source lines (3 lines carry two:
    // claim_updated_at + updated_at). Up from 124 when the PKIL
    // paused_by_operator recovery branches added 3 updated_at writers.
    assert.equal(interpolations.length, 127, "every former datetime('now') writer must interpolate SQL_NOW_ISO");
  });

  it("never leaves a SQL_NOW_ISO interpolation inside a double-quoted string", () => {
    // A double-quoted JS string would not interpolate: it would send the
    // literal `${SQL_NOW_ISO}` text to SQLite. Double-quoted strings cannot
    // span lines, so a same-line `"` is the dangerous signal. The three
    // multi-line template statements carry the interpolation on a line with
    // no quote at all, which is safe.
    const lines = stripComments(readStepOps()).split("\n");
    const bad: Array<{ line: number; text: string }> = [];
    lines.forEach((line, idx) => {
      if (!line.includes("${SQL_NOW_ISO}")) return;
      if (line.includes('"')) bad.push({ line: idx + 1, text: line.trim() });
    });
    assert.deepEqual(bad, [], "SQL_NOW_ISO interpolations must never sit inside double-quoted strings");
  });

  it("preserves representative statement shapes (columns/placeholders/WHERE clauses)", () => {
    const code = stripComments(readStepOps());
    // Claim records ownership + both instants; complete stamps updated_at;
    // fail flips run status. Columns, placeholders and WHERE clauses unchanged.
    // OUTAGE-ROUNDS SCLS (US-004) deliberately added `preclaim_death_count = 0`
    // to every successful claim SET list (a successful claim resets the
    // streak); the ownership/instant columns and the WHERE clauses are
    // otherwise unchanged.
    assert.ok(
      code.includes(
        "SET status = 'running', preclaim_death_count = 0, claim_job_id = ?, claim_pid = ?, claim_pgid = ?, claim_invalidated_by = NULL, claim_updated_at = ${SQL_NOW_ISO}, updated_at = ${SQL_NOW_ISO} WHERE id = ? AND status = 'pending'",
      ),
      "claim statement shape must be preserved",
    );
    assert.ok(
      code.includes("UPDATE steps SET status = 'done', updated_at = ${SQL_NOW_ISO} WHERE id = ?"),
      "complete statement shape must be preserved",
    );
    assert.ok(
      code.includes("UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?"),
      "fail statement shape must be preserved",
    );
  });

  it("preserves the writer distribution of the naive-instant baseline", () => {
    // Parent baseline: 127 SQL_NOW_ISO occurrences = 122 updated_at
    // assignments (including the 3 PKIL paused_by_operator recovery writers
    // added on top of the original 119), 3 claim_updated_at assignments
    // co-located with 3 of those updated_at assignments, and 2
    // story_abandonments created_at inserts.
    const code = stripComments(readStepOps());
    const totalInterpolations = code.match(/\$\{SQL_NOW_ISO\}/g) ?? [];
    const claimUpdated = code.match(/claim_updated_at = \$\{SQL_NOW_ISO\}/g) ?? [];
    const createdInserts = code.match(/created_at\) VALUES \([^)]*\$\{SQL_NOW_ISO\}/g) ?? [];
    const updatedAt = code.match(/updated_at = \$\{SQL_NOW_ISO\}/g) ?? []; // includes claim_updated_at
    assert.equal(totalInterpolations.length, 127);
    assert.equal(claimUpdated.length, 3);
    assert.equal(createdInserts.length, 2);
    assert.equal(updatedAt.length, 125);
  });

});
