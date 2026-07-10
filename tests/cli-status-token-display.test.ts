import fs from "node:fs";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");

function createTempEnv() {
  const th = createTempHome("tamandua-token-status-");
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
  steps?: Array<{ stepId: string; agentId: string; status: string; type: string; retryCount: number; stepIndex: number }>;
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
    CREATE TABLE IF NOT EXISTS events (
      ts TEXT NOT NULL,
      event TEXT NOT NULL,
      run_id TEXT,
      detail TEXT
    )
  `);

  const stmt = db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, tokens_spent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
  );

  for (const r of runs) {
    stmt.run(r.id, r.workflowId, r.task, r.status, r.tokensSpent);
    if (r.steps) {
      const stepStmt = db.prepare(
        "INSERT INTO steps (step_id, run_id, agent_id, step_index, status, type, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      for (const s of r.steps) {
        stepStmt.run(s.stepId, r.id, s.agentId, s.stepIndex, s.status, s.type, s.retryCount);
      }
    }
  }

  db.close();
}

describe("CLI token display", () => {
  it("workflow status shows Tokens line with formatted number", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    seedDb(dbPath, [
      {
        id: runId,
        workflowId: "feature-dev",
        task: "Implement token tracking",
        status: "running",
        tokensSpent: 4242,
        steps: [
          { stepId: "step-1", agentId: "feature-dev_developer", status: "done", type: "single", retryCount: 0, stepIndex: 0 },
          { stepId: "step-2", agentId: "feature-dev_planner", status: "running", type: "single", retryCount: 0, stepIndex: 1 },
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
    const stderr = getStderr();

    assert.match(stdout, /Run: aaaaaaaa/);
    assert.match(stdout, /Tokens: 4,242/);
    assert.match(stdout, /Steps:/);

    try { fs.rmSync(env.root, { recursive: true }); } catch { /* cleanup */ }
  });

  it("workflow status shows Tokens: 0 for zero tokens", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    seedDb(dbPath, [
      {
        id: runId,
        workflowId: "code-review",
        task: "Review PR #42",
        status: "completed",
        tokensSpent: 0,
        steps: [
          { stepId: "step-1", agentId: "code-review_reviewer", status: "done", type: "single", retryCount: 0, stepIndex: 0 },
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
    const stderr = getStderr();

    assert.match(stdout, /Run: bbbbbbbb/);
    assert.match(stdout, /Tokens: 0/);

    try { fs.rmSync(env.root, { recursive: true }); } catch { /* cleanup */ }
  });

  it("workflow runs shows token count per run", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");

    seedDb(dbPath, [
      {
        id: "cccccccc-cccc-4ccc-8ddd-eeeeeeeeeeee",
        workflowId: "feature-dev",
        task: "Add token display to CLI",
        status: "running",
        tokensSpent: 1234,
        steps: [
          { stepId: "step-1", agentId: "feature-dev_developer", status: "done", type: "single", retryCount: 0, stepIndex: 0 },
        ],
      },
      {
        id: "dddddddd-dddd-4ddd-8ddd-eeeeeeeeeeee",
        workflowId: "code-review",
        task: "Review token tracking PR",
        status: "completed",
        tokensSpent: 567890,
        steps: [
          { stepId: "step-1", agentId: "code-review_reviewer", status: "done", type: "single", retryCount: 0, stepIndex: 0 },
        ],
      },
    ]);

    const { child, getStdout, getStderr } = spawnCli(
      ["workflow", "runs"],
      { HOME: env.homeDir }
    );

    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
    });

    const stdout = getStdout();
    const stderr = getStderr();

    assert.match(stdout, /Workflow runs:/);
    // First run: cccccccc with 1,234 tokens
    assert.match(stdout, /cccccccc/);
    assert.match(stdout, /1,234/);
    // Second run: dddddddd with 567,890 tokens (formatted)
    assert.match(stdout, /dddddddd/);
    assert.match(stdout, /567,890/);
    // Runs sorted by created_at DESC (most recent first), both were inserted around same time

    try { fs.rmSync(env.root, { recursive: true }); } catch { /* cleanup */ }
  });

  it("workflow status queries tokens_spent from DB (not hardcoded)", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    // Seed with a specific non-zero value
    seedDb(dbPath, [
      {
        id: runId,
        workflowId: "bug-fix-github-pr",
        task: "Fix off-by-one error",
        status: "running",
        tokensSpent: 9999,
        steps: [
          { stepId: "step-1", agentId: "bug-fix-github-pr_developer", status: "done", type: "single", retryCount: 0, stepIndex: 0 },
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

    // The value 9999 must appear formatted as 9,999 — confirming it comes from the DB
    assert.match(stdout, /Tokens: 9,999/);

    try { fs.rmSync(env.root, { recursive: true }); } catch { /* cleanup */ }
  });

  it("workflow status with task substring match shows Tokens line", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

    seedDb(dbPath, [
      {
        id: runId,
        workflowId: "docs",
        task: "Update API documentation",
        status: "running",
        tokensSpent: 500,
        steps: [],
      },
    ]);

    const { child, getStdout, getStderr } = spawnCli(
      ["workflow", "status", "API documentation"],
      { HOME: env.homeDir }
    );

    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
    });

    const stdout = getStdout();

    assert.match(stdout, /Run: ffffffff/);
    assert.match(stdout, /Tokens: 500/);

    try { fs.rmSync(env.root, { recursive: true }); } catch { /* cleanup */ }
  });
});
