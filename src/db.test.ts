import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, realpathSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createTempHome } from "../tests/helpers/test-env.ts";

// We test the migration by directly importing getDb, which calls migrate().
// But since getDb() uses a cached connection and resolves DB path from
// env/home, we test the migration logic directly with an isolated DB.
import { getDb, getDbPath, SCHEMA_VERSION, detectSchemaLineage, migrateInstantsToIsoZ, _migrateFullRuns, getSystemTokenSpend, incrementSystemTokenSpend, upsertAutoresearchSession, getAutoresearchSessions, getAutoresearchSessionById, deleteAutoresearchSession, pruneOldSuiteResults, _enableWalModeForTest, _acquireMigrationLockForTest } from "../dist/db.js";

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
describe("WAL initialization under a concurrent first-time initializer", () => {
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  function distDir(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
  }

  function envFor(homeDir: string, dbPath: string): NodeJS.ProcessEnv {
    return {
      HOME: homeDir,
      TAMANDUA_DB_PATH: dbPath,
      TAMANDUA_TEST_GUARD: "1",
      PATH: process.env.PATH ?? "",
    };
  }

  before(() => {
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
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

  // Regression: `PRAGMA journal_mode=WAL` is NOT covered by the SQLite busy
  // handler, so a daemon and a CLI racing to initialize the same fresh
  // database made the loser throw "database is locked" immediately (the
  // load-dependent e2e gate flake). getDb() must retry the WAL switch until
  // the other initializer releases its lock, then succeed.
  it("retries the WAL switch instead of failing fast on a concurrent initializer", async () => {
    const th = createTempHome("tamandua-db-wal-race-");
    const dbPath = path.join(th.root, "tamandua.db");

    // Locker: creates a fresh ROLLBACK-journal database, takes a write lock
    // (BEGIN IMMEDIATE), announces LOCKED, holds for ~800ms, then releases.
    const lockScript = [
      'import { DatabaseSync } from "node:sqlite";',
      'const db = new DatabaseSync(process.env.TAMANDUA_DB_PATH);',
      'db.exec("CREATE TABLE seed (x INTEGER)");',
      'db.exec("BEGIN IMMEDIATE");',
      'db.prepare("INSERT INTO seed VALUES (1)").run();',
      'console.log("LOCKED");',
      'setTimeout(() => { try { db.exec("ROLLBACK"); } catch {} db.close(); process.exit(0); }, 800);',
      'setTimeout(() => process.exit(0), 5000);',
    ].join("\n");

    const locker = spawn(process.execPath, ["--input-type=module", "-e", lockScript], {
      env: envFor(th.homeDir, dbPath),
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      // Wait until the locker genuinely holds the write lock.
      await new Promise<void>((resolve, reject) => {
        let out = "";
        const onData = (chunk: Buffer) => {
          out += chunk.toString("utf-8");
          if (out.includes("LOCKED")) resolve();
        };
        locker.stdout?.on("data", onData);
        locker.on("error", reject);
        locker.on("close", (code) => {
          if (!out.includes("LOCKED")) {
            reject(new Error(`locker exited (${code}) before acquiring the lock:\n${out}`));
          }
        });
      });

      // Runner: getDb() races the held lock. Without the retry it throws
      // "database is locked" immediately and exits non-zero; with it, it
      // waits for the release and reaches WAL.
      const runnerScript = [
        `import { getDb } from ${JSON.stringify(path.join(distDir(), "db.js"))};`,
        "const db = getDb();",
        'console.log(JSON.stringify(db.prepare("PRAGMA journal_mode").get()));',
      ].join("\n");

      const result = execFileSync(
        process.execPath,
        ["--input-type=module", "-e", runnerScript],
        {
          cwd: distDir(),
          env: envFor(th.homeDir, dbPath),
          encoding: "utf-8",
        },
      ).trim();

      assert.match(
        result,
        /"journal_mode"\s*:\s*"wal"/i,
        `getDb() should recover from a concurrent WAL initializer, got: ${result}`,
      );
    } finally {
      if (locker.exitCode === null && locker.pid) {
        locker.kill("SIGKILL");
      }
      await new Promise<void>((resolve) => {
        if (locker.exitCode !== null) resolve();
        else locker.once("close", () => resolve());
      });
    }
  });
});

// ── US-006: monotonic lock deadlines ────────────────────────────────
//
// The WAL-init and migration-lock retry budgets are in-process intervals and
// must be enforced with the monotonic Deadline helper, so a wall-clock jump
// cannot make a bounded retry loop expire early (or run long).
describe("US-006 monotonic lock deadlines", () => {
  /** A fake DatabaseSync whose `exec` throws "database is locked" N times. */
  function lockedDb(failTimes: number): { db: DatabaseSync; calls: () => number } {
    let calls = 0;
    const fake = {
      exec(_sql: string): void {
        calls += 1;
        if (calls <= failTimes) throw new Error("database is locked");
      },
    };
    return { db: fake as unknown as DatabaseSync, calls: () => calls };
  }

  it("WAL-init retry budget retries through a forward wall-clock jump", () => {
    const { db, calls } = lockedDb(3);
    const realDateNow = Date.now;
    let reads = 0;
    // An epoch-based deadline (`Date.now() + TIMEOUT`) would expire on the
    // first locked error under this +1-day-per-read jump; the monotonic
    // deadline ignores Date.now entirely and keeps retrying to success.
    Date.now = () => realDateNow() + (++reads) * 86_400_000;
    try {
      assert.doesNotThrow(() => _enableWalModeForTest(db));
      assert.equal(calls(), 4, "WAL-init should retry each locked error before succeeding");
    } finally {
      Date.now = realDateNow;
    }
  });

  it("migration-lock retry budget retries through a forward wall-clock jump", () => {
    const { db, calls } = lockedDb(3);
    const realDateNow = Date.now;
    let reads = 0;
    Date.now = () => realDateNow() + (++reads) * 86_400_000;
    try {
      assert.doesNotThrow(() => _acquireMigrationLockForTest(db));
      assert.equal(calls(), 4, "migration lock should retry each locked error before succeeding");
    } finally {
      Date.now = realDateNow;
    }
  });

  it("WAL-init retry budget is bounded by the injected monotonic clock", () => {
    const db = lockedDb(Number.MAX_SAFE_INTEGER).db;
    // origin read -> 0ms; the first expiry check -> 20s, past the 10s budget.
    let reads = 0;
    const clock = (): number => {
      reads += 1;
      return reads === 1 ? 0 : 20_000;
    };
    assert.throws(() => _enableWalModeForTest(db, clock), /database is locked/);
    assert.equal(reads, 2, "the deadline should be read once at construction and once per expiry check");
  });

  it("migration-lock retry budget is bounded by the injected monotonic clock", () => {
    const db = lockedDb(Number.MAX_SAFE_INTEGER).db;
    let reads = 0;
    const clock = (): number => {
      reads += 1;
      return reads === 1 ? 0 : 30_000;
    };
    assert.throws(() => _acquireMigrationLockForTest(db, clock), /database is locked/);
    assert.equal(reads, 2, "the deadline should be read once at construction and once per expiry check");
  });

  it("retry loops keep their non-lock errors fatal", () => {
    const otherError = (() => {
      const fake = {
        exec(): void {
          throw new Error("some other sqlite failure");
        },
      };
      return fake as unknown as DatabaseSync;
    })();
    assert.throws(() => _enableWalModeForTest(otherError), /some other sqlite failure/);
    assert.throws(() => _acquireMigrationLockForTest(otherError), /some other sqlite failure/);
  });
});

describe("cross-process migration serialization", () => {
  function distDir(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
  }

  function envFor(homeDir: string, dbPath: string): NodeJS.ProcessEnv {
    return {
      HOME: homeDir,
      TAMANDUA_DB_PATH: dbPath,
      TAMANDUA_TEST_GUARD: "1",
      PATH: process.env.PATH ?? "",
    };
  }

  // Regression: without cross-process serialization, two cold-start
  // initializers both read the pre-migration `PRAGMA user_version` and both
  // ran the guarded ALTER TABLEs; the loser aborted with
  // "duplicate column name: <col>" — the same failure the fast-e2e gate
  // surfaced as `Workflow run failed (exit 1)`. Concurrent first-openers must
  // converge: the loser re-reads the version under the write lock and skips
  // the DDL instead of racing it.
  it("serializes concurrent first-open migrations instead of racing ALTER TABLEs", async () => {
    const CONCURRENCY = 8;
    const ITERATIONS = 6;
    const childScript = [
      `import { getDb } from ${JSON.stringify(path.join(distDir(), "db.js"))};`,
      "try {",
      "  const db = getDb();",
      '  const v = db.prepare("PRAGMA user_version").get();',
      '  process.stdout.write("OK:" + JSON.stringify(v));',
      "} catch (err) {",
      '  process.stderr.write(String(err && err.message ? err.message : err));',
      "  process.exit(3);",
      "}",
    ].join("\n");

    const failures: string[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const th = createTempHome(`tamandua-db-migrate-race-${i}-`);
      const dbPath = path.join(th.root, "tamandua.db");
      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, () =>
          new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
            const p = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
              cwd: distDir(),
              env: envFor(th.homeDir, dbPath),
              stdio: ["ignore", "pipe", "pipe"],
            });
            let out = "";
            let err = "";
            p.stdout?.on("data", (d: Buffer) => (out += d.toString("utf-8")));
            p.stderr?.on("data", (d: Buffer) => (err += d.toString("utf-8")));
            p.on("error", (e) => resolve({ code: -1, out, err: `${err}${e.message}` }));
            p.on("close", (code) => resolve({ code, out, err }));
          }),
        ),
      );
      for (const [j, r] of results.entries()) {
        if (r.code !== 0) {
          failures.push(`iter ${i} child ${j}: rc=${r.code} stderr=${r.err.trim()}`);
        } else if (!r.out.includes(`"user_version":${SCHEMA_VERSION}`) && !r.out.includes(`"user_version": ${SCHEMA_VERSION}`)) {
          failures.push(`iter ${i} child ${j}: unexpected user_version output ${r.out.trim()}`);
        }
      }
    }
    assert.deepEqual(
      failures,
      [],
      `concurrent getDb() must serialize the migration:\n${failures.join("\n")}`,
    );
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
      "resume_reset_count",
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
    assert.ok(stepCols.has("terminal_reroute_count"), "steps.terminal_reroute_count should exist");
    assert.ok(stepCols.has("target_moved_reroute_count"), "steps.target_moved_reroute_count should exist");
    assert.ok(stepCols.has("preclaim_death_count"), "steps.preclaim_death_count should exist");

    const storyCols = columnNames(db, "stories");
    assert.ok(storyCols.has("id"), "stories.id should exist");
    assert.ok(storyCols.has("retry_count"), "stories.retry_count should exist");
    assert.ok(storyCols.has("status"), "stories.status should exist");
  });
});

