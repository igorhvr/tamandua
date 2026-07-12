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
  const root = tamanduaTempDir("tamandua-claim-invalidated-");
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
      console.log(JSON.stringify({ cols }));
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

describe("claim_invalidated_by column migration", () => {
  it("migrates legacy steps schema to include claim_invalidated_by column as nullable TEXT", () => {
    const temp = createTempHome();

    try {
      const dbDir = path.join(temp.homeDir, ".tamandua");
      const dbPath = path.join(dbDir, "tamandua.db");
      fs.mkdirSync(dbDir, { recursive: true });

      const legacyDb = new DatabaseSync(dbPath);
      // Create a minimal schema mimicking pre-claim_invalidated_by steps + required runs table
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
          claim_job_id TEXT,
          claim_pid INTEGER,
          claim_pgid INTEGER,
          claim_updated_at TEXT,
          reroute_count INTEGER DEFAULT 0,
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

      // Check claim_invalidated_by column exists
      const claimInvalidated = cols.find((c) => c.name === "claim_invalidated_by");
      assert.ok(claimInvalidated, "claim_invalidated_by column should exist after migration");
      assert.equal(claimInvalidated.notnull, 0, "claim_invalidated_by should be nullable");
      assert.equal(claimInvalidated.dflt_value, null, "claim_invalidated_by should default to NULL (no default)");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("legacy rows have claim_invalidated_by = NULL after migration", () => {
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
          claim_job_id TEXT,
          claim_pid INTEGER,
          claim_pgid INTEGER,
          claim_updated_at TEXT,
          reroute_count INTEGER DEFAULT 0,
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

      const result = runMigrationScript(temp.homeDir);

      // Run a query to check the legacy row's value
      const queryResult = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", `
          import { getDb } from "./dist/db.js";
          const db = getDb();
          const row = db.prepare("SELECT claim_invalidated_by FROM steps WHERE id = ?").get("s1");
          console.log(JSON.stringify(row));
        `],
        {
          cwd: repoRoot,
          env: cleanChildEnv({ HOME: temp.homeDir }),
          encoding: "utf-8",
        },
      );

      assert.equal(queryResult.status, 0, `query script failed: ${queryResult.stderr}`);
      const row = JSON.parse(queryResult.stdout.trim().split(/\r?\n/).filter(Boolean).pop()!) as { claim_invalidated_by: string | null };
      assert.equal(row.claim_invalidated_by, null, "legacy row should have claim_invalidated_by = NULL");
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
          claim_job_id TEXT,
          claim_pid INTEGER,
          claim_pgid INTEGER,
          claim_updated_at TEXT,
          reroute_count INTEGER DEFAULT 0,
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
      const claimInvalidated = cols.find((c) => c.name === "claim_invalidated_by");
      assert.ok(claimInvalidated, "claim_invalidated_by should still exist after second migration");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("new rows inserted after migration default to claim_invalidated_by = NULL", () => {
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
          claim_job_id TEXT,
          claim_pid INTEGER,
          claim_pgid INTEGER,
          claim_updated_at TEXT,
          reroute_count INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      legacyDb.close();

      // Run migration then insert new row
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
          const row = db.prepare("SELECT claim_invalidated_by FROM steps WHERE id = ?").get("new-step");
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

      const row = JSON.parse(migrateResult.stdout.trim().split(/\r?\n/).filter(Boolean).pop()!) as { claim_invalidated_by: string | null };
      assert.equal(row.claim_invalidated_by, null, "newly inserted row should have claim_invalidated_by = NULL");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });
});
