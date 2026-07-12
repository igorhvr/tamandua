import crypto from "node:crypto";
import fs from "node:fs";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");

function createTempEnv() {
  const th = createTempHome("tamandua-abandon-status-");
  const root = th.root;
  const homeDir = th.homeDir;
  const tamanduaDir = th.tamanduaDir;
  fs.mkdirSync(tamanduaDir, { recursive: true });
  return { root, homeDir, tamanduaDir };
}

function spawnCli(args: string[], env: Record<string, string>): {
  child: ChildProcessWithoutNullStreams;
  getStdout: () => string;
  getStderr: () => string;
} {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: cleanChildEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

function seedDb(dbPath: string, runs: Array<{
  id: string;
  workflowId: string;
  task: string;
  status: string;
  tokensSpent: number;
  workerLostCount: number;
  steps?: Array<{ stepId: string; agentId: string; status: string; type: string; retryCount: number; stepIndex: number; output?: string }>;
  abandonments?: Array<{ id: string; storyId: string; reason: string; abandonedCount: number }>;
}>) {
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      context TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      run_number INTEGER,
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      worker_lost_count INTEGER NOT NULL DEFAULT 0,
      notify_url TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS steps (
      step_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'waiting',
      type TEXT NOT NULL DEFAULT 'single',
      retry_count INTEGER NOT NULL DEFAULT 0,
      output TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (step_id, run_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS story_abandonments (
      id TEXT PRIMARY KEY,
      story_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      abandoned_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Ensure composite index exists (additive, so CREATE IF NOT EXISTS is safe)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_story_abandonments_run_story
    ON story_abandonments (run_id, story_id)
  `);

  // Also need stories table for abandonments FK compatibility (no FK, but referenced)
  db.exec(`
    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      story_index INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      abandoned_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const runStmt = db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, tokens_spent, worker_lost_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
  );

  const stepStmt = db.prepare(
    "INSERT INTO steps (step_id, run_id, agent_id, step_index, status, type, retry_count, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );

  const abandonStmt = db.prepare(
    "INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
  );

  const storyStmt = db.prepare(
    "INSERT INTO stories (id, run_id, story_id, title, status, story_index, retry_count, abandoned_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );

  for (const r of runs) {
    runStmt.run(r.id, r.workflowId, r.task, r.status, r.tokensSpent, r.workerLostCount);
    if (r.steps) {
      for (const s of r.steps) {
        stepStmt.run(s.stepId, r.id, s.agentId, s.stepIndex, s.status, s.type, s.retryCount, s.output ?? null);
      }
    }
    if (r.abandonments) {
      // Track which story IDs we've inserted so we don't duplicate
      const seenStoryIds = new Set<string>();
      for (const a of r.abandonments) {
        if (!seenStoryIds.has(a.storyId)) {
          storyStmt.run(a.storyId, r.id, "US-001", "Test story", "failed", 1, 0, a.abandonedCount);
          seenStoryIds.add(a.storyId);
        }
        abandonStmt.run(a.id, a.storyId, r.id, a.reason, a.abandonedCount);
      }
    }
  }

  db.close();
}

describe("ABND — CLI abandon reason display", () => {
  it("workflow status shows abandon reasons for failed run with abandonments", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = crypto.randomUUID();

    seedDb(dbPath, [
      {
        id: runId,
        workflowId: "feature-dev-merge",
        task: "ABND: test task",
        status: "failed",
        tokensSpent: 5000,
        workerLostCount: 3,
        steps: [
          { stepId: "step-1", agentId: "feature-dev-merge_developer", status: "done", type: "single", retryCount: 0, stepIndex: 0 },
          { stepId: "step-2", agentId: "feature-dev-merge_planner", status: "failed", type: "single", retryCount: 5, stepIndex: 1, output: "Story abandoned — abandon budget exhausted (9/8); reasons: 5x worker_lost, 3x no_work_release, 1x worker_timeout" },
        ],
        abandonments: [
          { id: "ab-001", storyId: "story-001", reason: "worker_lost", abandonedCount: 1 },
          { id: "ab-002", storyId: "story-001", reason: "worker_lost", abandonedCount: 2 },
          { id: "ab-003", storyId: "story-001", reason: "worker_lost", abandonedCount: 3 },
          { id: "ab-004", storyId: "story-001", reason: "worker_lost", abandonedCount: 4 },
          { id: "ab-005", storyId: "story-001", reason: "worker_lost", abandonedCount: 5 },
          { id: "ab-006", storyId: "story-001", reason: "no_work_release", abandonedCount: 6 },
          { id: "ab-007", storyId: "story-001", reason: "no_work_release", abandonedCount: 7 },
          { id: "ab-008", storyId: "story-001", reason: "no_work_release", abandonedCount: 8 },
          { id: "ab-009", storyId: "story-001", reason: "worker_timeout", abandonedCount: 9 },
        ],
      },
    ]);

    const { child, getStdout, getStderr } = spawnCli(
      ["workflow", "status", runId],
      { HOME: env.homeDir }
    );

    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
    });

    const stdout = getStdout();

    // Run info should be displayed
    assert.match(stdout, new RegExp(`Run: ${runId.substring(0, 8)}`));
    assert.match(stdout, /Status: failed/);

    // Abandon reasons should be displayed with the aggregate
    assert.match(stdout, /Abandon reasons: abandon budget exhausted \(9\/8\); reasons: 5x worker_lost, 3x no_work_release, 1x worker_timeout/);

    // Step output for failed step should be displayed
    assert.match(stdout, /failed/);
    assert.match(stdout, /worker_lost/);

    try { fs.rmSync(env.root, { recursive: true }); } catch { /* cleanup */ }
  });

  it("workflow status does NOT show abandon reasons for failed run without abandonments", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = crypto.randomUUID();

    seedDb(dbPath, [
      {
        id: runId,
        workflowId: "feature-dev-merge",
        task: "Non-abandon fail",
        status: "failed",
        tokensSpent: 1000,
        workerLostCount: 0,
        steps: [
          { stepId: "step-1", agentId: "feature-dev-merge_developer", status: "done", type: "single", retryCount: 0, stepIndex: 0 },
          { stepId: "step-2", agentId: "feature-dev-merge_planner", status: "failed", type: "single", retryCount: 3, stepIndex: 1, output: "Run failed due to build error" },
        ],
      },
    ]);

    const { child, getStdout, getStderr } = spawnCli(
      ["workflow", "status", runId],
      { HOME: env.homeDir }
    );

    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
    });

    const stdout = getStdout();

    // Run info should be displayed
    assert.match(stdout, /Status: failed/);

    // Abandon reasons line should NOT be present (no abandonments)
    assert.doesNotMatch(stdout, /Abandon reasons/);

    // Step output for failed step should still be displayed
    assert.match(stdout, /Run failed due to build error/);

    try { fs.rmSync(env.root, { recursive: true }); } catch { /* cleanup */ }
  });

  it("workflow status shows step output for failed steps", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = crypto.randomUUID();

    seedDb(dbPath, [
      {
        id: runId,
        workflowId: "feature-dev-merge",
        task: "Step output test",
        status: "failed",
        tokensSpent: 2000,
        workerLostCount: 1,
        steps: [
          { stepId: "step-1", agentId: "feature-dev-merge_developer", status: "done", type: "single", retryCount: 0, stepIndex: 0 },
          { stepId: "step-2", agentId: "feature-dev-merge_verifier", status: "failed", type: "single", retryCount: 5, stepIndex: 1, output: "Story abandoned — abandon budget exhausted (9/8); reasons: 5x worker_lost, 3x no_work_release, 1x worker_timeout" },
        ],
        abandonments: [
          { id: "ab-101", storyId: "story-002", reason: "worker_lost", abandonedCount: 1 },
          { id: "ab-102", storyId: "story-002", reason: "worker_lost", abandonedCount: 2 },
          { id: "ab-103", storyId: "story-002", reason: "worker_lost", abandonedCount: 3 },
          { id: "ab-104", storyId: "story-002", reason: "worker_lost", abandonedCount: 4 },
          { id: "ab-105", storyId: "story-002", reason: "worker_lost", abandonedCount: 5 },
          { id: "ab-106", storyId: "story-002", reason: "no_work_release", abandonedCount: 6 },
          { id: "ab-107", storyId: "story-002", reason: "no_work_release", abandonedCount: 7 },
          { id: "ab-108", storyId: "story-002", reason: "no_work_release", abandonedCount: 8 },
          { id: "ab-109", storyId: "story-002", reason: "worker_timeout", abandonedCount: 9 },
        ],
      },
    ]);

    const { child, getStdout, getStderr } = spawnCli(
      ["workflow", "status", runId],
      { HOME: env.homeDir }
    );

    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
    });

    const stdout = getStdout();

    // Abandon reasons should be displayed
    assert.match(stdout, /Abandon reasons:/);

    // Step output for failed step should be displayed (indented)
    assert.match(stdout, /worker_lost, 3x no_work_release, 1x worker_timeout/);

    try { fs.rmSync(env.root, { recursive: true }); } catch { /* cleanup */ }
  });

  it("workflow status does NOT regress for normal running run", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = crypto.randomUUID();

    seedDb(dbPath, [
      {
        id: runId,
        workflowId: "feature-dev-merge",
        task: "Normal running task",
        status: "running",
        tokensSpent: 300,
        workerLostCount: 0,
        steps: [
          { stepId: "step-1", agentId: "feature-dev-merge_developer", status: "done", type: "single", retryCount: 0, stepIndex: 0 },
          { stepId: "step-2", agentId: "feature-dev-merge_planner", status: "running", type: "single", retryCount: 0, stepIndex: 1 },
          { stepId: "step-3", agentId: "feature-dev-merge_verifier", status: "pending", type: "single", retryCount: 0, stepIndex: 2 },
        ],
      },
    ]);

    const { child, getStdout, getStderr } = spawnCli(
      ["workflow", "status", runId],
      { HOME: env.homeDir }
    );

    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
    });

    const stdout = getStdout();

    // Normal run info
    assert.match(stdout, new RegExp(`Run: ${runId.substring(0, 8)}`));
    assert.match(stdout, /Status: running/);
    assert.match(stdout, /Tokens: 300/);

    // No abandon reasons for running runs
    assert.doesNotMatch(stdout, /Abandon reasons/);

    // Steps displayed
    assert.match(stdout, /done/);
    assert.match(stdout, /running/);
    assert.match(stdout, /pending/);

    try { fs.rmSync(env.root, { recursive: true }); } catch { /* cleanup */ }
  });

  it("workflow status shows single abandon reason correctly", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = crypto.randomUUID();

    seedDb(dbPath, [
      {
        id: runId,
        workflowId: "feature-dev-merge",
        task: "Single abandon reason",
        status: "failed",
        tokensSpent: 500,
        workerLostCount: 0,
        steps: [
          { stepId: "step-1", agentId: "feature-dev-merge_developer", status: "failed", type: "single", retryCount: 1, stepIndex: 0, output: "Agent terminated without completing story; abandon budget exhausted (1/8); reasons: 1x worker_timeout" },
        ],
        abandonments: [
          { id: "ab-201", storyId: "story-003", reason: "worker_timeout", abandonedCount: 1 },
        ],
      },
    ]);

    const { child, getStdout, getStderr } = spawnCli(
      ["workflow", "status", runId],
      { HOME: env.homeDir }
    );

    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
    });

    const stdout = getStdout();

    // Single reason aggregate
    assert.match(stdout, /Abandon reasons: abandon budget exhausted \(1\/8\); reasons: 1x worker_timeout/);

    try { fs.rmSync(env.root, { recursive: true }); } catch { /* cleanup */ }
  });
});
