import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";
import {
  RUN_LIFECYCLE_EVENTS,
  getRunEvents,
  getEventsPath,
  type TamanduaEvent,
} from "../../dist/installer/events.js";
import { emitRunTerminalEvent } from "../../dist/installer/step-ops.js";
import { deleteWorkflow, forceFailRun } from "../../dist/installer/status.js";

// ── Static (compile-time) contract pins ────────────────────────────────
// Exercised whenever this file is typechecked (IDE / contributors running
// tsc over tests). They pin the TamanduaEvent interface: runId and ts are
// REQUIRED fields, and the terminal-event payload fields are still declared.

/** If runId or ts becomes optional in TamanduaEvent, this fails typecheck. */
function requireIdentityFields(evt: TamanduaEvent): { runId: string; ts: string } {
  return { runId: evt.runId, ts: evt.ts };
}

/** If tokensSpent/workerLostCount/ceilingExpiryCount/reason are dropped from TamanduaEvent, this fails typecheck. */
const TAMANDUA_EVENT_PAYLOAD_FIELDS: TamanduaEvent = {
  ts: "static-pin",
  event: "run.canceled",
  runId: "static-pin",
  workflowId: "static-pin",
  tokensSpent: 0,
  workerLostCount: 0,
  ceilingExpiryCount: 0,
  reason: "static-pin",
};
void TAMANDUA_EVENT_PAYLOAD_FIELDS;

/**
 * The terminal-event vocabulary, pinned per CNEV US-004. run.started opens
 * a run's event stream; the remaining five are terminal records. Removing a
 * type from this set — or from RUN_LIFECYCLE_EVENTS in src/installer/
 * events.ts — fails the vocabulary pin below.
 */
const PINNED_TERMINAL_EVENT_VOCABULARY = [
  "run.started",
  "run.completed",
  "run.failed",
  "run.canceled",
  "run.deleted",
  "run.force_failed",
];

// ── Test suite ─────────────────────────────────────────────────────────

