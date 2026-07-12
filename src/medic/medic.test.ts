import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ensureMedicTables, getMedicStatus, runMedicCheck, getRecentMedicChecks } from "../../dist/medic/medic.js";
import { checkDatabaseIntegrity } from "../../dist/medic/checks.js";

describe("medic", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let originalDbPath: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    originalHome = process.env.HOME;
    tempDir = tamanduaTempDir("tamandua-medic-");
    const tamanduaDir = path.join(tempDir, ".tamandua");
    fs.mkdirSync(tamanduaDir, { recursive: true });
    dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    // medic checks uses os.homedir() to find cron-jobs.json
    process.env.HOME = tempDir;

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
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
      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
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
  });

  afterEach(() => {
    if (originalDbPath) process.env.TAMANDUA_DB_PATH = originalDbPath;
    else delete process.env.TAMANDUA_DB_PATH;
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    try { db.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("ensureMedicTables", () => {
    it("creates medic_checks table", () => {
      ensureMedicTables();

      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='medic_checks'"
      ).get() as { name: string } | undefined;

      assert.ok(row);
      assert.equal(row!.name, "medic_checks");
    });

    it("is idempotent — can be called multiple times", () => {
      ensureMedicTables();
      assert.doesNotThrow(() => ensureMedicTables());
    });
  });

  describe("checkDatabaseIntegrity", () => {
    it("returns ok for a healthy database", () => {
      const result = checkDatabaseIntegrity();
      assert.equal(result.ok, true);
      assert.equal(result.message, "ok");
    });
  });

  describe("getMedicStatus", () => {
    it("returns installed: true after tables are created", () => {
      ensureMedicTables();
      const status = getMedicStatus();
      assert.equal(status.installed, true);
      assert.equal(status.lastCheck, null);
      assert.equal(status.recentChecks, 0);
    });
  });

  // concurrency:1 — subtests race on process.env.TAMANDUA_DB_PATH via the getDb()
  // singleton, which reads the env at call time (not at hook time).
  describe("runMedicCheck", { concurrency: 1 }, () => {
    it("runs without errors on clean DB", async () => {
      ensureMedicTables();
      const result = await runMedicCheck();
      assert.equal(result.issuesFound, 0);
      assert.equal(result.actionsTaken, 0);
      assert.ok(result.summary.includes("All clear"));
    });

    it("detects and remediates zombie runs", async () => {
      ensureMedicTables();

      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-3 hours'), datetime('now', '-3 hours'))"
      ).run("zombie-run", "bug-fix", "Fix more", "running", "{}");

      db.prepare(
        "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-3 hours'), datetime('now', '-3 hours'))"
      ).run("zombie-step-1", "zombie-run", "implement", "dev-agent", 0, "Do it", "done", "completed");

      const result = await runMedicCheck();
      assert.ok(result.issuesFound >= 1, "should find zombie runs");
      assert.ok(
        result.summary.includes("critical") || result.summary.includes("auto-fixed"),
        "summary should mention critical or fixes",
      );
    });

    it("populates medic_checks table after check", async () => {
      ensureMedicTables();
      const result = await runMedicCheck();

      // Scope COUNT to the specific check ID, not global medic_checks
      const row = db.prepare("SELECT COUNT(*) as cnt FROM medic_checks WHERE id = ?").get(result.id) as { cnt: number } | undefined;
      assert.equal(row?.cnt, 1, "medic_checks should have exactly one entry for this check ID");
    });
  });

  // concurrency:1 — subtests race on process.env.TAMANDUA_DB_PATH via the getDb()
  // singleton, which reads the env at call time (not at hook time).
  describe("getRecentMedicChecks", { concurrency: 1 }, () => {
    it("returns empty array when no checks exist", () => {
      ensureMedicTables();
      const checks = getRecentMedicChecks(5);
      assert.deepEqual(checks, []);
    });

    it("returns recent checks after runMedicCheck", async () => {
      ensureMedicTables();
      const result = await runMedicCheck();

      const checks = getRecentMedicChecks(5);
      // Verify this test's own check is present, not just a global count
      const own = checks.find(c => c.id === result.id);
      assert.ok(own, "should include our check");
      assert.ok("checkedAt" in own!);
      assert.ok("issuesFound" in own!);
      assert.ok("summary" in own!);
    });

    it("respects limit parameter", async () => {
      ensureMedicTables();
      const r1 = await runMedicCheck();
      const r2 = await runMedicCheck();

      const checks = getRecentMedicChecks(1);
      assert.ok(checks.length === 1, "should return exactly 1 check with limit 1");
      // The returned check should be one of ours
      assert.ok(checks[0]?.id === r2.id || checks[0]?.id === r1.id);
    });
  });

  // concurrency:1 — subtests race on process.env.TAMANDUA_DB_PATH via the getDb()
  // singleton, which reads the env at call time (not at hook time).
  describe("getMedicStatus", { concurrency: 1 }, () => {
    it("reports recent stats after checks", async () => {
      ensureMedicTables();
      const firstCheck = await runMedicCheck();

      // Add a zombie run so we get non-zero stats
      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-3 hours'), datetime('now', '-3 hours'))"
      ).run("stats-run", "bug-fix", "Fix stats", "running", "{}");
      db.prepare(
        "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-3 hours'), datetime('now', '-3 hours'))"
      ).run("stats-step", "stats-run", "implement", "dev-agent", 0, "Do", "done", "done");

      const secondCheck = await runMedicCheck();

      const status = getMedicStatus();
      assert.equal(status.installed, true);
      assert.ok(status.lastCheck !== null, "should have last check");
      // Verify the last check matches our second run
      assert.equal(status.lastCheck?.checkedAt, secondCheck.checkedAt);
      assert.ok(status.recentChecks >= 1);
    });
  });
});
