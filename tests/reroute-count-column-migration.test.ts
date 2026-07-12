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
  const root = tamanduaTempDir("tamandua-reroute-count-");
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  return { root, homeDir };
}

function runMigrationScript(homeDir: string) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `
      import { getDb } from "./dist/db.js";

      const db = getDb();
      const cols = db.prepare("PRAGMA table_info(steps)").all();
      const rows = db.prepare("SELECT id, reroute_count FROM steps").all();
      console.log(JSON.stringify({ cols, rows }));
    `],
    {
      cwd: repoRoot,
      env: cleanChildEnv({ HOME: homeDir }),
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

describe("reroute_count column migration", () => {
  it("migrates legacy steps schema to include reroute_count column with default 0", () => {
    const temp = createTempHome();

    try {
      const dbDir = path.join(temp.homeDir, ".tamandua");
      const dbPath = path.join(dbDir, "tamandua.db");
      fs.mkdirSync(dbDir, { recursive: true });

      const legacyDb = new DatabaseSync(dbPath);
      // Create a minimal schema mimicking pre-reroute steps + required runs table
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

        CREATE TABLE steps (
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
      `);
      const now = new Date().toISOString();
      legacyDb.prepare(`
        INSERT INTO runs (id, workflow_id, task, status, context, notify_url, created_at, updated_at)
        VALUES ('legacy-run', 'wf', 'task', 'running', '{}', NULL, ?, ?)
      `).run(now, now);
      legacyDb.prepare(`
        INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
        VALUES ('legacy-step', 'legacy-run', 'implement', 'dev', 1, 'Implement', 'STATUS', 'pending', ?, ?)
      `).run(now, now);
      legacyDb.close();

      const result = runMigrationScript(temp.homeDir);

      const cols = result.cols as Array<{ name: string; notnull: number; dflt_value: string | null }>;

      // Check reroute_count column exists
      const rerouteCount = cols.find((c) => c.name === "reroute_count");
      assert.ok(rerouteCount, "reroute_count column should exist after migration");
      assert.equal(rerouteCount.notnull, 0, "reroute_count should be nullable");
      assert.equal(rerouteCount.dflt_value, "0", "reroute_count should default to 0");

      // Check legacy row has default value (0)
      const rows = result.rows as Array<{ id: string; reroute_count: number }>;
      assert.equal(rows.length, 1, "should have one step row");
      assert.equal(rows[0].id, "legacy-step");
      assert.equal(rows[0].reroute_count, 0, "legacy reroute_count should be 0");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("migration is idempotent — running it twice does not error", () => {
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
        CREATE TABLE steps (
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
      `);
      const now = new Date().toISOString();
      legacyDb.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, notify_url, created_at, updated_at) VALUES ('r1', 'wf', 'task', 'running', '{}', NULL, ?, ?)"
      ).run(now, now);
      legacyDb.prepare(
        "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES ('s1', 'r1', 's', 'a', 1, 'x', 'y', 'pending', ?, ?)"
      ).run(now, now);
      legacyDb.close();

      // First migration
      runMigrationScript(temp.homeDir);

      // Second migration — must not error
      const result = runMigrationScript(temp.homeDir);

      const cols = result.cols as Array<{ name: string }>;
      const rerouteCount = cols.find((c) => c.name === "reroute_count");
      assert.ok(rerouteCount, "reroute_count should still exist after second migration");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("new rows inserted after migration default to reroute_count=0", () => {
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
        CREATE TABLE steps (
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
      `);
      legacyDb.close();

      // Run migration
      const migrateResult = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", `
          import { getDb } from "./dist/db.js";

          const db = getDb();
          const now = new Date().toISOString();
          db.prepare("INSERT INTO runs (id, workflow_id, task, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
            .run("new-run", "wf", "task", now, now);
          db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run("new-step", "new-run", "s1", "a1", 1, "x", "y", "pending", now, now);
          const row = db.prepare("SELECT reroute_count FROM steps WHERE id = ?").get("new-step");
          console.log(JSON.stringify(row));
        `],
        {
          cwd: repoRoot,
          env: cleanChildEnv({ HOME: temp.homeDir }),
          encoding: "utf-8",
        },
      );

      if (migrateResult.status !== 0) {
        throw new Error(`Migration script failed: ${migrateResult.stderr}`);
      }

      const row = JSON.parse(migrateResult.stdout.trim().split(/\r?\n/).filter(Boolean).pop()!) as { reroute_count: number };
      assert.equal(row.reroute_count, 0, "newly inserted row should have reroute_count=0 by default");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });
});
