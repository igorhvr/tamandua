import fs from "node:fs";
import { cleanChildEnv, reservePortHandles, waitForPidExit } from "./helpers/test-env.ts";
import { stopDaemon, stopDashboardStandalone } from "../dist/server/daemonctl.js";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import crypto from "node:crypto";

const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");

function runGit(args: string[], cwd: string): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? "").trim();
}

async function createTempEnv() {
  const root = tamanduaTempDir("tamandua-cli-wt-");
  const homeDir = path.join(root, "home");
  const tamanduaDir = path.join(homeDir, ".tamandua");
  const dbPath = path.join(tamanduaDir, "tamandua.db");
  const worktreeRoot = path.join(tamanduaDir, "worktrees");
  fs.mkdirSync(tamanduaDir, { recursive: true });
  const handles = await reservePortHandles(2);
  const dashboardPort = handles[0].port;
  const controlPort = handles[1].port;
  await Promise.all(handles.map(h => h.close()));
  fs.writeFileSync(path.join(tamanduaDir, "port"), String(dashboardPort), "utf-8");
  return { root, homeDir, tamanduaDir, dbPath, worktreeRoot, controlPort, dashboardPort };
}

type TestEnv = Awaited<ReturnType<typeof createTempEnv>>;

function cliEnv(env: TestEnv): Record<string, string> {
  return {
    HOME: env.homeDir,
    TAMANDUA_CONTROL_PORT: String(env.controlPort),
    TAMANDUA_DB_PATH: env.dbPath,
    TAMANDUA_STATE_DIR: env.tamanduaDir,
    TAMANDUA_WORKTREE_ROOT: env.worktreeRoot,
  };
}

function assertCliSucceeded(
  result: { stdout: string; stderr: string; code: number | null },
  command: string,
): void {
  assert.equal(
    result.code,
    0,
    `${command} failed with exit code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

async function startDashboard(env: TestEnv): Promise<void> {
  const result = await runCliToExit([
    "dashboard", "start", "--port", String(env.dashboardPort),
  ], cliEnv(env));
  assertCliSucceeded(result, "tamandua dashboard start");
}

function createGitRepo(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  runGit(["init", "--initial-branch=main"], dirPath);
  runGit(["config", "user.email", "test@test"], dirPath);
  runGit(["config", "user.name", "Test"], dirPath);
  fs.writeFileSync(path.join(dirPath, "README.md"), "# test\n", "utf-8");
  runGit(["add", "."], dirPath);
  runGit(["commit", "-m", "initial"], dirPath);
}

function writeMinimalWorkflow(
  homeDir: string,
  workflowId: string,
  options?: { workspaceMode?: "direct" | "worktree" },
): void {
  const workflowDir = path.join(homeDir, ".tamandua", "workflows", workflowId);
  fs.mkdirSync(workflowDir, { recursive: true });
  const runBlock = options?.workspaceMode
    ? `run:\n  workspace: ${options.workspaceMode}\n`
    : "";
  fs.writeFileSync(path.join(workflowDir, "workflow.yml"),
    `id: ${workflowId}\n${runBlock}agents:\n  - id: dev\n    model: fake\n    workspace:\n      baseDir: .\nsteps:\n  - id: implement\n    agent: dev\n    input: Implement the task\n    expects: STATUS, CHANGES, TESTS\n`,
    "utf-8");
}

async function runCliToExit(
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: cleanChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CLI timed out")); }, 15000);
    child.stdout.on("data", (c) => stdout += c.toString());
    child.stderr.on("data", (c) => stderr += c.toString());
    child.on("error", (e) => { clearTimeout(t); reject(e); });
    child.on("close", (code) => { clearTimeout(t); resolve({ stdout, stderr, code }); });
  });
}

async function runCliUntilOutput(
  args: string[],
  env: Record<string, string>,
  pattern: RegExp,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: cleanChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", finished = false;
    const t = setTimeout(() => {
      if (!finished) { finished = true; child.kill("SIGKILL"); reject(new Error(`CLI timed out\nstdout:${stdout}\nstderr:${stderr}`)); }
    }, 15000);
    const maybeFinish = (code: number | null) => {
      if (finished) return;
      if (pattern.test(stdout)) { finished = true; clearTimeout(t); if (!child.killed) try { child.kill("SIGTERM"); } catch {} resolve({ stdout, stderr, code }); }
    };
    child.stdout.on("data", (c) => { stdout += c.toString(); maybeFinish(null); });
    child.stderr.on("data", (c) => stderr += c.toString());
    child.on("error", (e) => { if (!finished) { finished = true; clearTimeout(t); reject(e); } });
    child.on("close", (code) => { if (!finished) { finished = true; clearTimeout(t); resolve({ stdout, stderr, code }); } });
  });
}

function initDb(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, run_number INTEGER, workflow_id TEXT NOT NULL, task TEXT NOT NULL,
      status TEXT NOT NULL, context TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, tokens_spent INTEGER NOT NULL DEFAULT 0,
      notify_url TEXT, scheduling_status TEXT, scheduling_requested_at TEXT, scheduling_error TEXT
    );
    CREATE TABLE IF NOT EXISTS run_worktrees (
      run_id TEXT PRIMARY KEY, worktree_origin_repository TEXT NOT NULL,
      worktree_origin_git_common_dir TEXT NOT NULL, worktree_path TEXT NOT NULL,
      worktree_origin_ref TEXT, worktree_origin_sha TEXT, original_branch TEXT,
      status TEXT NOT NULL, cleanup_policy TEXT NOT NULL, created_at TEXT NOT NULL,
      removed_at TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_run_worktrees_status ON run_worktrees(status);
  `);
  db.close();
}

