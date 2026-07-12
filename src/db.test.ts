import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTempHome } from "../tests/helpers/test-env.ts";

// We test the migration by directly importing getDb, which calls migrate().
// But since getDb() uses a cached connection and resolves DB path from
// env/home, we test the migration logic directly with an isolated DB.
import { getDb, getDbPath, getSystemTokenSpend, incrementSystemTokenSpend, upsertAutoresearchSession, getAutoresearchSessions, getAutoresearchSessionById, deleteAutoresearchSession, pruneOldSuiteResults } from "../dist/db.js";

describe("PRAGMA synchronous", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  const th = createTempHome("tamandua-db-sync-test-");
  before(() => {
    tempHome = th.root;
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = th.homeDir;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  it("reports synchronous=NORMAL (1) after getDb() opens a connection", () => {
    const db = getDb();
    const row = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
    assert.equal(row.synchronous, 1, "synchronous should be 1 (NORMAL)");
  });
});

describe("run_worktrees table migration", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  const th = createTempHome("tamandua-db-test-");
  before(() => {
    tempHome = th.root;
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    // Isolate DB to temp directory by changing HOME
    process.env.HOME = th.homeDir;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  function columnNames(db: DatabaseSync, table: string): Set<string> {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(cols.map((c) => c.name));
  }

  function tableExists(db: DatabaseSync, table: string): boolean {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table);
    return row !== undefined;
  }

  it("creates run_worktrees table on first migration", () => {
    const db = getDb();
    assert.ok(tableExists(db, "run_worktrees"), "run_worktrees table should exist");
  });

  it("all required columns present with correct types", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(run_worktrees)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    const colMap = new Map(cols.map((c) => [c.name, c]));

    // Check each required column
    const runIdCol = colMap.get("run_id");
    assert.ok(runIdCol, "run_id column should exist");
    assert.equal(runIdCol.type, "TEXT", "run_id should be TEXT");
    assert.equal(runIdCol.pk, 1, "run_id should be PRIMARY KEY");

    const originRepoCol = colMap.get("worktree_origin_repository");
    assert.ok(originRepoCol, "worktree_origin_repository column should exist");
    assert.equal(originRepoCol.type, "TEXT", "worktree_origin_repository should be TEXT");

    const gitCommonDirCol = colMap.get("worktree_origin_git_common_dir");
    assert.ok(gitCommonDirCol, "worktree_origin_git_common_dir column should exist");
    assert.equal(gitCommonDirCol.type, "TEXT", "worktree_origin_git_common_dir should be TEXT");

    const worktreePathCol = colMap.get("worktree_path");
    assert.ok(worktreePathCol, "worktree_path column should exist");
    assert.equal(worktreePathCol.type, "TEXT", "worktree_path should be TEXT");

    const originRefCol = colMap.get("worktree_origin_ref");
    assert.ok(originRefCol, "worktree_origin_ref column should exist");
    assert.equal(originRefCol.type, "TEXT", "worktree_origin_ref should be TEXT");

    const originShaCol = colMap.get("worktree_origin_sha");
    assert.ok(originShaCol, "worktree_origin_sha column should exist");
    assert.equal(originShaCol.type, "TEXT", "worktree_origin_sha should be TEXT");

    const originalBranchCol = colMap.get("original_branch");
    assert.ok(originalBranchCol, "original_branch column should exist");
    assert.equal(originalBranchCol.type, "TEXT", "original_branch should be TEXT");

    const statusCol = colMap.get("status");
    assert.ok(statusCol, "status column should exist");
    assert.equal(statusCol.type, "TEXT", "status should be TEXT");

    const cleanupPolicyCol = colMap.get("cleanup_policy");
    assert.ok(cleanupPolicyCol, "cleanup_policy column should exist");
    assert.equal(cleanupPolicyCol.type, "TEXT", "cleanup_policy should be TEXT");

    const createdAtCol = colMap.get("created_at");
    assert.ok(createdAtCol, "created_at column should exist");
    assert.equal(createdAtCol.type, "TEXT", "created_at should be TEXT");

    const removedAtCol = colMap.get("removed_at");
    assert.ok(removedAtCol, "removed_at column should exist");
    assert.equal(removedAtCol.type, "TEXT", "removed_at should be TEXT");

    const errorCol = colMap.get("error");
    assert.ok(errorCol, "error column should exist");
    assert.equal(errorCol.type, "TEXT", "error should be TEXT");
  });

  it("has index on status column for list queries", () => {
    const db = getDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='run_worktrees'",
    ).all() as Array<{ name: string }>;

    const hasStatusIndex = indexes.some((idx) => idx.name === "idx_run_worktrees_status");
    assert.ok(hasStatusIndex, "should have idx_run_worktrees_status index");
  });

  it("existing DB tables unaffected by migration", () => {
    const db = getDb();
    // All existing tables should still be present
    assert.ok(tableExists(db, "runs"), "runs table should exist");
    assert.ok(tableExists(db, "steps"), "steps table should exist");
    assert.ok(tableExists(db, "stories"), "stories table should exist");
    assert.ok(tableExists(db, "tamandua_stats"), "tamandua_stats table should exist");

    // Core runs columns should still be present
    const runCols = columnNames(db, "runs");
    assert.ok(runCols.has("id"), "runs.id should exist");
    assert.ok(runCols.has("workflow_id"), "runs.workflow_id should exist");
    assert.ok(runCols.has("status"), "runs.status should exist");
    assert.ok(runCols.has("tokens_spent"), "runs.tokens_spent should exist");
    assert.ok(runCols.has("scheduling_status"), "runs.scheduling_status should exist");

    // Core steps columns should still be present
    const stepCols = columnNames(db, "steps");
    assert.ok(stepCols.has("id"), "steps.id should exist");
    assert.ok(stepCols.has("run_id"), "steps.run_id should exist");
    assert.ok(stepCols.has("agent_id"), "steps.agent_id should exist");
    assert.ok(stepCols.has("status"), "steps.status should exist");
    assert.ok(stepCols.has("claim_job_id"), "steps.claim_job_id should exist");

    // Core stories columns should still be present
    const storyCols = columnNames(db, "stories");
    assert.ok(storyCols.has("id"), "stories.id should exist");
    assert.ok(storyCols.has("run_id"), "stories.run_id should exist");
    assert.ok(storyCols.has("story_id"), "stories.story_id should exist");
    assert.ok(storyCols.has("status"), "stories.status should exist");

    // tamandua_stats should still be present
    const statsCols = columnNames(db, "tamandua_stats");
    assert.ok(statsCols.has("system_tokens_spent"), "tamandua_stats.system_tokens_spent should exist");
  });

  it("migration is idempotent (second call does nothing harmful)", () => {
    // Calling getDb() again will re-run migrate() on the same DB
    const db = getDb();

    // Table should still exist with no error
    assert.ok(tableExists(db, "run_worktrees"), "run_worktrees should still exist after second migration");

    // Should have exactly the expected columns (no duplicates)
    const cols = db.prepare("PRAGMA table_info(run_worktrees)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    const expectedCols = [
      "run_id",
      "worktree_origin_repository",
      "worktree_origin_git_common_dir",
      "worktree_path",
      "worktree_origin_ref",
      "worktree_origin_sha",
      "original_branch",
      "status",
      "cleanup_policy",
      "created_at",
      "removed_at",
      "error",
    ];
    assert.deepEqual(colNames.sort(), expectedCols.sort(), "columns should match expected after idempotent migrate");
  });

  it("can insert and query a worktree row", () => {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO run_worktrees
        (run_id, worktree_origin_repository, worktree_origin_git_common_dir,
         worktree_path, worktree_origin_ref, worktree_origin_sha,
         original_branch, status, cleanup_policy, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "test-run-id-001",
      "/home/user/repo",
      "/home/user/repo/.git",
      "/tmp/worktrees/repo-abc/r1-xyz",
      "refs/heads/main",
      "abc1234",
      "main",
      "ready",
      "remove_on_success",
      now,
    );

    const row = db.prepare("SELECT * FROM run_worktrees WHERE run_id = ?").get("test-run-id-001") as {
      run_id: string;
      worktree_origin_repository: string;
      worktree_origin_git_common_dir: string;
      worktree_path: string;
      worktree_origin_ref: string;
      worktree_origin_sha: string;
      original_branch: string;
      status: string;
      cleanup_policy: string;
      created_at: string;
      removed_at: string | null;
      error: string | null;
    };

    assert.ok(row, "should retrieve inserted row");
    assert.equal(row.run_id, "test-run-id-001");
    assert.equal(row.worktree_origin_repository, "/home/user/repo");
    assert.equal(row.worktree_origin_git_common_dir, "/home/user/repo/.git");
    assert.equal(row.worktree_path, "/tmp/worktrees/repo-abc/r1-xyz");
    assert.equal(row.worktree_origin_ref, "refs/heads/main");
    assert.equal(row.worktree_origin_sha, "abc1234");
    assert.equal(row.original_branch, "main");
    assert.equal(row.status, "ready");
    assert.equal(row.cleanup_policy, "remove_on_success");
    assert.equal(row.created_at, now);
    assert.equal(row.removed_at, null);
    assert.equal(row.error, null);
  });

  it("default status is 'creating' when not specified", () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Insert without specifying status
    db.prepare(`
      INSERT INTO run_worktrees
        (run_id, worktree_origin_repository, worktree_origin_git_common_dir,
         worktree_path, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      "test-run-id-002",
      "/home/user/repo2",
      "/home/user/repo2/.git",
      "/tmp/worktrees/repo2/r2-xyz",
      now,
    );

    const row = db.prepare("SELECT status, cleanup_policy FROM run_worktrees WHERE run_id = ?").get(
      "test-run-id-002",
    ) as { status: string; cleanup_policy: string };

    assert.equal(row.status, "creating", "default status should be creating");
    assert.equal(row.cleanup_policy, "remove_on_success", "default cleanup_policy should be remove_on_success");
  });

  it("can update status via index-friendly query", () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Insert with 'creating' status
    db.prepare(`
      INSERT INTO run_worktrees
        (run_id, worktree_origin_repository, worktree_origin_git_common_dir,
         worktree_path, worktree_origin_sha, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "test-run-id-003",
      "/home/user/repo3",
      "/home/user/repo3/.git",
      "/tmp/worktrees/repo3/r3-xyz",
      "def5678",
      now,
    );

    // Update status to 'ready'
    db.prepare("UPDATE run_worktrees SET status = 'ready' WHERE run_id = ?").run("test-run-id-003");

    const row = db.prepare(
      "SELECT status FROM run_worktrees WHERE run_id = ?",
    ).get("test-run-id-003") as { status: string };

    assert.equal(row.status, "ready");

    // Verify the status index is used (by checking explain query plan doesn't error)
    const explain = db.prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM run_worktrees WHERE status = ?",
    ).all("ready");
    assert.ok(explain.length > 0, "query plan should be valid");
  });
});

