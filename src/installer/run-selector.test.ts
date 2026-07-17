import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";

let tempRoot: string;
let originalDbPath: string | undefined;
let originalHome: string | undefined;
let db: DatabaseSync;

function setupDb(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA journal_mode=WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL DEFAULT 'test',
      task TEXT NOT NULL DEFAULT 'test',
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // Insert into the legacy tamandua_stats to satisfy schema checks
  database.exec(`
    CREATE TABLE IF NOT EXISTS tamandua_stats (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      system_tokens_spent INTEGER NOT NULL DEFAULT 0
    );
  `);
  database.exec("INSERT OR IGNORE INTO tamandua_stats (id, system_tokens_spent) VALUES (1, 0)");
  return database;
}

function insertRun(id: string, runNumber: number, status: string): void {
  db.prepare(
    "INSERT INTO runs (id, run_number, workflow_id, task, status, tokens_spent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))",
  ).run(id, runNumber, "feature-dev", "Task for " + id, status);
}

describe("resolveRunSelectors", () => {
  beforeEach(() => {
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    originalHome = process.env.HOME;
    tempRoot = tamanduaTempDir("tamandua-run-selector-");
    const dbPath = path.join(tempRoot, ".tamandua", "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.HOME = tempRoot;
    db = setupDb(dbPath);
  });

  afterEach(() => {
    if (originalDbPath) process.env.TAMANDUA_DB_PATH = originalDbPath;
    else delete process.env.TAMANDUA_DB_PATH;
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("resolves full UUID to that run", async () => {
    const { resolveRunSelectors } = await import("../../dist/installer/run-selector.js");
    insertRun("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "running");
    insertRun("11111111-2222-3333-4444-555555555555", 2, "running");

    const result = resolveRunSelectors(["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]);
    assert.deepEqual(result.runIds, ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]);
    assert.equal(result.warnings, undefined);
  });

  it("resolves unambiguous prefix to the single matching run", async () => {
    const { resolveRunSelectors } = await import("../../dist/installer/run-selector.js");
    insertRun("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "running");
    insertRun("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", 2, "running");

    const result = resolveRunSelectors(["aaaaaaa"]);
    assert.deepEqual(result.runIds, ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]);
  });

  it("throws for ambiguous prefix listing all matches", async () => {
    const { resolveRunSelectors } = await import("../../dist/installer/run-selector.js");
    insertRun("aaaaaaaa-1111-4ccc-8ddd-eeeeeeeeeeee", 1, "running");
    insertRun("aaaaaaaa-2222-4ccc-8ddd-eeeeeeeeeeee", 2, "running");

    assert.throws(
      () => resolveRunSelectors(["aaaaaaaa"]),
      (err: Error) => {
        const msg = err.message;
        return (
          msg.includes("Ambiguous selector") &&
          msg.includes("aaaaaaaa-1111") &&
          msg.includes("aaaaaaaa-2222")
        );
      },
    );
  });

  it("throws with clear message for not-found selector", async () => {
    const { resolveRunSelectors } = await import("../../dist/installer/run-selector.js");
    insertRun("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "running");

    assert.throws(
      () => resolveRunSelectors(["nonexistent-run"]),
      /No run found matching "nonexistent-run"/,
    );
  });

  it("resolves #N to the run with that run_number", async () => {
    const { resolveRunSelectors } = await import("../../dist/installer/run-selector.js");
    insertRun("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "running");
    insertRun("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", 42, "running");

    const result = resolveRunSelectors(["#42"]);
    assert.deepEqual(result.runIds, ["bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"]);
  });

  it("throws for #N with no matching run_number", async () => {
    const { resolveRunSelectors } = await import("../../dist/installer/run-selector.js");
    insertRun("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "running");

    assert.throws(
      () => resolveRunSelectors(["#999"]),
      /No run found with run number: #999/,
    );
  });

  it("with --all returns all non-terminal (running, paused) runs", async () => {
    const { resolveRunSelectors } = await import("../../dist/installer/run-selector.js");
    insertRun("run-1-active", 1, "running");
    insertRun("run-2-paused", 2, "paused");
    insertRun("run-3-done", 3, "completed");
    insertRun("run-4-failed", 4, "failed");
    insertRun("run-5-canceled", 5, "canceled");

    const result = resolveRunSelectors([], { all: true });
    assert.deepEqual(result.runIds.sort(), ["run-1-active", "run-2-paused"].sort());
  });

  it("--all returns empty when all runs are terminal", async () => {
    const { resolveRunSelectors } = await import("../../dist/installer/run-selector.js");
    insertRun("run-1-done", 1, "completed");
    insertRun("run-2-failed", 2, "failed");

    const result = resolveRunSelectors([], { all: true });
    assert.deepEqual(result.runIds, []);
  });

  it("multiple selectors resolve to union of all matched run IDs", async () => {
    const { resolveRunSelectors } = await import("../../dist/installer/run-selector.js");
    insertRun("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "running");
    insertRun("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", 2, "running");
    insertRun("cccccccc-dddd-4eee-8fff-111111111111", 3, "running");

    const result = resolveRunSelectors([
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "bbbbbbbb",
      "#3",
    ]);
    assert.deepEqual(result.runIds.sort(), [
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      "cccccccc-dddd-4eee-8fff-111111111111",
    ].sort());
  });

  it("multiple selectors deduplicate overlapping matches", async () => {
    const { resolveRunSelectors } = await import("../../dist/installer/run-selector.js");
    insertRun("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "running");

    const result = resolveRunSelectors([
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "aaaaaaaa",
      "#1",
    ]);
    assert.deepEqual(result.runIds, ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]);
  });

  it("--all combined with explicit selectors includes both", async () => {
    const { resolveRunSelectors } = await import("../../dist/installer/run-selector.js");
    insertRun("run-active", 1, "running");
    insertRun("run-paused", 2, "paused");
    insertRun("run-done", 3, "completed");

    const result = resolveRunSelectors(["run-done"], { all: true });
    assert.deepEqual(result.runIds.sort(), ["run-active", "run-done", "run-paused"].sort());
  });

  it("throws immediately on first bad selector even if others are valid", async () => {
    const { resolveRunSelectors } = await import("../../dist/installer/run-selector.js");
    insertRun("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "running");

    assert.throws(
      () => resolveRunSelectors([
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        "nonexistent",
      ]),
      /No run found matching "nonexistent"/,
    );
  });

  it("empty selectors without --all returns empty", async () => {
    const { resolveRunSelectors } = await import("../../dist/installer/run-selector.js");
    insertRun("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1, "running");

    const result = resolveRunSelectors([]);
    assert.deepEqual(result.runIds, []);
    assert.equal(result.warnings, undefined);
  });
});
