import fs from "node:fs";
import { cleanChildEnv } from "../../tests/helpers/test-env.ts";
import path from "node:path";
import crypto from "node:crypto";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, it, beforeEach, afterEach } from "node:test";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");

// ── Helpers ──

function createTempEnv() {
  const root = tamanduaTempDir("tamandua-status-test-");
  const homeDir = path.join(root, "home");
  const tamanduaDir = path.join(homeDir, ".tamandua");
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

function seedDb(dbPath: string, runId: string, context: Record<string, string>, wtData?: {
  worktreeOriginRepository: string;
  worktreeOriginGitCommonDir: string;
  worktreePath: string;
  worktreeOriginRef?: string;
  worktreeOriginSha?: string;
  originalBranch?: string;
  status?: string;
  cleanupPolicy?: string;
}): void {
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
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS run_worktrees (
      run_id TEXT PRIMARY KEY,
      worktree_origin_repository TEXT NOT NULL,
      worktree_origin_git_common_dir TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      worktree_origin_ref TEXT,
      worktree_origin_sha TEXT,
      original_branch TEXT,
      status TEXT NOT NULL DEFAULT 'creating',
      cleanup_policy TEXT NOT NULL DEFAULT 'remove_on_terminal',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      removed_at TEXT,
      error TEXT
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

  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))"
  ).run(runId, "feature-dev", "Build something", "running", JSON.stringify(context));

  if (wtData) {
    db.prepare(
      `INSERT INTO run_worktrees (run_id, worktree_origin_repository, worktree_origin_git_common_dir, worktree_path,
         worktree_origin_ref, worktree_origin_sha, original_branch, status, cleanup_policy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runId,
      wtData.worktreeOriginRepository,
      wtData.worktreeOriginGitCommonDir,
      wtData.worktreePath,
      wtData.worktreeOriginRef ?? null,
      wtData.worktreeOriginSha ?? null,
      wtData.originalBranch ?? null,
      wtData.status ?? "ready",
      wtData.cleanupPolicy ?? "remove_on_success",
    );
  }

  db.close();
}

// ── Tests ──

describe("CLI workflow status worktree display", () => {
  it("shows worktree path and origin ref for worktree runs", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = "eeee5555-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    seedDb(dbPath, runId, { workspace_mode: "worktree" }, {
      worktreeOriginRepository: "/home/user/my-repo",
      worktreeOriginGitCommonDir: "/home/user/my-repo/.git",
      worktreePath: "/tmp/tamandua-worktrees/my-repo-hash/5-eeee5555",
      worktreeOriginRef: "feature/cool-thing",
      worktreeOriginSha: "def789abc",
    });

    const { child, getStdout } = spawnCli(
      ["workflow", "status", runId],
      { HOME: env.homeDir }
    );

    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
    });

    const stdout = getStdout();
    assert.match(stdout, /Run: run-eeee5555/);
    assert.match(stdout, /Workspace: worktree/);
    assert.match(stdout, /Worktree: \/tmp\/tamandua-worktrees\/my-repo-hash\/5-eeee5555/);
    assert.match(stdout, /Origin ref: feature\/cool-thing/);
    assert.match(stdout, /Tokens: 0/);

    try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  it("does NOT show worktree info for direct runs", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = "ffff6666-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    seedDb(dbPath, runId, { workspace_mode: "direct" });

    const { child, getStdout } = spawnCli(
      ["workflow", "status", runId],
      { HOME: env.homeDir }
    );

    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
    });

    const stdout = getStdout();
    assert.match(stdout, /Run: run-ffff6666/);
    assert.doesNotMatch(stdout, /Workspace:/);
    assert.doesNotMatch(stdout, /Worktree:/);
    assert.doesNotMatch(stdout, /Origin ref:/);

    try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  it("compact workflow runs list does not show worktree info", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = "abab7777-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    seedDb(dbPath, runId, { workspace_mode: "worktree" }, {
      worktreeOriginRepository: "/home/user/project",
      worktreeOriginGitCommonDir: "/home/user/project/.git",
      worktreePath: "/tmp/wt/test-3",
      worktreeOriginRef: "feat/ui",
    });

    const { child, getStdout } = spawnCli(
      ["workflow", "runs"],
      { HOME: env.homeDir }
    );

    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
    });

    const stdout = getStdout();
    assert.match(stdout, /Workflow runs:/);
    assert.match(stdout, /abab7777/);
    assert.doesNotMatch(stdout, /worktree/i);
    assert.doesNotMatch(stdout, /Origin ref:/);

    try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  it("handles corrupt context gracefully in workflow status", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = "7777aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    // Seed a run with corrupt JSON context directly
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
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS stories (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        story_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_count INTEGER DEFAULT 0,
        story_index INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))"
    ).run(runId, "feature-dev", "Build something", "running", "{broken json!!! corrupted!!!");
    db.close();

    const { child, getStdout, getStderr } = spawnCli(
      ["workflow", "status", runId],
      { HOME: env.homeDir }
    );

    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
    });

    const stdout = getStdout();
    const stderr = getStderr();
    // Should not crash — the run should still be displayed (status truncates runId to first 8 chars)
    assert.match(stdout, /Run: run-7777aaaa/, "should show the run ID prefix");
    assert.match(stdout, /Status: running/, "should show the run status");
    // Verify no crash traceback in stderr
    assert.doesNotMatch(stderr, /Error|TypeError|SyntaxError/, "stderr should not contain crash error");

    try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* cleanup */ }
  });
});

describe("dashboard run detail worktree enrichment", () => {
  it("includes worktree data in API response for worktree runs", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = "caca8888-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    seedDb(dbPath, runId, { workspace_mode: "worktree" }, {
      worktreeOriginRepository: "/home/user/my-repo",
      worktreeOriginGitCommonDir: "/home/user/my-repo/.git",
      worktreePath: "/tmp/tamandua-worktrees/my-repo-hash/8-caca8888",
      worktreeOriginRef: "main",
      worktreeOriginSha: "abc123",
      status: "ready",
      cleanupPolicy: "remove_on_success",
    });

    const { createDashboardServer } = await import("../../dist/server/dashboard.js");

    // Set HOME so db module picks up our test DB
    const origHome = process.env.HOME;
    process.env.HOME = env.homeDir;
    try {
      const server = createDashboardServer(0);
      if (!server.listening) {
        await once(server, "listening");
      }
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      try {
        const response = await fetch(`http://localhost:${port}/api/runs/${runId}`);
        const data = await response.json() as {
          run: Record<string, unknown>;
          steps: unknown[];
          events: unknown[];
          worktree: Record<string, unknown> | null;
        };

        assert.equal(response.status, 200);
        assert.ok(data.worktree !== null, "worktree should be present");
        assert.equal(data.worktree!.worktree_path, "/tmp/tamandua-worktrees/my-repo-hash/8-caca8888");
        assert.equal(data.worktree!.worktree_origin_repository, "/home/user/my-repo");
        assert.equal(data.worktree!.worktree_origin_ref, "main");
        assert.equal(data.worktree!.worktree_origin_sha, "abc123");
        assert.equal(data.worktree!.wt_status, "ready");
        assert.equal(data.worktree!.cleanup_policy, "remove_on_success");
      } finally {
        server.close();
        await once(server, "close");
      }
    } finally {
      process.env.HOME = origHome;
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });

  it("does not include worktree data in API response for direct runs", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = "dada9999-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    seedDb(dbPath, runId, { workspace_mode: "direct" });

    const { createDashboardServer } = await import("../../dist/server/dashboard.js");

    const origHome = process.env.HOME;
    process.env.HOME = env.homeDir;
    try {
      const server = createDashboardServer(0);
      if (!server.listening) {
        await once(server, "listening");
      }
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      try {
        const response = await fetch(`http://localhost:${port}/api/runs/${runId}`);
        const data = await response.json() as {
          run: Record<string, unknown>;
          worktree: unknown;
        };

        assert.equal(response.status, 200);
        assert.equal(data.worktree, null, "worktree should be null for direct runs");
      } finally {
        server.close();
        await once(server, "close");
      }
    } finally {
      process.env.HOME = origHome;
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });
});

