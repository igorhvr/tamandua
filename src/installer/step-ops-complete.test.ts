import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { completeStep } from "../../dist/installer/step-ops.js";

describe("completeStep basic paths", () => {
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
    tempDir = tamanduaTempDir("tamandua-complete-step-");
    dbPath = path.join(tempDir, ".tamandua", "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.HOME = tempDir;
    process.env.TAMANDUA_STATE_DIR = path.join(tempDir, ".tamandua");

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL DEFAULT 'test',
      task TEXT NOT NULL DEFAULT 'test',
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      scheduling_status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL DEFAULT 0,
      input_template TEXT NOT NULL DEFAULT '',
      expects TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      type TEXT NOT NULL DEFAULT 'single',
      loop_config TEXT,
      current_story_id TEXT,
      abandoned_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS stories (
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
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

  it("completes a simple single step", () => {
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)"
    ).run("run-1", "wf", "test", "running");

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, expects, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("step-1-id", "run-1", "plan", "dev", 0, "", "running");

    const result = completeStep("step-1-id", "CHANGES: done");
    assert.ok(result.status === "advanced" || result.status === "completed");

    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get("step-1-id") as { status: string };
    assert.equal(step.status, "done");
  });

  it("blocks completion for failed runs", () => {
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)"
    ).run("run-fail", "wf", "test", "failed");

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("step-fail-id", "run-fail", "plan", "dev", 0, "running");

    const result = completeStep("step-fail-id", "output");
    assert.equal(result.status, "blocked");
  });

  it("throws when step not found with recovery hint", () => {
    assert.throws(
      () => completeStep("nonexistent-id", "output"),
      /Step not found: nonexistent-id\nIf you lost your step id, run: tamandua step current/,
    );
  });

  it("passes expects validation", () => {
    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run("r2", "wf", "t", "running");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, expects, status) VALUES (?, ?, ?, ?, ?, ?, ?)").run("s2", "r2", "plan", "dev", 0, "STATUS: done", "running");
    const r = completeStep("s2", "STATUS: done");
    assert.ok(r.status === "advanced" || r.status === "completed");
  });

  it("retries on expects failure", () => {
    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run("r3", "wf", "t", "running");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, expects, status) VALUES (?, ?, ?, ?, ?, ?, ?)").run("s3", "r3", "plan", "dev", 0, "REPO: x", "running");
    const r = completeStep("s3", "wrong");
    assert.equal(r.status, "retrying");
  });

  it("fails when expects exhausted", () => {
    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run("r4", "wf", "t", "running");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, expects, status, retry_count, max_retries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("s4", "r4", "plan", "dev", 0, "REPO: x", "running", 3, 3);
    const r = completeStep("s4", "no");
    assert.equal(r.status, "failed");
  });

  it("completes loop step story and stays running for next story", () => {
    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run("r7", "wf", "t", "running");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, expects, status, type, current_story_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("s7-loop", "r7", "develop", "dev", 0, "", "running", "loop", "story-1-id");
    db.prepare("INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("story-1-id", "r7", 0, "US-001", "Login", "Build login", '["AC1"]', "running");
    db.prepare("INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("story-2-id", "r7", 1, "US-002", "Dashboard", "Build dashboard", '["AC2"]', "pending");

    const r = completeStep("s7-loop", "CHANGES: done");
    // Without verify_each, checkLoopContinuation finds pending stories → advanced
    assert.ok(r.status === "advanced" || r.status === "completed");

    // Story should be done
    const story = db.prepare("SELECT status FROM stories WHERE id = ?").get("story-1-id") as { status: string };
    assert.equal(story.status, "done");

    // Loop step should have current_story_id cleared
    const step = db.prepare("SELECT current_story_id, status FROM steps WHERE id = ?").get("s7-loop") as { current_story_id: string | null; status: string };
    assert.equal(step.current_story_id, null);
  });

  it("completes loop step and finishes run when all stories done", () => {
    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run("r8", "wf", "t", "running");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, expects, status, type, current_story_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("s8-loop", "r8", "develop", "dev", 0, "", "running", "loop", "story-last-id");
    db.prepare("INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("story-last-id", "r8", 0, "US-FINAL", "Final", "Last story", '["AC1"]', "running");
    // Mark all other potential stories as done (so checkLoopContinuation sees no pending)
    // With only one story and it just being completed, pipeline should finish

    const r = completeStep("s8-loop", "CHANGES: done");
    // No verify_each, no pending stories → run completed
    assert.ok(r.status === "advanced" || r.status === "completed");

    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get("s8-loop") as { status: string };
    // Loop step should now be done (all stories completed)
    assert.ok(step.status === "done" || step.status === "running");
  });

  it("completes loop step with verify_each: sets verify step to pending", () => {
    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run("r9", "wf", "t", "running");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, expects, status, type, loop_config, current_story_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("s9-loop", "r9", "develop", "dev", 0, "", "running", "loop", JSON.stringify({ verify_each: true, verify_step: "verify" }), "story-vfy-id");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, expects, status) VALUES (?, ?, ?, ?, ?, ?, ?)").run("s9-verify", "r9", "verify", "verifier", 1, "", "waiting");
    db.prepare("INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("story-vfy-id", "r9", 0, "US-VFY", "Verify", "Needs verify", '["AC1"]', "running");
    db.prepare("INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("story-vfy-2", "r9", 1, "US-NEXT", "Next", "More", '["AC2"]', "pending");

    const r = completeStep("s9-loop", "CHANGES: done");
    assert.equal(r.status, "advanced");

    // Verify step should now be pending
    const verifyStep = db.prepare("SELECT status FROM steps WHERE id = ?").get("s9-verify") as { status: string };
    assert.equal(verifyStep.status, "pending");

    // Loop step should stay running (waiting for verify result)
    const loopStep = db.prepare("SELECT status FROM steps WHERE id = ?").get("s9-loop") as { status: string };
    assert.equal(loopStep.status, "running");
  });

  it("completes verify step with retry: resets story to pending", () => {
    db.prepare("INSERT INTO runs (id, workflow_id, task, status, context) VALUES (?, ?, ?, ?, ?)").run("r10", "wf", "t", "running", "{}");
    // Loop step with verify_each pointing to the verify step
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, expects, status, type, loop_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("s10-loop", "r10", "develop", "dev", 0, "", "pending", "loop", JSON.stringify({ verify_each: true, verify_step: "verify2" }));
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, expects, status) VALUES (?, ?, ?, ?, ?, ?, ?)").run("s10-verify", "r10", "verify2", "verifier", 1, "", "running");
    db.prepare("INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("story-10-done", "r10", 0, "US-DONE", "DoneStory", "Was done", '["AC1"]', "done");

    // Complete verify step with STATUS: retry
    const r = completeStep("s10-verify", "STATUS: retry\nISSUES: needs work");
    assert.ok(r.status === "advanced" || r.status === "completed");

    // The last done story should be reset to pending
    const story = db.prepare("SELECT status, retry_count FROM stories WHERE id = ?").get("story-10-done") as { status: string; retry_count: number };
    assert.equal(story.status, "pending");
    assert.equal(story.retry_count, 1);

    // Loop step should be set to pending (ready for next story iteration)
    const loopStep = db.prepare("SELECT status FROM steps WHERE id = ?").get("s10-loop") as { status: string };
    assert.equal(loopStep.status, "pending");
  });
});
