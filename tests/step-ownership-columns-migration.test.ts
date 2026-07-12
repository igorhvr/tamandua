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
  const root = tamanduaTempDir("tamandua-step-ownership-");
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
      const rows = db.prepare("SELECT id, claim_job_id, claim_pid, claim_pgid, claim_updated_at FROM steps").all();
      console.log(JSON.stringify({ cols, rows }));
    `],
    {
      cwd: repoRoot,
      env: cleanChildEnv({ HOME: homeDir  }),
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

describe("step ownership columns migration", () => {
  it("migrates legacy steps schema to include ownership columns with NULL defaults", () => {
    const temp = createTempHome();

    try {
      const dbDir = path.join(temp.homeDir, ".tamandua");
      const dbPath = path.join(dbDir, "tamandua.db");
      fs.mkdirSync(dbDir, { recursive: true });

      const legacyDb = new DatabaseSync(dbPath);
      // Create a minimal schema mimicking pre-ownership steps + required runs table
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

      // Check all four columns exist
      const claimJobId = cols.find((c) => c.name === "claim_job_id");
      assert.ok(claimJobId, "claim_job_id column should exist after migration");
      assert.equal(claimJobId.notnull, 0, "claim_job_id should be nullable");
      assert.equal(claimJobId.dflt_value, null, "claim_job_id should default to NULL");

      const claimPid = cols.find((c) => c.name === "claim_pid");
      assert.ok(claimPid, "claim_pid column should exist after migration");
      assert.equal(claimPid.notnull, 0, "claim_pid should be nullable");
      assert.equal(claimPid.dflt_value, null, "claim_pid should default to NULL");

      const claimPgid = cols.find((c) => c.name === "claim_pgid");
      assert.ok(claimPgid, "claim_pgid column should exist after migration");
      assert.equal(claimPgid.notnull, 0, "claim_pgid should be nullable");
      assert.equal(claimPgid.dflt_value, null, "claim_pgid should default to NULL");

      const claimUpdatedAt = cols.find((c) => c.name === "claim_updated_at");
      assert.ok(claimUpdatedAt, "claim_updated_at column should exist after migration");
      assert.equal(claimUpdatedAt.notnull, 0, "claim_updated_at should be nullable");
      assert.equal(claimUpdatedAt.dflt_value, null, "claim_updated_at should default to NULL");

      // Check legacy row has NULL values for new columns (no data loss)
      const rows = result.rows as Array<{
        id: string; claim_job_id: null; claim_pid: null;
        claim_pgid: null; claim_updated_at: null;
      }>;
      assert.equal(rows.length, 1, "should have one step row");
      assert.equal(rows[0].id, "legacy-step");
      assert.equal(rows[0].claim_job_id, null, "legacy claim_job_id should be NULL");
      assert.equal(rows[0].claim_pid, null, "legacy claim_pid should be NULL");
      assert.equal(rows[0].claim_pgid, null, "legacy claim_pgid should be NULL");
      assert.equal(rows[0].claim_updated_at, null, "legacy claim_updated_at should be NULL");
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
      const claimJobId = cols.find((c) => c.name === "claim_job_id");
      assert.ok(claimJobId, "claim_job_id should still exist after second migration");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });
});
