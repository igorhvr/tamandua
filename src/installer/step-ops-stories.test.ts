import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { parseAndInsertStories } from "../../dist/installer/step-ops.js";

describe("parseAndInsertStories", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let originalDbPath: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    originalHome = process.env.HOME;
    tempDir = tamanduaTempDir("tamandua-stories-");
    dbPath = path.join(tempDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.HOME = tempDir;

    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        context TEXT NOT NULL DEFAULT '{}',
        tokens_spent INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stories (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        story_index INTEGER NOT NULL,
        story_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        acceptance_criteria TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        output TEXT,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 4,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("test-run-1", "test-wf", "test task", "running", "{}",
      new Date().toISOString(), new Date().toISOString()
    );
  });

  afterEach(() => {
    if (originalDbPath) process.env.TAMANDUA_DB_PATH = originalDbPath;
    else delete process.env.TAMANDUA_DB_PATH;
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    try { db.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses STORIES_JSON and inserts stories into DB", () => {
    const output = `SOME_KEY: value
STORIES_JSON: [
  {
    "id": "US-001",
    "title": "Login page",
    "description": "Build login",
    "acceptanceCriteria": ["AC1", "AC2"]
  },
  {
    "id": "US-002",
    "title": "Dashboard",
    "description": "Build dashboard",
    "acceptanceCriteria": ["Show stats"]
  }
]
OTHER_KEY: after`;

    parseAndInsertStories(output, "test-run-1");

    const rows = db.prepare(
      "SELECT story_id, title, description, acceptance_criteria, status, story_index FROM stories WHERE run_id = ? ORDER BY story_index ASC"
    ).all("test-run-1") as Array<{
      story_id: string; title: string; description: string;
      acceptance_criteria: string; status: string; story_index: number;
    }>;

    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.story_id, "US-001");
    assert.equal(rows[0]!.status, "pending");
    assert.equal(rows[0]!.story_index, 0);
    assert.equal(rows[1]!.story_id, "US-002");
  });

  it("returns early when no STORIES_JSON line exists", () => {
    parseAndInsertStories("NO_STORIES: blah\n", "test-run-1");
    const row = db.prepare("SELECT COUNT(*) as cnt FROM stories WHERE run_id = ?").get("test-run-1") as { cnt: number };
    assert.equal(row.cnt, 0);
  });

  it("throws on invalid JSON", () => {
    assert.throws(
      () => parseAndInsertStories("STORIES_JSON: not json\n", "test-run-1"),
      /Failed to parse STORIES_JSON/,
    );
  });

  it("throws when STORIES_JSON is not an array", () => {
    assert.throws(
      () => parseAndInsertStories('STORIES_JSON: {"id": "x"}\n', "test-run-1"),
      /STORIES_JSON must be an array/,
    );
  });

  it("throws when exceeding max 20 stories", () => {
    const stories = Array.from({ length: 21 }, (_, i) => ({
      id: `US-${String(i).padStart(3, "0")}`,
      title: `S${i}`,
      description: `D${i}`,
      acceptanceCriteria: ["AC1"],
    }));
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, "test-run-1"),
      /max is 20/,
    );
  });

  it("throws on missing required story fields", () => {
    assert.throws(
      () => parseAndInsertStories('STORIES_JSON: [{"id": "US-001"}]\n', "test-run-1"),
      /missing required fields/,
    );
  });

  it("throws on duplicate story IDs", () => {
    const output = 'STORIES_JSON: [{"id":"US-001","title":"A","description":"A","acceptanceCriteria":["AC1"]},{"id":"US-001","title":"B","description":"B","acceptanceCriteria":["AC2"]}]\n';
    assert.throws(
      () => parseAndInsertStories(output, "test-run-1"),
      /duplicate story id/,
    );
  });

  it("handles multi-line STORIES_JSON with next KEY: boundary", () => {
    const output = `STORIES_JSON:
[
  {"id": "US-003", "title": "T", "description": "D", "acceptanceCriteria": ["AC1"]}
]
NEXT_KEY: val`;

    parseAndInsertStories(output, "test-run-1");
    const row = db.prepare("SELECT story_id FROM stories WHERE run_id = ?").get("test-run-1") as { story_id: string } | undefined;
    assert.ok(row);
    assert.equal(row!.story_id, "US-003");
  });
});
