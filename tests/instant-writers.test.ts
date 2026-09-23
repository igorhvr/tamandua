/**
 * TIME-STORAGE US-003 — non-step-ops SQL writers persist the ONE instant format.
 *
 * Two halves:
 *  1. Comment-blind source scan — the five converted files contain no
 *     `datetime('now')` writer, every one of them interpolates the shared
 *     `SQL_NOW_ISO` fragment, the medic `checked_at` window is a numeric
 *     `julianday` comparison (no lexical `datetime('now', ...)` cutoff), and
 *     the intentionally-skipped `julianday('now')` comparisons are left
 *     untouched.
 *  2. Behavioral — the real writer SQL text is read out of each source file,
 *     rendered with the shared `SQL_NOW_ISO` fragment, executed against a real
 *     SQLite database, and the persisted `updated_at` is asserted to match the
 *     canonical ISO-8601 UTC-with-milliseconds-and-Z shape.
 *
 * This file is pure (fs + node:sqlite through dist/db.js + dist/lib/*), so it
 * belongs to the parallel lane; it intentionally does NOT import the
 * process-spawning writer modules.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTempHome } from "./helpers/test-env.ts";
import { stripComments } from "../dist/lib/comment-blind.js";
import { SQL_NOW_ISO } from "../dist/lib/instant.js";
import { getDb } from "../dist/db.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ISO_MS_Z = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

const CONVERTED_FILES = [
  "src/server/control-server.ts",
  "src/installer/run.ts",
  "src/installer/status.ts",
  "src/medic/medic.ts",
  "src/installer/agent-scheduler.ts",
];

function readSource(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

describe("US-003 instant writers: comment-blind source scan", () => {
  for (const rel of CONVERTED_FILES) {
    it(`${rel} contains no datetime('now') writer`, () => {
      const code = stripComments(readSource(rel));
      const hits = code.match(/datetime\('now'\)/g) ?? [];
      assert.deepEqual(
        hits,
        [],
        `${rel} must interpolate SQL_NOW_ISO instead of writing datetime('now')`,
      );
    });
  }

  it("every converted file interpolates the shared SQL_NOW_ISO fragment", () => {
    for (const rel of CONVERTED_FILES) {
      const code = stripComments(readSource(rel));
      assert.ok(
        code.includes("SQL_NOW_ISO"),
        `${rel} must use the shared SQL_NOW_ISO fragment`,
      );
    }
  });

  it("uses the numeric medic checked_at window and keeps the julianday comparisons", () => {
    const medic = stripComments(readSource("src/medic/medic.ts"));
    assert.ok(
      medic.includes("WHERE julianday(checked_at) > julianday('now', '-24 hours')"),
      "the medic checked_at 24h window must be a numeric julianday comparison",
    );
    assert.ok(
      !medic.includes("checked_at > datetime('now', '-24 hours')"),
      "the lexical medic checked_at window must be gone",
    );
    assert.equal(
      (medic.match(/julianday\('now'\)/g) ?? []).length,
      2,
      "both medic julianday('now') comparisons must remain unchanged",
    );
  });
});

/**
 * Extract exactly one backtick-delimited SQL statement containing `marker`
 * from a source file. The writer statements contain no nested backticks, so a
 * simple backtick-pair scan is sufficient and keeps the behavioral test tied
 * to the real statement text rather than a hand-copied duplicate.
 */
function extractWriterSql(rel: string, marker: string): string {
  const found = [...readSource(rel).matchAll(/`([^`]*)`/g)]
    .map((m) => m[1])
    .filter((statement) => statement.includes(marker));
  assert.equal(
    found.length,
    1,
    `expected exactly one backtick SQL containing "${marker}" in ${rel}`,
  );
  return found[0];
}

describe("US-003 instant writers: persisted format", () => {
  const { homeDir, tamanduaDir } = createTempHome("tamandua-instant-writers-");
  process.env.HOME = homeDir;
  process.env.TAMANDUA_STATE_DIR = tamanduaDir;
  process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");

  const LEGACY_NAIVE = "2026-01-01 00:00:00";

  function seedRun(id: string): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 'instant-writers-wf', 'task', 'running', '{}', ?, ?)`,
    ).run(id, LEGACY_NAIVE, LEGACY_NAIVE);
  }

  function updatedAt(id: string): string {
    const db = getDb();
    const row = db
      .prepare("SELECT updated_at FROM runs WHERE id = ?")
      .get(id) as { updated_at: string } | undefined;
    assert.ok(row, `run row ${id} must exist`);
    return row.updated_at;
  }

  const REPRESENTATIVE_WRITERS: Array<{
    name: string;
    file: string;
    marker: string;
    params: unknown[];
  }> = [
    {
      name: "status.forceFailRun",
      file: "src/installer/status.ts",
      marker: "UPDATE runs SET status = 'failed', scheduling_status = NULL",
      params: [],
    },
    {
      name: "medic.remediate fail_run",
      file: "src/medic/medic.ts",
      marker: "UPDATE runs SET status = 'failed', updated_at",
      params: [],
    },
    {
      name: "agent-scheduler.incrementRunTokenSpend",
      file: "src/installer/agent-scheduler.ts",
      marker: "UPDATE runs SET tokens_spent = tokens_spent + ?",
      params: [7],
    },
  ];

  for (const writer of REPRESENTATIVE_WRITERS) {
    it(`${writer.name} persists updated_at as ISO-8601 UTC with ms and Z`, () => {
      const sql = extractWriterSql(writer.file, writer.marker);
      assert.ok(
        sql.includes("${SQL_NOW_ISO}"),
        `${writer.name} must interpolate SQL_NOW_ISO`,
      );
      assert.ok(
        !sql.includes("datetime('now')"),
        `${writer.name} must not write datetime('now')`,
      );

      const rendered = sql.replace("${SQL_NOW_ISO}", SQL_NOW_ISO);
      const runId = `run-${writer.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
      seedRun(runId);
      assert.equal(updatedAt(runId), LEGACY_NAIVE, "precondition: legacy naive value");

      getDb().prepare(rendered).run(...writer.params, runId);

      const persisted = updatedAt(runId);
      assert.match(
        persisted,
        ISO_MS_Z,
        `${writer.name} must persist ISO-Z updated_at, got ${persisted}`,
      );
      const epoch = Date.parse(persisted);
      assert.ok(Number.isFinite(epoch), `${writer.name} persisted a parseable instant`);
      assert.ok(
        Math.abs(Date.now() - epoch) < 10_000,
        `${writer.name} persisted a fresh instant, got ${persisted}`,
      );
    });
  }
});