describe("YSE stories resume_reset_count migration", () => {
  // YSE US-001: stories.resume_reset_count durably records how many times a
  // workflow resume has re-queued a FAILED loop story back to pending. The
  // column is INTEGER NOT NULL DEFAULT 0, added to the fresh-DDL CREATE TABLE
  // AND via a guarded idempotent ALTER for pre-existing DBs, with
  // SCHEMA_VERSION bumped (v7 → v8) so existing v7 installs actually run the
  // migration (the WLST5.1 failure mode). Existing rows read back 0.

  let origHome: string | undefined;
  let origDbPath: string | undefined;

  function distDir(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
  }

  // Pre-YSE (v7) runs/steps/stories schema: identical to the current shape
  // except stories lacks resume_reset_count.
  const LEGACY_V7_DDL = `
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      notify_url TEXT,
      scheduling_status TEXT,
      scheduling_requested_at TEXT,
      scheduling_error TEXT,
      worker_lost_count INTEGER NOT NULL DEFAULT 0,
      ceiling_expiry_count INTEGER NOT NULL DEFAULT 0,
      parent_run_id TEXT,
      instant_fail_count INTEGER NOT NULL DEFAULT 0,
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
      terminal_reroute_count INTEGER DEFAULT 0,
      ledger_concession_count INTEGER DEFAULT 0,
      claim_invalidated_by TEXT,
      conditional_condition TEXT,
      auto_completed INTEGER NOT NULL DEFAULT 0,
      auto_complete_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE stories (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      story_index INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      abandoned_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO runs (
      id, run_number, workflow_id, task, status, context, tokens_spent,
      worker_lost_count, ceiling_expiry_count, instant_fail_count,
      created_at, updated_at
    ) VALUES (
      'legacy-run', 1, 'workflow', 'task', 'running', '{}', 0, 0, 0, 0,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO stories (
      id, run_id, story_index, story_id, title, status, retry_count,
      max_retries, abandoned_count, created_at, updated_at
    ) VALUES
      ('legacy-story-1', 'legacy-run', 0, 'US-001', 'Story one', 'done', 1, 4, 0,
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('legacy-story-2', 'legacy-run', 1, 'US-002', 'Story two', 'pending', 0, 4, 0,
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `;

  function runInSubprocess(
    th: { homeDir: string },
    dbPath: string,
    script: string,
  ): string {
    return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: distDir(),
      env: {
        HOME: th.homeDir,
        TAMANDUA_DB_PATH: dbPath,
        TAMANDUA_TEST_GUARD: "1",
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    }).trim();
  }

  before(() => {
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
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

  it("fresh DB: stories table has resume_reset_count INTEGER NOT NULL DEFAULT 0", () => {
    const th = createTempHome("tamandua-yse-fresh-");
    const dbPath = path.join(th.root, "fresh.db");
    const script = [
      `import { getDb, SCHEMA_VERSION } from ${JSON.stringify(path.join(distDir(), "db.js"))};`,
      "const db = getDb();",
      'const col = db.prepare("PRAGMA table_info(stories)").all().find((c) => c.name === "resume_reset_count");',
      'const ver = db.prepare("PRAGMA user_version").get();',
      "console.log(JSON.stringify({ col, user_version: ver.user_version }));",
    ].join("\n");

    const result = runInSubprocess(th, dbPath, script);
    const parsed = JSON.parse(result) as {
      col?: { type: string; notnull: number; dflt_value: string | null };
      user_version: number;
    };

    assert.equal(parsed.user_version, SCHEMA_VERSION,
      `fresh DB should be stamped at ${SCHEMA_VERSION}`);
    assert.ok(parsed.col, "resume_reset_count column should exist on a fresh DB");
    assert.equal(parsed.col.type, "INTEGER", "resume_reset_count should be INTEGER");
    assert.equal(parsed.col.notnull, 1, "resume_reset_count should be NOT NULL");
    assert.equal(parsed.col.dflt_value, "0", "resume_reset_count should default to 0");
  });

  it("migrates a pre-YSE (v7) DB: adds resume_reset_count, pre-existing rows read back 0", () => {
    const PRE_YSE_SCHEMA_VERSION = SCHEMA_VERSION - 1;

    const th = createTempHome("tamandua-yse-migrate-");
    const dbPath = path.join(th.root, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      ${LEGACY_V7_DDL}
      PRAGMA user_version = ${PRE_YSE_SCHEMA_VERSION};
    `);
    // Sanity: the legacy DB really is in the pre-YSE state (the exact broken
    // state a real pre-v8 install carries: user_version at the pre-bump value
    // with a stories table lacking the column).
    const preCols = legacyDb.prepare("PRAGMA table_info(stories)").all() as Array<{ name: string }>;
    assert.ok(preCols.some((c) => c.name === "abandoned_count"), "precondition: legacy stories has abandoned_count");
    assert.ok(!preCols.some((c) => c.name === "resume_reset_count"), "precondition: legacy stories lacks resume_reset_count");
    const preVer = legacyDb.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(preVer.user_version, PRE_YSE_SCHEMA_VERSION, "precondition: user_version is the pre-bump version");
    legacyDb.close();

    // Spawn a fresh subprocess so getDb() runs migrate() from scratch on the legacy file.
    const script = [
      `import { getDb, SCHEMA_VERSION } from ${JSON.stringify(path.join(distDir(), "db.js"))};`,
      "const db = getDb();",
      'const col = db.prepare("PRAGMA table_info(stories)").all().find((c) => c.name === "resume_reset_count");',
      'const ver = db.prepare("PRAGMA user_version").get();',
      // SELECT exercising the new column — must not throw and must read 0.
      'const rows = db.prepare("SELECT id, resume_reset_count FROM stories WHERE run_id = ? ORDER BY story_index ASC").all("legacy-run");',
      "console.log(JSON.stringify({ col, user_version: ver.user_version, rows }));",
    ].join("\n");

    const result = runInSubprocess(th, dbPath, script);
    const migrated = JSON.parse(result) as {
      col?: { type: string; notnull: number; dflt_value: string | null };
      user_version: number;
      rows: Array<{ id: string; resume_reset_count: number }>;
    };

    assert.ok(migrated.col, "resume_reset_count column should be added by migration");
    assert.equal(migrated.col.type, "INTEGER", "resume_reset_count should be INTEGER");
    assert.equal(migrated.col.notnull, 1, "resume_reset_count should be NOT NULL");
    assert.equal(migrated.col.dflt_value, "0", "resume_reset_count should default to 0");
    assert.equal(migrated.user_version, SCHEMA_VERSION,
      `legacy DB should be re-stamped to ${SCHEMA_VERSION} (not stuck at the pre-bump version)`);
    assert.deepEqual(migrated.rows, [
      { id: "legacy-story-1", resume_reset_count: 0 },
      { id: "legacy-story-2", resume_reset_count: 0 },
    ], "pre-existing story rows read back resume_reset_count = 0 after migration");
  });

  it("migration is idempotent: repeated migration does not duplicate the column", () => {
    const PRE_YSE_SCHEMA_VERSION = SCHEMA_VERSION - 1;

    const th = createTempHome("tamandua-yse-idempotent-");
    const dbPath = path.join(th.root, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      ${LEGACY_V7_DDL}
      PRAGMA user_version = ${PRE_YSE_SCHEMA_VERSION};
    `);
    legacyDb.close();

    const script = [
      `import { getDb } from ${JSON.stringify(path.join(distDir(), "db.js"))};`,
      "const db = getDb();",
      'const count = db.prepare("PRAGMA table_info(stories)").all().filter((c) => c.name === "resume_reset_count").length;',
      'const ver = db.prepare("PRAGMA user_version").get();',
      "console.log(JSON.stringify({ count, user_version: ver.user_version }));",
    ].join("\n");

    // Migrate twice (two separate subprocesses) — second run must not error or duplicate.
    const first = JSON.parse(runInSubprocess(th, dbPath, script)) as {
      count: number;
      user_version: number;
    };
    const second = JSON.parse(runInSubprocess(th, dbPath, script)) as {
      count: number;
      user_version: number;
    };
    assert.equal(first.count, 1, "resume_reset_count should appear exactly once after first migration");
    assert.equal(second.count, 1, "resume_reset_count must not be duplicated by repeated migration");
    assert.equal(second.user_version, SCHEMA_VERSION,
      "repeated migration should keep user_version stamped at SCHEMA_VERSION");
  });
});

describe("IFLB harness probe persistence columns migration", () => {
  // IFLB US-001: runs.harness_probe_status (TEXT, NULL = never probed; later
  // 'probing' | 'ok' | 'failed') + runs.harness_probe_at (TEXT, NULL = never
  // probed; ISO timestamp when the probe outcome was recorded) durably record
  // the launch-time harness probe outcome so the dispatch motor probes a run
  // exactly ONCE and a daemon restart does not re-probe a passed run. Both are
  // nullable with no backfill, added to the runs table via guarded idempotent
  // ALTERs (the runs CREATE TABLE keeps its explicit column list unchanged),
  // with SCHEMA_VERSION bumped (v8 → v9) so existing v8 installs actually run
  // the migration (the WLST5.1 failure mode). Existing rows read back NULL.

  let origHome: string | undefined;
  let origDbPath: string | undefined;

  function distDir(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
  }

  // Pre-IFLB (v8) runs schema: identical to the current shape except runs
  // lacks harness_probe_status and harness_probe_at.
  const LEGACY_V8_DDL = `
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      notify_url TEXT,
      scheduling_status TEXT,
      scheduling_requested_at TEXT,
      scheduling_error TEXT,
      worker_lost_count INTEGER NOT NULL DEFAULT 0,
      ceiling_expiry_count INTEGER NOT NULL DEFAULT 0,
      parent_run_id TEXT,
      instant_fail_count INTEGER NOT NULL DEFAULT 0,
      test_cmd_established TEXT,
      test_cmd_source TEXT,
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
      terminal_reroute_count INTEGER DEFAULT 0,
      ledger_concession_count INTEGER DEFAULT 0,
      claim_invalidated_by TEXT,
      conditional_condition TEXT,
      auto_completed INTEGER NOT NULL DEFAULT 0,
      auto_complete_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE stories (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      story_index INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      abandoned_count INTEGER DEFAULT 0,
      resume_reset_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO runs (
      id, run_number, workflow_id, task, status, context, tokens_spent,
      worker_lost_count, ceiling_expiry_count, instant_fail_count,
      created_at, updated_at
    ) VALUES (
      'legacy-run', 1, 'workflow', 'task', 'running', '{}', 42, 3, 0, 2,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
  `;

  function runInSubprocess(
    th: { homeDir: string },
    dbPath: string,
    script: string,
  ): string {
    return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: distDir(),
      env: {
        HOME: th.homeDir,
        TAMANDUA_DB_PATH: dbPath,
        TAMANDUA_TEST_GUARD: "1",
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    }).trim();
  }

  before(() => {
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
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

  it("fresh DB: runs has both harness probe columns at SCHEMA_VERSION", () => {
    const th = createTempHome("tamandua-iflb-fresh-");
    const dbPath = path.join(th.root, "fresh.db");
    const script = [
      `import { getDb, SCHEMA_VERSION } from ${JSON.stringify(path.join(distDir(), "db.js"))};`,
      "const db = getDb();",
      'const statusCol = db.prepare("PRAGMA table_info(runs)").all().find((c) => c.name === "harness_probe_status");',
      'const atCol = db.prepare("PRAGMA table_info(runs)").all().find((c) => c.name === "harness_probe_at");',
      'const ver = db.prepare("PRAGMA user_version").get();',
      "console.log(JSON.stringify({ statusCol, atCol, user_version: ver.user_version }));",
    ].join("\n");

    const result = runInSubprocess(th, dbPath, script);
    const parsed = JSON.parse(result) as {
      statusCol?: { type: string; notnull: number; dflt_value: string | null };
      atCol?: { type: string; notnull: number; dflt_value: string | null };
      user_version: number;
    };

    assert.equal(parsed.user_version, SCHEMA_VERSION,
      `fresh DB should be stamped at ${SCHEMA_VERSION}`);
    assert.ok(parsed.statusCol, "harness_probe_status column should exist on a fresh DB");
    assert.equal(parsed.statusCol.type, "TEXT", "harness_probe_status should be TEXT");
    assert.equal(parsed.statusCol.notnull, 0, "harness_probe_status should be nullable");
    assert.equal(parsed.statusCol.dflt_value, null, "harness_probe_status should have no default");
    assert.ok(parsed.atCol, "harness_probe_at column should exist on a fresh DB");
    assert.equal(parsed.atCol.type, "TEXT", "harness_probe_at should be TEXT");
    assert.equal(parsed.atCol.notnull, 0, "harness_probe_at should be nullable");
    assert.equal(parsed.atCol.dflt_value, null, "harness_probe_at should have no default");
  });

  it("migrates a pre-IFLB (v8) DB: adds both columns, re-stamps version, status SELECT works", () => {
    // Regression for the WLST5.1 failure mode: adding the guarded harness
    // probe ALTERs without bumping SCHEMA_VERSION would leave every existing
    // DB (user_version === SCHEMA_VERSION) early-returned and skipping the
    // migration — the dispatch motor's probe status reads then crash with
    // "no such column: harness_probe_status". This fixture is the exact
    // broken state a real pre-v9 install carries: user_version at the
    // pre-bump version with a runs table lacking the columns.
    const PRE_IFLB_SCHEMA_VERSION = SCHEMA_VERSION - 1;

    const th = createTempHome("tamandua-iflb-migrate-");
    const dbPath = path.join(th.root, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      ${LEGACY_V8_DDL}
      PRAGMA user_version = ${PRE_IFLB_SCHEMA_VERSION};
    `);
    // Sanity: the legacy DB really is in the pre-IFLB broken state.
    const preCols = legacyDb.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    assert.ok(preCols.some((c) => c.name === "instant_fail_count"), "precondition: legacy runs has instant_fail_count");
    assert.ok(preCols.some((c) => c.name === "test_cmd_established"), "precondition: legacy runs has test_cmd_established");
    assert.ok(!preCols.some((c) => c.name === "harness_probe_status"), "precondition: legacy runs lacks harness_probe_status");
    assert.ok(!preCols.some((c) => c.name === "harness_probe_at"), "precondition: legacy runs lacks harness_probe_at");
    const preVer = legacyDb.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(preVer.user_version, PRE_IFLB_SCHEMA_VERSION, "precondition: user_version is the pre-bump version");
    legacyDb.close();

    // Spawn a fresh subprocess so getDb() runs migrate() from scratch on the legacy file.
    const script = [
      `import { getDb, SCHEMA_VERSION } from ${JSON.stringify(path.join(distDir(), "db.js"))};`,
      "const db = getDb();",
      'const statusCol = db.prepare("PRAGMA table_info(runs)").all().find((c) => c.name === "harness_probe_status");',
      'const atCol = db.prepare("PRAGMA table_info(runs)").all().find((c) => c.name === "harness_probe_at");',
      'const ver = db.prepare("PRAGMA user_version").get();',
      // The exact status SELECT shape from src/installer/status.ts — extended
      // with the new columns; must no longer throw and must read NULL.
      'const row = db.prepare("SELECT id, run_number, workflow_id, task, status, context, created_at, updated_at, tokens_spent, worker_lost_count, ceiling_expiry_count, instant_fail_count, harness_probe_status, harness_probe_at FROM runs WHERE id = ?").get("legacy-run");',
      "console.log(JSON.stringify({ statusCol, atCol, user_version: ver.user_version, row }));",
    ].join("\n");

    const result = runInSubprocess(th, dbPath, script);
    const migrated = JSON.parse(result) as {
      statusCol?: { type: string; notnull: number; dflt_value: string | null };
      atCol?: { type: string; notnull: number; dflt_value: string | null };
      user_version: number;
      row: {
        id: string;
        instant_fail_count: number;
        worker_lost_count: number;
        ceiling_expiry_count: number;
        harness_probe_status: string | null;
        harness_probe_at: string | null;
      };
    };

    assert.ok(migrated.statusCol, "harness_probe_status column should be added by migration");
    assert.equal(migrated.statusCol.type, "TEXT", "harness_probe_status should be TEXT");
    assert.equal(migrated.statusCol.notnull, 0, "harness_probe_status should be nullable");
    assert.equal(migrated.statusCol.dflt_value, null, "harness_probe_status should have no default");
    assert.ok(migrated.atCol, "harness_probe_at column should be added by migration");
    assert.equal(migrated.atCol.type, "TEXT", "harness_probe_at should be TEXT");
    assert.equal(migrated.atCol.notnull, 0, "harness_probe_at should be nullable");
    assert.equal(migrated.atCol.dflt_value, null, "harness_probe_at should have no default");
    assert.equal(migrated.user_version, SCHEMA_VERSION,
      `user_version should be re-stamped to ${SCHEMA_VERSION} (not stuck at the pre-bump version)`);
    assert.equal(migrated.row.harness_probe_status, null, "legacy row reads back harness_probe_status = NULL (never probed)");
    assert.equal(migrated.row.harness_probe_at, null, "legacy row reads back harness_probe_at = NULL (never probed)");
    assert.equal(migrated.row.instant_fail_count, 2, "existing RSPN counter untouched");
    assert.equal(migrated.row.worker_lost_count, 3, "existing WLST5 counters untouched");
    assert.equal(migrated.row.ceiling_expiry_count, 0, "existing WLST5 counters untouched");
  });

  it("migration is idempotent: repeated migration does not duplicate the columns", () => {
    const PRE_IFLB_SCHEMA_VERSION = SCHEMA_VERSION - 1;

    const th = createTempHome("tamandua-iflb-idempotent-");
    const dbPath = path.join(th.root, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      ${LEGACY_V8_DDL}
      PRAGMA user_version = ${PRE_IFLB_SCHEMA_VERSION};
    `);
    legacyDb.close();

    const script = [
      `import { getDb, SCHEMA_VERSION } from ${JSON.stringify(path.join(distDir(), "db.js"))};`,
      "const db = getDb();",
      'const count = (n) => db.prepare("PRAGMA table_info(runs)").all().filter((c) => c.name === n).length;',
      'const ver = db.prepare("PRAGMA user_version").get();',
      "console.log(JSON.stringify({ status: count('harness_probe_status'), at: count('harness_probe_at'), user_version: ver.user_version }));",
    ].join("\n");

    // Migrate twice (two separate subprocesses) — second run must not error or duplicate.
    const first = JSON.parse(runInSubprocess(th, dbPath, script)) as {
      status: number;
      at: number;
      user_version: number;
    };
    const second = JSON.parse(runInSubprocess(th, dbPath, script)) as {
      status: number;
      at: number;
      user_version: number;
    };
    assert.equal(first.status, 1, "harness_probe_status should appear exactly once after first migration");
    assert.equal(first.at, 1, "harness_probe_at should appear exactly once after first migration");
    assert.equal(second.status, 1, "harness_probe_status must not be duplicated by repeated migration");
    assert.equal(second.at, 1, "harness_probe_at must not be duplicated by repeated migration");
    assert.equal(second.user_version, SCHEMA_VERSION,
      "repeated migration should keep user_version stamped at SCHEMA_VERSION");
  });
});

describe("TIME-STORAGE instant migration (v10)", () => {
  // TIME-STORAGE US-002: migrateInstantsToIsoZ() rewrites every legacy naive
  // UTC instant (`YYYY-MM-DD HH:MM:SS`, 19 chars) in every timestamp column to
  // the canonical ISO-8601 UTC form with milliseconds and `Z`
  // (`YYYY-MM-DDTHH:MM:SS.000Z`). ISO-Z values, values with a real offset,
  // NULLs and non-timestamp strings stay byte-identical, so the migration is
  // idempotent. SCHEMA_VERSION is bumped 9 → 10 so existing DBs (user_version
  // === 9) actually run applySchema() instead of early-returning.

  let origHome: string | undefined;
  let origDbPath: string | undefined;

  function distDir(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
  }

  function runInSubprocess(
    th: { homeDir: string },
    dbPath: string,
    script: string,
  ): string {
    return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: distDir(),
      env: {
        HOME: th.homeDir,
        TAMANDUA_DB_PATH: dbPath,
        TAMANDUA_TEST_GUARD: "1",
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    }).trim();
  }

  // Boot the full current schema at v11 through the real getDb()/applySchema
  // path, so the fixture shapes are exactly production shapes.
  function bootCurrentSchema(th: { homeDir: string }, dbPath: string): void {
    runInSubprocess(
      th,
      dbPath,
      `import { getDb } from ${JSON.stringify(path.join(distDir(), "db.js"))}; getDb();`,
    );
  }

  // Seed a fixture that mixes naive, ISO-Z, offset, NULL, empty and
  // non-timestamp values across every table/column in the migration map, then
  // rewind user_version to the pre-v11 value so getDb() takes the migration
  // path. medic_checks is created here (it is NOT created by applySchema) to
  // prove an existing medic_checks.checked_at is normalized too.
  function seedMixedFixture(dbPath: string): void {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      INSERT INTO runs (id, workflow_id, task, created_at, updated_at, scheduling_requested_at, harness_probe_at) VALUES
        ('r-mixed', 'wf', 't', '2026-01-02 03:04:05', '2026-01-02T03:04:05.678Z', '2026-03-04 05:06:07', 'not-a-timestamp'),
        ('r-offset', 'wf', 't', '2026-05-06T07:08:09+03:00', '2026-01-01 00:00:00', NULL, '');

      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, created_at, updated_at, claim_updated_at) VALUES
        ('s-mixed', 'r-mixed', 'step', 'agent', 0, 'in', '{}', '2026-06-07 08:09:10', '2026-06-07T08:09:11.000Z', NULL),
        ('s-claim', 'r-mixed', 'step', 'agent', 1, 'in', '{}', '2026-06-07T08:09:12.000Z', '2026-06-07T08:09:13.000Z', '2026-06-07 08:09:14');

      INSERT INTO stories (id, run_id, story_index, story_id, title, created_at, updated_at) VALUES
        ('st-mixed', 'r-mixed', 0, 'US-1', 'title', '2026-07-08 09:10:11', '2026-07-08T09:10:12.000Z');

      INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, created_at) VALUES
        ('ab1', 'US-1', 'r-mixed', 'reason', 1, '2026-08-09 10:11:12');

      INSERT INTO run_worktrees (run_id, worktree_origin_repository, worktree_origin_git_common_dir, worktree_path, created_at, removed_at) VALUES
        ('r-mixed', '/x', '/x/.git', '/x/wt', '2026-09-10 11:12:13', NULL),
        ('r-offset', '/x', '/x/.git', '/x/wt2', '2026-09-11T12:13:14.000Z', '2026-09-12 13:14:15');

      INSERT INTO autoresearch_sessions (id, cwd, created_at, updated_at, last_seen_at, last_run_at) VALUES
        ('ar1', '/x', '2026-10-11 13:14:15', '2026-10-11T13:14:16.000Z', '2026-10-12 14:15:16', NULL),
        ('ar2', '/y', '2026-10-11T13:14:17.000Z', '2026-10-11T13:14:18.000Z', '2026-10-12T14:15:19.000Z', '2026-10-13 15:16:17');

      INSERT INTO suite_results (id, origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, created_at) VALUES
        (1, '/x', 'th', 'ch', 'npm test', 0, 5, '2026-11-12 16:17:18');

      CREATE TABLE IF NOT EXISTS medic_checks (
        id TEXT PRIMARY KEY,
        checked_at TEXT NOT NULL,
        issues_found INTEGER DEFAULT 0,
        actions_taken INTEGER DEFAULT 0,
        summary TEXT,
        details TEXT
      );
      INSERT INTO medic_checks (id, checked_at) VALUES ('m1', '2026-12-13 17:18:19');

      PRAGMA user_version = ${SCHEMA_VERSION - 1};
    `);
    db.close();
  }

  // Opens the DB through getDb() (running the migration on the slow path when
  // user_version is stale) and dumps every mapped timestamp column. With
  // `rerun` the normalization SQL is executed twice more explicitly, proving
  // the rewrite itself is idempotent rather than merely skipped by the fast
  // path.
  function dumpInstants(
    th: { homeDir: string },
    dbPath: string,
    rerun = false,
  ): { version: number; rows: Record<string, unknown> } {
    const script = `
import { getDb, migrateInstantsToIsoZ } from ${JSON.stringify(path.join(distDir(), "db.js"))};
const db = getDb();
${rerun ? "migrateInstantsToIsoZ(db); migrateInstantsToIsoZ(db);" : ""}
const rows = {};
rows.runs = db.prepare("SELECT id, created_at, updated_at, scheduling_requested_at, harness_probe_at FROM runs ORDER BY id").all();
rows.steps = db.prepare("SELECT id, created_at, updated_at, claim_updated_at FROM steps ORDER BY id").all();
rows.stories = db.prepare("SELECT id, created_at, updated_at FROM stories ORDER BY id").all();
rows.story_abandonments = db.prepare("SELECT id, created_at FROM story_abandonments ORDER BY id").all();
rows.run_worktrees = db.prepare("SELECT run_id, created_at, removed_at FROM run_worktrees ORDER BY run_id").all();
rows.autoresearch_sessions = db.prepare("SELECT id, created_at, updated_at, last_seen_at, last_run_at FROM autoresearch_sessions ORDER BY id").all();
rows.suite_results = db.prepare("SELECT id, created_at FROM suite_results ORDER BY id").all();
rows.medic_checks = db.prepare("SELECT id, checked_at FROM medic_checks ORDER BY id").all();
const version = db.prepare("PRAGMA user_version").get().user_version;
console.log(JSON.stringify({ version, rows }));
`;
    return JSON.parse(runInSubprocess(th, dbPath, script)) as {
      version: number;
      rows: Record<string, unknown>;
    };
  }

  before(() => {
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
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

  it("SCHEMA_VERSION is 13 (9->10 instants -> 10->11 target-moved reroute budget -> 11->12 preclaim death counter -> 12->13 matchlock policy)", () => {
    assert.equal(
      SCHEMA_VERSION,
      13,
      "SCHEMA_VERSION must be 13 after the union folds runs.matchlock_policy in as the v12->v13 step; the full chain is 9->10 instants, 10->11 target_moved_reroute_count, 11->12 preclaim_death_count, 12->13 matchlock_policy",
    );
  });

  it("mixed-format fixture: rewrites every naive instant, leaves ISO-Z/offset/NULL/other values byte-identical", () => {
    const th = createTempHome("tamandua-instant-mixed-");
    const dbPath = path.join(th.root, "legacy.db");
    bootCurrentSchema(th, dbPath);
    seedMixedFixture(dbPath);

    const { version, rows } = dumpInstants(th, dbPath);

    assert.equal(version, SCHEMA_VERSION, "migration must re-stamp user_version to SCHEMA_VERSION");

    assert.deepEqual(rows.runs, [
      {
        id: "r-mixed",
        created_at: "2026-01-02T03:04:05.000Z",
        updated_at: "2026-01-02T03:04:05.678Z",
        scheduling_requested_at: "2026-03-04T05:06:07.000Z",
        harness_probe_at: "not-a-timestamp",
      },
      {
        id: "r-offset",
        created_at: "2026-05-06T07:08:09+03:00",
        updated_at: "2026-01-01T00:00:00.000Z",
        scheduling_requested_at: null,
        harness_probe_at: "",
      },
    ]);

    assert.deepEqual(rows.steps, [
      {
        id: "s-claim",
        created_at: "2026-06-07T08:09:12.000Z",
        updated_at: "2026-06-07T08:09:13.000Z",
        claim_updated_at: "2026-06-07T08:09:14.000Z",
      },
      {
        id: "s-mixed",
        created_at: "2026-06-07T08:09:10.000Z",
        updated_at: "2026-06-07T08:09:11.000Z",
        claim_updated_at: null,
      },
    ]);

    assert.deepEqual(rows.stories, [
      {
        id: "st-mixed",
        created_at: "2026-07-08T09:10:11.000Z",
        updated_at: "2026-07-08T09:10:12.000Z",
      },
    ]);

    assert.deepEqual(rows.story_abandonments, [
      { id: "ab1", created_at: "2026-08-09T10:11:12.000Z" },
    ]);

    assert.deepEqual(rows.run_worktrees, [
      {
        run_id: "r-mixed",
        created_at: "2026-09-10T11:12:13.000Z",
        removed_at: null,
      },
      {
        run_id: "r-offset",
        created_at: "2026-09-11T12:13:14.000Z",
        removed_at: "2026-09-12T13:14:15.000Z",
      },
    ]);

    assert.deepEqual(rows.autoresearch_sessions, [
      {
        id: "ar1",
        created_at: "2026-10-11T13:14:15.000Z",
        updated_at: "2026-10-11T13:14:16.000Z",
        last_seen_at: "2026-10-12T14:15:16.000Z",
        last_run_at: null,
      },
      {
        id: "ar2",
        created_at: "2026-10-11T13:14:17.000Z",
        updated_at: "2026-10-11T13:14:18.000Z",
        last_seen_at: "2026-10-12T14:15:19.000Z",
        last_run_at: "2026-10-13T15:16:17.000Z",
      },
    ]);

    assert.deepEqual(rows.suite_results, [
      { id: 1, created_at: "2026-11-12T16:17:18.000Z" },
    ]);

    assert.deepEqual(rows.medic_checks, [
      { id: "m1", checked_at: "2026-12-13T17:18:19.000Z" },
    ]);
  });

  it("is idempotent: a second migration and an explicit rerun leave every value unchanged", () => {
    const th = createTempHome("tamandua-instant-idempotent-");
    const dbPath = path.join(th.root, "legacy.db");
    bootCurrentSchema(th, dbPath);
    seedMixedFixture(dbPath);

    const first = dumpInstants(th, dbPath);
    assert.equal(first.version, SCHEMA_VERSION, "first migration stamps SCHEMA_VERSION");

    // Second subprocess: getDb() sees user_version === SCHEMA_VERSION and
    // early-returns, then the normalization SQL runs twice more explicitly.
    const second = dumpInstants(th, dbPath, true);
    assert.equal(second.version, SCHEMA_VERSION, "repeated migration keeps SCHEMA_VERSION");
    assert.deepEqual(second.rows, first.rows, "second migration must not change any value");
  });

  it("does not throw on an empty DB and handles the absent medic_checks table", () => {
    const th = createTempHome("tamandua-instant-empty-");
    const dbPath = path.join(th.root, "fresh.db");

    const out = runInSubprocess(
      th,
      dbPath,
      [
        `import { getDb, SCHEMA_VERSION } from ${JSON.stringify(path.join(distDir(), "db.js"))};`,
        "const db = getDb();",
        'const version = db.prepare("PRAGMA user_version").get().user_version;',
        'const medic = db.prepare("SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'medic_checks\'").all();',
        "console.log(JSON.stringify({ version, expected: SCHEMA_VERSION, medicExists: medic.length }));",
      ].join("\n"),
    );
    const parsed = JSON.parse(out) as { version: number; expected: number; medicExists: number };
    assert.equal(parsed.version, SCHEMA_VERSION, "fresh DB is stamped at SCHEMA_VERSION");
    assert.equal(parsed.expected, SCHEMA_VERSION);
    assert.equal(parsed.medicExists, 0, "fixture precondition: medic_checks is absent at migrate() time");
  });
});

describe("steps ledger_concession_count migration", () => {
  it("adds the column to a legacy steps table without losing rows", () => {
    const th = createTempHome("tamandua-ledger-concession-migration-");
    const dbPath = path.join(th.root, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        context TEXT NOT NULL DEFAULT '{}',
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
      INSERT INTO runs (
        id, workflow_id, task, status, created_at, updated_at
      ) VALUES (
        'legacy-run', 'workflow', 'task', 'running',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO steps (
        id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, created_at, updated_at
      ) VALUES (
        'legacy-step', 'legacy-run', 'finalize_merge', 'merger', 0, '', '',
        'waiting', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      PRAGMA user_version = ${SCHEMA_VERSION - 1};
    `);
    legacyDb.close();

    const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
    const importPath = JSON.stringify(path.join(distDir, "db.js"));
    const script = [
      `import { getDb } from ${importPath};`,
      "const db = getDb();",
      "const column = db.prepare(\"PRAGMA table_info(steps)\").all().find((entry) => entry.name === \"ledger_concession_count\");",
      "const row = db.prepare(\"SELECT id, ledger_concession_count FROM steps WHERE id = 'legacy-step'\").get();",
      "console.log(JSON.stringify({ column, row }));",
    ].join("\n");

    const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: distDir,
      env: {
        HOME: th.homeDir,
        TAMANDUA_DB_PATH: dbPath,
        TAMANDUA_TEST_GUARD: "1",
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });
    const migrated = JSON.parse(result.trim()) as {
      column?: { type: string; dflt_value: string | null };
      row: { id: string; ledger_concession_count: number };
    };

    assert.ok(migrated.column, "ledger_concession_count column should be added");
    assert.equal(migrated.column.type, "INTEGER");
    assert.equal(migrated.column.dflt_value, "0");
    assert.deepEqual(migrated.row, {
      id: "legacy-step",
      ledger_concession_count: 0,
    });
  });

  it("defaults ledger_concession_count to zero for new step rows", () => {
    const th = createTempHome("tamandua-ledger-concession-default-");
    const dbPath = path.join(th.root, "fresh.db");
    const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
    const importPath = JSON.stringify(path.join(distDir, "db.js"));
    const script = [
      `import { getDb } from ${importPath};`,
      "const db = getDb();",
      "const now = new Date().toISOString();",
      "db.prepare(\"INSERT INTO runs (id, workflow_id, task, created_at, updated_at) VALUES (?, ?, ?, ?, ?)\").run('new-run', 'workflow', 'task', now, now);",
      "db.prepare(\"INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)\").run('new-step', 'new-run', 'test', 'tester', 0, '', '', now, now);",
      "console.log(JSON.stringify(db.prepare(\"SELECT ledger_concession_count FROM steps WHERE id = 'new-step'\").get()));",
    ].join("\n");

    const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: distDir,
      env: {
        HOME: th.homeDir,
        TAMANDUA_DB_PATH: dbPath,
        TAMANDUA_TEST_GUARD: "1",
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });

    assert.deepEqual(JSON.parse(result.trim()), { ledger_concession_count: 0 });
  });
});