function seedWorktreeRow(dbPath: string, runId: string, overrides?: {
  status?: string; worktreePath?: string; originRepo?: string;
  originRef?: string | null; originSha?: string | null; cleanupPolicy?: string;
}): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(`INSERT INTO run_worktrees (run_id, worktree_origin_repository, worktree_origin_git_common_dir,
    worktree_path, worktree_origin_ref, worktree_origin_sha, original_branch, status,
    cleanup_policy, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
    runId, overrides?.originRepo ?? "/tmp/origin", "/tmp/origin/.git",
    overrides?.worktreePath ?? "/tmp/fake-worktree",
    overrides?.originRef ?? "main",
    overrides?.originSha ?? "abc1234",
    "main", overrides?.status ?? "ready", overrides?.cleanupPolicy ?? "keep");
  db.close();
}

function seedRunRow(dbPath: string, runId: string, overrides?: {
  status?: string; task?: string; workflowId?: string; runNumber?: number;
}): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(`INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent,
    scheduling_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '{}', 0, 'active', datetime('now'), datetime('now'))`).run(
    runId, overrides?.runNumber ?? 1, overrides?.workflowId ?? "test-wf",
    overrides?.task ?? "Test task", overrides?.status ?? "running");
  db.close();
}

// ── Tests ──

describe("CLI worktree run arguments", () => {
  it("accepts --worktree-origin-repository and --worktree-origin-ref for worktree workflows", async () => {
    const env = await createTempEnv();
    try {
      const workflowId = "cli-wt-run";
      writeMinimalWorkflow(env.homeDir, workflowId, { workspaceMode: "worktree" });
      const originRepo = path.join(env.root, "origin");
      createGitRepo(originRepo);
      await startDashboard(env);

      const result = await runCliToExit([
        "workflow", "run", workflowId, "Test worktree run",
        "--worktree-origin-repository", originRepo, "--worktree-origin-ref", "main",
      ], cliEnv(env));
      assertCliSucceeded(result, "tamandua workflow run cli-wt-run");

      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT context FROM runs ORDER BY created_at DESC LIMIT 1").get() as { context: string } | undefined;
      db.close();
      assert.ok(row, "expected a run row in DB");
      const context = JSON.parse(row!.context) as Record<string, string>;
      // Compare realpaths: macOS /tmp is a symlink to /private/tmp — realpath handles it.
      assert.equal(
        fs.realpathSync(context.worktree_origin_repository),
        fs.realpathSync(originRepo),
      );
      assert.equal(context.worktree_origin_ref, "main");
    } finally {
      // Stop both the dashboard (started by startDashboard) and the daemon (started by workflow run).
      // The prior code only called dashboard stop which checked dashboard.pid — the daemon's
      // tamandua.pid was never read, leaving detached daemon processes.
      const dashboardPidFile = path.join(env.homeDir, ".tamandua", "dashboard.pid");
      const daemonPidFile = path.join(env.homeDir, ".tamandua", "tamandua.pid");
      let dashboardPid: number | null = null;
      let daemonPid: number | null = null;
      try {
        if (fs.existsSync(dashboardPidFile)) dashboardPid = parseInt(fs.readFileSync(dashboardPidFile, "utf-8").trim(), 10);
        if (fs.existsSync(daemonPidFile)) daemonPid = parseInt(fs.readFileSync(daemonPidFile, "utf-8").trim(), 10);
      } catch {}
      if (dashboardPid !== null && !isNaN(dashboardPid)) {
        let wasAlive = false;
        try { process.kill(dashboardPid, 0); wasAlive = true; } catch {}
        const stopped = stopDashboardStandalone({ homeDir: env.homeDir });
        if (wasAlive) {
          assert.ok(stopped, `stopDashboardStandalone must return true when dashboard PID ${dashboardPid} is alive`);
          const exited = await waitForPidExit(dashboardPid, 10000);
          assert.ok(exited, `dashboard PID ${dashboardPid} must exit before temp directory cleanup`);
        }
      }
      if (daemonPid !== null && !isNaN(daemonPid)) {
        let wasAlive = false;
        try { process.kill(daemonPid, 0); wasAlive = true; } catch {}
        const stopped = stopDaemon({ homeDir: env.homeDir });
        if (wasAlive) {
          assert.ok(stopped, `stopDaemon must return true when daemon PID ${daemonPid} is alive`);
          const exited = await waitForPidExit(daemonPid, 10000);
          assert.ok(exited, `daemon PID ${daemonPid} must exit before temp directory cleanup`);
        }
      }
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("accepts inline worktree origin args for worktree workflows", async () => {
    const env = await createTempEnv();
    try {
      const workflowId = "cli-wt-run-inline";
      writeMinimalWorkflow(env.homeDir, workflowId, { workspaceMode: "worktree" });
      const originRepo = path.join(env.root, "origin");
      createGitRepo(originRepo);
      await startDashboard(env);

      const result = await runCliToExit([
        "workflow", "run", workflowId,
        `--worktree-origin-repository=${originRepo}`, "--worktree-origin-ref=main",
        "Test worktree run with inline args",
      ], cliEnv(env));
      assertCliSucceeded(result, "tamandua workflow run cli-wt-run-inline");

      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT context FROM runs ORDER BY created_at DESC LIMIT 1").get() as { context: string } | undefined;
      db.close();
      assert.ok(row);
      const context = JSON.parse(row!.context) as Record<string, string>;
      // Compare realpaths: macOS /tmp is a symlink to /private/tmp — realpath handles it.
      assert.equal(
        fs.realpathSync(context.worktree_origin_repository),
        fs.realpathSync(originRepo),
      );
      assert.equal(context.worktree_origin_ref, "main");
    } finally {
      // Stop both the dashboard (started by startDashboard) and the daemon (started by workflow run).
      const dashboardPidFile = path.join(env.homeDir, ".tamandua", "dashboard.pid");
      const daemonPidFile = path.join(env.homeDir, ".tamandua", "tamandua.pid");
      let dashboardPid: number | null = null;
      let daemonPid: number | null = null;
      try {
        if (fs.existsSync(dashboardPidFile)) dashboardPid = parseInt(fs.readFileSync(dashboardPidFile, "utf-8").trim(), 10);
        if (fs.existsSync(daemonPidFile)) daemonPid = parseInt(fs.readFileSync(daemonPidFile, "utf-8").trim(), 10);
      } catch {}
      if (dashboardPid !== null && !isNaN(dashboardPid)) {
        let wasAlive = false;
        try { process.kill(dashboardPid, 0); wasAlive = true; } catch {}
        const stopped = stopDashboardStandalone({ homeDir: env.homeDir });
        if (wasAlive) {
          assert.ok(stopped, `stopDashboardStandalone must return true when dashboard PID ${dashboardPid} is alive`);
          const exited = await waitForPidExit(dashboardPid, 10000);
          assert.ok(exited, `dashboard PID ${dashboardPid} must exit before temp directory cleanup`);
        }
      }
      if (daemonPid !== null && !isNaN(daemonPid)) {
        let wasAlive = false;
        try { process.kill(daemonPid, 0); wasAlive = true; } catch {}
        const stopped = stopDaemon({ homeDir: env.homeDir });
        if (wasAlive) {
          assert.ok(stopped, `stopDaemon must return true when daemon PID ${daemonPid} is alive`);
          const exited = await waitForPidExit(daemonPid, 10000);
          assert.ok(exited, `daemon PID ${daemonPid} must exit before temp directory cleanup`);
        }
      }
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("allows --worktree-origin-repository without --worktree-origin-ref for worktree workflows", async () => {
    const env = await createTempEnv();
    try {
      const workflowId = "cli-wt-run-repo-only";
      writeMinimalWorkflow(env.homeDir, workflowId, { workspaceMode: "worktree" });
      const originRepo = path.join(env.root, "origin");
      createGitRepo(originRepo);
      await startDashboard(env);

      const result = await runCliToExit([
        "workflow", "run", workflowId, "Test repo only", "--worktree-origin-repository", originRepo,
      ], cliEnv(env));
      assertCliSucceeded(result, "tamandua workflow run cli-wt-run-repo-only");

      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT context FROM runs ORDER BY created_at DESC LIMIT 1").get() as { context: string } | undefined;
      db.close();
      assert.ok(row, "expected a run row in DB");
      const context = JSON.parse(row!.context) as Record<string, string>;
      // Compare realpaths: macOS /tmp is a symlink to /private/tmp — realpath handles it.
      assert.equal(
        fs.realpathSync(context.worktree_origin_repository),
        fs.realpathSync(originRepo),
      );
      assert.ok(context.worktree_origin_ref, "expected worktree_origin_ref to be defaulted from the origin branch");
    } finally {
      // Stop both the dashboard (started by startDashboard) and the daemon (started by workflow run).
      const dashboardPidFile = path.join(env.homeDir, ".tamandua", "dashboard.pid");
      const daemonPidFile = path.join(env.homeDir, ".tamandua", "tamandua.pid");
      let dashboardPid: number | null = null;
      let daemonPid: number | null = null;
      try {
        if (fs.existsSync(dashboardPidFile)) dashboardPid = parseInt(fs.readFileSync(dashboardPidFile, "utf-8").trim(), 10);
        if (fs.existsSync(daemonPidFile)) daemonPid = parseInt(fs.readFileSync(daemonPidFile, "utf-8").trim(), 10);
      } catch {}
      if (dashboardPid !== null && !isNaN(dashboardPid)) {
        let wasAlive = false;
        try { process.kill(dashboardPid, 0); wasAlive = true; } catch {}
        const stopped = stopDashboardStandalone({ homeDir: env.homeDir });
        if (wasAlive) {
          assert.ok(stopped, `stopDashboardStandalone must return true when dashboard PID ${dashboardPid} is alive`);
          const exited = await waitForPidExit(dashboardPid, 10000);
          assert.ok(exited, `dashboard PID ${dashboardPid} must exit before temp directory cleanup`);
        }
      }
      if (daemonPid !== null && !isNaN(daemonPid)) {
        let wasAlive = false;
        try { process.kill(daemonPid, 0); wasAlive = true; } catch {}
        const stopped = stopDaemon({ homeDir: env.homeDir });
        if (wasAlive) {
          assert.ok(stopped, `stopDaemon must return true when daemon PID ${daemonPid} is alive`);
          const exited = await waitForPidExit(daemonPid, 10000);
          assert.ok(exited, `daemon PID ${daemonPid} must exit before temp directory cleanup`);
        }
      }
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("rejects missing value for --worktree-origin-repository", async () => {
    const env = await createTempEnv();
    try {
      const { stderr, code } = await runCliToExit(
        ["workflow", "run", "test-wf", "Test", "--worktree-origin-repository"], cliEnv(env));
      assert.equal(code, 1);
      assert.match(stderr, /Missing value for --worktree-origin-repository/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("rejects worktree origin args for direct workflows", async () => {
    const env = await createTempEnv();
    try {
      const workflowId = "cli-direct-run";
      writeMinimalWorkflow(env.homeDir, workflowId, { workspaceMode: "direct" });
      const originRepo = path.join(env.root, "origin");
      createGitRepo(originRepo);

      const { stderr, code } = await runCliToExit([
        "workflow", "run", workflowId, "Should fail",
        "--worktree-origin-repository", originRepo,
      ], cliEnv(env));

      assert.equal(code, 1);
      assert.match(stderr, /--worktree-origin-repository is only valid for workflows with run\.workspace: worktree/i);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("rejects --working-directory-for-harness for worktree workflows", async () => {
    const env = await createTempEnv();
    try {
      const workflowId = "cli-wt-reject-harness";
      writeMinimalWorkflow(env.homeDir, workflowId, { workspaceMode: "worktree" });
      const originRepo = path.join(env.root, "origin");
      const harnessDir = path.join(env.root, "harness");
      createGitRepo(originRepo);
      fs.mkdirSync(harnessDir, { recursive: true });

      const { stderr, code } = await runCliToExit([
        "workflow", "run", workflowId, "Should fail",
        "--working-directory-for-harness", harnessDir,
        "--worktree-origin-repository", originRepo,
      ], cliEnv(env));

      assert.equal(code, 1);
      assert.match(stderr, /--working-directory-for-harness is not valid for workflows with run\.workspace: worktree/i);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("creates a managed worktree and seeds worktree context for worktree workflows", async () => {
    const env = await createTempEnv();
    try {
      const workflowId = "cli-wt-managed";
      writeMinimalWorkflow(env.homeDir, workflowId, { workspaceMode: "worktree" });
      const originRepo = path.join(env.root, "origin");
      createGitRepo(originRepo);
      await startDashboard(env);

      const runResult = await runCliToExit([
        "workflow", "run", workflowId, "Create managed worktree",
        "--worktree-origin-repository", originRepo,
      ], cliEnv(env));
      assertCliSucceeded(runResult, "tamandua workflow run cli-wt-managed");
      const { stdout } = runResult;

      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      const db = new DatabaseSync(dbPath);
      const row = db.prepare(
        "SELECT id, context FROM runs ORDER BY created_at DESC LIMIT 1",
      ).get() as { id: string; context: string } | undefined;
      const worktreeRow = row
        ? db.prepare("SELECT worktree_path, worktree_origin_repository, worktree_origin_ref, status FROM run_worktrees WHERE run_id = ?").get(row.id) as { worktree_path: string; worktree_origin_repository: string; worktree_origin_ref: string; status: string } | undefined
        : undefined;
      db.close();

      assert.ok(row, "expected a run row in DB");
      assert.ok(worktreeRow, "expected a run_worktrees row in DB");
      const context = JSON.parse(row!.context) as Record<string, string>;
      assert.equal(context.workspace_mode, "worktree");
      assert.equal(context.repo, worktreeRow!.worktree_path);
      assert.equal(context.working_directory_for_harness, worktreeRow!.worktree_path);
      assert.equal(context.worktree_path, worktreeRow!.worktree_path);
      assert.equal(context.worktree_origin_repository, worktreeRow!.worktree_origin_repository);
      assert.equal(context.worktree_origin_ref, worktreeRow!.worktree_origin_ref);
      assert.equal(worktreeRow!.status, "ready");
      assert.ok(fs.existsSync(worktreeRow!.worktree_path), "managed worktree should exist on disk");
      if (stdout.trim().length > 0) {
        assert.match(stdout, new RegExp(`Harness CWD: ${worktreeRow!.worktree_path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      }
    } finally {
      // Stop both the dashboard (started by startDashboard) and the daemon (started by workflow run).
      const dashboardPidFile = path.join(env.homeDir, ".tamandua", "dashboard.pid");
      const daemonPidFile = path.join(env.homeDir, ".tamandua", "tamandua.pid");
      let dashboardPid: number | null = null;
      let daemonPid: number | null = null;
      try {
        if (fs.existsSync(dashboardPidFile)) dashboardPid = parseInt(fs.readFileSync(dashboardPidFile, "utf-8").trim(), 10);
        if (fs.existsSync(daemonPidFile)) daemonPid = parseInt(fs.readFileSync(daemonPidFile, "utf-8").trim(), 10);
      } catch {}
      if (dashboardPid !== null && !isNaN(dashboardPid)) {
        let wasAlive = false;
        try { process.kill(dashboardPid, 0); wasAlive = true; } catch {}
        const stopped = stopDashboardStandalone({ homeDir: env.homeDir });
        if (wasAlive) {
          assert.ok(stopped, `stopDashboardStandalone must return true when dashboard PID ${dashboardPid} is alive`);
          const exited = await waitForPidExit(dashboardPid, 10000);
          assert.ok(exited, `dashboard PID ${dashboardPid} must exit before temp directory cleanup`);
        }
      }
      if (daemonPid !== null && !isNaN(daemonPid)) {
        let wasAlive = false;
        try { process.kill(daemonPid, 0); wasAlive = true; } catch {}
        const stopped = stopDaemon({ homeDir: env.homeDir });
        if (wasAlive) {
          assert.ok(stopped, `stopDaemon must return true when daemon PID ${daemonPid} is alive`);
          const exited = await waitForPidExit(daemonPid, 10000);
          assert.ok(exited, `daemon PID ${daemonPid} must exit before temp directory cleanup`);
        }
      }
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("CLI worktree list", () => {
  it("shows empty message when no worktrees exist", async () => {
    const env = await createTempEnv();
    try {
      initDb(path.join(env.tamanduaDir, "tamandua.db"));
      const { stdout } = await runCliToExit(["worktree", "list"], cliEnv(env));
      assert.match(stdout, /No managed worktrees found/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("lists managed worktrees", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      initDb(dbPath);
      const runId = crypto.randomUUID();
      seedRunRow(dbPath, runId);
      seedWorktreeRow(dbPath, runId, { worktreePath: "/tmp/tamandua-wt/fake-1", originRepo: "/home/project" });
      const { stdout } = await runCliToExit(["worktree", "list"], cliEnv(env));
      assert.match(stdout, /ready/);
      assert.match(stdout, new RegExp(runId.slice(0, 8)));
      assert.match(stdout, /keep/);
      assert.match(stdout, /\/tmp\/tamandua-wt\/fake-1/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("CLI worktree status", () => {
  it("shows worktree details for a run", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      initDb(dbPath);
      const runId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      seedRunRow(dbPath, runId);
      seedWorktreeRow(dbPath, runId, {
        worktreePath: "/tmp/tamandua-wt/details", originRepo: "/home/user/repo",
        originRef: "feature/branch", originSha: "abc123def456", cleanupPolicy: "remove_on_success",
      });
      const { stdout } = await runCliToExit(["worktree", "status", runId], cliEnv(env));
      assert.match(stdout, /Run:\s+aaaaaaaa/);
      assert.match(stdout, /Status:\s+ready/);
      assert.match(stdout, /Origin repo:\s+\/home\/user\/repo/);
      assert.match(stdout, /Origin ref:\s+feature\/branch/);
      assert.match(stdout, /Origin SHA:\s+abc123def456/);
      assert.match(stdout, /Cleanup:\s+remove_on_success/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("shows none for missing ref and sha", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      initDb(dbPath);
      const runId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
      seedRunRow(dbPath, runId);
      // Use actual NULL values via raw SQL
      const db = new DatabaseSync(dbPath);
      db.prepare(`INSERT INTO run_worktrees (run_id, worktree_origin_repository, worktree_origin_git_common_dir,
        worktree_path, worktree_origin_ref, worktree_origin_sha, original_branch, status,
        cleanup_policy, created_at)
        VALUES (?, ?, ?, ?, NULL, NULL, 'main', 'ready', 'keep', datetime('now'))`).run(
        runId, "/tmp/origin", "/tmp/origin/.git", "/tmp/tamandua-wt/no-ref");
      db.close();
      const { stdout } = await runCliToExit(["worktree", "status", runId], cliEnv(env));
      assert.match(stdout, /Origin ref:\s+\(none\)/);
      assert.match(stdout, /Origin SHA:\s+\(none\)/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("shows message for run with no managed worktree", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      initDb(dbPath);
      const runId = "cccccccc-dddd-eeee-ffff-000000000000";
      seedRunRow(dbPath, runId);
      const { stdout } = await runCliToExit(["worktree", "status", runId], cliEnv(env));
      assert.match(stdout, /No managed worktree/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("errors when run does not exist", async () => {
    const env = await createTempEnv();
    try {
      initDb(path.join(env.tamanduaDir, "tamandua.db"));
      const { stderr, code } = await runCliToExit(
        ["worktree", "status", "nonexistent-run"], cliEnv(env));
      assert.equal(code, 1);
      assert.match(stderr, /No run found matching/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("CLI worktree remove", () => {
  it("removes a managed worktree", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      initDb(dbPath);
      const originRepo = path.join(env.root, "origin");
      createGitRepo(originRepo);
      const worktreePath = path.join(env.root, "managed-wt");
      runGit(["worktree", "add", "--detach", worktreePath, "main"], originRepo);
      const runId = crypto.randomUUID();
      seedRunRow(dbPath, runId);
      seedWorktreeRow(dbPath, runId, { worktreePath, originRepo, originRef: "main" });
      const { stdout, code } = await runCliToExit(["worktree", "remove", runId], cliEnv(env));
      assert.equal(code, 0);
      assert.match(stdout, /Removed managed worktree for run/);
      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT status FROM run_worktrees WHERE run_id = ?").get(runId) as { status: string } | undefined;
      db.close();
      assert.ok(row);
      assert.equal(row!.status, "removed");
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("errors when run has no managed worktree", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      initDb(dbPath);
      const runId = crypto.randomUUID();
      seedRunRow(dbPath, runId);
      const { stderr, code } = await runCliToExit(["worktree", "remove", runId], cliEnv(env));
      assert.equal(code, 1);
      assert.match(stderr, /has no managed worktree/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("CLI worktree prune", () => {
  it("prunes completed worktrees older than threshold", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      initDb(dbPath);
      const originRepo = path.join(env.root, "origin");
      createGitRepo(originRepo);
      const worktreePath = path.join(env.root, "old-wt");
      runGit(["worktree", "add", "--detach", worktreePath, "main"], originRepo);
      const runId = crypto.randomUUID();
      seedRunRow(dbPath, runId, { status: "completed" });
      seedWorktreeRow(dbPath, runId, { worktreePath, originRepo, originRef: "main" });
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE run_worktrees SET created_at = datetime('now', '-30 days') WHERE run_id = ?").run(runId);
      db.close();
      const { stdout, code } = await runCliToExit(
        ["worktree", "prune", "--completed", "--older-than", "7d"], cliEnv(env));
      assert.equal(code, 0);
      assert.match(stdout, /Pruned worktree/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("skips completed worktrees newer than threshold", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      initDb(dbPath);
      const originRepo = path.join(env.root, "origin");
      createGitRepo(originRepo);
      const worktreePath = path.join(env.root, "new-wt");
      runGit(["worktree", "add", "--detach", worktreePath, "main"], originRepo);
      const runId = crypto.randomUUID();
      seedRunRow(dbPath, runId, { status: "completed" });
      seedWorktreeRow(dbPath, runId, { worktreePath, originRepo, originRef: "main" });
      const { stdout } = await runCliToExit(
        ["worktree", "prune", "--completed", "--older-than", "7d"], cliEnv(env));
      assert.match(stdout, /No worktrees to prune/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("skips worktrees for non-terminal runs", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      initDb(dbPath);
      const originRepo = path.join(env.root, "origin");
      createGitRepo(originRepo);
      const worktreePath = path.join(env.root, "running-wt");
      runGit(["worktree", "add", "--detach", worktreePath, "main"], originRepo);
      const runId = crypto.randomUUID();
      seedRunRow(dbPath, runId, { status: "running" });
      seedWorktreeRow(dbPath, runId, { worktreePath, originRepo, originRef: "main" });
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE run_worktrees SET created_at = datetime('now', '-30 days') WHERE run_id = ?").run(runId);
      db.close();
      const { stdout } = await runCliToExit(
        ["worktree", "prune", "--completed", "--older-than", "7d"], cliEnv(env));
      assert.match(stdout, /No worktrees to prune/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("errors without --completed flag", async () => {
    const env = await createTempEnv();
    try {
      initDb(path.join(env.tamanduaDir, "tamandua.db"));
      const { stderr, code } = await runCliToExit(
        ["worktree", "prune", "--older-than", "7d"], cliEnv(env));
      assert.equal(code, 1);
      assert.match(stderr, /Missing --completed/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("prunes cleanup_failed worktree successfully", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      initDb(dbPath);
      const originRepo = path.join(env.root, "origin");
      createGitRepo(originRepo);
      const worktreePath = path.join(env.root, "cleanup-failed-wt");
      runGit(["worktree", "add", "--detach", worktreePath, "main"], originRepo);
      const runId = crypto.randomUUID();
      seedRunRow(dbPath, runId, { status: "completed" });
      seedWorktreeRow(dbPath, runId, { worktreePath, originRepo, originRef: "main", status: "cleanup_failed" });
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE run_worktrees SET created_at = datetime('now', '-30 days'), error = 'prior failure' WHERE run_id = ?").run(runId);
      db.close();
      const { stdout, code } = await runCliToExit(
        ["worktree", "prune", "--completed", "--older-than", "7d"], cliEnv(env));
      assert.equal(code, 0);
      assert.match(stdout, /Pruned cleanup_failed worktree for run/);
      assert.match(stdout, /Pruned 1 worktree/);
      // Verify the worktree row is now removed
      const db2 = new DatabaseSync(dbPath);
      const row = db2.prepare("SELECT status FROM run_worktrees WHERE run_id = ?").get(runId) as { status: string } | undefined;
      db2.close();
      assert.ok(row, "row should still exist");
      assert.equal(row!.status, "removed");
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("logs warning when cleanup_failed worktree removal fails", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      initDb(dbPath);
      const runId = crypto.randomUUID();
      // Create a dir at the worktree path so fs.statSync finds it, but
      // make the origin repo point to a non-git directory so git worktree
      // remove fails.
      const wtPath = path.join(env.root, "stale-wt");
      fs.mkdirSync(wtPath, { recursive: true });
      const nonGitOrigin = path.join(env.root, "non-git-origin");
      fs.mkdirSync(nonGitOrigin, { recursive: true });
      seedRunRow(dbPath, runId, { status: "completed" });
      seedWorktreeRow(dbPath, runId, { worktreePath: wtPath, originRepo: nonGitOrigin, status: "cleanup_failed" });
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE run_worktrees SET created_at = datetime('now', '-30 days'), error = 'prior failure' WHERE run_id = ?").run(runId);
      db.close();
      const { stdout, stderr, code } = await runCliToExit(
        ["worktree", "prune", "--completed", "--older-than", "7d"], cliEnv(env));
      assert.equal(code, 0);
      // The warning goes to stderr via console.warn in the CLI process
      assert.match(stderr, /Warning: failed to prune cleanup_failed worktree for run/);
      // Should report no worktrees pruned
      assert.match(stdout, /No worktrees to prune/);
      // Verify the row still exists with cleanup_failed status
      const db2 = new DatabaseSync(dbPath);
      const row = db2.prepare("SELECT status FROM run_worktrees WHERE run_id = ?").get(runId) as { status: string } | undefined;
      db2.close();
      assert.ok(row, "row should still exist after failed prune");
      assert.equal(row!.status, "cleanup_failed");
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("prunes cleanup_failed worktree even when associated run does not exist", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      initDb(dbPath);
      const originRepo = path.join(env.root, "origin");
      createGitRepo(originRepo);
      const worktreePath = path.join(env.root, "orphan-wt");
      runGit(["worktree", "add", "--detach", worktreePath, "main"], originRepo);
      const runId = crypto.randomUUID();
      // Seed the worktree row but NOT the run row — simulating deleteWorkflow having deleted the run
      seedWorktreeRow(dbPath, runId, { worktreePath, originRepo, originRef: "main", status: "cleanup_failed" });
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE run_worktrees SET created_at = datetime('now', '-30 days'), error = 'prior failure' WHERE run_id = ?").run(runId);
      db.close();
      const { stdout, code } = await runCliToExit(
        ["worktree", "prune", "--completed", "--older-than", "7d"], cliEnv(env));
      assert.equal(code, 0);
      assert.match(stdout, /Pruned cleanup_failed worktree for run/);
      assert.match(stdout, /Pruned 1 worktree/);
      // Verify the worktree row is now removed
      const db2 = new DatabaseSync(dbPath);
      const row = db2.prepare("SELECT status FROM run_worktrees WHERE run_id = ?").get(runId) as { status: string } | undefined;
      db2.close();
      assert.ok(row, "row should still exist");
      assert.equal(row!.status, "removed");
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("errors without --older-than value", async () => {
    const env = await createTempEnv();
    try {
      initDb(path.join(env.tamanduaDir, "tamandua.db"));
      const { stderr, code } = await runCliToExit(
        ["worktree", "prune", "--completed"], cliEnv(env));
      assert.equal(code, 1);
      assert.match(stderr, /Missing --older-than/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("prunes orphaned worktree (no runs row) when older than threshold", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      initDb(dbPath);
      const originRepo = path.join(env.root, "origin");
      createGitRepo(originRepo);
      const worktreePath = path.join(env.root, "orphan-old-wt");
      runGit(["worktree", "add", "--detach", worktreePath, "main"], originRepo);
      const runId = crypto.randomUUID();
      // Seed worktree row but NO runs row — simulating orphaned row
      seedWorktreeRow(dbPath, runId, { worktreePath, originRepo, originRef: "main" });
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE run_worktrees SET created_at = datetime('now', '-30 days') WHERE run_id = ?").run(runId);
      db.close();
      const { stdout, code } = await runCliToExit(
        ["worktree", "prune", "--completed", "--older-than", "7d"], cliEnv(env));
      assert.equal(code, 0);
      assert.match(stdout, /Pruned orphaned worktree/);
      assert.match(stdout, /no runs row/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("skips orphaned worktree newer than threshold", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      initDb(dbPath);
      const originRepo = path.join(env.root, "origin");
      createGitRepo(originRepo);
      const worktreePath = path.join(env.root, "orphan-new-wt");
      runGit(["worktree", "add", "--detach", worktreePath, "main"], originRepo);
      const runId = crypto.randomUUID();
      // Seed worktree row but NO runs row — simulating orphaned row
      seedWorktreeRow(dbPath, runId, { worktreePath, originRepo, originRef: "main" });
      const { stdout, code } = await runCliToExit(
        ["worktree", "prune", "--completed", "--older-than", "7d"], cliEnv(env));
      assert.equal(code, 0);
      assert.match(stdout, /No worktrees to prune/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("prunes orphaned worktree with very short --older-than", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      initDb(dbPath);
      const originRepo = path.join(env.root, "origin");
      createGitRepo(originRepo);
      const worktreePath = path.join(env.root, "orphan-recent-wt");
      runGit(["worktree", "add", "--detach", worktreePath, "main"], originRepo);
      const runId = crypto.randomUUID();
      // Seed worktree row but NO runs row — set created_at to 2 days ago
      seedWorktreeRow(dbPath, runId, { worktreePath, originRepo, originRef: "main" });
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE run_worktrees SET created_at = datetime('now', '-2 days') WHERE run_id = ?").run(runId);
      db.close();
      // Use 1m threshold — 2-day-old worktree will definitely pass
      const { stdout, code } = await runCliToExit(
        ["worktree", "prune", "--completed", "--older-than", "1m"], cliEnv(env));
      assert.equal(code, 0);
      assert.match(stdout, /Pruned orphaned worktree/);
      assert.match(stdout, /no runs row/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("prunes failed-run worktree older than threshold", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      initDb(dbPath);
      const originRepo = path.join(env.root, "origin");
      createGitRepo(originRepo);
      const worktreePath = path.join(env.root, "failed-old-wt");
      runGit(["worktree", "add", "--detach", worktreePath, "main"], originRepo);
      const runId = crypto.randomUUID();
      seedRunRow(dbPath, runId, { status: "failed" });
      seedWorktreeRow(dbPath, runId, { worktreePath, originRepo, originRef: "main" });
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE run_worktrees SET created_at = datetime('now', '-30 days') WHERE run_id = ?").run(runId);
      db.close();
      const { stdout, code } = await runCliToExit(
        ["worktree", "prune", "--completed", "--older-than", "7d"], cliEnv(env));
      assert.equal(code, 0);
      assert.match(stdout, /Pruned worktree/);
      assert.match(stdout, /\(failed\)/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("skips failed-run worktree newer than threshold (rugpull safety)", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      initDb(dbPath);
      const originRepo = path.join(env.root, "origin");
      createGitRepo(originRepo);
      const worktreePath = path.join(env.root, "failed-new-wt");
      runGit(["worktree", "add", "--detach", worktreePath, "main"], originRepo);
      const runId = crypto.randomUUID();
      seedRunRow(dbPath, runId, { status: "failed" });
      seedWorktreeRow(dbPath, runId, { worktreePath, originRepo, originRef: "main" });
      const { stdout, code } = await runCliToExit(
        ["worktree", "prune", "--completed", "--older-than", "7d"], cliEnv(env));
      assert.equal(code, 0);
      assert.match(stdout, /No worktrees to prune/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("prunes failed-run worktree with short --older-than", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      initDb(dbPath);
      const originRepo = path.join(env.root, "origin");
      createGitRepo(originRepo);
      const worktreePath = path.join(env.root, "failed-short-wt");
      runGit(["worktree", "add", "--detach", worktreePath, "main"], originRepo);
      const runId = crypto.randomUUID();
      seedRunRow(dbPath, runId, { status: "failed" });
      seedWorktreeRow(dbPath, runId, { worktreePath, originRepo, originRef: "main" });
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE run_worktrees SET created_at = datetime('now', '-2 days') WHERE run_id = ?").run(runId);
      db.close();
      const { stdout, code } = await runCliToExit(
        ["worktree", "prune", "--completed", "--older-than", "1m"], cliEnv(env));
      assert.equal(code, 0);
      assert.match(stdout, /Pruned worktree/);
      assert.match(stdout, /\(failed\)/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("CLI parseDuration", () => {
  it("rejects invalid duration format via prune", async () => {
    const env = await createTempEnv();
    try {
      initDb(path.join(env.tamanduaDir, "tamandua.db"));
      const { stderr, code } = await runCliToExit(
        ["worktree", "prune", "--completed", "--older-than", "invalid"], cliEnv(env));
      assert.equal(code, 1);
      assert.match(stderr, /Invalid duration format/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("CLI handlers surface operational errors instead of masking them as not-found", () => {
  it("workflow status surfaces SQLite errors instead of No run found matching", async () => {
    const env = await createTempEnv();
    try {
      // Write garbage into the DB file so SQLite throws an operational error
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, "not a valid database", "utf-8");

      const { stdout, code } = await runCliToExit(
        ["workflow", "status", "some-query"], cliEnv(env));
      // Must NOT mask the operational error as "No run found matching"
      assert.doesNotMatch(stdout, /No run found matching/);
      // The actual SQLite error message should be surfaced
      assert.match(stdout, /not a database|malformed|database disk image/i);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("worktree status surfaces operational errors instead of No run found matching", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, "not a valid database", "utf-8");

      const { stderr, code } = await runCliToExit(
        ["worktree", "status", "some-run-id"], cliEnv(env));
      assert.equal(code, 1);
      // Must NOT mask the operational error as "No run found matching"
      assert.doesNotMatch(stderr, /No run found matching/);
      // The actual SQLite error message should be surfaced
      assert.match(stderr, /not a database|malformed|database disk image/i);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("worktree remove surfaces operational errors instead of No run found matching", async () => {
    const env = await createTempEnv();
    try {
      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, "not a valid database", "utf-8");

      const { stderr, code } = await runCliToExit(
        ["worktree", "remove", "some-run-id"], cliEnv(env));
      assert.equal(code, 1);
      // Must NOT mask the operational error as "No run found matching"
      assert.doesNotMatch(stderr, /No run found matching/);
      // The actual SQLite error message should be surfaced
      assert.match(stderr, /not a database|malformed|database disk image/i);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("workflow status still prints not-found for genuinely missing runs", async () => {
    const env = await createTempEnv();
    try {
      initDb(path.join(env.tamanduaDir, "tamandua.db"));
      const { stdout } = await runCliToExit(
        ["workflow", "status", "nonexistent-run-query"], cliEnv(env));
      assert.match(stdout, /No run found matching/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("worktree status still prints not-found for genuinely missing runs", async () => {
    const env = await createTempEnv();
    try {
      initDb(path.join(env.tamanduaDir, "tamandua.db"));
      const { stderr, code } = await runCliToExit(
        ["worktree", "status", "nonexistent-run"], cliEnv(env));
      assert.equal(code, 1);
      assert.match(stderr, /No run found matching/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });

  it("worktree remove still prints not-found for genuinely missing runs", async () => {
    const env = await createTempEnv();
    try {
      initDb(path.join(env.tamanduaDir, "tamandua.db"));
      const { stderr, code } = await runCliToExit(
        ["worktree", "remove", "nonexistent-run"], cliEnv(env));
      assert.equal(code, 1);
      assert.match(stderr, /No run found matching/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("CLI printUsage includes worktree commands", () => {
  it("shows worktree subcommands in --help output", async () => {
    const env = await createTempEnv();
    try {
      const { stdout } = await runCliToExit([], cliEnv(env));
      assert.match(stdout, /tamandua worktree list/);
      assert.match(stdout, /tamandua worktree status/);
      assert.match(stdout, /tamandua worktree remove/);
      assert.match(stdout, /tamandua worktree prune/);
      assert.match(stdout, /--worktree-origin-repository/);
      assert.match(stdout, /--worktree-origin-ref/);
    } finally {
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch {}
    }
  });
});
