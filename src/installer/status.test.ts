import fs from "node:fs";
import { cleanChildEnv } from "../../tests/helpers/test-env.ts";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, it, beforeEach, afterEach } from "node:test";
import { once } from "node:events";

const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");

// ── Helpers ──

function createTempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-status-test-"));
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
    assert.match(stdout, /Run: eeee5555/);
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
    assert.match(stdout, /Run: ffff6666/);
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
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-stopwf-"));
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
});