describe("TATR runs parent_run_id migration", () => {
  // TATR US-001: runs.parent_run_id records which run spawned a child run so
  // graph consumers can discover parent/child linkage. The column is nullable
  // with no backfill — existing rows and runs without a parent keep NULL.

  function distDir(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
  }

  function runMigrateSubprocess(dbPath: string, homeDir: string): void {
    const importPath = JSON.stringify(path.join(distDir(), "db.js"));
    const script = [
      `import { getDb } from ${importPath};`,
      "getDb();",
    ].join("\n");
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: distDir(),
      env: {
        HOME: homeDir,
        TAMANDUA_DB_PATH: dbPath,
        TAMANDUA_TEST_GUARD: "1",
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });
  }

  it("fresh DB: runs table includes nullable parent_run_id TEXT", () => {
    const th = createTempHome("tamandua-tatr-fresh-");
    const dbPath = path.join(th.root, "fresh.db");
    runMigrateSubprocess(dbPath, th.homeDir);

    const db = new DatabaseSync(dbPath);
    try {
      const col = (db.prepare("PRAGMA table_info(runs)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>).find((c) => c.name === "parent_run_id");
      assert.ok(col, "runs.parent_run_id column should exist on a fresh DB");
      assert.equal(col.type, "TEXT", "parent_run_id should be TEXT");
      assert.equal(col.notnull, 0, "parent_run_id should be nullable (notnull = 0)");
      assert.equal(col.dflt_value, null, "parent_run_id should have no default");
      const ver = db.prepare("PRAGMA user_version").get() as { user_version: number };
      assert.equal(ver.user_version, SCHEMA_VERSION, "fresh DB should be stamped at SCHEMA_VERSION");
    } finally {
      db.close();
    }
  });

  it("migrates a legacy DB: adds parent_run_id without touching existing rows (NULL)", () => {
    const th = createTempHome("tamandua-tatr-migrate-");
    const dbPath = path.join(th.root, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    // Pre-TATR (v4) runs schema: has the v4 columns but NOT parent_run_id.
    legacyDb.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        run_number INTEGER,
        workflow_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        context TEXT NOT NULL DEFAULT '{}',
        tokens_spent INTEGER NOT NULL DEFAULT 0,
        notify_url TEXT,
        scheduling_status TEXT,
        scheduling_requested_at TEXT,
        scheduling_error TEXT,
        worker_lost_count INTEGER NOT NULL DEFAULT 0,
        ceiling_expiry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO runs (
        id, run_number, workflow_id, task, status, context, tokens_spent,
        worker_lost_count, ceiling_expiry_count, created_at, updated_at
      ) VALUES (
        'legacy-run', 1, 'workflow', 'task', 'running', '{}', 42, 3, 0,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      PRAGMA user_version = ${SCHEMA_VERSION - 1};
    `);
    // Precondition: legacy DB really is in the pre-TATR state.
    const preCols = legacyDb.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    assert.ok(!preCols.some((c) => c.name === "parent_run_id"), "precondition: legacy runs lacks parent_run_id");
    const preVer = legacyDb.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(preVer.user_version, SCHEMA_VERSION - 1, "precondition: user_version is the pre-bump version");
    legacyDb.close();

    // Spawn a fresh subprocess so getDb() runs migrate() from scratch on the legacy file.
    runMigrateSubprocess(dbPath, th.homeDir);

    const db = new DatabaseSync(dbPath);
    try {
      const col = (db.prepare("PRAGMA table_info(runs)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>).find((c) => c.name === "parent_run_id");
      assert.ok(col, "migration should add parent_run_id to the legacy runs table");
      assert.equal(col.type, "TEXT", "parent_run_id should be TEXT");
      assert.equal(col.notnull, 0, "parent_run_id should be nullable");

      const row = db.prepare(
        "SELECT id, workflow_id, task, status, tokens_spent, worker_lost_count, ceiling_expiry_count, parent_run_id FROM runs WHERE id = 'legacy-run'",
      ).get() as {
        id: string;
        workflow_id: string;
        task: string;
        status: string;
        tokens_spent: number;
        worker_lost_count: number;
        ceiling_expiry_count: number;
        parent_run_id: string | null;
      };
      assert.deepEqual({ ...row }, {
        id: "legacy-run",
        workflow_id: "workflow",
        task: "task",
        status: "running",
        tokens_spent: 42,
        worker_lost_count: 3,
        ceiling_expiry_count: 0,
        parent_run_id: null,
      }, "existing row must be untouched with parent_run_id NULL");

      const ver = db.prepare("PRAGMA user_version").get() as { user_version: number };
      assert.equal(ver.user_version, SCHEMA_VERSION, "legacy DB should be re-stamped at SCHEMA_VERSION");
    } finally {
      db.close();
    }
  });

  it("migration is idempotent: second migrate run keeps parent_run_id and rows", () => {
    const th = createTempHome("tamandua-tatr-idempotent-");
    const dbPath = path.join(th.root, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        context TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO runs (id, workflow_id, task, created_at, updated_at)
      VALUES ('legacy-run', 'workflow', 'task', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      PRAGMA user_version = ${SCHEMA_VERSION - 1};
    `);
    legacyDb.close();

    // Migrate twice (two separate subprocesses) — second run must not error or duplicate.
    runMigrateSubprocess(dbPath, th.homeDir);
    runMigrateSubprocess(dbPath, th.homeDir);

    const db = new DatabaseSync(dbPath);
    try {
      const cols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
      const parentCols = cols.filter((c) => c.name === "parent_run_id");
      assert.equal(parentCols.length, 1, "parent_run_id must appear exactly once after repeated migration");
      const row = db.prepare("SELECT id, parent_run_id FROM runs WHERE id = 'legacy-run'").get() as {
        id: string;
        parent_run_id: string | null;
      };
      assert.equal(row.id, "legacy-run", "existing row must survive repeated migration");
      assert.equal(row.parent_run_id, null, "existing row parent_run_id stays NULL");
    } finally {
      db.close();
    }
  });

  it("inserts a run with parent_run_id set", () => {
    const th = createTempHome("tamandua-tatr-insert-");
    const dbPath = path.join(th.root, "fresh.db");
    const importPath = JSON.stringify(path.join(distDir(), "db.js"));
    const script = [
      `import { getDb } from ${importPath};`,
      "const db = getDb();",
      "const now = new Date().toISOString();",
      "db.prepare(\"INSERT INTO runs (id, workflow_id, task, parent_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)\").run('child-run', 'workflow', 'task', 'parent-run', now, now);",
      "db.prepare(\"INSERT INTO runs (id, workflow_id, task, created_at, updated_at) VALUES (?, ?, ?, ?, ?)\").run('orphan-run', 'workflow', 'task', now, now);",
      "const child = db.prepare(\"SELECT parent_run_id FROM runs WHERE id = 'child-run'\").get();",
      "const orphan = db.prepare(\"SELECT parent_run_id FROM runs WHERE id = 'orphan-run'\").get();",
      "console.log(JSON.stringify({ child, orphan }));",
    ].join("\n");

    const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: distDir(),
      env: {
        HOME: th.homeDir,
        TAMANDUA_DB_PATH: dbPath,
        TAMANDUA_TEST_GUARD: "1",
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });

    assert.deepEqual(JSON.parse(result.trim()), {
      child: { parent_run_id: "parent-run" },
      orphan: { parent_run_id: null },
    });
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

  it("filters by numeric age against an injected now (US-011)", () => {
    const db = getDb();
    const now = Date.UTC(2026, 8, 16, 12, 0, 0);
    const retention = 14 * 24 * 60 * 60 * 1000;

    db.prepare(
      `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("/repo", "injected-old", "cmd-old", "npm test", 0, 100, new Date(now - retention - 1000).toISOString());
    db.prepare(
      `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("/repo", "injected-fresh", "cmd-fresh", "npm test", 0, 100, new Date(now - retention + 1000).toISOString());

    // The injected now drives the decision — a row 14d+1s old relative to
    // `now` is pruned even though it is recent relative to the real clock.
    const pruned = pruneOldSuiteResults(now);
    assert.equal(pruned, 1);

    const oldRow = db.prepare("SELECT tree_hash FROM suite_results WHERE tree_hash = ?").get("injected-old");
    assert.equal(oldRow, undefined, "old row must be pruned");
    const freshRow = db.prepare("SELECT tree_hash FROM suite_results WHERE tree_hash = ?").get("injected-fresh");
    assert.ok(freshRow, "fresh row must remain");
  });

  it("never prunes an unparseable created_at (US-011 safe skip)", () => {
    const db = getDb();
    const now = Date.UTC(2026, 8, 16, 12, 0, 0);

    db.prepare(
      `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("/repo", "unparseable", "cmd", "npm test", 0, 100, "not-a-timestamp");

    assert.equal(pruneOldSuiteResults(now), 0);
    const row = db.prepare("SELECT tree_hash FROM suite_results WHERE tree_hash = ?").get("unparseable");
    assert.ok(row, "an unknown age must never destroy ledger history");
  });

  it("prunes a legacy naive-UTC row older than the retention window (US-011)", () => {
    const db = getDb();
    const now = Date.UTC(2026, 8, 16, 12, 0, 0);
    // Naive UTC shape written by the old SQLite datetime('now').
    const naiveOld = new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
    db.prepare(
      `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("/repo", "naive-old", "cmd", "npm test", 0, 100, naiveOld);

    assert.equal(pruneOldSuiteResults(now), 1);
    const row = db.prepare("SELECT tree_hash FROM suite_results WHERE tree_hash = ?").get("naive-old");
    assert.equal(row, undefined);
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

    // step_id: TEXT (nullable — no NOT NULL constraint)
    const stepIdCol = colMap.get("step_id");
    assert.ok(stepIdCol, "step_id column should exist");
    assert.equal(stepIdCol.type, "TEXT", "step_id should be TEXT");
    assert.equal(stepIdCol.notnull, 0, "step_id should be nullable (no NOT NULL constraint)");

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
      "id", "story_id", "run_id", "reason", "abandoned_count", "step_id", "created_at",
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

// ── RNUM: atomic run_number allocation concurrency test ──

describe("RNUM: atomic run_number allocation under interleaved connections", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;
  let dbPath: string;

  const th = createTempHome("tamandua-rnum-concurrency-test-");
  before(() => {
    tempHome = th.root;
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = th.homeDir;
    delete process.env.TAMANDUA_DB_PATH;

    // Determine what getDb() would use as its path so we can open
    // independent connections to the same file
    dbPath = path.join(th.homeDir, ".tamandua", "tamandua.db");
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

  function schemaForRunsTable(): string {
    return `
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
      )
    `;
  }

  /**
   * Insert a single run using the atomic subquery approach.
   * Matches the production pattern in src/installer/run.ts after US-001.
   */
  function insertRun(db: DatabaseSync, id: string, workflowId: string, task: string, tokensSpent: number): void {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, (SELECT COALESCE(MAX(run_number), 0) + 1 FROM runs), ?, ?, 'running', '{}', ?, ?, ?)
    `).run(id, workflowId, task, tokensSpent, now, now);
  }

  it("produces distinct run_numbers with interleaved inserts across two connections", () => {
    // Open two independent SQLite connections to the same DB file
    const connA = new DatabaseSync(dbPath);
    const connB = new DatabaseSync(dbPath);

    try {
      // Enable WAL mode on both connections
      connA.exec("PRAGMA journal_mode=WAL");
      connB.exec("PRAGMA journal_mode=WAL");

      // Create the runs table via one connection
      connA.exec(schemaForRunsTable());

      const TOTAL = 20;

      // Interleaved inserts: A, B, A, B, ...
      for (let i = 0; i < TOTAL; i++) {
        const id = `rnum-concurrency-test-${String(i).padStart(3, "0")}`;
        const workflowId = i % 2 === 0 ? "wf-alpha" : "wf-beta";
        const task = `Task for run ${i}`;
        const tokensSpent = i * 10;

        if (i % 2 === 0) {
          insertRun(connA, id, workflowId, task, tokensSpent);
        } else {
          insertRun(connB, id, workflowId, task, tokensSpent);
        }
      }

      // Read all run_numbers back from either connection
      const rows = connA.prepare(
        "SELECT run_number FROM runs WHERE id LIKE 'rnum-concurrency-test-%' ORDER BY run_number"
      ).all() as Array<{ run_number: number }>;

      // Assert the right number of rows
      assert.equal(rows.length, TOTAL, `should have inserted ${TOTAL} runs`);

      // Extract run_numbers
      const runNumbers = rows.map((r) => r.run_number);

      // Assert all run_numbers are distinct
      const uniqueRunNumbers = new Set(runNumbers);
      assert.equal(
        uniqueRunNumbers.size,
        TOTAL,
        `all ${TOTAL} run_numbers should be distinct, but found ${uniqueRunNumbers.size} unique values`
      );

      // Assert count of unique run_numbers equals total count of inserted runs
      assert.equal(
        uniqueRunNumbers.size,
        rows.length,
        "unique run_number count must equal total inserted rows"
      );

      // SA-001: run_numbers should be a contiguous sequence starting from 1
      const sorted = [...runNumbers].sort((a, b) => a - b);
      for (let i = 0; i < sorted.length; i++) {
        assert.equal(
          sorted[i],
          i + 1,
          `run_numbers should be contiguous starting at 1; expected ${i + 1} at index ${i}, got ${sorted[i]}`
        );
      }
    } finally {
      connA.close();
      connB.close();
    }
  });

  it("no duplicate run_numbers when connections alternate single inserts", () => {
    // Second scenario: smaller set, different interleaving pattern
    const connA = new DatabaseSync(dbPath);
    const connB = new DatabaseSync(dbPath);

    try {
      connA.exec("PRAGMA journal_mode=WAL");
      connB.exec("PRAGMA journal_mode=WAL");
      connA.exec(schemaForRunsTable());

      const TOTAL = 10;

      // Pattern: A, A, B, B, A, A, B, B, ...
      for (let i = 0; i < TOTAL; i++) {
        const id = `rnum-pair-test-${String(i).padStart(3, "0")}`;
        const conn = Math.floor(i / 2) % 2 === 0 ? connA : connB;
        insertRun(conn, id, "wf-test", `Task ${i}`, 0);
      }

      const rows = connA.prepare(
        "SELECT run_number FROM runs WHERE id LIKE 'rnum-pair-test-%' ORDER BY run_number"
      ).all() as Array<{ run_number: number }>;

      assert.equal(rows.length, TOTAL);

      const runNumbers = rows.map((r) => r.run_number);
      const uniqueRunNumbers = new Set(runNumbers);

      assert.equal(uniqueRunNumbers.size, TOTAL, "all run_numbers must be distinct");
      assert.equal(uniqueRunNumbers.size, rows.length, "unique count equals total count");
    } finally {
      connA.close();
      connB.close();
    }
  });

  it("staggered interleaving with three connections produces no duplicates", () => {
    // Three connections, round-robin pattern
    const connA = new DatabaseSync(dbPath);
    const connB = new DatabaseSync(dbPath);
    const connC = new DatabaseSync(dbPath);

    try {
      connA.exec("PRAGMA journal_mode=WAL");
      connB.exec("PRAGMA journal_mode=WAL");
      connC.exec("PRAGMA journal_mode=WAL");
      connA.exec(schemaForRunsTable());

      const TOTAL = 15;
      const connections = [connA, connB, connC];

      for (let i = 0; i < TOTAL; i++) {
        const id = `rnum-triple-test-${String(i).padStart(3, "0")}`;
        const conn = connections[i % 3];
        insertRun(conn, id, "wf-triple", `Task ${i}`, 0);
      }

      const rows = connA.prepare(
        "SELECT run_number FROM runs WHERE id LIKE 'rnum-triple-test-%' ORDER BY run_number"
      ).all() as Array<{ run_number: number }>;

      assert.equal(rows.length, TOTAL);

      const runNumbers = rows.map((r) => r.run_number);
      const uniqueRunNumbers = new Set(runNumbers);

      assert.equal(uniqueRunNumbers.size, TOTAL, "all run_numbers across three connections must be distinct");
      assert.equal(uniqueRunNumbers.size, rows.length);
    } finally {
      connA.close();
      connB.close();
      connC.close();
    }
  });

  it("run_numbers are assigned in insertion order regardless of connection", () => {
    const connA = new DatabaseSync(dbPath);
    const connB = new DatabaseSync(dbPath);

    try {
      connA.exec("PRAGMA journal_mode=WAL");
      connB.exec("PRAGMA journal_mode=WAL");
      connA.exec(schemaForRunsTable());

      const prefix = "order-";

      // Insert in known order: A, A, B, B, B, A
      const ids = [prefix + "a", prefix + "b", prefix + "c", prefix + "d", prefix + "e", prefix + "f"];
      const connectors = [connA, connA, connB, connB, connB, connA];

      for (let i = 0; i < ids.length; i++) {
        insertRun(connectors[i], ids[i], "wf-order", `Task ${i}`, 0);
      }

      // Read back with ORDER BY run_number — should match insertion order
      const rows = connA.prepare(
        "SELECT id, run_number FROM runs WHERE id IN (?, ?, ?, ?, ?, ?) ORDER BY run_number"
      ).all(...ids) as Array<{ id: string; run_number: number }>;

      assert.equal(rows.length, ids.length);

      // run_number should be monotonically increasing and match insertion order
      for (let i = 0; i < ids.length; i++) {
        assert.equal(rows[i].id, ids[i], `row ${i} should be ${ids[i]} (insertion order preserved)`);
        if (i > 0) {
          assert.ok(
            rows[i].run_number > rows[i - 1].run_number,
            `run_number should increase: ${rows[i].run_number} > ${rows[i - 1].run_number}`
          );
        }
      }
    } finally {
      connA.close();
      connB.close();
    }
  });
});

describe("MIGV schema version short-circuit", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;
  let baselineRuns: number;



  const th = createTempHome("tamandua-migv-");

  before(() => {
    baselineRuns = _migrateFullRuns;
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

  const EXPECTED_TABLES = [
    "runs", "steps", "stories", "story_abandonments",
    "run_worktrees", "autoresearch_sessions", "suite_results",
  ];

  it("fresh DB migration stamps user_version and runs full path once", () => {
    const db = getDb();
    const ver = db.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(ver.user_version, SCHEMA_VERSION,
      `user_version should be ${SCHEMA_VERSION} after fresh migration`);
    assert.equal(_migrateFullRuns - baselineRuns, 1,
      "_migrateFullRuns should have incremented by exactly 1 after first migration");
  });

  it("second getDb() returns early without re-running full migration", () => {
    const beforeRuns = _migrateFullRuns;
    const db = getDb();
    const ver = db.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(ver.user_version, SCHEMA_VERSION,
      `user_version should still be ${SCHEMA_VERSION} after second getDb()`);
    assert.equal(_migrateFullRuns, beforeRuns,
      "_migrateFullRuns should not increment when early-return triggers");
  });

  it("DB stamped with older version runs full path and re-stamps in fresh process", () => {
    // Downgrade user_version on the fully-migrated DB
    const db = getDb();
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);

    // Verify downgrade took effect in-process
    let ver = db.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(ver.user_version, SCHEMA_VERSION - 1,
      "user_version should be downgraded");

    // Spawn a fresh Node process that opens the DB from scratch.
    // Since user_version is stale, migrate() should run the full path
    // and re-stamp to SCHEMA_VERSION.
    const dbPath = getDbPath();
    const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
    const importPath = JSON.stringify(path.join(distDir, "db.js"));
    const script = [
      `import { getDb, SCHEMA_VERSION, _migrateFullRuns } from ${importPath};`,
      `const db = getDb();`,
      `const ver = db.prepare("PRAGMA user_version").get();`,
      `console.log(JSON.stringify({ user_version: ver.user_version, fullRuns: _migrateFullRuns }));`,
    ].join("\n");

    const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: distDir,
      env: {
        HOME: th.homeDir,
        TAMANDUA_DB_PATH: dbPath,
        PATH: process.env.PATH ?? '',
      },
      encoding: "utf-8",
    });

    const parsed = JSON.parse(result.trim());
    assert.equal(parsed.user_version, SCHEMA_VERSION,
      `subprocess user_version should be ${SCHEMA_VERSION} after re-migration`);
    assert.equal(parsed.fullRuns, 1,
      "subprocess should have run full migration exactly once");
  });

  it("all expected tables exist after early-return; no corruption", () => {
    const db = getDb();
    for (const table of EXPECTED_TABLES) {
      assert.ok(tableExists(db, table),
        `table '${table}' should exist after early-return`);
    }
  });
});

describe("MIGV upgrade path (pre-WLST5 DB → current)", () => {
  // Regression test for WLST5.1: WLST5 (5873a9a9) added the guarded
  // ceiling_expiry_count ALTER to migrate() but did NOT bump SCHEMA_VERSION,
  // so every existing DB (user_version === SCHEMA_VERSION) early-returned and
  // skipped the migration — status.ts SELECTs and step-ops.ts UPDATEs crashed
  // with "no such column: ceiling_expiry_count". Every prior test exercised
  // either a fresh DB (full-DDL path, column present) or a downgraded
  // already-migrated DB (column already present), so the exact broken state —
  // user_version == SCHEMA_VERSION with a runs table lacking the column — had
  // zero coverage.

  // Hardcoded, NOT SCHEMA_VERSION - 1: it must equal the version a real
  // pre-WLST5 install carries (the pre-bump value, 3). Deriving it as
  // SCHEMA_VERSION - 1 would make the fixture sit at user_version 2 on the
  // unbumped code, where migrate() still runs (2 != 3) and the test would
  // falsely pass — exactly the regression it exists to catch.
  const PRE_WLST5_SCHEMA_VERSION = 3;

  // Pre-WLST5 (v3) runs/steps/stories schema: includes worker_lost_count but
  // NOT ceiling_expiry_count.
  const LEGACY_DDL = `
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      notify_url TEXT,
      scheduling_status TEXT,
      scheduling_requested_at TEXT,
      scheduling_error TEXT,
      worker_lost_count INTEGER NOT NULL DEFAULT 0,
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
      terminal_reroute_count INTEGER DEFAULT 0,
      ledger_concession_count INTEGER DEFAULT 0,
      claim_invalidated_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE stories (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      story_index INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      abandoned_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `;

  function distDir(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
  }

  it("migrates a pre-WLST5 DB: adds ceiling_expiry_count, re-stamps version, status SELECT works", () => {
    const th = createTempHome("tamandua-migv-upgrade-");
    const dbPath = path.join(th.root, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      ${LEGACY_DDL}
      INSERT INTO runs (
        id, run_number, workflow_id, task, status, context, tokens_spent,
        worker_lost_count, created_at, updated_at
      ) VALUES (
        'legacy-run', 1, 'workflow', 'task', 'running', '{}', 0, 0,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      PRAGMA user_version = ${PRE_WLST5_SCHEMA_VERSION};
    `);
    // Sanity: the legacy DB really is in the pre-WLST5 broken state.
    const preCols = legacyDb.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    assert.ok(preCols.some((c) => c.name === "worker_lost_count"), "precondition: legacy runs has worker_lost_count");
    assert.ok(!preCols.some((c) => c.name === "ceiling_expiry_count"), "precondition: legacy runs lacks ceiling_expiry_count");
    const preVer = legacyDb.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(preVer.user_version, PRE_WLST5_SCHEMA_VERSION, "precondition: user_version is the pre-bump version");
    legacyDb.close();

    // Spawn a fresh subprocess so getDb() runs migrate() from scratch on the
    // legacy file (the in-process getDb() connection is already cached).
    const importPath = JSON.stringify(path.join(distDir(), "db.js"));
    const script = [
      `import { getDb, SCHEMA_VERSION } from ${importPath};`,
      "const db = getDb();",
      'const ceiling = db.prepare("PRAGMA table_info(runs)").all().find((c) => c.name === "ceiling_expiry_count");',
      'const worker = db.prepare("PRAGMA table_info(runs)").all().find((c) => c.name === "worker_lost_count");',
      'const instantFail = db.prepare("PRAGMA table_info(runs)").all().find((c) => c.name === "instant_fail_count");',
      'const ver = db.prepare("PRAGMA user_version").get();',
      // The exact SELECT from src/installer/status.ts:90 — must no longer throw.
      'const row = db.prepare("SELECT id, run_number, workflow_id, task, status, context, created_at, updated_at, tokens_spent, worker_lost_count, ceiling_expiry_count, instant_fail_count FROM runs WHERE id = ?").get("legacy-run");',
      "console.log(JSON.stringify({ ceiling, worker, instantFail, user_version: ver.user_version, row }));",
    ].join("\n");

    const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: distDir(),
      env: {
        HOME: th.homeDir,
        TAMANDUA_DB_PATH: dbPath,
        TAMANDUA_TEST_GUARD: "1",
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });
    const migrated = JSON.parse(result.trim()) as {
      ceiling?: { type: string; notnull: number; dflt_value: string | null };
      worker?: { type: string; notnull: number; dflt_value: string | null };
      instantFail?: { type: string; notnull: number; dflt_value: string | null };
      user_version: number;
      row: {
        id: string;
        run_number: number;
        worker_lost_count: number;
        ceiling_expiry_count: number;
        instant_fail_count: number;
      };
    };

    assert.ok(migrated.ceiling, "ceiling_expiry_count column should be added by migration");
    assert.equal(migrated.ceiling.type, "INTEGER");
    assert.equal(migrated.ceiling.notnull, 1, "ceiling_expiry_count should be NOT NULL");
    assert.equal(migrated.ceiling.dflt_value, "0", "ceiling_expiry_count should default to 0");
    assert.ok(migrated.worker, "worker_lost_count should be untouched by migration");
    assert.equal(migrated.user_version, SCHEMA_VERSION,
      `user_version should be re-stamped to ${SCHEMA_VERSION} (not stuck at the pre-bump version)`);
    assert.equal(migrated.row.ceiling_expiry_count, 0, "legacy row gets ceiling_expiry_count = 0 via DEFAULT");
    assert.equal(migrated.row.worker_lost_count, 0, "legacy row keeps its worker_lost_count");
    assert.equal(migrated.row.id, "legacy-run");

    // RSPN: the pre-WLST5 fixture predates instant_fail_count too — the
    // migration must add it (guarded ALTER, NOT NULL DEFAULT 0) exactly
    // like ceiling_expiry_count, or status.ts SELECTs crash with
    // "no such column: instant_fail_count" (the WLST5.1 failure mode).
    assert.ok(migrated.instantFail, "instant_fail_count column should be added by migration");
    assert.equal(migrated.instantFail.type, "INTEGER");
    assert.equal(migrated.instantFail.notnull, 1, "instant_fail_count should be NOT NULL");
    assert.equal(migrated.instantFail.dflt_value, "0", "instant_fail_count should default to 0");
    assert.equal(migrated.row.instant_fail_count, 0, "legacy row gets instant_fail_count = 0 via DEFAULT");
  });

  it("schema parity: every fresh-DDL column exists in a migrated legacy DB", () => {
    const th = createTempHome("tamandua-migv-parity-");
    const legacyPath = path.join(th.root, "legacy.db");
    const freshPath = path.join(th.root, "fresh.db");

    // Legacy DB: pre-WLST5 schema at the pre-bump user_version (empty file for
    // the fresh side — full DDL path builds it).
    const legacyDb = new DatabaseSync(legacyPath);
    legacyDb.exec(`
      ${LEGACY_DDL}
      PRAGMA user_version = ${PRE_WLST5_SCHEMA_VERSION};
    `);
    legacyDb.close();
    const freshDb = new DatabaseSync(freshPath);
    freshDb.close();

    // Open both through getDb() in one subprocess: the legacy one first (so
    // migrate() upgrades it), then switch TAMANDUA_DB_PATH to the fresh file.
    const importPath = JSON.stringify(path.join(distDir(), "db.js"));
    const script = [
      `import { getDb } from ${importPath};`,
      "const tables = ['runs', 'steps', 'stories'];",
      "const colsOf = (db, table) => db.prepare(\"PRAGMA table_info(\" + table + \")\").all().map((c) => c.name).sort();",
      "const legacy = getDb();",
      "const legacyCols = Object.fromEntries(tables.map((t) => [t, colsOf(legacy, t)]));",
      `process.env.TAMANDUA_DB_PATH = ${JSON.stringify(freshPath)};`,
      "const fresh = getDb();",
      "const freshCols = Object.fromEntries(tables.map((t) => [t, colsOf(fresh, t)]));",
      "console.log(JSON.stringify({ legacyCols, freshCols }));",
    ].join("\n");

    const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: distDir(),
      env: {
        HOME: th.homeDir,
        TAMANDUA_DB_PATH: legacyPath,
        TAMANDUA_TEST_GUARD: "1",
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });
    const parsed = JSON.parse(result.trim()) as {
      legacyCols: Record<string, string[]>;
      freshCols: Record<string, string[]>;
    };

    for (const table of ["runs", "steps", "stories"]) {
      const missing = parsed.freshCols[table].filter((c) => !parsed.legacyCols[table].includes(c));
      assert.deepEqual(missing, [],
        `migrated legacy ${table} table should have every fresh-DDL column (missing: ${missing.join(", ")})`);
    }
  });

  it("migrates a pre-instant-fail (v5) DB: adds instant_fail_count, re-stamps version, status SELECT works", () => {
    // RSPN regression for the WLST5.1 failure mode: adding the guarded
    // instant_fail_count ALTER without bumping SCHEMA_VERSION would leave
    // every existing DB (user_version === SCHEMA_VERSION) early-returned
    // and skipping the migration — status.ts SELECTs then crash with
    // "no such column: instant_fail_count". This fixture is the exact
    // broken state a real pre-v6 install carries: user_version at the
    // pre-bump version with a runs table lacking the column.
    const PRE_INSTANT_FAIL_SCHEMA_VERSION = SCHEMA_VERSION - 1;

    const th = createTempHome("tamandua-migv-instant-fail-");
    const dbPath = path.join(th.root, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        run_number INTEGER,
        workflow_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        context TEXT NOT NULL DEFAULT '{}',
        tokens_spent INTEGER NOT NULL DEFAULT 0,
        notify_url TEXT,
        scheduling_status TEXT,
        scheduling_requested_at TEXT,
        scheduling_error TEXT,
        worker_lost_count INTEGER NOT NULL DEFAULT 0,
        ceiling_expiry_count INTEGER NOT NULL DEFAULT 0,
        parent_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO runs (
        id, run_number, workflow_id, task, status, context, tokens_spent,
        worker_lost_count, ceiling_expiry_count, created_at, updated_at
      ) VALUES (
        'legacy-run', 1, 'workflow', 'task', 'running', '{}', 42, 3, 0,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      PRAGMA user_version = ${PRE_INSTANT_FAIL_SCHEMA_VERSION};
    `);
    // Sanity: the legacy DB really is in the pre-instant-fail broken state.
    const preCols = legacyDb.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    assert.ok(preCols.some((c) => c.name === "ceiling_expiry_count"), "precondition: legacy runs has ceiling_expiry_count");
    assert.ok(!preCols.some((c) => c.name === "instant_fail_count"), "precondition: legacy runs lacks instant_fail_count");
    const preVer = legacyDb.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(preVer.user_version, PRE_INSTANT_FAIL_SCHEMA_VERSION, "precondition: user_version is the pre-bump version");
    legacyDb.close();

    // Spawn a fresh subprocess so getDb() runs migrate() from scratch on
    // the legacy file.
    const importPath = JSON.stringify(path.join(distDir(), "db.js"));
    const script = [
      `import { getDb, SCHEMA_VERSION } from ${importPath};`,
      "const db = getDb();",
      'const col = db.prepare("PRAGMA table_info(runs)").all().find((c) => c.name === "instant_fail_count");',
      'const ver = db.prepare("PRAGMA user_version").get();',
      // The exact SELECT from src/installer/status.ts:90 — must no longer throw.
      'const row = db.prepare("SELECT id, run_number, workflow_id, task, status, context, created_at, updated_at, tokens_spent, worker_lost_count, ceiling_expiry_count, instant_fail_count FROM runs WHERE id = ?").get("legacy-run");',
      "console.log(JSON.stringify({ col, user_version: ver.user_version, row }));",
    ].join("\n");

    const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: distDir(),
      env: {
        HOME: th.homeDir,
        TAMANDUA_DB_PATH: dbPath,
        TAMANDUA_TEST_GUARD: "1",
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });
    const migrated = JSON.parse(result.trim()) as {
      col?: { type: string; notnull: number; dflt_value: string | null };
      user_version: number;
      row: { id: string; instant_fail_count: number; worker_lost_count: number; ceiling_expiry_count: number };
    };

    assert.ok(migrated.col, "instant_fail_count column should be added by migration");
    assert.equal(migrated.col.type, "INTEGER");
    assert.equal(migrated.col.notnull, 1, "instant_fail_count should be NOT NULL");
    assert.equal(migrated.col.dflt_value, "0", "instant_fail_count should default to 0");
    assert.equal(migrated.user_version, SCHEMA_VERSION,
      `user_version should be re-stamped to ${SCHEMA_VERSION} (not stuck at the pre-bump version)`);
    assert.equal(migrated.row.instant_fail_count, 0, "legacy row gets instant_fail_count = 0 via DEFAULT");
    assert.equal(migrated.row.worker_lost_count, 3, "existing WLST5 counters untouched");
    assert.equal(migrated.row.ceiling_expiry_count, 0, "existing WLST5 counters untouched");
  });
});

describe("REROUTE-BUDGET steps.target_moved_reroute_count migration (v11)", () => {
  // REROUTE-BUDGET US-001: steps gains target_moved_reroute_count
  // (INTEGER DEFAULT 0) via a guarded idempotent ALTER, with SCHEMA_VERSION
  // bumped (v10 → v11). Without the bump, existing v10 DBs early-return from
  // migrate() and skip the ALTER, so any SQL touching the new column crashes
  // with "no such column: target_moved_reroute_count" (the WLST5.1 failure
  // mode). This fixture pins exactly that broken pre-bump state.

  // The pre-bump version is the literal v10, NOT SCHEMA_VERSION - 1: deriving
  // it from SCHEMA_VERSION would let the test pass on unbumped code (fixture
  // at v9, migrate() still runs because 9 !== 10) and miss the very
  // regression it exists to catch.
  const PRE_REROUTE_BUDGET_SCHEMA_VERSION = 10;

  // v10 runs/steps/stories schema: identical to the pre-bump shape except
  // steps lacks target_moved_reroute_count.
  const LEGACY_V10_DDL = `
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      notify_url TEXT,
      scheduling_status TEXT,
      scheduling_requested_at TEXT,
      scheduling_error TEXT,
      worker_lost_count INTEGER NOT NULL DEFAULT 0,
      ceiling_expiry_count INTEGER NOT NULL DEFAULT 0,
      parent_run_id TEXT,
      instant_fail_count INTEGER NOT NULL DEFAULT 0,
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
      terminal_reroute_count INTEGER DEFAULT 0,
      ledger_concession_count INTEGER DEFAULT 0,
      claim_invalidated_by TEXT,
      conditional_condition TEXT,
      auto_completed INTEGER NOT NULL DEFAULT 0,
      auto_complete_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE stories (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      story_index INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      abandoned_count INTEGER DEFAULT 0,
      resume_reset_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO runs (
      id, run_number, workflow_id, task, status, context, tokens_spent,
      worker_lost_count, ceiling_expiry_count, instant_fail_count,
      created_at, updated_at
    ) VALUES (
      'legacy-run', 1, 'workflow', 'task', 'running', '{}', 0, 0, 0, 0,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO steps (
      id, run_id, step_id, agent_id, step_index, input_template, expects,
      status, reroute_count, terminal_reroute_count, created_at, updated_at
    ) VALUES (
      'legacy-step', 'legacy-run', 'finalize_merge', 'developer', 0, '', '{}',
      'waiting', 2, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
  `;

  function distDir(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
  }

  function runInSubprocess(th: { homeDir: string }, dbPath: string, script: string): string {
    return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: distDir(),
      env: {
        HOME: th.homeDir,
        TAMANDUA_DB_PATH: dbPath,
        TAMANDUA_TEST_GUARD: "1",
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    }).trim();
  }

  const INSPECT_SCRIPT = [
    `import { getDb, SCHEMA_VERSION } from ${JSON.stringify(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "db.js"))};`,
    "const db = getDb();",
    'const col = db.prepare("PRAGMA table_info(steps)").all().find((c) => c.name === "target_moved_reroute_count");',
    'const ver = db.prepare("PRAGMA user_version").get();',
    'const step = db.prepare("SELECT id, reroute_count, terminal_reroute_count, target_moved_reroute_count FROM steps WHERE id = ?").get("legacy-step");',
    // The exact SELECT from src/installer/status.ts over runs — must not throw.
    'const row = db.prepare("SELECT id, run_number, workflow_id, task, status, context, created_at, updated_at, tokens_spent, worker_lost_count, ceiling_expiry_count, instant_fail_count FROM runs WHERE id = ?").get("legacy-run");',
    "console.log(JSON.stringify({ col, user_version: ver.user_version, schemaVersion: SCHEMA_VERSION, step, row }));",
  ].join("\n");

  it("migrates a pre-REROUTE-BUDGET v10 DB: adds target_moved_reroute_count, re-stamps version, status SELECT works", () => {
    const th = createTempHome("tamandua-migv-reroute-budget-");
    const dbPath = path.join(th.root, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      ${LEGACY_V10_DDL}
      PRAGMA user_version = ${PRE_REROUTE_BUDGET_SCHEMA_VERSION};
    `);
    // Sanity: the legacy DB really is in the pre-bump broken state.
    const preStepCols = legacyDb.prepare("PRAGMA table_info(steps)").all() as Array<{ name: string }>;
    assert.ok(preStepCols.some((c) => c.name === "terminal_reroute_count"),
      "precondition: legacy steps has terminal_reroute_count");
    assert.ok(!preStepCols.some((c) => c.name === "target_moved_reroute_count"),
      "precondition: legacy steps lacks target_moved_reroute_count");
    const preVer = legacyDb.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(preVer.user_version, PRE_REROUTE_BUDGET_SCHEMA_VERSION,
      "precondition: user_version is the pre-bump version");
    legacyDb.close();

    const parsed = JSON.parse(runInSubprocess(th, dbPath, INSPECT_SCRIPT)) as {
      col?: { type: string; notnull: number; dflt_value: string | null };
      user_version: number;
      schemaVersion: number;
      step: {
        id: string;
        reroute_count: number;
        terminal_reroute_count: number;
        target_moved_reroute_count: number;
      };
      row: { id: string };
    };

    assert.ok(parsed.col, "target_moved_reroute_count column should be added by migration");
    assert.equal(parsed.col.type, "INTEGER");
    assert.equal(parsed.col.notnull, 0, "target_moved_reroute_count is nullable, matching reroute_count");
    assert.equal(parsed.col.dflt_value, "0", "target_moved_reroute_count should default to 0");
    assert.equal(parsed.user_version, SCHEMA_VERSION,
      `user_version should be re-stamped to ${SCHEMA_VERSION} (not stuck at the pre-bump version)`);
    assert.equal(parsed.step.target_moved_reroute_count, 0,
      "legacy step row gets target_moved_reroute_count = 0 via DEFAULT");
    assert.equal(parsed.step.reroute_count, 2, "existing reroute_count untouched");
    assert.equal(parsed.step.terminal_reroute_count, 1, "existing terminal_reroute_count untouched");
    assert.equal(parsed.row.id, "legacy-run", "status SELECT over runs still works");
  });

  it("re-opening an already-migrated DB is idempotent and does not error", () => {
    const th = createTempHome("tamandua-migv-reroute-budget-idem-");
    const dbPath = path.join(th.root, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      ${LEGACY_V10_DDL}
      PRAGMA user_version = ${PRE_REROUTE_BUDGET_SCHEMA_VERSION};
    `);
    legacyDb.close();

    const first = JSON.parse(runInSubprocess(th, dbPath, INSPECT_SCRIPT)) as {
      col?: { name: string };
      user_version: number;
      step: { target_moved_reroute_count: number };
    };
    assert.ok(first.col, "first open adds the column");
    assert.equal(first.user_version, SCHEMA_VERSION, "first open re-stamps the version");

    // A second fresh process on the same file must not error and must leave
    // the column/version intact.
    const second = JSON.parse(runInSubprocess(th, dbPath, INSPECT_SCRIPT)) as {
      col?: { name: string };
      user_version: number;
      step: { target_moved_reroute_count: number };
    };
    assert.ok(second.col, "second open leaves the column present");
    assert.equal(second.user_version, SCHEMA_VERSION, "second open keeps the version stamped");
    assert.equal(second.step.target_moved_reroute_count, 0, "second open preserves the defaulted value");
  });
});

describe("OUTAGE-ROUNDS steps.preclaim_death_count migration (v12 step)", () => {
  // OUTAGE-ROUNDS US-003: steps gains preclaim_death_count
  // (INTEGER NOT NULL DEFAULT 0) via a guarded idempotent ALTER (the
  // v11 → v12 step of the combined union chain, which now runs on to v13).
  // The counter records consecutive
  // dispatch rounds that ran past the wall threshold and exited/died WITHOUT
  // claiming the step. Without the bump, existing v11 DBs early-return from
  // migrate() and skip the ALTER, so any SQL touching the new column crashes
  // with "no such column: preclaim_death_count" (the WLST5.1 failure mode).
  // This fixture pins exactly that broken pre-bump state.

  // The pre-bump version is the literal v11, NOT SCHEMA_VERSION - 1: deriving
  // it from SCHEMA_VERSION would let the test pass on unbumped code (fixture
  // at v10, migrate() still runs because 10 !== 13) and miss the very
  // regression it exists to catch.
  const PRE_PRECLAIM_SCHEMA_VERSION = 11;

  // v11 runs/steps/stories schema: identical to the pre-bump shape except
  // steps lacks preclaim_death_count (it already carries the v11
  // target_moved_reroute_count column).
  const LEGACY_V11_DDL = `
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      notify_url TEXT,
      scheduling_status TEXT,
      scheduling_requested_at TEXT,
      scheduling_error TEXT,
      worker_lost_count INTEGER NOT NULL DEFAULT 0,
      ceiling_expiry_count INTEGER NOT NULL DEFAULT 0,
      parent_run_id TEXT,
      instant_fail_count INTEGER NOT NULL DEFAULT 0,
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
      terminal_reroute_count INTEGER DEFAULT 0,
      ledger_concession_count INTEGER DEFAULT 0,
      claim_invalidated_by TEXT,
      conditional_condition TEXT,
      auto_completed INTEGER NOT NULL DEFAULT 0,
      auto_complete_reason TEXT,
      target_moved_reroute_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE stories (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      story_index INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      abandoned_count INTEGER DEFAULT 0,
      resume_reset_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO runs (
      id, run_number, workflow_id, task, status, context, tokens_spent,
      worker_lost_count, ceiling_expiry_count, instant_fail_count,
      created_at, updated_at
    ) VALUES (
      'legacy-run', 1, 'workflow', 'task', 'running', '{}', 0, 0, 0, 0,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO steps (
      id, run_id, step_id, agent_id, step_index, input_template, expects,
      status, created_at, updated_at
    ) VALUES (
      'legacy-step', 'legacy-run', 'execute', 'developer', 0, '', '{}',
      'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
  `;

  function distDir(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
  }

  function runInSubprocess(th: { homeDir: string }, dbPath: string, script: string): string {
    return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: distDir(),
      env: {
        HOME: th.homeDir,
        TAMANDUA_DB_PATH: dbPath,
        TAMANDUA_TEST_GUARD: "1",
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    }).trim();
  }

  const INSPECT_SCRIPT = [
    `import { getDb, SCHEMA_VERSION } from ${JSON.stringify(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "db.js"))};`,
    "const db = getDb();",
    'const col = db.prepare("PRAGMA table_info(steps)").all().find((c) => c.name === "preclaim_death_count");',
    'const ver = db.prepare("PRAGMA user_version").get();',
    // The status SELECT from src/installer/status.ts over steps — must not throw.
    'const step = db.prepare("SELECT id, run_id, step_id, agent_id, step_index, status, preclaim_death_count FROM steps WHERE id = ?").get("legacy-step");',
    "console.log(JSON.stringify({ col, user_version: ver.user_version, schemaVersion: SCHEMA_VERSION, step }));",
  ].join("\n");

  it("migrates a pre-OUTAGE-ROUNDS v11 DB: adds preclaim_death_count, re-stamps version, status SELECT works", () => {
    const th = createTempHome("tamandua-migv-preclaim-death-");
    const dbPath = path.join(th.root, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      ${LEGACY_V11_DDL}
      PRAGMA user_version = ${PRE_PRECLAIM_SCHEMA_VERSION};
    `);
    // Sanity: the legacy DB really is in the pre-bump broken state.
    const preStepCols = legacyDb.prepare("PRAGMA table_info(steps)").all() as Array<{ name: string }>;
    assert.ok(preStepCols.some((c) => c.name === "target_moved_reroute_count"),
      "precondition: legacy steps has the v11 target_moved_reroute_count");
    assert.ok(!preStepCols.some((c) => c.name === "preclaim_death_count"),
      "precondition: legacy steps lacks preclaim_death_count");
    const preVer = legacyDb.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(preVer.user_version, PRE_PRECLAIM_SCHEMA_VERSION,
      "precondition: user_version is the pre-bump version");
    legacyDb.close();

    const parsed = JSON.parse(runInSubprocess(th, dbPath, INSPECT_SCRIPT)) as {
      col?: { type: string; notnull: number; dflt_value: string | null };
      user_version: number;
      schemaVersion: number;
      step: {
        id: string;
        run_id: string;
        step_id: string;
        agent_id: string;
        step_index: number;
        status: string;
        preclaim_death_count: number;
      };
    };

    assert.ok(parsed.col, "preclaim_death_count column should be added by migration");
    assert.equal(parsed.col.type, "INTEGER");
    assert.equal(parsed.col.notnull, 1, "preclaim_death_count is NOT NULL");
    assert.equal(parsed.col.dflt_value, "0", "preclaim_death_count should default to 0");
    assert.equal(parsed.schemaVersion, 13, "SCHEMA_VERSION is 13 for the preclaim bump");
    assert.equal(parsed.user_version, SCHEMA_VERSION,
      `user_version should be re-stamped to ${SCHEMA_VERSION} (not stuck at the pre-bump version)`);
    assert.equal(parsed.step.preclaim_death_count, 0,
      "legacy step row gets preclaim_death_count = 0 via DEFAULT");
    assert.equal(parsed.step.id, "legacy-step", "status SELECT over steps still works");
    assert.equal(parsed.step.status, "pending", "existing step status untouched");
  });

  it("re-opening an already-migrated DB is idempotent and does not error", () => {
    const th = createTempHome("tamandua-migv-preclaim-death-idem-");
    const dbPath = path.join(th.root, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      ${LEGACY_V11_DDL}
      PRAGMA user_version = ${PRE_PRECLAIM_SCHEMA_VERSION};
    `);
    legacyDb.close();

    const first = JSON.parse(runInSubprocess(th, dbPath, INSPECT_SCRIPT)) as {
      col?: { name: string };
      user_version: number;
      step: { preclaim_death_count: number };
    };
    assert.ok(first.col, "first open adds the column");
    assert.equal(first.user_version, SCHEMA_VERSION, "first open re-stamps the version");

    // A second fresh process on the same file must not error and must leave
    // the column/version intact.
    const second = JSON.parse(runInSubprocess(th, dbPath, INSPECT_SCRIPT)) as {
      col?: { name: string };
      user_version: number;
      step: { preclaim_death_count: number };
    };
    assert.ok(second.col, "second open leaves the column present");
    assert.equal(second.user_version, SCHEMA_VERSION, "second open keeps the version stamped");
    assert.equal(second.step.preclaim_death_count, 0, "second open preserves the defaulted value");
  });
});

describe("WAVE-A US-001 conditional-review + TEST_CMD contract columns", () => {
  // WAVE-A US-001: steps gains conditional_condition (TEXT), auto_completed
  // (INTEGER NOT NULL DEFAULT 0), auto_complete_reason (TEXT); runs gains
  // test_cmd_established (TEXT), test_cmd_source (TEXT) — all via guarded
  // idempotent ALTERs, with SCHEMA_VERSION bumped (v6 → v7) so pre-existing
  // v6 installs actually run the migration (the WLST5.1 failure mode).

  function distDir(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
  }

  // Pre-WAVE-A (v6) runs/steps schema: has instant_fail_count but NOT the
  // conditional-review / TEST_CMD contract columns.
  const LEGACY_V6_DDL = `
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      notify_url TEXT,
      scheduling_status TEXT,
      scheduling_requested_at TEXT,
      scheduling_error TEXT,
      worker_lost_count INTEGER NOT NULL DEFAULT 0,
      ceiling_expiry_count INTEGER NOT NULL DEFAULT 0,
      parent_run_id TEXT,
      instant_fail_count INTEGER NOT NULL DEFAULT 0,
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
      terminal_reroute_count INTEGER DEFAULT 0,
      ledger_concession_count INTEGER DEFAULT 0,
      claim_invalidated_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO runs (
      id, run_number, workflow_id, task, status, context, tokens_spent,
      worker_lost_count, ceiling_expiry_count, instant_fail_count,
      created_at, updated_at
    ) VALUES (
      'legacy-run', 1, 'workflow', 'task', 'running', '{}', 42, 3, 0, 0,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO steps (
      id, run_id, step_id, agent_id, step_index, input_template, expects,
      status, created_at, updated_at
    ) VALUES (
      'legacy-step', 'legacy-run', 'test_cmd_review', 'reviewer', 0, '', '',
      'waiting', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
  `;

  it("fresh DB: steps and runs include the WAVE-A columns at SCHEMA_VERSION", () => {
    const th = createTempHome("tamandua-wavea-fresh-");
    const dbPath = path.join(th.root, "fresh.db");
    const importPath = JSON.stringify(path.join(distDir(), "db.js"));
    const script = [
      `import { getDb, SCHEMA_VERSION } from ${importPath};`,
      "const db = getDb();",
      "const stepCols = db.prepare(\"PRAGMA table_info(steps)\").all();",
      "const runCols = db.prepare(\"PRAGMA table_info(runs)\").all();",
      "const col = (t, n) => t.find((c) => c.name === n);",
      "const ver = db.prepare(\"PRAGMA user_version\").get();",
      "console.log(JSON.stringify({",
      "  cond: col(stepCols, 'conditional_condition'),",
      "  auto: col(stepCols, 'auto_completed'),",
      "  reason: col(stepCols, 'auto_complete_reason'),",
      "  tce: col(runCols, 'test_cmd_established'),",
      "  tcs: col(runCols, 'test_cmd_source'),",
      "  user_version: ver.user_version,",
      "}));",
    ].join("\n");

    const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: distDir(),
      env: {
        HOME: th.homeDir,
        TAMANDUA_DB_PATH: dbPath,
        TAMANDUA_TEST_GUARD: "1",
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });
    const parsed = JSON.parse(result.trim()) as {
      cond: { type: string; notnull: number; dflt_value: string | null };
      auto: { type: string; notnull: number; dflt_value: string | null };
      reason: { type: string; notnull: number; dflt_value: string | null };
      tce: { type: string; notnull: number; dflt_value: string | null };
      tcs: { type: string; notnull: number; dflt_value: string | null };
      user_version: number;
    };

    assert.equal(parsed.user_version, SCHEMA_VERSION,
      `fresh DB should be stamped at ${SCHEMA_VERSION}`);
    // steps.conditional_condition: nullable TEXT, no default
    assert.equal(parsed.cond.type, "TEXT");
    assert.equal(parsed.cond.notnull, 0);
    assert.equal(parsed.cond.dflt_value, null);
    // steps.auto_completed: NOT NULL INTEGER defaulting to 0
    assert.equal(parsed.auto.type, "INTEGER");
    assert.equal(parsed.auto.notnull, 1);
    assert.equal(parsed.auto.dflt_value, "0");
    // steps.auto_complete_reason: nullable TEXT, no default
    assert.equal(parsed.reason.type, "TEXT");
    assert.equal(parsed.reason.notnull, 0);
    assert.equal(parsed.reason.dflt_value, null);
    // runs.test_cmd_established / test_cmd_source: nullable TEXT, no default
    assert.equal(parsed.tce.type, "TEXT");
    assert.equal(parsed.tce.notnull, 0);
    assert.equal(parsed.tce.dflt_value, null);
    assert.equal(parsed.tcs.type, "TEXT");
    assert.equal(parsed.tcs.notnull, 0);
    assert.equal(parsed.tcs.dflt_value, null);
  });

  it("migrates a pre-WAVE-A (v6) DB: adds all five columns, re-stamps version, existing rows preserved", () => {
    const PRE_WAVE_A_SCHEMA_VERSION = SCHEMA_VERSION - 1;

    const th = createTempHome("tamandua-wavea-migrate-");
    const dbPath = path.join(th.root, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      ${LEGACY_V6_DDL}
      PRAGMA user_version = ${PRE_WAVE_A_SCHEMA_VERSION};
    `);
    // Sanity: the legacy DB really is in the pre-WAVE-A state.
    const preStepCols = legacyDb.prepare("PRAGMA table_info(steps)").all() as Array<{ name: string }>;
    assert.ok(preStepCols.some((c) => c.name === "claim_invalidated_by"), "precondition: legacy steps has claim_invalidated_by");
    assert.ok(!preStepCols.some((c) => c.name === "conditional_condition"), "precondition: legacy steps lacks conditional_condition");
    assert.ok(!preStepCols.some((c) => c.name === "auto_completed"), "precondition: legacy steps lacks auto_completed");
    assert.ok(!preStepCols.some((c) => c.name === "auto_complete_reason"), "precondition: legacy steps lacks auto_complete_reason");
    const preRunCols = legacyDb.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    assert.ok(preRunCols.some((c) => c.name === "instant_fail_count"), "precondition: legacy runs has instant_fail_count");
    assert.ok(!preRunCols.some((c) => c.name === "test_cmd_established"), "precondition: legacy runs lacks test_cmd_established");
    assert.ok(!preRunCols.some((c) => c.name === "test_cmd_source"), "precondition: legacy runs lacks test_cmd_source");
    const preVer = legacyDb.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(preVer.user_version, PRE_WAVE_A_SCHEMA_VERSION, "precondition: user_version is the pre-bump version");
    legacyDb.close();

    // Spawn a fresh subprocess so getDb() runs migrate() from scratch on the legacy file.
    const importPath = JSON.stringify(path.join(distDir(), "db.js"));
    const script = [
      `import { getDb, SCHEMA_VERSION } from ${importPath};`,
      "const db = getDb();",
      "const col = (t, n) => db.prepare(\"PRAGMA table_info(\" + t + \")\").all().find((c) => c.name === n);",
      "const ver = db.prepare(\"PRAGMA user_version\").get();",
      // SELECTs exercising every new column — must not throw.
      'const stepRow = db.prepare("SELECT id, conditional_condition, auto_completed, auto_complete_reason FROM steps WHERE id = ?").get("legacy-step");',
      'const runRow = db.prepare("SELECT id, test_cmd_established, test_cmd_source FROM runs WHERE id = ?").get("legacy-run");',
      "console.log(JSON.stringify({",
      "  cond: col('steps', 'conditional_condition'),",
      "  auto: col('steps', 'auto_completed'),",
      "  reason: col('steps', 'auto_complete_reason'),",
      "  tce: col('runs', 'test_cmd_established'),",
      "  tcs: col('runs', 'test_cmd_source'),",
      "  user_version: ver.user_version,",
      "  stepRow, runRow,",
      "}));",
    ].join("\n");

    const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: distDir(),
      env: {
        HOME: th.homeDir,
        TAMANDUA_DB_PATH: dbPath,
        TAMANDUA_TEST_GUARD: "1",
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });
    const migrated = JSON.parse(result.trim()) as {
      cond?: { type: string; notnull: number; dflt_value: string | null };
      auto?: { type: string; notnull: number; dflt_value: string | null };
      reason?: { type: string; notnull: number; dflt_value: string | null };
      tce?: { type: string; notnull: number; dflt_value: string | null };
      tcs?: { type: string; notnull: number; dflt_value: string | null };
      user_version: number;
      stepRow: { id: string; conditional_condition: string | null; auto_completed: number; auto_complete_reason: string | null };
      runRow: { id: string; test_cmd_established: string | null; test_cmd_source: string | null };
    };

    assert.ok(migrated.cond, "conditional_condition column should be added");
    assert.equal(migrated.cond.type, "TEXT");
    assert.equal(migrated.cond.notnull, 0, "conditional_condition should be nullable");
    assert.equal(migrated.cond.dflt_value, null);
    assert.ok(migrated.auto, "auto_completed column should be added");
    assert.equal(migrated.auto.type, "INTEGER");
    assert.equal(migrated.auto.notnull, 1, "auto_completed should be NOT NULL");
    assert.equal(migrated.auto.dflt_value, "0", "auto_completed should default to 0");
    assert.ok(migrated.reason, "auto_complete_reason column should be added");
    assert.equal(migrated.reason.type, "TEXT");
    assert.equal(migrated.reason.notnull, 0, "auto_complete_reason should be nullable");
    assert.equal(migrated.reason.dflt_value, null);
    assert.ok(migrated.tce, "test_cmd_established column should be added");
    assert.equal(migrated.tce.type, "TEXT");
    assert.equal(migrated.tce.notnull, 0, "test_cmd_established should be nullable");
    assert.equal(migrated.tce.dflt_value, null);
    assert.ok(migrated.tcs, "test_cmd_source column should be added");
    assert.equal(migrated.tcs.type, "TEXT");
    assert.equal(migrated.tcs.notnull, 0, "test_cmd_source should be nullable");
    assert.equal(migrated.tcs.dflt_value, null);

    assert.equal(migrated.user_version, SCHEMA_VERSION,
      `legacy DB should be re-stamped to ${SCHEMA_VERSION} (not stuck at the pre-bump version)`);

    // Existing rows are untouched: the new columns hold their defaults/NULL.
    assert.deepEqual(migrated.stepRow, {
      id: "legacy-step",
      conditional_condition: null,
      auto_completed: 0,
      auto_complete_reason: null,
    }, "legacy step row keeps identity with auto_completed = 0 via DEFAULT");
    assert.deepEqual(migrated.runRow, {
      id: "legacy-run",
      test_cmd_established: null,
      test_cmd_source: null,
    }, "legacy run row keeps identity with NULL contract columns");
  });

  it("migration is idempotent: repeated migration does not duplicate columns", () => {
    const PRE_WAVE_A_SCHEMA_VERSION = SCHEMA_VERSION - 1;

    const th = createTempHome("tamandua-wavea-idempotent-");
    const dbPath = path.join(th.root, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      ${LEGACY_V6_DDL}
      PRAGMA user_version = ${PRE_WAVE_A_SCHEMA_VERSION};
    `);
    legacyDb.close();

    const importPath = JSON.stringify(path.join(distDir(), "db.js"));
    const script = [
      `import { getDb } from ${importPath};`,
      "const db = getDb();",
      "const count = (t, n) => db.prepare(\"PRAGMA table_info(\" + t + \")\").all().filter((c) => c.name === n).length;",
      "console.log(JSON.stringify({",
      "  cond: count('steps', 'conditional_condition'),",
      "  auto: count('steps', 'auto_completed'),",
      "  reason: count('steps', 'auto_complete_reason'),",
      "  tce: count('runs', 'test_cmd_established'),",
      "  tcs: count('runs', 'test_cmd_source'),",
      "}));",
    ].join("\n");
    const runMigrate = () => execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: distDir(),
      env: {
        HOME: th.homeDir,
        TAMANDUA_DB_PATH: dbPath,
        TAMANDUA_TEST_GUARD: "1",
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });

    // Migrate twice (two separate subprocesses) — second run must not error or duplicate.
    runMigrate();
    const second = JSON.parse(runMigrate().trim()) as Record<string, number>;
    assert.deepEqual(second, {
      cond: 1,
      auto: 1,
      reason: 1,
      tce: 1,
      tcs: 1,
    }, "each WAVE-A column must appear exactly once after repeated migration");
  });
});

describe("MTLK matchlock_policy column migration", () => {
  // MTLK-PI US-001: runs.matchlock_policy (TEXT, NULL = no Matchlock policy;
  // JSON) durably persists the typed, host-owned execution-isolation policy
  // captured at run creation when --matchlock IMAGE is passed. Nullable with
  // no backfill, added via the guarded idempotent ALTER pattern (the runs
  // CREATE TABLE keeps its explicit column list unchanged), with
  // SCHEMA_VERSION bumped (v9 → v10) so existing v9 installs actually run the
  // migration (the WLST5.1 failure mode). Existing rows read back NULL and
  // use the native path.

  let origHome: string | undefined;
  let origDbPath: string | undefined;

  function distDir(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
  }

  // Pre-MTLK (v9) runs schema: identical to the current shape except runs
  // lacks matchlock_policy (and includes all v9 columns).
  const LEGACY_V9_DDL = `
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      notify_url TEXT,
      scheduling_status TEXT,
      scheduling_requested_at TEXT,
      scheduling_error TEXT,
      worker_lost_count INTEGER NOT NULL DEFAULT 0,
      ceiling_expiry_count INTEGER NOT NULL DEFAULT 0,
      parent_run_id TEXT,
      instant_fail_count INTEGER NOT NULL DEFAULT 0,
      test_cmd_established TEXT,
      test_cmd_source TEXT,
      harness_probe_status TEXT,
      harness_probe_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO runs (
      id, run_number, workflow_id, task, status, context, tokens_spent,
      worker_lost_count, ceiling_expiry_count, instant_fail_count,
      created_at, updated_at
    ) VALUES (
      'legacy-run', 1, 'workflow', 'task', 'running', '{}', 42, 3, 0, 2,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
  `;

  function runInSubprocess(
    th: { homeDir: string },
    dbPath: string,
    script: string,
  ): string {
    return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: distDir(),
      env: {
        HOME: th.homeDir,
        TAMANDUA_DB_PATH: dbPath,
        TAMANDUA_TEST_GUARD: "1",
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    }).trim();
  }

  before(() => {
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
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

  it("fresh DB: runs has matchlock_policy at SCHEMA_VERSION", () => {
    const th = createTempHome("tamandua-mtlk-fresh-");
    const dbPath = path.join(th.root, "fresh.db");
    const script = [
      `import { getDb, SCHEMA_VERSION } from ${JSON.stringify(path.join(distDir(), "db.js"))};`,
      "const db = getDb();",
      'const col = db.prepare("PRAGMA table_info(runs)").all().find((c) => c.name === "matchlock_policy");',
      'const ver = db.prepare("PRAGMA user_version").get();',
      "console.log(JSON.stringify({ col, user_version: ver.user_version }));",
    ].join("\n");

    const result = runInSubprocess(th, dbPath, script);
    const parsed = JSON.parse(result) as {
      col?: { type: string; notnull: number; dflt_value: string | null };
      user_version: number;
    };

    assert.equal(parsed.user_version, SCHEMA_VERSION,
      `fresh DB should be stamped at ${SCHEMA_VERSION}`);
    assert.ok(parsed.col, "matchlock_policy column should exist on a fresh DB");
    assert.equal(parsed.col.type, "TEXT", "matchlock_policy should be TEXT");
    assert.equal(parsed.col.notnull, 0, "matchlock_policy should be nullable");
    assert.equal(parsed.col.dflt_value, null, "matchlock_policy should have no default");
  });

  it("migrates a pre-MTLK (v9) DB: adds the column, re-stamps version, status SELECT reads NULL", () => {
    // Regression for the WLST5.1 failure mode. This fixture is the exact
    // broken state a real pre-v10 install carries: user_version at the
    // pre-bump version with a runs table lacking matchlock_policy.
    const PRE_MTLK_SCHEMA_VERSION = SCHEMA_VERSION - 1;

    const th = createTempHome("tamandua-mtlk-migrate-");
    const dbPath = path.join(th.root, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      ${LEGACY_V9_DDL}
      PRAGMA user_version = ${PRE_MTLK_SCHEMA_VERSION};
    `);
    // Sanity: the legacy DB really is in the pre-MTLK broken state.
    const preCols = legacyDb.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    assert.ok(preCols.some((c) => c.name === "harness_probe_status"), "precondition: legacy runs has harness_probe_status");
    assert.ok(preCols.some((c) => c.name === "harness_probe_at"), "precondition: legacy runs has harness_probe_at");
    assert.ok(!preCols.some((c) => c.name === "matchlock_policy"), "precondition: legacy runs lacks matchlock_policy");
    const preVer = legacyDb.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(preVer.user_version, PRE_MTLK_SCHEMA_VERSION, "precondition: user_version is the pre-bump version");
    legacyDb.close();

    // Spawn a fresh subprocess so getDb() runs migrate() from scratch on the legacy file.
    const script = [
      `import { getDb, SCHEMA_VERSION } from ${JSON.stringify(path.join(distDir(), "db.js"))};`,
      "const db = getDb();",
      'const col = db.prepare("PRAGMA table_info(runs)").all().find((c) => c.name === "matchlock_policy");',
      'const ver = db.prepare("PRAGMA user_version").get();',
      // The exact status SELECT shape from src/installer/status.ts plus the new
      // column; must no longer throw and must read the legacy row with NULL.
      'const row = db.prepare("SELECT id, run_number, workflow_id, task, status, scheduling_status, context, created_at, updated_at, tokens_spent, worker_lost_count, ceiling_expiry_count, instant_fail_count, matchlock_policy FROM runs WHERE id = ?").get("legacy-run");',
      "console.log(JSON.stringify({ col, user_version: ver.user_version, row }));",
    ].join("\n");

    const result = runInSubprocess(th, dbPath, script);
    const migrated = JSON.parse(result) as {
      col?: { type: string; notnull: number; dflt_value: string | null };
      user_version: number;
      row: {
        id: string;
        instant_fail_count: number;
        worker_lost_count: number;
        ceiling_expiry_count: number;
        matchlock_policy: string | null;
      };
    };

    assert.ok(migrated.col, "matchlock_policy column should be added by migration");
    assert.equal(migrated.col.type, "TEXT", "matchlock_policy should be TEXT");
    assert.equal(migrated.col.notnull, 0, "matchlock_policy should be nullable");
    assert.equal(migrated.col.dflt_value, null, "matchlock_policy should have no default");
    assert.equal(migrated.user_version, SCHEMA_VERSION,
      `legacy DB should be re-stamped to ${SCHEMA_VERSION} (not stuck at the pre-bump version)`);
    assert.equal(migrated.row.matchlock_policy, null,
      "existing runs keep NULL matchlock_policy (native path) after migration");
  });
});

describe("MIGV union4 v13 schema chain (every starting state)", () => {
  // MATCHLOCK-UNION-4 US-002. The union keeps ONE schema chain with four
  // guarded, idempotent steps:
  //   9  -> 10  migrateInstantsToIsoZ(): rewrite naive `YYYY-MM-DD HH:MM:SS`
  //   10 -> 11  steps.target_moved_reroute_count (ALTER ... DEFAULT 0)
  //   11 -> 12  steps.preclaim_death_count (ALTER ... NOT NULL DEFAULT 0)
  //   12 -> 13  runs.matchlock_policy TEXT
  // Every step is a `pragma_table_info`-guarded ALTER, so re-running the full
  // DDL pass over an already-current shape must not raise
  // "duplicate column name" and must not churn values.
  //
  // Starting states under test (raw pre-bump DDL + PRAGMA user_version):
  //   v9            main lineage, naive instants, no matchlock_policy, no target_moved
  //   v10 MAIN      ISO-Z instants, no matchlock_policy, no target_moved
  //   v10 MATCHLOCK matchlock_policy present, naive instants, no target_moved
  //   v11 MAIN      ISO-Z instants, no matchlock_policy, target_moved present
  //   v11 MATCHLOCK matchlock_policy present, target_moved present, naive instants
  //   v12 MAIN      main lineage: preclaim_death_count present, matchlock_policy absent
  //   v12 UNION     Matchlock lineage: matchlock_policy present, preclaim absent,
  //                 naive instants (proves 9->10 normalization runs on this shape)
  //   v13           already current -> migrate() fast-path no-op
  //
  // Every case asserts user_version === 13, that runs.matchlock_policy,
  // steps.preclaim_death_count and steps.target_moved_reroute_count each exist
  // exactly once, and that the representative status SELECT (which names the
  // new columns) succeeds.

  const MATCHLOCK_POLICY_JSON = '{"image":"ghcr.io/acme/pi:1"}';

  function distDir(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
  }

  function runInSubprocess(
    th: { homeDir: string },
    dbPath: string,
    script: string,
  ): string {
    return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: distDir(),
      env: {
        HOME: th.homeDir,
        TAMANDUA_DB_PATH: dbPath,
        TAMANDUA_TEST_GUARD: "1",
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    }).trim();
  }

  interface SeedOpts {
    userVersion: number;
    matchlockPolicy: "absent" | "present";
    targetMoved: "absent" | "present";
    /** Only honored when targetMoved === "present". Defaults to 0. */
    targetMovedValue?: number;
    /**
     * Pre-union main-v12 lineage carries steps.preclaim_death_count (main's
     * 11 -> 12 step); the union lineage does not. Defaults to "absent".
     */
    preclaim?: "absent" | "present";
    /** Only honored when preclaim === "present". Defaults to 0. */
    preclaimValue?: number;
    runCreatedAt: string;
    runUpdatedAt: string;
    stepCreatedAt: string;
    stepUpdatedAt: string;
    stepClaimUpdatedAt: string;
  }

  // Builds a legacy DB with the real historical column set for the requested
  // starting state. matchlock_policy / target_moved_reroute_count are appended
  // last when present, mirroring how an ALTER TABLE would have added them.
  function seedLegacyState(dbPath: string, opts: SeedOpts): void {
    const matchlockCol = opts.matchlockPolicy === "present"
      ? ",\n      matchlock_policy TEXT"
      : "";
    const targetMovedCol = opts.targetMoved === "present"
      ? ",\n      target_moved_reroute_count INTEGER DEFAULT 0"
      : "";
    const preclaimCol = opts.preclaim === "present"
      ? ",\n      preclaim_death_count INTEGER NOT NULL DEFAULT 0"
      : "";
    const matchlockInsertCol = opts.matchlockPolicy === "present"
      ? ", matchlock_policy"
      : "";
    const matchlockInsertVal = opts.matchlockPolicy === "present"
      ? `, '${MATCHLOCK_POLICY_JSON}'`
      : "";
    const targetMovedInsertCol = opts.targetMoved === "present"
      ? ", target_moved_reroute_count"
      : "";
    const targetMovedInsertVal = opts.targetMoved === "present"
      ? `, ${opts.targetMovedValue ?? 0}`
      : "";
    const preclaimInsertCol = opts.preclaim === "present"
      ? ", preclaim_death_count"
      : "";
    const preclaimInsertVal = opts.preclaim === "present"
      ? `, ${opts.preclaimValue ?? 0}`
      : "";

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        run_number INTEGER,
        workflow_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        context TEXT NOT NULL DEFAULT '{}',
        tokens_spent INTEGER NOT NULL DEFAULT 0,
        notify_url TEXT,
        scheduling_status TEXT,
        scheduling_requested_at TEXT,
        scheduling_error TEXT,
        worker_lost_count INTEGER NOT NULL DEFAULT 0,
        ceiling_expiry_count INTEGER NOT NULL DEFAULT 0,
        parent_run_id TEXT,
        instant_fail_count INTEGER NOT NULL DEFAULT 0,
        test_cmd_established TEXT,
        test_cmd_source TEXT,
        harness_probe_status TEXT,
        harness_probe_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL${matchlockCol}
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
        terminal_reroute_count INTEGER DEFAULT 0,
        ledger_concession_count INTEGER DEFAULT 0,
        claim_invalidated_by TEXT,
        conditional_condition TEXT,
        auto_completed INTEGER NOT NULL DEFAULT 0,
        auto_complete_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL${targetMovedCol}${preclaimCol}
      );
      INSERT INTO runs (
        id, run_number, workflow_id, task, status, context, tokens_spent,
        worker_lost_count, ceiling_expiry_count, instant_fail_count,
        created_at, updated_at${matchlockInsertCol}
      ) VALUES (
        'legacy-run', 1, 'workflow', 'task', 'running', '{}', 42, 3, 2, 1,
        '${opts.runCreatedAt}', '${opts.runUpdatedAt}'${matchlockInsertVal}
      );
      INSERT INTO steps (
        id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, reroute_count, terminal_reroute_count, created_at, updated_at,
        claim_updated_at${targetMovedInsertCol}${preclaimInsertCol}
      ) VALUES (
        'legacy-step', 'legacy-run', 'finalize_merge', 'developer', 0, '', '{}',
        'waiting', 2, 1, '${opts.stepCreatedAt}', '${opts.stepUpdatedAt}',
        '${opts.stepClaimUpdatedAt}'${targetMovedInsertVal}${preclaimInsertVal}
      );
      PRAGMA user_version = ${opts.userVersion};
    `);
    db.close();
  }

  interface InspectResult {
    user_version: number;
    schemaVersion: number;
    fullRuns: number;
    runCols: string[];
    stepCols: string[];
    run: {
      id: string;
      created_at: string;
      updated_at: string;
      scheduling_requested_at: string | null;
      harness_probe_at: string | null;
      matchlock_policy: string | null;
      tokens_spent: number;
      worker_lost_count: number;
    };
    step: {
      id: string;
      created_at: string;
      updated_at: string;
      claim_updated_at: string | null;
      reroute_count: number;
      terminal_reroute_count: number;
      target_moved_reroute_count: number;
      preclaim_death_count: number;
    };
  }

  function inspectScript(): string {
    const dbJs = JSON.stringify(path.join(distDir(), "db.js"));
    return [
      `import { getDb, SCHEMA_VERSION, _migrateFullRuns } from ${dbJs};`,
      "const db = getDb();",
      'const user_version = db.prepare("PRAGMA user_version").get().user_version;',
      'const runCols = db.prepare("PRAGMA table_info(runs)").all().map((c) => c.name);',
      'const stepCols = db.prepare("PRAGMA table_info(steps)").all().map((c) => c.name);',
      // The exact status SELECT shape from src/installer/status.ts plus the new
      // matchlock_policy column — must not throw after migration.
      'const run = db.prepare("SELECT id, run_number, workflow_id, task, status, context, created_at, updated_at, tokens_spent, worker_lost_count, ceiling_expiry_count, instant_fail_count, scheduling_requested_at, harness_probe_at, matchlock_policy FROM runs WHERE id = ?").get("legacy-run");',
      'const step = db.prepare("SELECT id, reroute_count, terminal_reroute_count, target_moved_reroute_count, preclaim_death_count, created_at, updated_at, claim_updated_at FROM steps WHERE id = ?").get("legacy-step");',
      "console.log(JSON.stringify({ user_version, schemaVersion: SCHEMA_VERSION, fullRuns: _migrateFullRuns, runCols, stepCols, run, step }));",
    ].join("\n");
  }

  // Samples detectSchemaLineage() on the RAW pre-migration fixture (a second
  // read-only connection), then again through getDb() after the chain ran.
  // This proves the exported helper discriminates from PRAGMA table_info and
  // that migrate() drives the same state to "current".
  function lineageScript(): string {
    const dbJs = JSON.stringify(path.join(distDir(), "db.js"));
    return [
      `import { DatabaseSync } from "node:sqlite";`,
      `import { getDb, SCHEMA_VERSION, detectSchemaLineage } from ${dbJs};`,
      "const raw = new DatabaseSync(process.env.TAMANDUA_DB_PATH);",
      "const before = detectSchemaLineage(raw);",
      "const beforeVersion = raw.prepare('PRAGMA user_version').get().user_version;",
      "raw.close();",
      "const db = getDb();",
      "const after = detectSchemaLineage(db);",
      "const user_version = db.prepare('PRAGMA user_version').get().user_version;",
      'const runCols = db.prepare("PRAGMA table_info(runs)").all().map((c) => c.name);',
      'const stepCols = db.prepare("PRAGMA table_info(steps)").all().map((c) => c.name);',
      "console.log(JSON.stringify({ before, beforeVersion, after, user_version, schemaVersion: SCHEMA_VERSION, runCols, stepCols }));",
    ].join("\n");
  }

  interface FreshInspectResult {
    user_version: number;
    schemaVersion: number;
    fullRuns: number;
    runCols: string[];
    stepCols: string[];
  }

  function freshInspectScript(): string {
    const dbJs = JSON.stringify(path.join(distDir(), "db.js"));
    return [
      `import { getDb, SCHEMA_VERSION, _migrateFullRuns } from ${dbJs};`,
      "const db = getDb();",
      'const user_version = db.prepare("PRAGMA user_version").get().user_version;',
      'const runCols = db.prepare("PRAGMA table_info(runs)").all().map((c) => c.name);',
      'const stepCols = db.prepare("PRAGMA table_info(steps)").all().map((c) => c.name);',
      "console.log(JSON.stringify({ user_version, schemaVersion: SCHEMA_VERSION, fullRuns: _migrateFullRuns, runCols, stepCols }));",
    ].join("\n");
  }

  function countOf(values: string[], target: string): number {
    return values.filter((v) => v === target).length;
  }

  // Defaults for the common ISO-Z fixture shape; callers override just the
  // lineage-relevant fields (userVersion, matchlockPolicy, targetMoved,
  // preclaim).
  function seedOpts(overrides: Partial<SeedOpts> & Pick<SeedOpts, "userVersion">): SeedOpts {
    return {
      matchlockPolicy: "absent",
      targetMoved: "absent",
      runCreatedAt: "2026-01-02T03:04:05.000Z",
      runUpdatedAt: "2026-01-02T03:04:06.000Z",
      stepCreatedAt: "2026-03-04T05:06:07.000Z",
      stepUpdatedAt: "2026-03-04T05:06:08.000Z",
      stepClaimUpdatedAt: "2026-03-04T05:06:09.000Z",
      ...overrides,
    };
  }

  it("v9 → v13: ISO-Z instants, target_moved_reroute_count and matchlock_policy added, status SELECT works", () => {
    const th = createTempHome("tamandua-union4-v9-");
    const dbPath = path.join(th.root, "v9.db");
    seedLegacyState(dbPath, {
      userVersion: 9,
      matchlockPolicy: "absent",
      targetMoved: "absent",
      runCreatedAt: "2026-01-02 03:04:05",
      runUpdatedAt: "2026-01-02 03:04:06",
      stepCreatedAt: "2026-03-04 05:06:07",
      stepUpdatedAt: "2026-03-04 05:06:08",
      stepClaimUpdatedAt: "2026-03-04 05:06:09",
    });

    const parsed = JSON.parse(runInSubprocess(th, dbPath, inspectScript())) as InspectResult;

    assert.equal(parsed.schemaVersion, 13, "chain must converge on SCHEMA_VERSION 13");
    assert.equal(parsed.user_version, 13, "v9 must be re-stamped to 13");
    assert.equal(parsed.fullRuns, 1, "v9 must take the slow migration path exactly once");
    assert.equal(countOf(parsed.runCols, "matchlock_policy"), 1,
      "12->13 must add runs.matchlock_policy exactly once");
    assert.equal(countOf(parsed.stepCols, "target_moved_reroute_count"), 1,
      "10->11 must add steps.target_moved_reroute_count exactly once");
    assert.equal(countOf(parsed.stepCols, "preclaim_death_count"), 1,
      "11->12 must add steps.preclaim_death_count exactly once");
    assert.equal(parsed.run.created_at, "2026-01-02T03:04:05.000Z",
      "9->10 must rewrite the naive runs instant to ISO-Z");
    assert.equal(parsed.run.updated_at, "2026-01-02T03:04:06.000Z",
      "9->10 must rewrite every naive runs instant");
    assert.equal(parsed.run.scheduling_requested_at, null, "NULL instants stay NULL");
    assert.equal(parsed.step.created_at, "2026-03-04T05:06:07.000Z",
      "9->10 must rewrite the naive steps instant to ISO-Z");
    assert.equal(parsed.step.updated_at, "2026-03-04T05:06:08.000Z");
    assert.equal(parsed.step.claim_updated_at, "2026-03-04T05:06:09.000Z");
    assert.equal(parsed.step.target_moved_reroute_count, 0,
      "existing step gets the 10->11 DEFAULT 0");
    assert.equal(parsed.run.matchlock_policy, null,
      "existing run keeps NULL matchlock_policy (native path)");
    assert.equal(parsed.run.id, "legacy-run", "status SELECT over runs still works");
    assert.equal(parsed.run.tokens_spent, 42, "existing values survive the chain");
    assert.equal(parsed.run.worker_lost_count, 3, "existing counters survive the chain");
  });

  it("v10 MAIN lineage → v13: ISO-Z instants unchanged, target_moved and matchlock_policy added", () => {
    const th = createTempHome("tamandua-union4-v10-main-");
    const dbPath = path.join(th.root, "v10-main.db");
    seedLegacyState(dbPath, {
      userVersion: 10,
      matchlockPolicy: "absent",
      targetMoved: "absent",
      runCreatedAt: "2026-01-02T03:04:05.000Z",
      runUpdatedAt: "2026-01-02T03:04:06.123Z",
      stepCreatedAt: "2026-03-04T05:06:07.000Z",
      stepUpdatedAt: "2026-03-04T05:06:08.000Z",
      stepClaimUpdatedAt: "2026-03-04T05:06:09.000Z",
    });

    const parsed = JSON.parse(runInSubprocess(th, dbPath, inspectScript())) as InspectResult;

    assert.equal(parsed.user_version, 13, "v10 MAIN must be re-stamped to 13");
    assert.equal(parsed.fullRuns, 1, "v10 MAIN must take the slow migration path");
    assert.equal(countOf(parsed.runCols, "matchlock_policy"), 1);
    assert.equal(countOf(parsed.stepCols, "target_moved_reroute_count"), 1);
    assert.equal(countOf(parsed.stepCols, "preclaim_death_count"), 1,
      "11->12 must add steps.preclaim_death_count exactly once to a v10 main DB");
    assert.equal(parsed.run.created_at, "2026-01-02T03:04:05.000Z",
      "main-lineage ISO-Z instants must stay byte-identical");
    assert.equal(parsed.run.updated_at, "2026-01-02T03:04:06.123Z",
      "millisecond precision must be preserved for main-lineage values");
    assert.equal(parsed.step.created_at, "2026-03-04T05:06:07.000Z");
    assert.equal(parsed.step.claim_updated_at, "2026-03-04T05:06:09.000Z");
    assert.equal(parsed.step.target_moved_reroute_count, 0);
    assert.equal(parsed.run.matchlock_policy, null,
      "a main-lineage run keeps the native path (NULL policy)");
    assert.equal(parsed.run.id, "legacy-run", "status SELECT over runs still works");
  });

  it("v10 MATCHLOCK lineage → v13: policy preserved, naive instants rewritten, target_moved added", () => {
    const th = createTempHome("tamandua-union4-v10-matchlock-");
    const dbPath = path.join(th.root, "v10-matchlock.db");
    seedLegacyState(dbPath, {
      userVersion: 10,
      matchlockPolicy: "present",
      targetMoved: "absent",
      runCreatedAt: "2026-02-03 04:05:06",
      runUpdatedAt: "2026-02-03 04:05:07",
      stepCreatedAt: "2026-04-05 06:07:08",
      stepUpdatedAt: "2026-04-05 06:07:09",
      stepClaimUpdatedAt: "2026-04-05 06:07:10",
    });

    const parsed = JSON.parse(runInSubprocess(th, dbPath, inspectScript())) as InspectResult;

    assert.equal(parsed.user_version, 13, "a Matchlock-lineage v10 DB must reach v13");
    assert.equal(parsed.fullRuns, 1, "v10 MATCHLOCK must take the slow migration path");
    assert.equal(countOf(parsed.runCols, "matchlock_policy"), 1,
      "the existing matchlock_policy column must not be duplicated");
    assert.equal(countOf(parsed.stepCols, "target_moved_reroute_count"), 1,
      "10->11 must still add the missing target_moved column");
    assert.equal(countOf(parsed.stepCols, "preclaim_death_count"), 1,
      "11->12 must add the missing preclaim column to a Matchlock-lineage v10 DB");
    assert.equal(parsed.run.matchlock_policy, MATCHLOCK_POLICY_JSON,
      "the Matchlock policy captured at run creation must survive the union");
    assert.deepEqual(JSON.parse(parsed.run.matchlock_policy as string),
      { image: "ghcr.io/acme/pi:1" },
      "policy JSON must round-trip unchanged");
    assert.equal(parsed.run.created_at, "2026-02-03T04:05:06.000Z",
      "the 9->10 rewrite must also normalize Matchlock-lineage naive instants");
    assert.equal(parsed.run.updated_at, "2026-02-03T04:05:07.000Z");
    assert.equal(parsed.step.created_at, "2026-04-05T06:07:08.000Z");
    assert.equal(parsed.step.claim_updated_at, "2026-04-05T06:07:10.000Z");
    assert.equal(parsed.step.target_moved_reroute_count, 0);
    assert.equal(parsed.run.id, "legacy-run", "status SELECT over runs still works");
  });

  it("v11 MAIN lineage → v13: gains preclaim_death_count and matchlock_policy, keeps target_moved value, ends at 13", () => {
    const th = createTempHome("tamandua-union4-v11-");
    const dbPath = path.join(th.root, "v11.db");
    seedLegacyState(dbPath, {
      userVersion: 11,
      matchlockPolicy: "absent",
      targetMoved: "present",
      targetMovedValue: 7,
      runCreatedAt: "2026-01-02T03:04:05.000Z",
      runUpdatedAt: "2026-01-02T03:04:06.000Z",
      stepCreatedAt: "2026-03-04T05:06:07.000Z",
      stepUpdatedAt: "2026-03-04T05:06:08.000Z",
      stepClaimUpdatedAt: "2026-03-04T05:06:09.000Z",
    });

    const parsed = JSON.parse(runInSubprocess(th, dbPath, inspectScript())) as InspectResult;

    assert.equal(parsed.user_version, 13, "v11 must be re-stamped to 13");
    assert.equal(parsed.fullRuns, 1, "v11 must take the slow migration path");
    assert.equal(countOf(parsed.runCols, "matchlock_policy"), 1,
      "12->13 must add exactly one matchlock_policy column");
    assert.equal(countOf(parsed.stepCols, "target_moved_reroute_count"), 1,
      "the pre-existing target_moved column must not be duplicated");
    assert.equal(countOf(parsed.stepCols, "preclaim_death_count"), 1,
      "11->12 must add exactly one preclaim_death_count column");
    assert.equal(parsed.step.preclaim_death_count, 0,
      "a legacy v11 step reads back preclaim_death_count = 0 via DEFAULT");
    assert.equal(parsed.step.target_moved_reroute_count, 7,
      "an existing target_moved_reroute_count value must not be reset");
    assert.equal(parsed.run.matchlock_policy, null);
    assert.equal(parsed.run.created_at, "2026-01-02T03:04:05.000Z");
    assert.equal(parsed.step.created_at, "2026-03-04T05:06:07.000Z");
    assert.equal(parsed.run.id, "legacy-run", "status SELECT over runs still works");
  });

  it("v11 MATCHLOCK lineage → v13: policy and target_moved preserved, preclaim added, naive instants normalized", () => {
    const th = createTempHome("tamandua-union4-v11-matchlock-");
    const dbPath = path.join(th.root, "v11-matchlock.db");
    seedLegacyState(dbPath, seedOpts({
      userVersion: 11,
      matchlockPolicy: "present",
      targetMoved: "present",
      targetMovedValue: 9,
      runCreatedAt: "2026-02-03 04:05:06",
      runUpdatedAt: "2026-02-03 04:05:07",
      stepCreatedAt: "2026-04-05 06:07:08",
      stepUpdatedAt: "2026-04-05 06:07:09",
      stepClaimUpdatedAt: "2026-04-05 06:07:10",
    }));

    const parsed = JSON.parse(runInSubprocess(th, dbPath, inspectScript())) as InspectResult;

    assert.equal(parsed.user_version, 13, "v11 MATCHLOCK must be re-stamped to 13");
    assert.equal(parsed.fullRuns, 1, "v11 MATCHLOCK must take the slow migration path");
    assert.equal(countOf(parsed.runCols, "matchlock_policy"), 1,
      "the pre-existing matchlock_policy column must not be duplicated");
    assert.equal(countOf(parsed.stepCols, "target_moved_reroute_count"), 1,
      "the pre-existing target_moved column must not be duplicated");
    assert.equal(countOf(parsed.stepCols, "preclaim_death_count"), 1,
      "11->12 must add exactly one preclaim_death_count column to a v11 Matchlock DB");
    assert.equal(parsed.step.preclaim_death_count, 0,
      "a v11 Matchlock step reads back preclaim_death_count = 0 via DEFAULT");
    assert.equal(parsed.step.target_moved_reroute_count, 9,
      "an existing target_moved_reroute_count value must not be reset");
    assert.equal(parsed.run.matchlock_policy, MATCHLOCK_POLICY_JSON,
      "the Matchlock policy captured at run creation must survive the union");
    assert.deepEqual(JSON.parse(parsed.run.matchlock_policy as string),
      { image: "ghcr.io/acme/pi:1" });
    assert.equal(parsed.run.created_at, "2026-02-03T04:05:06.000Z",
      "9->10 must normalize the v11 Matchlock-lineage naive runs instants");
    assert.equal(parsed.run.updated_at, "2026-02-03T04:05:07.000Z");
    assert.equal(parsed.step.created_at, "2026-04-05T06:07:08.000Z",
      "9->10 must normalize the v11 Matchlock-lineage naive steps instants");
    assert.equal(parsed.step.claim_updated_at, "2026-04-05T06:07:10.000Z");
    assert.equal(parsed.run.id, "legacy-run", "status SELECT over runs still works");
  });

  it("guards are idempotent: forcing the slow path over an already-v13 shape duplicates nothing", () => {
    const th = createTempHome("tamandua-union4-guard-idem-");
    const dbPath = path.join(th.root, "guard-idem.db");
    seedLegacyState(dbPath, {
      userVersion: 9,
      matchlockPolicy: "absent",
      targetMoved: "absent",
      runCreatedAt: "2026-01-02 03:04:05",
      runUpdatedAt: "2026-01-02 03:04:06",
      stepCreatedAt: "2026-03-04 05:06:07",
      stepUpdatedAt: "2026-03-04 05:06:08",
      stepClaimUpdatedAt: "2026-03-04 05:06:09",
    });

    const first = JSON.parse(runInSubprocess(th, dbPath, inspectScript())) as InspectResult;
    assert.equal(first.user_version, 13);

    // Rewind only user_version (the columns stay at the v13 shape) and force
    // applySchema() over an already-current schema. All three steps must
    // no-op through their pragma_table_info guards instead of raising
    // "duplicate column name".
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA user_version = 9");
    raw.close();

    const again = JSON.parse(runInSubprocess(th, dbPath, inspectScript())) as InspectResult;
    assert.equal(again.user_version, 13, "forced slow path re-stamps to 13");
    assert.equal(again.fullRuns, 1, "forced slow path runs applySchema exactly once");
    assert.equal(countOf(again.runCols, "matchlock_policy"), 1,
      "12->13 guard must not duplicate runs.matchlock_policy");
    assert.equal(countOf(again.stepCols, "target_moved_reroute_count"), 1,
      "10->11 guard must not duplicate steps.target_moved_reroute_count");
    assert.deepEqual(again.run, first.run,
      "9->10 instant rewrite is idempotent: already-ISO-Z values stay byte-identical");
    assert.deepEqual(again.step, first.step, "forced re-run leaves step values unchanged");
  });

  it("detectSchemaLineage discriminates both v12 lineages and every pre-v12 shape through PRAGMA table_info", () => {
    const th = createTempHome("tamandua-union4-lineage-");
    const fixtures: Array<{ name: string; opts: SeedOpts; expected: string }> = [
      { name: "v9-main", opts: seedOpts({ userVersion: 9 }), expected: "pre-v12" },
      { name: "v10-main", opts: seedOpts({ userVersion: 10 }), expected: "pre-v12" },
      { name: "v10-union", opts: seedOpts({ userVersion: 10, matchlockPolicy: "present" }), expected: "union-v12" },
      { name: "v11-main", opts: seedOpts({ userVersion: 11, targetMoved: "present" }), expected: "pre-v12" },
      {
        name: "v11-union",
        opts: seedOpts({ userVersion: 11, targetMoved: "present", matchlockPolicy: "present" }),
        expected: "union-v12",
      },
      {
        name: "v12-main",
        opts: seedOpts({ userVersion: 12, targetMoved: "present", preclaim: "present", preclaimValue: 5 }),
        expected: "main-v12",
      },
      {
        name: "v12-union",
        opts: seedOpts({ userVersion: 12, targetMoved: "present", matchlockPolicy: "present" }),
        expected: "union-v12",
      },
    ];

    interface LineageResult {
      before: string;
      beforeVersion: number;
      after: string;
      user_version: number;
      schemaVersion: number;
      runCols: string[];
      stepCols: string[];
    }

    for (const fixture of fixtures) {
      const dbPath = path.join(th.root, `${fixture.name}.db`);
      seedLegacyState(dbPath, fixture.opts);
      const parsed = JSON.parse(runInSubprocess(th, dbPath, lineageScript())) as LineageResult;

      assert.equal(parsed.before, fixture.expected,
        `${fixture.name}: detector must classify the raw pre-migration fixture as ${fixture.expected}`);
      assert.equal(parsed.beforeVersion, fixture.opts.userVersion,
        `${fixture.name}: the version-only probe must see the raw user_version`);
      assert.equal(parsed.after, "current",
        `${fixture.name}: after getDb() the shape must be current`);
      assert.equal(parsed.schemaVersion, 13, "the chain terminates at 13");
      assert.equal(parsed.user_version, 13,
        `${fixture.name}: migrate() must re-stamp to 13`);
      assert.ok(parsed.runCols.includes("matchlock_policy"),
        `${fixture.name}: runs.matchlock_policy must exist after the chain`);
      assert.ok(parsed.stepCols.includes("preclaim_death_count"),
        `${fixture.name}: steps.preclaim_death_count must exist after the chain`);
    }
  });

  it("v12 MAIN lineage → v13: gains matchlock_policy, preserves preclaim count, status SELECT works", () => {
    const th = createTempHome("tamandua-union4-v12-main-");
    const dbPath = path.join(th.root, "v12-main.db");
    seedLegacyState(dbPath, seedOpts({
      userVersion: 12,
      matchlockPolicy: "absent",
      targetMoved: "present",
      targetMovedValue: 4,
      preclaim: "present",
      preclaimValue: 5,
    }));

    const parsed = JSON.parse(runInSubprocess(th, dbPath, inspectScript())) as InspectResult;

    assert.equal(parsed.user_version, 13, "v12 MAIN must be re-stamped to 13");
    assert.equal(parsed.fullRuns, 1, "v12 MAIN must take the slow migration path");
    assert.equal(countOf(parsed.runCols, "matchlock_policy"), 1,
      "12->13 must add runs.matchlock_policy exactly once to a main-v12 DB");
    assert.equal(countOf(parsed.stepCols, "preclaim_death_count"), 1,
      "the main-v12 preclaim column must not be duplicated");
    assert.equal(parsed.step.preclaim_death_count, 5,
      "an existing main-lineage preclaim_death_count must be preserved");
    assert.equal(parsed.step.target_moved_reroute_count, 4,
      "an existing target_moved_reroute_count must be preserved");
    assert.equal(parsed.run.matchlock_policy, null,
      "a main-v12 run keeps the native path (NULL policy)");
    assert.equal(parsed.run.id, "legacy-run", "status SELECT over runs still works");
  });

  it("v12 UNION lineage → v13: gains preclaim_death_count, preserves matchlock_policy, normalizes naive instants", () => {
    const th = createTempHome("tamandua-union4-v12-union-");
    const dbPath = path.join(th.root, "v12-union.db");
    seedLegacyState(dbPath, seedOpts({
      userVersion: 12,
      matchlockPolicy: "present",
      targetMoved: "present",
      targetMovedValue: 4,
      // The union cut predates the 9->10 instant normalization on some
      // installs, so a union-v12 DB can still carry naive instants. The
      // migration must normalize them even though it takes the v12 path.
      runCreatedAt: "2026-02-03 04:05:06",
      runUpdatedAt: "2026-02-03 04:05:07",
      stepCreatedAt: "2026-04-05 06:07:08",
      stepUpdatedAt: "2026-04-05 06:07:09",
      stepClaimUpdatedAt: "2026-04-05 06:07:10",
    }));

    const parsed = JSON.parse(runInSubprocess(th, dbPath, inspectScript())) as InspectResult;

    assert.equal(parsed.user_version, 13, "v12 UNION must be re-stamped to 13");
    assert.equal(parsed.fullRuns, 1, "v12 UNION must take the slow migration path");
    assert.equal(countOf(parsed.stepCols, "preclaim_death_count"), 1,
      "11->12 must add steps.preclaim_death_count exactly once to a union-v12 DB");
    assert.equal(countOf(parsed.runCols, "matchlock_policy"), 1,
      "the union-v12 matchlock_policy column must not be duplicated");
    assert.equal(countOf(parsed.stepCols, "target_moved_reroute_count"), 1,
      "the union-v12 target_moved_reroute_count column must not be duplicated");
    assert.equal(parsed.step.preclaim_death_count, 0,
      "a new union-lineage preclaim column reads back NOT NULL DEFAULT 0");
    assert.equal(parsed.run.matchlock_policy, MATCHLOCK_POLICY_JSON,
      "the Matchlock policy captured at run creation must survive the union");
    assert.deepEqual(JSON.parse(parsed.run.matchlock_policy as string),
      { image: "ghcr.io/acme/pi:1" },
      "policy JSON must round-trip unchanged");
    assert.equal(parsed.run.created_at, "2026-02-03T04:05:06.000Z",
      "the 9->10 normalization must run for a union-v12 DB with naive runs instants");
    assert.equal(parsed.run.updated_at, "2026-02-03T04:05:07.000Z");
    assert.equal(parsed.step.created_at, "2026-04-05T06:07:08.000Z",
      "the 9->10 normalization must run for a union-v12 DB with naive steps instants");
    assert.equal(parsed.step.updated_at, "2026-04-05T06:07:09.000Z");
    assert.equal(parsed.step.claim_updated_at, "2026-04-05T06:07:10.000Z");
    assert.equal(parsed.step.target_moved_reroute_count, 4,
      "an existing target_moved_reroute_count must be preserved");
    assert.equal(parsed.run.id, "legacy-run", "status SELECT over runs still works");
  });

  it("re-opening an already-migrated v12-lineage DB is idempotent (both lineages, no throw)", () => {
    for (const lineage of ["main-v12", "union-v12"] as const) {
      const th = createTempHome(`tamandua-union4-v12-idem-${lineage}-`);
      const dbPath = path.join(th.root, `${lineage}.db`);
      seedLegacyState(dbPath, seedOpts({
        userVersion: 12,
        targetMoved: "present",
        matchlockPolicy: lineage === "union-v12" ? "present" : "absent",
        preclaim: lineage === "main-v12" ? "present" : "absent",
      }));

      const first = JSON.parse(runInSubprocess(th, dbPath, inspectScript())) as InspectResult;
      assert.equal(first.user_version, 13, `${lineage}: first open stamps v13`);

      // Second open: getDb() sees user_version === 13 and must early-return
      // without running the DDL path or throwing.
      const second = JSON.parse(runInSubprocess(th, dbPath, inspectScript())) as InspectResult;
      assert.equal(second.user_version, 13, `${lineage}: second open keeps v13`);
      assert.equal(second.fullRuns, 0, `${lineage}: second open early-returns (no DDL)`);
      assert.deepEqual(second.run, first.run, `${lineage}: run values unchanged`);
      assert.deepEqual(second.step, first.step, `${lineage}: step values unchanged`);
    }
  });

  it("already at v13: migrate() fast-path is a no-op (no DDL, no re-stamp churn)", () => {
    const th = createTempHome("tamandua-union4-v13-noop-");
    const dbPath = path.join(th.root, "current.db");

    const first = JSON.parse(runInSubprocess(th, dbPath, freshInspectScript())) as FreshInspectResult;
    assert.equal(first.schemaVersion, 13);
    assert.equal(first.user_version, 13, "a fresh DB starts at the current version");
    assert.equal(first.fullRuns, 1, "first open stamps v13 through the full DDL path");
    assert.equal(countOf(first.runCols, "matchlock_policy"), 1,
      "a v13 DB must have runs.matchlock_policy exactly once");
    assert.equal(countOf(first.stepCols, "preclaim_death_count"), 1,
      "a v13 DB must have steps.preclaim_death_count exactly once");
    assert.equal(countOf(first.stepCols, "target_moved_reroute_count"), 1,
      "a v13 DB must have steps.target_moved_reroute_count exactly once");

    const second = JSON.parse(runInSubprocess(th, dbPath, freshInspectScript())) as FreshInspectResult;
    assert.equal(second.user_version, 13, "second open keeps user_version at 13");
    assert.equal(second.fullRuns, 0,
      "second open must early-return without running the DDL path");
    assert.deepEqual(second.runCols, first.runCols, "no DDL: runs columns unchanged");
    assert.deepEqual(second.stepCols, first.stepCols, "no DDL: steps columns unchanged");
  });
});
