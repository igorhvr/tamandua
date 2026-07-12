import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { checkActiveRuns, uninstallWorkflow, uninstallAllWorkflows } from "../../dist/installer/uninstall.js";

describe("uninstall", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let originalDbPath: string | undefined;
  let originalHome: string | undefined;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    originalHome = process.env.HOME;
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    tempDir = tamanduaTempDir("tamandua-uninstall-");
    dbPath = path.join(tempDir, ".tamandua", "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.HOME = tempDir;
    process.env.TAMANDUA_STATE_DIR = path.join(tempDir, ".tamandua");

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
    if (originalStateDir) process.env.TAMANDUA_STATE_DIR = originalStateDir;
    else delete process.env.TAMANDUA_STATE_DIR;
    try { db.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("checkActiveRuns", () => {
    it("returns empty array when no active runs", async () => {
      const runs = await checkActiveRuns();
      assert.deepEqual(runs, []);
    });

    it("returns empty array for completed runs", async () => {
      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      ).run("r1", "wf1", "task1", "completed", "{}");
      const runs = await checkActiveRuns();
      assert.deepEqual(runs, []);
    });

    it("returns running runs", async () => {
      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      ).run("r1", "wf1", "task1", "running", "{}");
      const runs = await checkActiveRuns();
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.id, "r1");
      assert.equal(runs[0]!.task, "task1");
      assert.equal(runs[0]!.status, "running");
    });

    it("returns paused runs", async () => {
      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      ).run("r2", "wf2", "task2", "paused", "{}");
      const runs = await checkActiveRuns();
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.id, "r2");
    });

    it("filters active runs by workflow_id", async () => {
      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      ).run("r1", "wf-a", "task A", "running", "{}");
      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      ).run("r2", "wf-b", "task B", "running", "{}");

      const runsA = await checkActiveRuns("wf-a");
      assert.equal(runsA.length, 1);
      assert.equal(runsA[0]!.id, "r1");
    });
  });

  describe("uninstallWorkflow", () => {
    it("refuses when workflow has active (running) runs", async () => {
      const wfDir = path.join(tempDir, ".tamandua", "workflows", "wf-active");
      fs.mkdirSync(wfDir, { recursive: true });

      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      ).run("r-active-1", "wf-active", "active task", "running", "{}");

      await assert.rejects(
        uninstallWorkflow("wf-active"),
        /Cannot uninstall workflow "wf-active"/,
      );
    });

    it("refuses when workflow has active (paused) runs", async () => {
      const wfDir = path.join(tempDir, ".tamandua", "workflows", "wf-paused");
      fs.mkdirSync(wfDir, { recursive: true });

      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      ).run("r-paused-1", "wf-paused", "paused task", "paused", "{}");

      await assert.rejects(
        uninstallWorkflow("wf-paused"),
        /Cannot uninstall workflow "wf-paused"/,
      );
    });



    it("successfully uninstalls a workflow with no active runs", async () => {
      const wfId = "wf-clean";
      const tamanduaDir = path.join(tempDir, ".tamandua");

      // Create workflow directory
      const wfDir = path.join(tamanduaDir, "workflows", wfId);
      fs.mkdirSync(wfDir, { recursive: true });
      fs.writeFileSync(path.join(wfDir, "workflow.yml"), "id: test", "utf-8");

      // Create workspace directories
      const wsRoot = path.join(tamanduaDir, "workspaces", "workflows");
      const wsDir = path.join(wsRoot, `${wfId}_some-agent`);
      fs.mkdirSync(wsDir, { recursive: true });
      fs.writeFileSync(path.join(wsDir, "README.md"), "workspace", "utf-8");

      // Create agent directory
      const agentDir = path.join(tamanduaDir, "agents", `${wfId}_some-agent`);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "agent", "utf-8");

      // Create agents.json with entries
      const agentsJson = path.join(tamanduaDir, "agents.json");
      fs.writeFileSync(
        agentsJson,
        JSON.stringify([
          { id: `${wfId}_some-agent`, workflowId: wfId, name: "Dev" },
          { id: "other-wf_agent", workflowId: "other-wf", name: "Other" },
        ]),
        "utf-8",
      );

      const result = await uninstallWorkflow(wfId);

      // Check result structure
      assert.equal(result.workflowId, wfId);
      assert.ok(result.removedDirs.length >= 2, "should remove workflow and workspace dirs");
      assert.ok(result.removedAgents.length >= 1, "should track removed agents");
      assert.equal(result.errors.length, 0, "should have no errors");

      // Verify workflow dir is gone
      const wfExists = (() => { try { fs.accessSync(wfDir); return true; } catch { return false; } })();
      assert.ok(!wfExists, "workflow dir should be gone");

      // Verify workspace dir is gone
      const wsExists = (() => { try { fs.accessSync(wsDir); return true; } catch { return false; } })();
      assert.ok(!wsExists, "workspace dir should be gone");

      // Verify agent dir is gone
      const agentExists = (() => { try { fs.accessSync(agentDir); return true; } catch { return false; } })();
      assert.ok(!agentExists, "agent dir should be gone");

      // Verify agents.json still has other entries but not wf-clean
      const raw = fs.readFileSync(agentsJson, "utf-8");
      const list = JSON.parse(raw);
      assert.equal(list.length, 1);
      assert.equal(list[0].id, "other-wf_agent");
    });

    it("handles missing workflow directory gracefully", async () => {
      const wfId = "wf-no-dir";
      const tamanduaDir = path.join(tempDir, ".tamandua");
      fs.mkdirSync(tamanduaDir, { recursive: true });

      // No workflow dir exists — the fs.rm will fail (ENOENT) but force:true means no error
      const result = await uninstallWorkflow(wfId);
      assert.equal(result.errors.length, 0, "force:true rm should not error on missing dir");
    });

    it("handles missing workspace and agent directories", async () => {
      const wfId = "wf-minimal";
      const tamanduaDir = path.join(tempDir, ".tamandua");

      // Create only the workflow directory
      const wfDir = path.join(tamanduaDir, "workflows", wfId);
      fs.mkdirSync(wfDir, { recursive: true });

      // No workspaces, no agents — should still succeed
      const result = await uninstallWorkflow(wfId);
      assert.equal(result.errors.length, 0, "should not error on missing subdirs");
    });
  });

  describe("uninstallAllWorkflows", () => {
    it("returns empty array when no workflows dir exists", async () => {
      const results = await uninstallAllWorkflows();
      assert.deepEqual(results, []);
    });

    it("processes workflow dirs when present", async () => {
      const wfDir = path.join(tempDir, ".tamandua", "workflows", "wf-empty");
      fs.mkdirSync(wfDir, { recursive: true });

      const tamanduaDir = path.join(tempDir, ".tamandua");
      fs.mkdirSync(path.join(tamanduaDir, "agents"), { recursive: true });
      fs.writeFileSync(
        path.join(tamanduaDir, "agents.json"),
        JSON.stringify([
          { id: "wf-empty_dev-agent", workflowId: "wf-empty", name: "Dev" },
        ]),
        "utf-8",
      );

      const results = await uninstallAllWorkflows();
      assert.ok(results.length >= 1, "should process at least one workflow");
    });

    it("handles inner uninstall failure for one workflow", async () => {
      const tamanduaDir = path.join(tempDir, ".tamandua");

      // Create two workflow dirs
      const wfGood = path.join(tamanduaDir, "workflows", "wf-good");
      fs.mkdirSync(wfGood, { recursive: true });
      const wfBad = path.join(tamanduaDir, "workflows", "wf-bad");
      fs.mkdirSync(wfBad, { recursive: true });

      // Insert an active run for wf-bad so uninstallWorkflow throws
      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      ).run("r-bad-1", "wf-bad", "active", "running", "{}");

      const results = await uninstallAllWorkflows();
      assert.equal(results.length, 2, "should return result for both workflows");

      // Find the failure result
      const badResult = results.find((r) => r.workflowId === "wf-bad");
      assert.ok(badResult !== undefined, "should have result for wf-bad");
      assert.ok(badResult.errors.length > 0, "wf-bad should have errors");

      // wf-good should have succeeded (no errors, removed its dir)
      const goodResult = results.find((r) => r.workflowId === "wf-good");
      assert.ok(goodResult !== undefined, "should have result for wf-good");
    });
  });
});
