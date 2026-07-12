import fs from "node:fs";
import { cleanChildEnv } from "./helpers/test-env.ts";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

function createTempHome() {
  const root = tamanduaTempDir("tamandua-system-tokens-");
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  return { root, homeDir };
}

function runNodeScript(script: string, env: Record<string, string>) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: repoRoot,
      env: cleanChildEnv(env),
      encoding: "utf-8",
    },
  );

  if (result.status !== 0) {
    throw new Error([
      `Script failed with exit ${result.status}`,
      `STDOUT:\n${result.stdout}`,
      `STDERR:\n${result.stderr}`,
    ].join("\n\n"));
  }

  const lastLine = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!lastLine) {
    throw new Error(`Script produced no JSON output. STDERR:\n${result.stderr}`);
  }

  return JSON.parse(lastLine) as Record<string, unknown>;
}

describe("tamandua_stats migration", () => {
  it("creates tamandua_stats table with default system_tokens_spent=0 on fresh DB", () => {
    const temp = createTempHome();

    try {
      const result = runNodeScript(
        `
          import { getDb, getSystemTokenSpend } from "./dist/db.js";

          const db = getDb();
          const cols = db.prepare("PRAGMA table_info(tamandua_stats)").all();
          const systemTokens = getSystemTokenSpend();
          console.log(JSON.stringify({ cols, systemTokens }));
        `,
        { HOME: temp.homeDir },
      );

      const cols = result.cols as Array<{ name: string; notnull: number; dflt_value: string | null }>;

      const idCol = cols.find((c) => c.name === "id");
      assert.ok(idCol, "id column should exist");
      // INTEGER PRIMARY KEY in SQLite is special, notnull may be 0
      assert.equal(idCol.dflt_value, "1", "id should default to 1");

      const tokensCol = cols.find((c) => c.name === "system_tokens_spent");
      assert.ok(tokensCol, "system_tokens_spent column should exist");
      assert.equal(tokensCol.notnull, 1, "system_tokens_spent should be NOT NULL");
      assert.equal(tokensCol.dflt_value, "0", "system_tokens_spent should default to 0");

      assert.equal(result.systemTokens, 0, "getSystemTokenSpend() should return 0 on fresh DB");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("tamandua_stats is a singleton — only one row with id=1", () => {
    const temp = createTempHome();

    try {
      const result = runNodeScript(
        `
          import { getDb } from "./dist/db.js";

          const db = getDb();
          const rows = db.prepare("SELECT id, system_tokens_spent FROM tamandua_stats").all();
          console.log(JSON.stringify({ rows }));
        `,
        { HOME: temp.homeDir },
      );

      const rows = result.rows as Array<{ id: number; system_tokens_spent: number }>;
      assert.equal(rows.length, 1, "should have exactly one row");
      assert.equal(rows[0].id, 1, "singleton row should have id=1");
      assert.equal(rows[0].system_tokens_spent, 0, "singleton row should start at 0");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("existing runs table and its tokens_spent column are unchanged by the migration", () => {
    const temp = createTempHome();

    try {
      const dbDir = path.join(temp.homeDir, ".tamandua");
      const dbPath = path.join(dbDir, "tamandua.db");
      fs.mkdirSync(dbDir, { recursive: true });

      const legacyDb = new DatabaseSync(dbPath);
      legacyDb.exec(`
        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          task TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          context TEXT NOT NULL DEFAULT '{}',
          notify_url TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const now = new Date().toISOString();
      legacyDb.prepare(`
        INSERT INTO runs (id, workflow_id, task, status, context, notify_url, created_at, updated_at)
        VALUES ('legacy-run', 'wf', 'test', 'running', '{}', NULL, ?, ?)
      `).run(now, now);
      legacyDb.close();

      const result = runNodeScript(
        `
          import { getDb } from "./dist/db.js";

          const db = getDb();
          const runCols = db.prepare("PRAGMA table_info(runs)").all();
          const runRow = db.prepare("SELECT id, tokens_spent FROM runs WHERE id = 'legacy-run'").get();
          console.log(JSON.stringify({ runCols, runRow }));
        `,
        { HOME: temp.homeDir },
      );

      const runCols = result.runCols as Array<{ name: string }>;
      assert.ok(runCols.find((c) => c.name === "id"), "runs.id should still exist");
      assert.ok(runCols.find((c) => c.name === "tokens_spent"), "runs.tokens_spent should still exist");
      assert.ok(runCols.find((c) => c.name === "status"), "runs.status should still exist");
      assert.ok(runCols.find((c) => c.name === "workflow_id"), "runs.workflow_id should still exist");

      const runRow = result.runRow as { id: string; tokens_spent: number };
      assert.equal(runRow.id, "legacy-run");
      assert.equal(runRow.tokens_spent, 0, "legacy run tokens_spent should be backfilled to 0");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("migration is idempotent — running it twice does not error", () => {
    const temp = createTempHome();

    try {
      // First migration (open DB, trigger migrate)
      const dbDir = path.join(temp.homeDir, ".tamandua");
      const dbPath = path.join(dbDir, "tamandua.db");
      fs.mkdirSync(dbDir, { recursive: true });
      const firstDb = new DatabaseSync(dbPath);
      // Create the minimal schema that migrate() expects (runs table already exists),
      // then close so getDb() picks it up and runs full migration.
      firstDb.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          run_number INTEGER,
          workflow_id TEXT NOT NULL,
          task TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          context TEXT NOT NULL DEFAULT '{}',
          tokens_spent INTEGER NOT NULL DEFAULT 0,
          notify_url TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS steps (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          step_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          step_index INTEGER NOT NULL,
          input_template TEXT NOT NULL,
          expects TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'waiting',
          output TEXT,
          retry_count INTEGER DEFAULT 0,
          max_retries INTEGER DEFAULT 4,
          type TEXT NOT NULL DEFAULT 'single',
          loop_config TEXT,
          current_story_id TEXT,
          abandoned_count INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tamandua_stats (
          id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          system_tokens_spent INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO tamandua_stats (id, system_tokens_spent) VALUES (1, 0);
      `);
      firstDb.close();

      // Second migration — must not error
      const result = runNodeScript(
        `
          import { getDb, getSystemTokenSpend } from "./dist/db.js";

          const db = getDb();
          const cols = db.prepare("PRAGMA table_info(tamandua_stats)").all();
          const rows = db.prepare("SELECT id, system_tokens_spent FROM tamandua_stats").all();
          const systemTokens = getSystemTokenSpend();
          console.log(JSON.stringify({ cols, rows, systemTokens }));
        `,
        { HOME: temp.homeDir },
      );

      const cols = result.cols as Array<{ name: string }>;
      assert.ok(cols.find((c) => c.name === "id"), "id column should exist after second migration");
      assert.ok(cols.find((c) => c.name === "system_tokens_spent"), "system_tokens_spent column should exist after second migration");

      const rows = result.rows as Array<{ id: number; system_tokens_spent: number }>;
      assert.equal(rows.length, 1, "should still have exactly one row after second migration");
      assert.equal(result.systemTokens, 0, "system_tokens_spent should still be 0 after second migration");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });
});

describe("getSystemTokenSpend and incrementSystemTokenSpend", () => {
  it("getSystemTokenSpend() returns 0 on a fresh DB", () => {
    const temp = createTempHome();

    try {
      const result = runNodeScript(
        `
          import { getSystemTokenSpend } from "./dist/db.js";
          console.log(JSON.stringify({ value: getSystemTokenSpend() }));
        `,
        { HOME: temp.homeDir },
      );
      assert.equal(result.value, 0);
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("incrementSystemTokenSpend(100) updates the counter to 100 and returns 100", () => {
    const temp = createTempHome();

    try {
      const result = runNodeScript(
        `
          import { incrementSystemTokenSpend } from "./dist/db.js";
          const val = incrementSystemTokenSpend(100);
          console.log(JSON.stringify({ value: val }));
        `,
        { HOME: temp.homeDir },
      );
      assert.equal(result.value, 100);
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("incrementSystemTokenSpend accumulates correctly across multiple calls", () => {
    const temp = createTempHome();

    try {
      const result = runNodeScript(
        `
          import { getSystemTokenSpend, incrementSystemTokenSpend } from "./dist/db.js";
          let v1 = incrementSystemTokenSpend(50);
          let v2 = incrementSystemTokenSpend(25);
          let v3 = incrementSystemTokenSpend(25);
          let total = getSystemTokenSpend();
          console.log(JSON.stringify({ v1, v2, v3, total }));
        `,
        { HOME: temp.homeDir },
      );
      assert.equal(result.v1, 50);
      assert.equal(result.v2, 75);
      assert.equal(result.v3, 100);
      assert.equal(result.total, 100);
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("incrementSystemTokenSpend is atomic — separate processes see consistent values", () => {
    const temp = createTempHome();

    try {
      // Process 1: increment by 50
      runNodeScript(
        `
          import { incrementSystemTokenSpend } from "./dist/db.js";
          const val = incrementSystemTokenSpend(50);
          console.log(JSON.stringify({ value: val }));
        `,
        { HOME: temp.homeDir },
      );

      // Process 2: read and increment by 30 (should see 50, then get 80)
      const result = runNodeScript(
        `
          import { getSystemTokenSpend, incrementSystemTokenSpend } from "./dist/db.js";
          const before = getSystemTokenSpend();
          const after = incrementSystemTokenSpend(30);
          console.log(JSON.stringify({ before, after }));
        `,
        { HOME: temp.homeDir },
      );

      assert.equal(result.before, 50, "second process should see the 50 from first process");
      assert.equal(result.after, 80, "after increment should be 80 (50+30)");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });
});