describe("stories abandoned_count migration", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  const th = createTempHome("tamandua-stories-migration-test-");
  before(() => {
    tempHome = th.root;
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = th.homeDir;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  function columnNames(db: DatabaseSync, table: string): Set<string> {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(cols.map((c) => c.name));
  }

  it("stories table has abandoned_count column with INTEGER DEFAULT 0", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(stories)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;

    const col = cols.find((c) => c.name === "abandoned_count");
    assert.ok(col, "abandoned_count column should exist");
    assert.equal(col.type, "INTEGER", "abandoned_count should be INTEGER");
    assert.equal(col.dflt_value, "0", "abandoned_count default should be 0");
  });

  it("migration is idempotent (second call does nothing harmful)", () => {
    const db = getDb();

    const cols = db.prepare("PRAGMA table_info(stories)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name).sort();
    const expectedCols = [
      "abandoned_count",
      "acceptance_criteria",
      "created_at",
      "description",
      "id",
      "max_retries",
      "output",
      "retry_count",
      "run_id",
      "status",
      "story_id",
      "story_index",
      "title",
      "updated_at",
    ];
    assert.deepEqual(colNames, expectedCols.sort(), "columns should match expected after idempotent migrate");
  });

  it("new story inserted gets abandoned_count = 0 via DEFAULT", () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Insert a run first
    db.prepare(`
      INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at, tokens_spent, run_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("wlst-test-run", "test-workflow", "Test task", "running", now, now, 0, 1);

    // Insert a story — note abandoned_count is NOT in the column list, relying on DEFAULT
    db.prepare(`
      INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("wlst-story-1", "wlst-test-run", 0, "US-001", "Test Story", "Desc", "[]", "pending", 0, 4, now, now);

    const row = db.prepare("SELECT abandoned_count FROM stories WHERE id = ?").get("wlst-story-1") as { abandoned_count: number };
    assert.equal(row.abandoned_count, 0, "new story should have abandoned_count = 0 via DEFAULT");
  });

  it("existing DB tables unaffected by stories migration", () => {
    const db = getDb();
    // Core tables still exist
    const runsCols = columnNames(db, "runs");
    assert.ok(runsCols.has("id"), "runs.id should exist");
    assert.ok(runsCols.has("tokens_spent"), "runs.tokens_spent should exist");

    const stepCols = columnNames(db, "steps");
    assert.ok(stepCols.has("id"), "steps.id should exist");
    assert.ok(stepCols.has("abandoned_count"), "steps.abandoned_count should exist");
    assert.ok(stepCols.has("reroute_count"), "steps.reroute_count should exist");

    const storyCols = columnNames(db, "stories");
    assert.ok(storyCols.has("id"), "stories.id should exist");
    assert.ok(storyCols.has("retry_count"), "stories.retry_count should exist");
    assert.ok(storyCols.has("status"), "stories.status should exist");
  });
});

describe("getDbPath", () => {
  it("returns path ending with .tamandua/tamandua.db under HOME", () => {
    const result = getDbPath();
    assert.ok(result.endsWith(path.join(".tamandua", "tamandua.db")), `expected path ending with .tamandua/tamandua.db, got ${result}`);
  });

  it("respects TAMANDUA_DB_PATH env var", () => {
    const customPath = "/tmp/custom-tamandua.db";
    process.env.TAMANDUA_DB_PATH = customPath;
    try {
      const result = getDbPath();
      assert.equal(result, customPath);
    } finally {
      delete process.env.TAMANDUA_DB_PATH;
    }
  });
});

describe("getSystemTokenSpend", () => {
  let startingSpend: number;
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  const th = createTempHome("tamandua-db-token-test-");
  before(() => {
    // Isolate into a temp HOME — this suite mutates tamandua_stats and must
    // never touch the real DB (it used to zero the production token counter
    // before the isolation guard existed; the file was invisible to npm test
    // until the find-based lanes picked it up).
    tempHome = th.root;
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = th.homeDir;
    delete process.env.TAMANDUA_DB_PATH;

    // Reset tamandua_stats to a known baseline
    const db = getDb();
    db.prepare("UPDATE tamandua_stats SET system_tokens_spent = 0 WHERE id = 1").run();
    // Also ensure the row exists (migrate() creates it)
    db.prepare("INSERT OR IGNORE INTO tamandua_stats (id, system_tokens_spent) VALUES (1, 0)").run();
    startingSpend = getSystemTokenSpend();
  });

  it("returns 0 after reset", () => {
    assert.equal(startingSpend, 0);
  });

  it("returns updated value after incrementSystemTokenSpend", () => {
    incrementSystemTokenSpend(100);
    const result = getSystemTokenSpend();
    assert.equal(result, 100);
  });

  it("accumulates across multiple increments", () => {
    incrementSystemTokenSpend(50);
    incrementSystemTokenSpend(25);
    const result = getSystemTokenSpend();
    assert.equal(result, 175);
  });

  after(() => {
    if (origHome !== undefined) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath !== undefined) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
  });
});