describe("events vocabulary and terminal-event contract (CNEV US-004)", () => {
  let tempRoot: string;
  let stateDir: string;
  let db: DatabaseSync;
  let originalDbPath: string | undefined;
  let originalHome: string | undefined;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    originalHome = process.env.HOME;
    originalStateDir = process.env.TAMANDUA_STATE_DIR;

    tempRoot = tamanduaTempDir("tamandua-events-vocab-");
    stateDir = path.join(tempRoot, "state");
    const dbPath = path.join(stateDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.HOME = tempRoot;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    fs.mkdirSync(stateDir, { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL DEFAULT 'test',
      task TEXT NOT NULL DEFAULT 'test',
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      worker_lost_count INTEGER NOT NULL DEFAULT 0,
      ceiling_expiry_count INTEGER NOT NULL DEFAULT 0,
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
      status TEXT NOT NULL DEFAULT 'waiting',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      type TEXT NOT NULL DEFAULT 'single',
      loop_config TEXT,
      current_story_id TEXT,
      abandoned_count INTEGER DEFAULT 0,
      claim_pid INTEGER,
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
    db.exec(`CREATE TABLE IF NOT EXISTS run_worktrees (
      run_id TEXT PRIMARY KEY,
      worktree_origin_repository TEXT NOT NULL,
      worktree_origin_git_common_dir TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      worktree_origin_ref TEXT,
      worktree_origin_sha TEXT,
      original_branch TEXT,
      status TEXT NOT NULL DEFAULT 'creating',
      cleanup_policy TEXT NOT NULL DEFAULT 'remove_on_success',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      removed_at TEXT,
      error TEXT
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
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function seedRun(
    runId: string,
    tokensSpent = 0,
    workerLostCount = 0,
    status = "running",
    ceilingExpiryCount = 0,
  ): void {
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, tokens_spent, worker_lost_count, ceiling_expiry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "wf-vocab", "vocabulary contract test", status, tokensSpent, workerLostCount, ceilingExpiryCount);
  }

  it("pins the terminal-event vocabulary: {run.started, run.completed, run.failed, run.canceled, run.deleted, run.force_failed}", () => {
    assert.ok(Array.isArray(RUN_LIFECYCLE_EVENTS), "RUN_LIFECYCLE_EVENTS must be exported");
    assert.deepEqual(
      [...RUN_LIFECYCLE_EVENTS].sort(),
      [...PINNED_TERMINAL_EVENT_VOCABULARY].sort(),
      "the terminal-event vocabulary changed — an event type was removed or added; update this pin deliberately (CNEV US-004)",
    );
    assert.equal(RUN_LIFECYCLE_EVENTS.length, PINNED_TERMINAL_EVENT_VOCABULARY.length, "vocabulary must not contain duplicates");
    assert.ok(Object.isFrozen(RUN_LIFECYCLE_EVENTS), "vocabulary must be frozen");
    for (const evt of RUN_LIFECYCLE_EVENTS) {
      assert.match(evt, /^run\.[a-z_.]+$/, `malformed lifecycle event name: ${evt}`);
    }
  });

  it("terminal events land in the isolated test state dir (guard-aware)", () => {
    // The test-isolation guard refuses writes into the real ~/.tamandua;
    // this pins that every event produced by this suite resolves into the
    // per-test temp state dir.
    assert.doesNotThrow(() => assertStatePathIsolation(getEventsPath(), "events-vocabulary-test"));
    assert.ok(
      getEventsPath().startsWith(stateDir + path.sep),
      `events dir ${getEventsPath()} must live under the temp state dir ${stateDir}`,
    );
  });

  it("run.completed/run.failed/run.canceled carry ts+runId+tokensSpent+workerLostCount+ceilingExpiryCount; run.canceled also carries reason", () => {
    const runId = "run-vocab-terminal-001";
    seedRun(runId, 41, 2, "running", 3);

    emitRunTerminalEvent({ event: "run.completed", runId, workflowId: "wf-vocab" });
    emitRunTerminalEvent({ event: "run.failed", runId, workflowId: "wf-vocab", detail: "boom" });
    emitRunTerminalEvent({ event: "run.canceled", runId, workflowId: "wf-vocab", reason: "cli-stop" });

    const events = getRunEvents(runId);
    assert.equal(events.length, 3, "expected one event per terminal emission");
    const [completed, failed, canceled] = events;

    // runId + ts always
    for (const evt of events) {
      const identity = requireIdentityFields(evt);
      assert.equal(identity.runId, runId, `${evt.event} must carry runId`);
      assert.ok(identity.ts.length > 0, `${evt.event} must carry a non-empty ts`);
    }

    // completed: tokensSpent + workerLostCount + ceilingExpiryCount, no reason
    assert.equal(completed.event, "run.completed");
    assert.equal(completed.workflowId, "wf-vocab");
    assert.equal(completed.tokensSpent, 41);
    assert.equal(completed.workerLostCount, 2);
    assert.equal(completed.ceilingExpiryCount, 3);
    assert.ok(!("reason" in completed), "run.completed must not carry reason");

    // failed: tokensSpent + workerLostCount + ceilingExpiryCount, no reason
    assert.equal(failed.event, "run.failed");
    assert.equal(failed.detail, "boom");
    assert.equal(failed.tokensSpent, 41);
    assert.equal(failed.workerLostCount, 2);
    assert.equal(failed.ceilingExpiryCount, 3);
    assert.ok(!("reason" in failed), "run.failed must not carry reason");

    // canceled: reason + tokensSpent + workerLostCount + ceilingExpiryCount
    assert.equal(canceled.event, "run.canceled");
    assert.equal(canceled.reason, "cli-stop");
    assert.equal(canceled.tokensSpent, 41);
    assert.equal(canceled.workerLostCount, 2);
    assert.equal(canceled.ceilingExpiryCount, 3);
  });

  it("run.force_failed carries reason + runId + ts; run.deleted carries runId + ts", async () => {
    // forceFailRun on a running run with no live workers
    const forceId = "run-vocab-forcefail-1";
    seedRun(forceId);
    const forceResult = await forceFailRun(forceId, "operator force-fail");
    assert.equal(forceResult.ok, true);

    const forceEvents = getRunEvents(forceId);
    assert.equal(forceEvents.length, 1, "forceFailRun must emit exactly one event");
    const forceFailed = forceEvents[0];
    assert.equal(forceFailed.event, "run.force_failed");
    assert.equal(forceFailed.reason, "operator force-fail");
    assert.equal(forceFailed.detail, "operator force-fail");
    const forceIdentity = requireIdentityFields(forceFailed);
    assert.equal(forceIdentity.runId, forceId);
    assert.ok(forceIdentity.ts.length > 0);

    // deleteWorkflow --force on an active run
    const deletedId = "run-vocab-deleted-01";
    seedRun(deletedId);
    const deleteResult = await deleteWorkflow(deletedId, { force: true });
    assert.equal(deleteResult.status, "deleted");

    const deleteEvents = getRunEvents(deletedId);
    assert.equal(deleteEvents.length, 1, "deleteWorkflow must emit exactly one event");
    const deleted = deleteEvents[0];
    assert.equal(deleted.event, "run.deleted");
    const deleteIdentity = requireIdentityFields(deleted);
    assert.equal(deleteIdentity.runId, deletedId);
    assert.ok(deleteIdentity.ts.length > 0);
  });

  it("run.started emitter (src/installer/run.ts) carries ts and runId (source pin)", () => {
    const runTsPath = path.resolve(import.meta.dirname, "run.ts");
    const source = fs.readFileSync(runTsPath, "utf-8");

    const marker = 'event: "run.started"';
    const idx = source.indexOf(marker);
    assert.ok(idx !== -1, "run.started emitter not found in src/installer/run.ts");
    const window = source.slice(Math.max(0, idx - 400), idx + 400);
    assert.match(window, /emitEvent\(\{/, "run.started must be emitted via emitEvent");
    assert.match(window, /\bts\s*:/, "run.started must carry ts");
    assert.match(window, /\brunId\s*[,}]/, "run.started must carry runId");
  });
});
