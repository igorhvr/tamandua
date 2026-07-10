import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { checkDatabaseIntegrity, checkStuckRuns, checkOrphanedCrons } from "../../dist/medic/checks.js";

describe("medic checks", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let originalDbPath: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    originalHome = process.env.HOME;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-medic-checks-"));
    const tamanduaDir = path.join(tempDir, ".tamandua");
    fs.mkdirSync(tamanduaDir, { recursive: true });
    dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
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

  describe("checkDatabaseIntegrity", () => {
    it("returns ok for a healthy database", () => {
      const result = checkDatabaseIntegrity();
      assert.equal(result.ok, true);
      assert.equal(result.message, "ok");
    });
  });

  describe("checkStuckRuns", () => {
    it("returns empty array when no stuck runs exist", () => {
      const stuck = checkStuckRuns();
      assert.deepEqual(stuck, []);
    });

    it("returns empty array for recent runs", () => {
      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      ).run("r1", "wf1", "task", "running", "{}");
      const stuck = checkStuckRuns();
      assert.deepEqual(stuck, []);
    });

    it("detects stuck runs (idle > 30 minutes)", () => {
      // Create a run that hasn't been updated for 2 hours
      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-2 hours'), datetime('now', '-2 hours'))"
      ).run("stuck-1", "wf-stuck", "Build feature", "running", "{}");

      // Add some steps
      db.prepare(
        "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-2 hours'), datetime('now', '-2 hours'))"
      ).run("step-a", "stuck-1", "implement", "dev", 0, "Do it", "pass", "running");

      db.prepare(
        "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-2 hours'), datetime('now', '-2 hours'))"
      ).run("step-b", "stuck-1", "test", "qa", 1, "Test it", "pass", "done");

      const stuck = checkStuckRuns();
      assert.equal(stuck.length, 1, "should find one stuck run");
      assert.equal(stuck[0]!.runId, "stuck-1");
      assert.equal(stuck[0]!.workflowId, "wf-stuck");
      assert.equal(stuck[0]!.totalSteps, 2);
      assert.equal(stuck[0]!.terminalSteps, 1); // one 'done' step
      assert.ok(stuck[0]!.idleMinutes >= 30);
    });

    it("does not flag runs idle less than threshold", () => {
      // Run updated only 5 minutes ago — should not be flagged
      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-5 minutes'), datetime('now', '-5 minutes'))"
      ).run("recent-1", "wf-recent", "Fresh task", "running", "{}");

      const stuck = checkStuckRuns();
      assert.deepEqual(stuck, []);
    });

    it("ignores non-running runs even if old", () => {
      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-2 hours'), datetime('now', '-2 hours'))"
      ).run("done-1", "wf-done", "Done task", "completed", "{}");

      const stuck = checkStuckRuns();
      assert.deepEqual(stuck, []);
    });
  });

  describe("checkOrphanedCrons", () => {
    it("returns empty array when no cron file exists", () => {
      const orphaned = checkOrphanedCrons();
      assert.deepEqual(orphaned, []);
    });

    it("returns empty array when cron file is empty array", () => {
      const cronDir = path.join(tempDir, ".tamandua");
      fs.mkdirSync(cronDir, { recursive: true });
      fs.writeFileSync(path.join(cronDir, "cron-jobs.json"), "[]", "utf-8");

      const orphaned = checkOrphanedCrons();
      assert.deepEqual(orphaned, []);
    });

    it("returns empty array when cron file has invalid JSON", () => {
      const cronDir = path.join(tempDir, ".tamandua");
      fs.mkdirSync(cronDir, { recursive: true });
      fs.writeFileSync(path.join(cronDir, "cron-jobs.json"), "not valid json", "utf-8");

      const orphaned = checkOrphanedCrons();
      assert.deepEqual(orphaned, []);
    });

    it("detects orphaned crons (no active runs for workflow)", () => {
      const cronDir = path.join(tempDir, ".tamandua");
      fs.mkdirSync(cronDir, { recursive: true });
      fs.writeFileSync(
        path.join(cronDir, "cron-jobs.json"),
        JSON.stringify([
          { id: "cron-1", workflowId: "wf-orphan", agentId: "dev" },
          { id: "cron-2", workflowId: "wf-active", agentId: "qa" },
        ]),
        "utf-8",
      );

      // Only wf-active has an active run
      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      ).run("r-active", "wf-active", "Active task", "running", "{}");

      const orphaned = checkOrphanedCrons();
      // wf-orphan should be detected as orphaned
      const orphans = orphaned.filter((o) => o.workflowId === "wf-orphan");
      assert.equal(orphans.length, 1, "should find orphaned cron for wf-orphan");
      assert.equal(orphans[0]!.cronJobId, "cron-1");
      assert.equal(orphans[0]!.activeRuns, 0);

      // wf-active should NOT be flagged
      const active = orphaned.filter((o) => o.workflowId === "wf-active");
      assert.equal(active.length, 0, "wf-active should not be orphaned");
    });

    it("detects orphaned cron for paused runs too", () => {
      const cronDir = path.join(tempDir, ".tamandua");
      fs.mkdirSync(cronDir, { recursive: true });
      fs.writeFileSync(
        path.join(cronDir, "cron-jobs.json"),
        JSON.stringify([
          { id: "cron-3", workflowId: "wf-paused", agentId: "dev" },
        ]),
        "utf-8",
      );

      // Create a paused run for this workflow — should NOT be orphaned
      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      ).run("r-paused", "wf-paused", "Paused task", "paused", "{}");

      const orphaned = checkOrphanedCrons();
      assert.deepEqual(orphaned, []);
    });

    it("skips cron jobs without workflowId", () => {
      const cronDir = path.join(tempDir, ".tamandua");
      fs.mkdirSync(cronDir, { recursive: true });
      fs.writeFileSync(
        path.join(cronDir, "cron-jobs.json"),
        JSON.stringify([
          { id: "cron-no-wf", agentId: "dev" },
        ]),
        "utf-8",
      );

      const orphaned = checkOrphanedCrons();
      assert.deepEqual(orphaned, []);
    });
  });

  describe("checkDatabaseIntegrity", () => {
    it("returns ok for a healthy database", () => {
      const result = checkDatabaseIntegrity();
      assert.equal(result.ok, true);
      assert.equal(result.message, "ok");
    });
  });
});