describe("stopWorkflow", () => {
  let tempRoot: string;
  let originalDbPath: string | undefined;
  let originalHome: string | undefined;
  let db: DatabaseSync;

  beforeEach(() => {
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    originalHome = process.env.HOME;
    tempRoot = tamanduaTempDir("tamandua-stopwf-");
    const dbPath = path.join(tempRoot, ".tamandua", "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.HOME = tempRoot;

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
      status TEXT NOT NULL DEFAULT 'waiting',
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
    try { db.close(); } catch {}
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("cancels a running workflow", async () => {
    const { stopWorkflow } = await import("../../dist/installer/status.js");

    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run("run-cancel", "wf", "test task", "running");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status) VALUES (?, ?, ?, ?, ?, ?)").run("s1", "run-cancel", "implement", "dev", 0, "waiting");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status) VALUES (?, ?, ?, ?, ?, ?)").run("s2", "run-cancel", "test", "qa", 1, "running");

    const result = await stopWorkflow("run-cancel");
    assert.equal(result.ok, true);
    assert.equal(result.runId, "run-cancel");

    // Run should be canceled
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get("run-cancel") as { status: string };
    assert.equal(run.status, "canceled");

    // Steps should be canceled
    const steps = db.prepare("SELECT status FROM steps WHERE run_id = ?").all("run-cancel") as Array<{ status: string }>;
    for (const s of steps) {
      assert.equal(s.status, "canceled");
    }
  });

  it("throws when run not found", async () => {
    const { stopWorkflow } = await import("../../dist/installer/status.js");
    await assert.rejects(() => stopWorkflow("nonexistent"), /Run not found/i);
  });

  it("throws when run is already terminal (completed)", async () => {
    const { stopWorkflow } = await import("../../dist/installer/status.js");
    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run("run-done", "wf", "test", "completed");
    await assert.rejects(() => stopWorkflow("run-done"), /already completed/i);
  });

  it("deletes a terminal workflow and its associated records", async () => {
    const { deleteWorkflow } = await import("../../dist/installer/status.js");

    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run("run-delete", "wf", "test", "completed");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status) VALUES (?, ?, ?, ?, ?, ?)").run("s-delete", "run-delete", "implement", "dev", 0, "done");
    db.prepare("INSERT INTO stories (id, run_id, story_index, story_id, title, status) VALUES (?, ?, ?, ?, ?, ?)").run("story-delete", "run-delete", 0, "story-1", "Delete run", "done");
    db.prepare(
      `INSERT INTO run_worktrees (run_id, worktree_origin_repository, worktree_origin_git_common_dir, worktree_path, status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("run-delete", tempRoot, path.join(tempRoot, ".git"), path.join(tempRoot, "worktree"), "removed");

    const result = await deleteWorkflow("run-delete");

    assert.deepEqual(result, { ok: true, runId: "run-delete", status: "deleted" });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs WHERE id = ?").get("run-delete") as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ?").get("run-delete") as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM stories WHERE run_id = ?").get("run-delete") as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM run_worktrees WHERE run_id = ?").get("run-delete") as { count: number }).count, 0);
  });

  it("requires force before deleting active workflows", async () => {
    const { deleteWorkflow } = await import("../../dist/installer/status.js");

    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run("run-active", "wf", "test", "running");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status) VALUES (?, ?, ?, ?, ?, ?)").run("s-active", "run-active", "implement", "dev", 0, "running");

    await assert.rejects(() => deleteWorkflow("run-active"), /Use --force/);
    assert.equal((db.prepare("SELECT status FROM runs WHERE id = ?").get("run-active") as { status: string }).status, "running");

    const result = await deleteWorkflow("run-active", { force: true });

    assert.deepEqual(result, { ok: true, runId: "run-active", status: "deleted" });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs WHERE id = ?").get("run-active") as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ?").get("run-active") as { count: number }).count, 0);
  });

  it("stepInfos include displayStatus and currentStoryId from the data layer", async () => {
    const { getWorkflowStatus } = await import("../../dist/installer/status.js");

    const runId = "run-display-status";

    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run(runId, "test-wf", "test task", "running");

    // Parked loop: loop + running + current_story_id NULL → displayStatus="verifying"
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, type, status, current_story_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("s-parked", runId, "verify-each-parked", "dev", 0, "loop", "running", null);

    // Active loop: loop + running + current_story_id SET → displayStatus="running"
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, type, status, current_story_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("s-active-loop", runId, "verify-each-active", "dev", 1, "loop", "running", "story-001");

    // Single step: running → displayStatus="running" (same as raw)
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, type, status, current_story_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("s-single", runId, "implement", "dev", 2, "single", "running", null);

    // Parked loop with current_story_id as empty string (active): displayStatus="running"
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, type, status, current_story_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("s-active-loop-empty", runId, "verify_each-loop", "dev", 3, "loop", "running", "");

    const detail = getWorkflowStatus(runId);

    // Parked loop: status invariant is "running", displayStatus is "verifying"
    const parked = detail.steps.find((s) => s.stepId === "verify-each-parked")!;
    assert.equal(parked.status, "running");
    assert.equal(parked.displayStatus, "verifying");
    assert.equal(parked.currentStoryId, null);
    assert.equal(parked.type, "loop");

    // Active loop: both status and displayStatus are "running"
    const activeLoop = detail.steps.find((s) => s.stepId === "verify-each-active")!;
    assert.equal(activeLoop.status, "running");
    assert.equal(activeLoop.displayStatus, "running");
    assert.equal(activeLoop.currentStoryId, "story-001");

    // Single step: displayStatus matches raw status
    const single = detail.steps.find((s) => s.stepId === "implement")!;
    assert.equal(single.status, "running");
    assert.equal(single.displayStatus, "running");
    assert.equal(single.currentStoryId, null);

    // Active loop with empty current_story_id: treated as active (not parked)
    const activeLoopEmpty = detail.steps.find((s) => s.stepId === "verify_each-loop")!;
    assert.equal(activeLoopEmpty.status, "running");
    assert.equal(activeLoopEmpty.displayStatus, "running");
    assert.equal(activeLoopEmpty.currentStoryId, "");
  });

  it("preserves run_worktrees row with cleanup_failed when worktree removal fails", async () => {
    const { deleteWorkflow } = await import("../../dist/installer/status.js");

    const runId = "run-wt-fail";
    const wtPath = path.join(tempRoot, "nonexistent-worktree");
    // Create the directory so fs.statSync finds it, but it's not a git
    // worktree so `git worktree remove` will fail.
    fs.mkdirSync(wtPath, { recursive: true });

    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run(runId, "wf", "test", "completed");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status) VALUES (?, ?, ?, ?, ?, ?)").run("s-wtf", runId, "implement", "dev", 0, "done");
    db.prepare("INSERT INTO stories (id, run_id, story_index, story_id, title, status) VALUES (?, ?, ?, ?, ?, ?)").run("story-wtf", runId, 0, "story-1", "Test story", "done");
    db.prepare(
      `INSERT INTO run_worktrees (run_id, worktree_origin_repository, worktree_origin_git_common_dir, worktree_path, status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(runId, tempRoot, path.join(tempRoot, ".git"), wtPath, "ready");

    const result = await deleteWorkflow(runId);

    // Should still return ok with a warning
    assert.equal(result.ok, true);
    assert.equal(result.runId, runId);
    assert.equal(result.status, "deleted");
    assert.ok(result.warning, "should include a warning");
    assert.match(result.warning!, /Worktree removal failed/);
    assert.match(result.warning!, /tamandua worktree prune/);

    // Run, steps, and stories should be deleted
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs WHERE id = ?").get(runId) as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ?").get(runId) as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM stories WHERE run_id = ?").get(runId) as { count: number }).count, 0);

    // run_worktrees row should SURVIVE with cleanup_failed status
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM run_worktrees WHERE run_id = ?").get(runId) as { count: number }).count, 1);
    const wtRow = db.prepare("SELECT status, error FROM run_worktrees WHERE run_id = ?").get(runId) as { status: string; error: string | null };
    assert.equal(wtRow.status, "cleanup_failed");
    assert.ok(wtRow.error, "error message should be set");
    assert.ok(wtRow.error!.length > 0, "error message should be non-empty");

    // Clean up the directory we created
    try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch { /* cleanup */ }
  });
});

describe("stopWorkflow run.canceled terminal event", () => {
  let tempRoot: string;
  let stateDir: string;
  let originalDbPath: string | undefined;
  let originalHome: string | undefined;
  let originalStateDir: string | undefined;
  let db: DatabaseSync;

  beforeEach(() => {
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    originalHome = process.env.HOME;
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    tempRoot = tamanduaTempDir("tamandua-canceled-event-");
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

  function readRunEventLines(runId: string): Array<Record<string, unknown>> {
    const file = path.join(stateDir, "events", `${runId}.jsonl`);
    const raw = fs.readFileSync(file, "utf-8");
    return raw.trim().split("\n").map((line) => JSON.parse(line));
  }

  it("sets run and steps canceled AND appends run.canceled with payload parity (run with a running step)", async () => {
    const { stopWorkflow } = await import("../../dist/installer/status.js");

    const runId = "run-cnev-000000000000";
    db.prepare("INSERT INTO runs (id, workflow_id, task, status, tokens_spent, worker_lost_count) VALUES (?, ?, ?, ?, ?, ?)")
      .run(runId, "feature-dev-merge-worktree", "cancel me", "running", 42, 3);
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status) VALUES (?, ?, ?, ?, ?, ?)")
      .run("s-cnev-1", runId, "implement", "dev", 0, "waiting");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status) VALUES (?, ?, ?, ?, ?, ?)")
      .run("s-cnev-2", runId, "verify", "verifier", 1, "running");

    const result = await stopWorkflow(runId);
    assert.equal(result.ok, true);

    // DB: run canceled
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "canceled");

    // DB: every waiting/running step canceled
    const steps = db.prepare("SELECT status FROM steps WHERE run_id = ?").all(runId) as Array<{ status: string }>;
    assert.equal(steps.length, 2);
    for (const s of steps) {
      assert.equal(s.status, "canceled");
    }

    // Event stream: run.canceled is the terminal record with payload parity
    const lines = readRunEventLines(runId);
    assert.ok(lines.length >= 1, "expected at least one event line");
    const last = lines[lines.length - 1];
    assert.equal(last.event, "run.canceled");
    assert.equal(last.runId, runId);
    assert.equal(last.workflowId, "feature-dev-merge-worktree");
    assert.equal(last.reason, "cli-stop");
    assert.equal(last.tokensSpent, 42);
    assert.equal(last.workerLostCount, 3);
    assert.equal(typeof last.ts, "string");
    assert.ok((last.ts as string).length > 0);

    // No terminal event precedes it — run.canceled is THE terminal record
    const terminalEvents = new Set(["run.completed", "run.failed", "run.canceled", "run.deleted", "run.force_failed"]);
    for (const line of lines.slice(0, -1)) {
      assert.ok(!terminalEvents.has(line.event as string), `event ${line.event} precedes run.canceled`);
    }
  });

  it("emits run.canceled without errors for a not-yet-started run (all steps waiting)", async () => {
    const { stopWorkflow } = await import("../../dist/installer/status.js");

    const runId = "run-cnev-waiting000000";
    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)")
      .run(runId, "feature-dev-merge-worktree", "waiting run", "running");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status) VALUES (?, ?, ?, ?, ?, ?)")
      .run("s-cnev-w1", runId, "implement", "dev", 0, "waiting");

    const result = await stopWorkflow(runId, { source: "operator-test" });
    assert.deepEqual(result, { ok: true, runId });

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "canceled");

    const lines = readRunEventLines(runId);
    assert.ok(lines.length >= 1);
    const last = lines[lines.length - 1];
    assert.equal(last.event, "run.canceled");
    assert.equal(last.runId, runId);
    assert.equal(last.reason, "operator-test");
  });

  it("emits run.canceled only after in-flight token attribution settles (TATR US-006)", async () => {
    const { stopWorkflow } = await import("../../dist/installer/status.js");
    const { executeDispatchRound, setupAgentCrons } = await import("../../dist/installer/agent-scheduler.js");

    // Random UUID: must not collide with a real daemon's run ids — the
    // terminate request may reach the daemon on TAMANDUA_CONTROL_PORT when
    // it is ambient, and a collision would make the daemon respond 200
    // (settled) for a run it doesn't actually own, skipping the fallback.
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workdir = path.join(tempRoot, "work");
    fs.mkdirSync(workdir, { recursive: true });
    db.prepare("INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at, tokens_spent, worker_lost_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(runId, "feature-dev-merge-worktree", "cancel with in-flight round", "running", JSON.stringify({ working_directory_for_harness: workdir }), now, now, 0, 0);
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'feature-dev-merge-worktree_developer', 0, 'do work', 'STATUS', 'pending', ?, ?)")
      .run(`${runId}-step`, runId, now, now);

    const workflow = {
      id: "feature-dev-merge-worktree",
      agents: [{ id: "developer", model: "fake", workspace: { baseDir: "." } }],
      steps: [{ id: "step-1", agent: "developer", input: "do work", expects: "STATUS" }],
    };
    await setupAgentCrons(workflow, runId, { workingDirectoryForHarness: workdir });

    const marker = path.join(tempRoot, "cancel-settle.marker");
    const fakePi = path.join(tempRoot, "pi-mock");
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
const db = new DatabaseSync(process.env.TAMANDUA_DB_PATH);
db.exec("PRAGMA busy_timeout = 5000");
db.prepare("UPDATE steps SET status = 'running', claim_job_id = ? WHERE status = 'pending'").run(process.env.TAMANDUA_WORKER_JOB_ID);
fs.writeFileSync(process.env.TAMANDUA_ROUND_MARKER, "inflight");
await new Promise((resolve) => setTimeout(resolve, 300));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "STATUS: done", usage: { totalTokens: 137 } } }));
console.log("STATUS: done");
process.exit(0);
`,
      { mode: 0o755 },
    );
    process.env.TAMANDUA_PI_BINARY = fakePi;
    process.env.TAMANDUA_ROUND_MARKER = marker;

    const jobId = `tamandua-feature-dev-merge-worktree-${runId}-developer`;
    const round = executeDispatchRound(
      { id: jobId, workflowId: "feature-dev-merge-worktree", runId, agentId: "feature-dev-merge-worktree_developer", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" },
      { id: "developer", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 },
    );

    try {
      // Wait until the round is genuinely in flight (child spawned + claimed).
      const waitStarted = Date.now();
      while (Date.now() - waitStarted < 5000) {
        if (fs.existsSync(marker)) break;
        await sleep(20);
      }
      assert.ok(fs.existsSync(marker), "round never reached in-flight state");

      // Cancel mid-round. No daemon is reachable in this test env, so
      // stopWorkflow must fall back to the bounded in-process settle and
      // emit run.canceled only after the in-flight attribution lands.
      const result = await stopWorkflow(runId);
      assert.equal(result.ok, true);

      // Ordering: the settled run.tokens.updated precedes run.canceled, and
      // run.canceled is the FINAL event — nothing trails it.
      const lines = readRunEventLines(runId);
      const events = lines.map((l) => l.event);
      const tokenIdx = events.indexOf("run.tokens.updated");
      assert.notEqual(tokenIdx, -1, "settled run.tokens.updated must be present");
      assert.equal(events.filter((e) => e === "run.tokens.updated").length, 1, "exactly one token update");
      const canceledIdx = events.lastIndexOf("run.canceled");
      assert.equal(canceledIdx, events.length - 1, "run.canceled must be the final event");
      assert.ok(tokenIdx < canceledIdx, "run.tokens.updated must precede run.canceled");

      // The settled delta is reflected in the terminal event's tokensSpent.
      const last = lines[lines.length - 1];
      assert.equal(last.event, "run.canceled");
      assert.equal(last.tokensSpent, 137);
      const row = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId) as { tokens_spent: number };
      assert.equal(row.tokens_spent, 137);

      await round;
    } finally {
      delete process.env.TAMANDUA_PI_BINARY;
      delete process.env.TAMANDUA_ROUND_MARKER;
    }
  });

  it("deleteWorkflow --force still emits run.deleted and no run.canceled", async () => {
    const { deleteWorkflow } = await import("../../dist/installer/status.js");

    const runId = "run-cnev-delete000000";
    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)")
      .run(runId, "wf", "active run", "running");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status) VALUES (?, ?, ?, ?, ?, ?)")
      .run("s-cnev-del", runId, "implement", "dev", 0, "running");

    const result = await deleteWorkflow(runId, { force: true });
    assert.equal(result.ok, true);
    assert.equal(result.status, "deleted");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs WHERE id = ?").get(runId) as { count: number }).count, 0);

    const lines = readRunEventLines(runId);
    const events = lines.map((l) => l.event);
    assert.ok(!events.includes("run.canceled"), "deleteWorkflow --force must not emit run.canceled");
    assert.equal(lines[lines.length - 1].event, "run.deleted");
  });

  it("forceFailRun still emits run.force_failed and no run.canceled", async () => {
    const { forceFailRun } = await import("../../dist/installer/status.js");

    const runId = "run-cnev-forcefail000";
    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)")
      .run(runId, "wf", "force-fail me", "running");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status) VALUES (?, ?, ?, ?, ?, ?)")
      .run("s-cnev-ff", runId, "implement", "dev", 0, "running");

    const result = await forceFailRun(runId, "operator halt");
    assert.equal(result.ok, true);

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed");

    const lines = readRunEventLines(runId);
    const events = lines.map((l) => l.event);
    assert.ok(!events.includes("run.canceled"), "forceFailRun must not emit run.canceled");
    assert.equal(lines[lines.length - 1].event, "run.force_failed");
  });
});

// ── WLST5 split counters surface ────────────────────────────────────
// worker_lost_count now means harness_lost only; ceiling-expired rounds
// tick the sibling ceiling_expiry_count. Both must surface through the
// CLI so an operator can tell "harness crashed N times" from "N long
// productive rounds hit the configured ceiling".

describe("WLST5 split counters surface", () => {
  it("workflow status shows both Rounds expired at ceiling and Worker lost", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = "aaab1111-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        context TEXT NOT NULL DEFAULT '{}',
        tokens_spent INTEGER NOT NULL DEFAULT 0,
        worker_lost_count INTEGER NOT NULL DEFAULT 0,
        ceiling_expiry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, worker_lost_count, ceiling_expiry_count) VALUES (?, 'feature-dev', 'split counters', 'running', '{}', 100, 2, 3)"
    ).run(runId);
    db.close();

    const { child, getStdout } = spawnCli(
      ["workflow", "status", runId],
      { HOME: env.homeDir }
    );
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    const stdout = getStdout();
    assert.match(stdout, /Rounds expired at ceiling: 3/);
    assert.match(stdout, /Worker lost: 2/);

    try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  it("compact workflow runs list separates wl: (harness lost) from ce: (ceiling expiry)", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = "bbbb2222-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        context TEXT NOT NULL DEFAULT '{}',
        tokens_spent INTEGER NOT NULL DEFAULT 0,
        worker_lost_count INTEGER NOT NULL DEFAULT 0,
        ceiling_expiry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, worker_lost_count, ceiling_expiry_count) VALUES (?, 'feature-dev', 'split counters', 'running', '{}', 100, 1, 4)"
    ).run(runId);
    db.close();

    const { child, getStdout } = spawnCli(
      ["workflow", "runs"],
      { HOME: env.homeDir }
    );
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    const stdout = getStdout();
    assert.match(stdout, /wl:1/);
    assert.match(stdout, /ce:4/);

    try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  it("workflow status omits both counter lines when both are zero", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = "cccc3333-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        context TEXT NOT NULL DEFAULT '{}',
        tokens_spent INTEGER NOT NULL DEFAULT 0,
        worker_lost_count INTEGER NOT NULL DEFAULT 0,
        ceiling_expiry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent) VALUES (?, 'feature-dev', 'no counters', 'running', '{}', 0)"
    ).run(runId);
    db.close();

    const { child, getStdout } = spawnCli(
      ["workflow", "status", runId],
      { HOME: env.homeDir }
    );
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    const stdout = getStdout();
    assert.doesNotMatch(stdout, /Rounds expired at ceiling/);
    assert.doesNotMatch(stdout, /Worker lost/);

    try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* cleanup */ }
  });
});

// ── RSPN instant-fail loop surfacing ─────────────────────────────────
// A run in an instant-fail loop (K+ consecutive sub-threshold zero-output
// nonzero-exit rounds) must be visible in `tamandua workflow status` and
// `tamandua workflow runs` BEFORE it becomes fatal (DDTH): the motor is
// backing off and heading for force-fail escalation. Below the backoff
// threshold K the counter must stay silent — a lone instant fail is not a
// loop.

describe("RSPN instant-fail loop surfacing", () => {
  const RUNS_DDL = `
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      worker_lost_count INTEGER NOT NULL DEFAULT 0,
      ceiling_expiry_count INTEGER NOT NULL DEFAULT 0,
      instant_fail_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `;

  it("workflow status shows the instant-fail loop line at or above the backoff threshold", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = "dddd4444-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    const db = new DatabaseSync(dbPath);
    db.exec(RUNS_DDL);
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, instant_fail_count) VALUES (?, 'feature-dev', 'instant fail loop', 'running', '{}', 100, 3)"
    ).run(runId);
    db.close();

    const { child, getStdout } = spawnCli(
      ["workflow", "status", runId],
      { HOME: env.homeDir }
    );
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    const stdout = getStdout();
    assert.match(stdout, /Worker instant-fail loop: 3 consecutive sub-\d+s exit-1 rounds/);

    try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  it("workflow status omits the instant-fail line below the backoff threshold", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = "eeee5555-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    const db = new DatabaseSync(dbPath);
    db.exec(RUNS_DDL);
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, instant_fail_count) VALUES (?, 'feature-dev', 'one-off instant fail', 'running', '{}', 0, 1)"
    ).run(runId);
    db.close();

    const { child, getStdout } = spawnCli(
      ["workflow", "status", runId],
      { HOME: env.homeDir }
    );
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    const stdout = getStdout();
    assert.doesNotMatch(stdout, /Worker instant-fail loop/, "a sub-threshold count is not a loop yet");

    try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  it("compact workflow runs list surfaces the if: marker at or above the backoff threshold", async () => {
    const env = createTempEnv();
    const dbPath = path.join(env.tamanduaDir, "tamandua.db");
    const runId = "ffff6666-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    const db = new DatabaseSync(dbPath);
    db.exec(RUNS_DDL);
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, instant_fail_count) VALUES (?, 'feature-dev', 'instant fail loop', 'running', '{}', 100, 4)"
    ).run(runId);
    db.close();

    const { child, getStdout } = spawnCli(
      ["workflow", "runs"],
      { HOME: env.homeDir }
    );
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    const stdout = getStdout();
    assert.match(stdout, /if:4/);

    try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* cleanup */ }
  });
});