// ── AutoResearch sessions ──

function writeSessionConfig(cwd: string, config: Record<string, unknown>): void {
  writeFileSync(path.join(cwd, "autoresearch.config.json"), JSON.stringify(config, null, 2) + "\n");
}

function writeSessionLog(cwd: string, lines: Record<string, unknown>[]): void {
  writeFileSync(path.join(cwd, "autoresearch.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

describe("autoresearch_sessions table migration", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  const th = createTempHome("tamandua-ar-sessions-test-");
  before(() => {
    tempHome = th.root;
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = th.homeDir;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  function tableExists(db: DatabaseSync, table: string): boolean {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table);
    return row !== undefined;
  }

  it("creates autoresearch_sessions table on migration", () => {
    const db = getDb();
    assert.ok(tableExists(db, "autoresearch_sessions"), "autoresearch_sessions table should exist");
  });

  it("all required columns present with correct types", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(autoresearch_sessions)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    const colMap = new Map(cols.map((c) => [c.name, c]));

    const idCol = colMap.get("id");
    assert.ok(idCol, "id column should exist");
    assert.equal(idCol.type, "TEXT", "id should be TEXT");
    assert.equal(idCol.pk, 1, "id should be PRIMARY KEY");

    const cwdCol = colMap.get("cwd");
    assert.ok(cwdCol, "cwd column should exist");
    assert.equal(cwdCol.type, "TEXT", "cwd should be TEXT");

    const goalCol = colMap.get("goal");
    assert.ok(goalCol, "goal column should exist");
    assert.equal(goalCol.type, "TEXT", "goal should be TEXT");

    const metricNameCol = colMap.get("metric_name");
    assert.ok(metricNameCol, "metric_name column should exist");
    assert.equal(metricNameCol.type, "TEXT", "metric_name should be TEXT");

    const metricUnitCol = colMap.get("metric_unit");
    assert.ok(metricUnitCol, "metric_unit column should exist");
    assert.equal(metricUnitCol.type, "TEXT", "metric_unit should be TEXT");

    const directionCol = colMap.get("direction");
    assert.ok(directionCol, "direction column should exist");
    assert.equal(directionCol.type, "TEXT", "direction should be TEXT");

    const commandCol = colMap.get("command");
    assert.ok(commandCol, "command column should exist");
    assert.equal(commandCol.type, "TEXT", "command should be TEXT");

    const createdAtCol = colMap.get("created_at");
    assert.ok(createdAtCol, "created_at column should exist");
    assert.equal(createdAtCol.type, "TEXT", "created_at should be TEXT");

    const updatedAtCol = colMap.get("updated_at");
    assert.ok(updatedAtCol, "updated_at column should exist");
    assert.equal(updatedAtCol.type, "TEXT", "updated_at should be TEXT");

    const lastSeenAtCol = colMap.get("last_seen_at");
    assert.ok(lastSeenAtCol, "last_seen_at column should exist");
    assert.equal(lastSeenAtCol.type, "TEXT", "last_seen_at should be TEXT");

    const lastRunAtCol = colMap.get("last_run_at");
    assert.ok(lastRunAtCol, "last_run_at column should exist");
    assert.equal(lastRunAtCol.type, "TEXT", "last_run_at should be TEXT");

    const totalRunsCol = colMap.get("total_runs");
    assert.ok(totalRunsCol, "total_runs column should exist");
    assert.equal(totalRunsCol.type, "INTEGER", "total_runs should be INTEGER");

    const baselineMetricCol = colMap.get("baseline_metric");
    assert.ok(baselineMetricCol, "baseline_metric column should exist");
    assert.equal(baselineMetricCol.type, "REAL", "baseline_metric should be REAL");

    const bestMetricCol = colMap.get("best_metric");
    assert.ok(bestMetricCol, "best_metric column should exist");
    assert.equal(bestMetricCol.type, "REAL", "best_metric should be REAL");

    const bestRunCol = colMap.get("best_run");
    assert.ok(bestRunCol, "best_run column should exist");
    assert.equal(bestRunCol.type, "INTEGER", "best_run should be INTEGER");

    const filesMissingCol = colMap.get("files_missing");
    assert.ok(filesMissingCol, "files_missing column should exist");
    assert.equal(filesMissingCol.type, "INTEGER", "files_missing should be INTEGER");
  });

  it("has indexes on cwd (unique), updated_at, and last_seen_at", () => {
    const db = getDb();
    const indexes = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='autoresearch_sessions'",
    ).all() as Array<{ name: string; sql: string }>;

    const cwdIndex = indexes.find((idx) => idx.name === "idx_autoresearch_sessions_cwd");
    assert.ok(cwdIndex, "should have idx_autoresearch_sessions_cwd index");
    assert.ok(cwdIndex.sql.includes("UNIQUE"), "cwd index should be UNIQUE");

    const updatedAtIndex = indexes.find((idx) => idx.name === "idx_autoresearch_sessions_updated_at");
    assert.ok(updatedAtIndex, "should have idx_autoresearch_sessions_updated_at index");

    const lastSeenAtIndex = indexes.find((idx) => idx.name === "idx_autoresearch_sessions_last_seen_at");
    assert.ok(lastSeenAtIndex, "should have idx_autoresearch_sessions_last_seen_at index");
  });

  it("migration is idempotent (second call does nothing harmful)", () => {
    const db = getDb();

    assert.ok(tableExists(db, "autoresearch_sessions"), "table should still exist after second migration");

    const cols = db.prepare("PRAGMA table_info(autoresearch_sessions)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name).sort();
    const expectedCols = [
      "baseline_metric", "best_metric", "best_run", "command", "created_at",
      "cwd", "direction", "files_missing", "goal", "id",
      "last_run_at", "last_seen_at", "metric_name", "metric_unit",
      "total_runs", "updated_at",
    ].sort();
    assert.deepEqual(colNames, expectedCols, "columns should match expected after idempotent migrate");
  });

  it("existing DB tables unaffected by autoresearch_sessions migration", () => {
    const db = getDb();
    assert.ok(tableExists(db, "runs"), "runs table should exist");
    assert.ok(tableExists(db, "steps"), "steps table should exist");
    assert.ok(tableExists(db, "stories"), "stories table should exist");
    assert.ok(tableExists(db, "tamandua_stats"), "tamandua_stats table should exist");
    assert.ok(tableExists(db, "run_worktrees"), "run_worktrees table should exist");
  });
});

describe("upsertAutoresearchSession", () => {
  let tempHome: string;
  let tempSessionDir: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  const th = createTempHome("tamandua-ar-upsert-test-");
  const ssth = createTempHome("tamandua-ar-session-");
  before(() => {
    tempHome = th.root;
    tempSessionDir = ssth.root;
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = th.homeDir;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  it("inserts a new row when cwd has valid autoresearch.config.json", () => {
    writeSessionConfig(tempSessionDir, {
      goal: "optimize something",
      metricName: "latency_ms",
      metricUnit: "ms",
      direction: "lower",
      command: "npm test",
    });
    writeSessionLog(tempSessionDir, [
      { type: "run", run: 1, status: "baseline", metric: 100.5 },
      { type: "run", run: 2, status: "keep", metric: 95.3 },
      { type: "run", run: 3, status: "discard", metric: 102.0 },
    ]);

    const session = upsertAutoresearchSession(tempSessionDir);
    assert.ok(session, "should return a session row");
    assert.equal(session!.id, realpathSync(tempSessionDir));
    assert.equal(session!.cwd, realpathSync(tempSessionDir));
    assert.equal(session!.goal, "optimize something");
    assert.equal(session!.metric_name, "latency_ms");
    assert.equal(session!.metric_unit, "ms");
    assert.equal(session!.direction, "lower");
    assert.equal(session!.command, "npm test");
    assert.equal(session!.total_runs, 3);
    assert.equal(session!.baseline_metric, 100.5);
    assert.equal(session!.best_metric, 95.3);
    assert.equal(session!.best_run, 2);
    assert.equal(session!.files_missing, 0);
  });

  it("updates an existing row when cwd already has a registry entry", () => {
    // First upsert
    writeSessionConfig(tempSessionDir, {
      goal: "optimize something",
      metricName: "latency_ms",
      metricUnit: "ms",
      direction: "lower",
      command: "npm test",
    });
    writeSessionLog(tempSessionDir, [
      { type: "run", run: 1, status: "baseline", metric: 100.5 },
    ]);

    upsertAutoresearchSession(tempSessionDir);

    // Add more runs and re-upsert
    writeSessionLog(tempSessionDir, [
      { type: "run", run: 1, status: "baseline", metric: 100.5 },
      { type: "run", run: 2, status: "keep", metric: 90.0 },
      { type: "run", run: 3, status: "keep", metric: 85.0 },
    ]);

    const session = upsertAutoresearchSession(tempSessionDir);
    assert.ok(session, "should return a session row");
    assert.equal(session!.total_runs, 3);
    assert.equal(session!.baseline_metric, 100.5);
    assert.equal(session!.best_metric, 85.0);
    assert.equal(session!.best_run, 3);
    assert.equal(session!.files_missing, 0);

    // Verify there is exactly one row for this session
    const db = getDb();
    const count = db.prepare(
      "SELECT COUNT(*) as cnt FROM autoresearch_sessions WHERE id = ?",
    ).get(session!.id) as { cnt: number };
    assert.equal(count.cnt, 1, "should have exactly one row");
  });

  it("sets files_missing=1 when config does not exist", () => {
    const nonexistentDir = path.join(tempHome, "nonexistent");

    const session = upsertAutoresearchSession(nonexistentDir);
    assert.ok(session, "should return a session row even for missing files");
    assert.equal(session!.files_missing, 1);
    assert.equal(session!.goal, null);
    assert.equal(session!.metric_name, null);
    assert.equal(session!.total_runs, 0);
  });

  it("counts runs correctly with mixed statuses", () => {
    writeSessionConfig(tempSessionDir, {
      goal: "test",
      metricName: "score",
      direction: "higher",
      command: "echo test",
    });
    writeSessionLog(tempSessionDir, [
      { type: "run", run: 1, status: "baseline", metric: 50 },
      { type: "run", run: 2, status: "keep", metric: 60 },
      { type: "run", run: 3, status: "discard", metric: 55 },
      { type: "run", run: 4, status: "crash", metric: null },
      { type: "run", run: 5, status: "checks_failed", metric: null },
    ]);

    const session = upsertAutoresearchSession(tempSessionDir);
    assert.ok(session, "should return a session row");
    assert.equal(session!.total_runs, 5);
    assert.equal(session!.baseline_metric, 50);
    assert.equal(session!.best_metric, 60);
    assert.equal(session!.best_run, 2);
  });

  it("handles direction=higher correctly for best_metric", () => {
    writeSessionConfig(tempSessionDir, {
      goal: "maximize",
      metricName: "accuracy",
      direction: "higher",
      command: "echo test",
    });
    writeSessionLog(tempSessionDir, [
      { type: "run", run: 1, status: "baseline", metric: 0.75 },
      { type: "run", run: 2, status: "keep", metric: 0.80 },
      { type: "run", run: 3, status: "keep", metric: 0.77 },
    ]);

    const session = upsertAutoresearchSession(tempSessionDir);
    assert.ok(session, "should return a session row");
    assert.equal(session!.best_metric, 0.80);
    assert.equal(session!.best_run, 2);
  });

  it("handles empty log file", () => {
    writeSessionConfig(tempSessionDir, {
      goal: "test",
      metricName: "score",
      direction: "lower",
      command: "echo test",
    });
    writeSessionLog(tempSessionDir, []);

    const session = upsertAutoresearchSession(tempSessionDir);
    assert.ok(session, "should return a session row");
    assert.equal(session!.total_runs, 0);
    assert.equal(session!.baseline_metric, null);
    assert.equal(session!.best_metric, null);
    assert.equal(session!.best_run, null);
    assert.equal(session!.files_missing, 0);
  });

  it("uses realpath(cwd) as stable id", () => {
    writeSessionConfig(tempSessionDir, {
      goal: "test",
      metricName: "score",
      direction: "lower",
      command: "echo test",
    });
    writeSessionLog(tempSessionDir, []);

    // Pass a symlink or relative path to verify realpath is used
    const session = upsertAutoresearchSession(tempSessionDir);
    assert.ok(session, "should return a session row");
    const expectedId = realpathSync(tempSessionDir);
    assert.equal(session!.id, expectedId);
    // Also test that the cwd field uses the resolved path
    assert.equal(session!.cwd, expectedId);
  });

  it("handles cwd that does not exist", () => {
    const nonexistent = path.join(tempHome, "ghost-dir");
    const session = upsertAutoresearchSession(nonexistent);
    assert.ok(session, "should return a session row for nonexistent cwd");
    assert.equal(session!.files_missing, 1);
    // id should use resolved path (which won't exist but path.resolve handles)
    assert.ok(session!.id.length > 0);
  });
});

describe("getAutoresearchSessions", () => {
  let tempHome: string;
  let tempSessionDir: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  const th = createTempHome("tamandua-ar-list-test-");
  const ssth = createTempHome("tamandua-ar-session2-");
  before(() => {
    tempHome = th.root;
    tempSessionDir = ssth.root;
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = th.homeDir;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  it("returns empty array when no sessions exist", () => {
    const sessions = getAutoresearchSessions();
    assert.deepEqual(sessions, []);
  });

  it("returns all non-missing sessions ordered by updated_at DESC", () => {
    // Create two sessions
    const dir1 = createTempHome("tamandua-ar-a-").root;
    const dir2 = createTempHome("tamandua-ar-b-").root;

    try {
      writeSessionConfig(dir1, {
        goal: "session A",
        metricName: "latency",
        direction: "lower",
        command: "test A",
      });
      writeSessionLog(dir1, [{ type: "run", run: 1, status: "baseline", metric: 100 }]);

      writeSessionConfig(dir2, {
        goal: "session B",
        metricName: "throughput",
        direction: "higher",
        command: "test B",
      });
      writeSessionLog(dir2, [{ type: "run", run: 1, status: "baseline", metric: 50 }]);

      // Insert B first, then A (so B has older updated_at)
      upsertAutoresearchSession(dir2);
      // Small delay to ensure different timestamps
      const start = Date.now();
      while (Date.now() - start < 10) { /* busy wait for timestamp difference */ }
      upsertAutoresearchSession(dir1);

      const sessions = getAutoresearchSessions();
      assert.equal(sessions.length, 2);
      // A was inserted last, should be first
      assert.equal(sessions[0].goal, "session A");
      assert.equal(sessions[1].goal, "session B");
    } finally {
      // createTempHome handles cleanup via after()
    }
  });

  it("excludes missing sessions by default", () => {
    const nonexistent = path.join(tempHome, "ghost-session");
    upsertAutoresearchSession(nonexistent);

    const sessions = getAutoresearchSessions();
    // The missing session should be excluded
    const missingSessions = sessions.filter((s) => s.files_missing === 1);
    assert.equal(missingSessions.length, 0, "default should exclude missing sessions");
  });

  it("includeMissing option returns missing sessions", () => {
    const nonexistent = path.join(tempHome, "ghost-session2");
    upsertAutoresearchSession(nonexistent);

    const sessions = getAutoresearchSessions({ includeMissing: true });
    const missingSessions = sessions.filter((s) => s.files_missing === 1);
    assert.ok(missingSessions.length >= 1, "should include missing sessions when requested");
  });
});

describe("getAutoresearchSessionById", () => {
  let tempHome: string;
  let tempSessionDir: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  const th = createTempHome("tamandua-ar-getbyid-test-");
  const ssth = createTempHome("tamandua-ar-session3-");
  before(() => {
    tempHome = th.root;
    tempSessionDir = ssth.root;
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = th.homeDir;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  it("returns a session by id", () => {
    writeSessionConfig(tempSessionDir, {
      goal: "find me",
      metricName: "score",
      direction: "lower",
      command: "test",
    });
    writeSessionLog(tempSessionDir, [{ type: "run", run: 1, status: "baseline", metric: 42 }]);

    const upserted = upsertAutoresearchSession(tempSessionDir);
    assert.ok(upserted, "should upsert successfully");

    const session = getAutoresearchSessionById(upserted!.id);
    assert.ok(session, "should find session by id");
    assert.equal(session!.goal, "find me");
    assert.equal(session!.metric_name, "score");
    assert.equal(session!.total_runs, 1);
  });

  it("returns undefined for nonexistent id", () => {
    const session = getAutoresearchSessionById("/nonexistent/path");
    assert.equal(session, undefined);
  });
});

describe("getDb handle stability", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  const th = createTempHome("tamandua-db-handle-test-");
  before(() => {
    tempHome = th.root;
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = th.homeDir;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  it("returns the identical handle for same path across multiple calls", () => {
    const db1 = getDb();
    const db2 = getDb();
    assert.strictEqual(db1, db2, "getDb() should return the same handle on repeated same-path calls");
  });

  it("returns the identical handle even after time elapses between calls", () => {
    const db1 = getDb();
    // Busy-wait to simulate time passing. With the bug (5s TTL), a much
    // longer wait would trigger rotation; post-fix, any elapsed time is fine.
    const start = Date.now();
    while (Date.now() - start < 20) { /* wait */ }
    const db2 = getDb();
    assert.strictEqual(db1, db2, "getDb() should return the same handle after time elapses with unchanged path");
  });

  it("returns a fresh handle when TAMANDUA_DB_PATH changes", () => {
    const db1 = getDb();

    const newPath = path.join(tempHome, "new-db.sqlite");
    process.env.TAMANDUA_DB_PATH = newPath;

    const db2 = getDb();
    assert.notStrictEqual(db1, db2, "getDb() should return a new handle when DB path changes");
    assert.strictEqual(getDbPath(), newPath, "getDbPath should reflect the new path");
  });

  it("returns the identical handle when TAMANDUA_DB_PATH is set and unchanged", () => {
    const customPath = path.join(tempHome, "stable-db.sqlite");
    process.env.TAMANDUA_DB_PATH = customPath;

    const db1 = getDb();
    const db2 = getDb();
    assert.strictEqual(db1, db2, "getDb() should return the same handle when explicit DB path is unchanged");
  });
});

describe("deleteAutoresearchSession", () => {
  let tempHome: string;
  let tempSessionDir: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  const th = createTempHome("tamandua-ar-delete-test-");
  const ssth = createTempHome("tamandua-ar-session4-");
  before(() => {
    tempHome = th.root;
    tempSessionDir = ssth.root;
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = th.homeDir;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  it("removes a row by id and returns true", () => {
    writeSessionConfig(tempSessionDir, {
      goal: "delete me",
      metricName: "score",
      direction: "lower",
      command: "test",
    });
    writeSessionLog(tempSessionDir, [{ type: "run", run: 1, status: "baseline", metric: 99 }]);

    const upserted = upsertAutoresearchSession(tempSessionDir);
    assert.ok(upserted, "should upsert successfully");

    const result = deleteAutoresearchSession(upserted!.id);
    assert.equal(result, true, "should return true on successful delete");

    // Verify it's gone
    const session = getAutoresearchSessionById(upserted!.id);
    assert.equal(session, undefined, "should be gone after delete");
  });

  it("returns false for nonexistent id", () => {
    const result = deleteAutoresearchSession("/nonexistent/id");
    assert.equal(result, false, "should return false for nonexistent id");
  });
});

// ── TSTX suite_results table ──

describe("suite_results table migration", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  const th = createTempHome("tamandua-suite-results-test-");
  before(() => {
    tempHome = th.root;
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = th.homeDir;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  function tableExists(db: DatabaseSync, table: string): boolean {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table);
    return row !== undefined;
  }

  it("creates suite_results table on first migration", () => {
    const db = getDb();
    assert.ok(tableExists(db, "suite_results"), "suite_results table should exist");
  });

  it("all required columns present with correct types and constraints", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(suite_results)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    const colMap = new Map(cols.map((c) => [c.name, c]));

    // id: INTEGER PRIMARY KEY
    const idCol = colMap.get("id");
    assert.ok(idCol, "id column should exist");
    assert.equal(idCol.type, "INTEGER", "id should be INTEGER");
    assert.equal(idCol.pk, 1, "id should be PRIMARY KEY");

    // origin_repo: TEXT NOT NULL
    const originRepoCol = colMap.get("origin_repo");
    assert.ok(originRepoCol, "origin_repo column should exist");
    assert.equal(originRepoCol.type, "TEXT", "origin_repo should be TEXT");
    assert.equal(originRepoCol.notnull, 1, "origin_repo should be NOT NULL");

    // tree_hash: TEXT NOT NULL
    const treeHashCol = colMap.get("tree_hash");
    assert.ok(treeHashCol, "tree_hash column should exist");
    assert.equal(treeHashCol.type, "TEXT", "tree_hash should be TEXT");
    assert.equal(treeHashCol.notnull, 1, "tree_hash should be NOT NULL");

    // cmd_hash: TEXT NOT NULL
    const cmdHashCol = colMap.get("cmd_hash");
    assert.ok(cmdHashCol, "cmd_hash column should exist");
    assert.equal(cmdHashCol.type, "TEXT", "cmd_hash should be TEXT");
    assert.equal(cmdHashCol.notnull, 1, "cmd_hash should be NOT NULL");

    // cmd_display: TEXT NOT NULL
    const cmdDisplayCol = colMap.get("cmd_display");
    assert.ok(cmdDisplayCol, "cmd_display column should exist");
    assert.equal(cmdDisplayCol.type, "TEXT", "cmd_display should be TEXT");
    assert.equal(cmdDisplayCol.notnull, 1, "cmd_display should be NOT NULL");

    // exit_code: INTEGER NOT NULL
    const exitCodeCol = colMap.get("exit_code");
    assert.ok(exitCodeCol, "exit_code column should exist");
    assert.equal(exitCodeCol.type, "INTEGER", "exit_code should be INTEGER");
    assert.equal(exitCodeCol.notnull, 1, "exit_code should be NOT NULL");

    // duration_ms: INTEGER NOT NULL
    const durationMsCol = colMap.get("duration_ms");
    assert.ok(durationMsCol, "duration_ms column should exist");
    assert.equal(durationMsCol.type, "INTEGER", "duration_ms should be INTEGER");
    assert.equal(durationMsCol.notnull, 1, "duration_ms should be NOT NULL");

    // log_tail: TEXT (nullable)
    const logTailCol = colMap.get("log_tail");
    assert.ok(logTailCol, "log_tail column should exist");
    assert.equal(logTailCol.type, "TEXT", "log_tail should be TEXT");
    assert.equal(logTailCol.notnull, 0, "log_tail should be nullable");

    // run_id: TEXT (nullable)
    const runIdCol = colMap.get("run_id");
    assert.ok(runIdCol, "run_id column should exist");
    assert.equal(runIdCol.type, "TEXT", "run_id should be TEXT");
    assert.equal(runIdCol.notnull, 0, "run_id should be nullable");

    // step_id: TEXT (nullable)
    const stepIdCol = colMap.get("step_id");
    assert.ok(stepIdCol, "step_id column should exist");
    assert.equal(stepIdCol.type, "TEXT", "step_id should be TEXT");
    assert.equal(stepIdCol.notnull, 0, "step_id should be nullable");

    // created_at: TEXT NOT NULL
    const createdAtCol = colMap.get("created_at");
    assert.ok(createdAtCol, "created_at column should exist");
    assert.equal(createdAtCol.type, "TEXT", "created_at should be TEXT");
    assert.equal(createdAtCol.notnull, 1, "created_at should be NOT NULL");
  });

  it("has lookup index on (origin_repo, tree_hash, cmd_hash, created_at)", () => {
    const db = getDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='suite_results'",
    ).all() as Array<{ name: string }>;

    const hasLookupIndex = indexes.some((idx) => idx.name === "idx_suite_results_lookup");
    assert.ok(hasLookupIndex, "should have idx_suite_results_lookup index");
  });

  it("migration is idempotent (second call does nothing harmful)", () => {
    const db = getDb();

    // Table should still exist with no error
    assert.ok(tableExists(db, "suite_results"), "suite_results should still exist after second migration");

    // Columns should be unchanged
    const cols = db.prepare("PRAGMA table_info(suite_results)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name).sort();
    const expectedCols = [
      "id", "origin_repo", "tree_hash", "cmd_hash", "cmd_display",
      "exit_code", "duration_ms", "log_tail", "run_id", "step_id", "created_at",
    ];
    assert.deepEqual(colNames, expectedCols.sort(), "columns should match expected after idempotent migrate");
  });

  it("existing DB tables unaffected by migration", () => {
    const db = getDb();
    // All existing tables should still be present
    assert.ok(tableExists(db, "runs"), "runs table should exist");
    assert.ok(tableExists(db, "steps"), "steps table should exist");
    assert.ok(tableExists(db, "stories"), "stories table should exist");
    assert.ok(tableExists(db, "tamandua_stats"), "tamandua_stats table should exist");
    assert.ok(tableExists(db, "run_worktrees"), "run_worktrees table should exist");
    assert.ok(tableExists(db, "autoresearch_sessions"), "autoresearch_sessions table should exist");

    // Core runs columns should still be present
    const runCols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    const runColNames = new Set(runCols.map((c) => c.name));
    assert.ok(runColNames.has("id"), "runs.id should exist");
    assert.ok(runColNames.has("workflow_id"), "runs.workflow_id should exist");
    assert.ok(runColNames.has("status"), "runs.status should exist");
  });

  it("can insert and query a suite result row", () => {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO suite_results
        (origin_repo, tree_hash, cmd_hash, cmd_display,
         exit_code, duration_ms, log_tail, run_id, step_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "/home/user/repo",
      "abc123def456789012345678901234567890abcd",
      "sha256:def456",
      "npm test",
      0,
      5432,
      "All tests passed!\n42 tests, 0 failures",
      "run-001",
      "step-001",
      now,
    );

    const row = db.prepare("SELECT * FROM suite_results WHERE run_id = ?").get("run-001") as {
      id: number;
      origin_repo: string;
      tree_hash: string;
      cmd_hash: string;
      cmd_display: string;
      exit_code: number;
      duration_ms: number;
      log_tail: string;
      run_id: string;
      step_id: string;
      created_at: string;
    };

    assert.ok(row, "should retrieve inserted row");
    assert.ok(typeof row.id === "number", "id should be auto-generated");
    assert.equal(row.origin_repo, "/home/user/repo");
    assert.equal(row.tree_hash, "abc123def456789012345678901234567890abcd");
    assert.equal(row.cmd_hash, "sha256:def456");
    assert.equal(row.cmd_display, "npm test");
    assert.equal(row.exit_code, 0);
    assert.equal(row.duration_ms, 5432);
    assert.equal(row.log_tail, "All tests passed!\n42 tests, 0 failures");
    assert.equal(row.run_id, "run-001");
    assert.equal(row.step_id, "step-001");
    assert.equal(row.created_at, now);
  });

  it("table is append-only: multiple inserts for same key produce distinct rows", () => {
    const db = getDb();
    const now1 = new Date("2026-01-01T00:00:00Z").toISOString();
    const now2 = new Date("2026-01-01T01:00:00Z").toISOString();

    db.prepare(`
      INSERT INTO suite_results
        (origin_repo, tree_hash, cmd_hash, cmd_display,
         exit_code, duration_ms, log_tail, run_id, step_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "/home/user/repo",
      "tree-aaa",
      "cmd-aaa",
      "npm test",
      0,
      5000,
      "pass",
      "run-a",
      "step-a",
      now1,
    );

    db.prepare(`
      INSERT INTO suite_results
        (origin_repo, tree_hash, cmd_hash, cmd_display,
         exit_code, duration_ms, log_tail, run_id, step_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "/home/user/repo",
      "tree-aaa",
      "cmd-aaa",
      "npm test",
      1,
      3000,
      "fail",
      "run-b",
      "step-b",
      now2,
    );

    const count = db.prepare(
      "SELECT COUNT(*) as cnt FROM suite_results WHERE origin_repo = ? AND tree_hash = ? AND cmd_hash = ?",
    ).get("/home/user/repo", "tree-aaa", "cmd-aaa") as { cnt: number };

    assert.equal(count.cnt, 2, "same key should produce two distinct rows (append-only)");
  });

  it("handles null log_tail, run_id, and step_id", () => {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO suite_results
        (origin_repo, tree_hash, cmd_hash, cmd_display,
         exit_code, duration_ms, log_tail, run_id, step_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
    `).run(
      "/home/user/repo",
      "tree-nullable",
      "cmd-nullable",
      "npm test",
      0,
      100,
      now,
    );

    const row = db.prepare(
      "SELECT log_tail, run_id, step_id FROM suite_results WHERE tree_hash = ?",
    ).get("tree-nullable") as { log_tail: string | null; run_id: string | null; step_id: string | null };

    assert.equal(row.log_tail, null, "log_tail should be null");
    assert.equal(row.run_id, null, "run_id should be null");
    assert.equal(row.step_id, null, "step_id should be null");
  });
});

describe("suite_results pruneOldSuiteResults", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  beforeEach(() => {
    const th = createTempHome("tamandua-suite-prune-test-");
    tempHome = th.root;
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = th.homeDir;
    delete process.env.TAMANDUA_DB_PATH;
  });

  afterEach(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  it("removes rows older than 14 days", () => {
    const db = getDb();
    const prefix = "us001-older";

    // Insert a row older than 14 days
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO suite_results
        (origin_repo, tree_hash, cmd_hash, cmd_display,
         exit_code, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("/home/user/repo", prefix + "-old", prefix + "-cmd-old", "npm test", 0, 1000, oldDate);

    // Insert a recent row (less than 14 days)
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO suite_results
        (origin_repo, tree_hash, cmd_hash, cmd_display,
         exit_code, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("/home/user/repo", prefix + "-recent", prefix + "-cmd-recent", "npm test", 0, 2000, recentDate);

    // Verify both rows exist before pruning — scoped to test's own prefix
    const countBefore = db.prepare(
      "SELECT COUNT(*) as cnt FROM suite_results WHERE tree_hash IN (?, ?)"
    ).get(prefix + "-old", prefix + "-recent") as { cnt: number };
    assert.equal(countBefore.cnt, 2, "should have 2 rows before pruning");

    // Prune
    const pruned = pruneOldSuiteResults();
    assert.equal(pruned, 1, "should prune exactly the old row");

    // Verify old row is gone
    const oldRow = db.prepare(
      "SELECT id FROM suite_results WHERE tree_hash = ?",
    ).get(prefix + "-old");
    assert.equal(oldRow, undefined, "old row should be gone");

    // Verify recent row remains
    const recentRow = db.prepare(
      "SELECT tree_hash FROM suite_results WHERE tree_hash = ?",
    ).get(prefix + "-recent") as { tree_hash: string };
    assert.ok(recentRow, "recent row should remain");
    assert.equal(recentRow.tree_hash, prefix + "-recent");
  });

  it("returns 0 when no rows to prune", () => {
    const db = getDb();
    const prefix = "us001-none";

    // Insert only a recent row
    const recentDate = new Date().toISOString();
    db.prepare(`
      INSERT INTO suite_results
        (origin_repo, tree_hash, cmd_hash, cmd_display,
         exit_code, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("/repo", prefix + "-recent", prefix + "-cmd", "echo hi", 0, 100, recentDate);

    const pruned = pruneOldSuiteResults();
    assert.equal(pruned, 0, "should prune 0 rows when all are recent");

    const count = db.prepare(
      "SELECT COUNT(*) as cnt FROM suite_results WHERE tree_hash = ?"
    ).get(prefix + "-recent") as { cnt: number };
    assert.equal(count.cnt, 1, "row should remain");
  });

  it("returns 0 on empty table (no crash)", () => {
    const db = getDb();
    // Fresh per-test DB is empty — no DELETE needed

    const pruned = pruneOldSuiteResults();
    assert.equal(pruned, 0, "should return 0 on empty table");

    const count = db.prepare("SELECT COUNT(*) as cnt FROM suite_results").get() as { cnt: number };
    assert.equal(count.cnt, 0, "table should still be empty");
  });

  it("respects the exact 14-day cutoff", () => {
    const db = getDb();
    const prefix = "us001-cutoff";

    // Insert a row exactly 14d minus 1 second ago — should NOT be pruned
    const almostExpired = new Date(Date.now() - (14 * 24 * 60 * 60 * 1000) + 1000).toISOString();
    db.prepare(`
      INSERT INTO suite_results
        (origin_repo, tree_hash, cmd_hash, cmd_display,
         exit_code, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("/repo", prefix + "-almost", prefix + "-cmd-almost", "echo test", 0, 500, almostExpired);

    // Insert a row exactly 14d + 1 second ago — should be pruned
    const justExpired = new Date(Date.now() - (14 * 24 * 60 * 60 * 1000) - 1000).toISOString();
    db.prepare(`
      INSERT INTO suite_results
        (origin_repo, tree_hash, cmd_hash, cmd_display,
         exit_code, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("/repo", prefix + "-just", prefix + "-cmd-just", "echo test", 0, 600, justExpired);

    const pruned = pruneOldSuiteResults();
    assert.equal(pruned, 1, "should prune exactly the row older than 14d");

    // almostExpired should remain
    const almostRow = db.prepare(
      "SELECT tree_hash FROM suite_results WHERE tree_hash = ?",
    ).get(prefix + "-almost");
    assert.ok(almostRow, "row < 14d old should remain");

    // justExpired should be gone
    const justRow = db.prepare(
      "SELECT tree_hash FROM suite_results WHERE tree_hash = ?",
    ).get(prefix + "-just");
    assert.equal(justRow, undefined, "row > 14d old should be pruned");
  });
});

describe("story_abandonments table migration", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  const th = createTempHome("tamandua-story-abandonments-test-");
  before(() => {
    tempHome = th.root;
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = th.homeDir;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
  });

  function tableExists(db: DatabaseSync, table: string): boolean {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table);
    return row !== undefined;
  }

  it("creates story_abandonments table on first migration", () => {
    const db = getDb();
    assert.ok(tableExists(db, "story_abandonments"), "story_abandonments table should exist");
  });

  it("all required columns present with correct types", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(story_abandonments)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    const colMap = new Map(cols.map((c) => [c.name, c]));

    // id: TEXT PRIMARY KEY
    const idCol = colMap.get("id");
    assert.ok(idCol, "id column should exist");
    assert.equal(idCol.type, "TEXT", "id should be TEXT");
    assert.equal(idCol.pk, 1, "id should be PRIMARY KEY");

    // story_id: TEXT NOT NULL
    const storyIdCol = colMap.get("story_id");
    assert.ok(storyIdCol, "story_id column should exist");
    assert.equal(storyIdCol.type, "TEXT", "story_id should be TEXT");
    assert.equal(storyIdCol.notnull, 1, "story_id should be NOT NULL");

    // run_id: TEXT NOT NULL
    const runIdCol = colMap.get("run_id");
    assert.ok(runIdCol, "run_id column should exist");
    assert.equal(runIdCol.type, "TEXT", "run_id should be TEXT");
    assert.equal(runIdCol.notnull, 1, "run_id should be NOT NULL");

    // reason: TEXT NOT NULL
    const reasonCol = colMap.get("reason");
    assert.ok(reasonCol, "reason column should exist");
    assert.equal(reasonCol.type, "TEXT", "reason should be TEXT");
    assert.equal(reasonCol.notnull, 1, "reason should be NOT NULL");

    // abandoned_count: INTEGER NOT NULL
    const abandonedCountCol = colMap.get("abandoned_count");
    assert.ok(abandonedCountCol, "abandoned_count column should exist");
    assert.equal(abandonedCountCol.type, "INTEGER", "abandoned_count should be INTEGER");
    assert.equal(abandonedCountCol.notnull, 1, "abandoned_count should be NOT NULL");

    // created_at: TEXT NOT NULL
    const createdAtCol = colMap.get("created_at");
    assert.ok(createdAtCol, "created_at column should exist");
    assert.equal(createdAtCol.type, "TEXT", "created_at should be TEXT");
    assert.equal(createdAtCol.notnull, 1, "created_at should be NOT NULL");
  });

  it("has index on (run_id, story_id)", () => {
    const db = getDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='story_abandonments'",
    ).all() as Array<{ name: string }>;

    const hasLookupIndex = indexes.some(
      (idx) => idx.name === "idx_story_abandonments_run_story",
    );
    assert.ok(
      hasLookupIndex,
      "should have idx_story_abandonments_run_story index",
    );
  });

  it("migration is idempotent (second call does nothing harmful)", () => {
    const db = getDb();

    // Table should still exist with no error
    assert.ok(
      tableExists(db, "story_abandonments"),
      "story_abandonments should still exist after second migration",
    );

    // Columns should be unchanged
    const cols = db.prepare("PRAGMA table_info(story_abandonments)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name).sort();
    const expectedCols = [
      "id", "story_id", "run_id", "reason", "abandoned_count", "created_at",
    ];
    assert.deepEqual(colNames, expectedCols.sort(), "columns should match expected after idempotent migrate");
  });

  it("existing DB tables unaffected by migration", () => {
    const db = getDb();
    // All existing tables should still be present
    assert.ok(tableExists(db, "runs"), "runs table should exist");
    assert.ok(tableExists(db, "steps"), "steps table should exist");
    assert.ok(tableExists(db, "stories"), "stories table should exist");
    assert.ok(tableExists(db, "tamandua_stats"), "tamandua_stats table should exist");

    // Can still read core runs columns
    const runCols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    const runColNames = new Set(runCols.map((c) => c.name));
    assert.ok(runColNames.has("id"), "runs.id should exist");
    assert.ok(runColNames.has("workflow_id"), "runs.workflow_id should exist");
    assert.ok(runColNames.has("status"), "runs.status should exist");
  });
});
