import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { sweepRunProcesses } from "../../dist/installer/run-cleanup.js";
import type { RunCleanupResult } from "../../dist/installer/run-cleanup.js";
import { readEventsFromCursor, emitEvent, type TamanduaEvent } from "../../dist/installer/events.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";

// ── Helpers ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait until a child process exits, or resolve after a timeout.
 * Returns true if the process exited (killed), false if it timed out (still alive).
 */
function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Poll a process to see if it is still alive.
 */
function isAlive(pid: number): boolean {
  try {
    // Signal 0 just checks if we can send signals — doesn't actually send one
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe("run-cleanup", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;
  let originalDbPath: string | undefined;
  let originalTestGuard: string | undefined;
  let originalWorktreeRoot: string | undefined;

  // We spin up one fake worktree directory per test, plus marker processes.
  let fakeWorktreePath: string;
  let children: ChildProcess[];

  beforeEach(() => {
    // Full isolation
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    originalTestGuard = process.env.TAMANDUA_TEST_GUARD;
    originalWorktreeRoot = process.env.TAMANDUA_WORKTREE_ROOT;

    stateDir = tamanduaTempDir("tamandua-cleanup-");
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    process.env.TAMANDUA_TEST_GUARD = "1";
    process.env.TAMANDUA_WORKTREE_ROOT = path.join(stateDir, "worktrees");

    // Ensure we have a DB that emitEvent can use (events module resolves
    // the DB when firing webhooks — but for tests we just need state dir)
    const db = new DatabaseSync(process.env.TAMANDUA_DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT,
        status TEXT,
        notify_url TEXT,
        scheduling_status TEXT,
        updated_at TEXT
      );
    `);
    // Insert a lightweight run row so emitEvent doesn't error on webhook lookup
    db.prepare("INSERT OR REPLACE INTO runs (id, workflow_id, status) VALUES (?, ?, ?)").run(
      "test-run-001",
      "test-workflow",
      "running",
    );
    db.close();

    fakeWorktreePath = path.join(stateDir, "fake-worktree");
    fs.mkdirSync(fakeWorktreePath, { recursive: true });

    children = [];
  });

  afterEach(() => {
    // Restore env
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;
    if (originalDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = originalDbPath;
    if (originalTestGuard === undefined) delete process.env.TAMANDUA_TEST_GUARD;
    else process.env.TAMANDUA_TEST_GUARD = originalTestGuard;
    if (originalWorktreeRoot === undefined) delete process.env.TAMANDUA_WORKTREE_ROOT;
    else process.env.TAMANDUA_WORKTREE_ROOT = originalWorktreeRoot;

    // Kill all spawned children
    for (const child of children) {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      } catch {
        // already dead
      }
    }
    children.length = 0;

    // Clean up state directory
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  // ── Basic function shape ──────────────────────────────────────────

  it("sweepRunProcesses returns correct result shape", () => {
    const result = sweepRunProcesses("test-run-001", fakeWorktreePath);
    assert.ok(result, "should return a result");
    assert.equal(result.runId, "test-run-001");
    assert.equal(result.worktreePath, fakeWorktreePath);
    assert.ok(typeof result.scannedPids === "number");
    assert.ok(Array.isArray(result.killedPids));
    assert.ok(typeof result.evidence === "object");
  });

  // ── Skip-own-pid and skip-pid-1 ───────────────────────────────────

  it("never kills pid 1 or own pid", () => {
    const result = sweepRunProcesses("test-run-001", fakeWorktreePath);
    // pid 1 and our own pid should never appear in killedPids
    assert.ok(
      !result.killedPids.includes(1),
      "pid 1 must never be killed",
    );
    assert.ok(
      !result.killedPids.includes(process.pid),
      "our own pid must never be killed",
    );
  });

  // ── Daemon PID exclusion ─────────────────────────────────────────

  it("never kills the daemonPid when provided", () => {
    // Spawn a marker process inside the fake worktree with matching env
    // then pass that pid as daemonPid — it should survive.
    const markerCwd = path.join(fakeWorktreePath, "daemon-dir");
    fs.mkdirSync(markerCwd, { recursive: true });

    const child = spawn("sleep", ["30"], {
      cwd: markerCwd,
      env: {
        TAMANDUA_WORKER_JOB_ID: "tamandua-test-workflow-test-run-001_developer",
        PATH: process.env.PATH || "/usr/bin",
      },
      stdio: "ignore",
    });
    children.push(child);

    // Give it a moment to start
    return sleep(200).then(() => {
      const daemonPid = child.pid!;
      assert.ok(isAlive(daemonPid), "marker process should be alive before sweep");

      const result = sweepRunProcesses("test-run-001", fakeWorktreePath, {
        daemonPid,
      });

      // The daemonPid should NOT be in killedPids
      assert.ok(
        !result.killedPids.includes(daemonPid),
        `daemonPid ${daemonPid} must not be killed: killedPids=${JSON.stringify(result.killedPids)}`,
      );

      // Process should still be alive
      assert.ok(isAlive(daemonPid), "daemonPid process should still be alive after sweep");

      child.kill("SIGKILL");
    });
  });

  // ── Kill processes with cwd under worktree ───────────────────────

  it("kills processes whose cwd is under the worktree path", () => {
    const markerCwd = path.join(fakeWorktreePath, "subdir");
    fs.mkdirSync(markerCwd, { recursive: true });

    // Spawn a process with cwd inside the worktree, without any run env var
    const child = spawn("sleep", ["30"], {
      cwd: markerCwd,
      env: { PATH: process.env.PATH || "/usr/bin" },
      stdio: "ignore",
    });
    children.push(child);

    return sleep(200).then(async () => {
      const pid = child.pid!;
      assert.ok(isAlive(pid), "child should be alive before sweep");

      const result = sweepRunProcesses("test-run-001", fakeWorktreePath);
      assert.ok(
        result.killedPids.includes(pid),
        `pid ${pid} with cwd under worktree should be killed: killedPids=${JSON.stringify(result.killedPids)}`,
      );
      assert.ok(
        result.evidence[pid]?.includes("cwd under worktree"),
        `evidence should indicate cwd match: ${JSON.stringify(result.evidence[pid])}`,
      );

      const exited = await waitForExit(child, 2000);
      assert.ok(exited, "child should have exited after SIGKILL");
    });
  });

  // ── Kill processes with TAMANDUA_WORKER_JOB_ID containing runId ──

  // Environ-based evidence is procfs-only: the macOS kernel does not let
  // unprivileged callers read another process's environment, so the env
  // channels can never fire there (cwd + cmdline evidence carry the sweep).
  const environUnreadable =
    process.platform === "darwin" ? "environ evidence is unreadable on macOS" : false;

  it("kills processes with TAMANDUA_WORKER_JOB_ID containing runId", { skip: environUnreadable }, () => {
    // Use a CWD that is NOT under the worktree to isolate the env check
    const unrelatedCwd = path.join(stateDir, "unrelated");
    fs.mkdirSync(unrelatedCwd, { recursive: true });

    const child = spawn("sleep", ["30"], {
      cwd: unrelatedCwd,
      env: {
        TAMANDUA_WORKER_JOB_ID: "tamandua-test-workflow-test-run-001_developer",
        PATH: process.env.PATH || "/usr/bin",
      },
      stdio: "ignore",
    });
    children.push(child);

    return sleep(200).then(async () => {
      const pid = child.pid!;
      assert.ok(isAlive(pid), "child should be alive before sweep");

      const result = sweepRunProcesses("test-run-001", fakeWorktreePath);
      assert.ok(
        result.killedPids.includes(pid),
        `pid ${pid} with TAMANDUA_WORKER_JOB_ID should be killed: killedPids=${JSON.stringify(result.killedPids)}`,
      );
      assert.ok(
        result.evidence[pid]?.includes("TAMANDUA_WORKER_JOB_ID"),
        `evidence should indicate TAMANDUA_WORKER_JOB_ID match: ${JSON.stringify(result.evidence[pid])}`,
      );

      const exited = await waitForExit(child, 2000);
      assert.ok(exited, "child should have exited after SIGKILL");
    });
  });

  // ── Kill processes with environ containing worktreePath ──────────

  it("kills processes whose environ contains the worktree path string", { skip: environUnreadable }, () => {
    const unrelatedCwd = path.join(stateDir, "unrelated-env");
    fs.mkdirSync(unrelatedCwd, { recursive: true });

    const child = spawn("sleep", ["30"], {
      cwd: unrelatedCwd,
      env: {
        SOME_VAR: `path=${fakeWorktreePath}/data`,
        PATH: process.env.PATH || "/usr/bin",
      },
      stdio: "ignore",
    });
    children.push(child);

    return sleep(200).then(async () => {
      const pid = child.pid!;
      assert.ok(isAlive(pid), "child should be alive before sweep");

      const result = sweepRunProcesses("test-run-001", fakeWorktreePath);
      assert.ok(
        result.killedPids.includes(pid),
        `pid ${pid} with environ containing worktree path should be killed: killedPids=${JSON.stringify(result.killedPids)}`,
      );
      assert.ok(
        result.evidence[pid]?.includes("environ contains worktree path"),
        `evidence should indicate environ match: ${JSON.stringify(result.evidence[pid])}`,
      );

      const exited = await waitForExit(child, 2000);
      assert.ok(exited, "child should have exited after SIGKILL");
    });
  });

  // ── Kill processes whose command line names the run ──────────────

  it("kills processes whose command line contains the run id", () => {
    const unrelatedCwd = path.join(stateDir, "unrelated-cmdline");
    fs.mkdirSync(unrelatedCwd, { recursive: true });

    // The runId appears only in argv (harness children carry run/agent ids
    // in their prompt argv) — the primary evidence channel on macOS.
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)", "marker-test-run-001"],
      {
        cwd: unrelatedCwd,
        env: { PATH: process.env.PATH || "/usr/bin" },
        stdio: "ignore",
      },
    );
    children.push(child);

    return sleep(200).then(async () => {
      const pid = child.pid!;
      assert.ok(isAlive(pid), "child should be alive before sweep");

      const result = sweepRunProcesses("test-run-001", fakeWorktreePath);
      assert.ok(
        result.killedPids.includes(pid),
        `pid ${pid} with runId in argv should be killed: killedPids=${JSON.stringify(result.killedPids)}`,
      );
      assert.ok(
        result.evidence[pid]?.includes("cmdline contains runId"),
        `evidence should indicate cmdline match: ${JSON.stringify(result.evidence[pid])}`,
      );

      const exited = await waitForExit(child, 2000);
      assert.ok(exited, "child should have exited after SIGKILL");
    });
  });

  // ── Unmarked processes survive ───────────────────────────────────

  it("does not kill unmarked processes", () => {
    const unrelatedCwd = path.join(stateDir, "unmarked");
    fs.mkdirSync(unrelatedCwd, { recursive: true });

    const child = spawn("sleep", ["30"], {
      cwd: unrelatedCwd,
      env: { PATH: process.env.PATH || "/usr/bin" },
      stdio: "ignore",
    });
    children.push(child);

    return sleep(200).then(async () => {
      const pid = child.pid!;
      assert.ok(isAlive(pid), "unmarked child should be alive before sweep");

      const result = sweepRunProcesses("test-run-001", fakeWorktreePath);
      assert.ok(
        !result.killedPids.includes(pid),
        `unmarked pid ${pid} must not be killed: killedPids=${JSON.stringify(result.killedPids)}`,
      );

      assert.ok(isAlive(pid), "unmarked process should still be alive after sweep");
    });
  });

  // ── Event emission ───────────────────────────────────────────────

  it("emits a run.process_cleanup event after sweep", () => {
    const result = sweepRunProcesses("test-run-001", fakeWorktreePath);

    // Read the run-specific events file
    const runEventsFile = path.join(stateDir, "events", "test-run-001.jsonl");
    assert.ok(fs.existsSync(runEventsFile), "run events file should exist");

    const content = fs.readFileSync(runEventsFile, "utf-8");
    const lines = content.trim().split("\n");
    assert.ok(lines.length > 0, "should have at least one event");

    const lastEvent = JSON.parse(lines[lines.length - 1]) as TamanduaEvent;
    assert.equal(lastEvent.event, "run.process_cleanup");
    assert.equal(lastEvent.runId, "test-run-001");
    assert.ok(lastEvent.detail, "event detail should be populated");

    const detail = JSON.parse(lastEvent.detail!);
    assert.equal(detail.worktreePath, fakeWorktreePath);
    assert.ok(typeof detail.scannedPids === "number");
    assert.ok(Array.isArray(detail.killedPids));
  });

  // ── Graceful handling of missing /proc entries ───────────────────

  it("handles ENOENT from /proc entries gracefully", () => {
    // This is inherently tested by the sweep — any process that exits
    // between scanning procfs and reading per-pid procfs files will
    // trigger ENOENT, and the code must handle it without throwing.
    // We can also test with a guaranteed-non-existent PID.
    // The function iterates only over pids from readdir, so we can't
    // easily inject a fake PID. Instead, we rely on the fact that
    // reading from nonexistent pids is handled by processBelongsToRun
    // returning null.
    const result = sweepRunProcesses("test-run-999", "/nonexistent/path/for/test");
    assert.ok(result, "should return a result even with nonexistent worktree path");
    assert.equal(result.killedPids.length, 0, "should not find any matches with fake path");
    assert.ok(result.scannedPids >= 0, "should have scanned pids count");
  });

  // ── Multiple process sweep ───────────────────────────────────────

  it("kills multiple marked processes in one sweep", () => {
    const markerCwd = path.join(fakeWorktreePath, "multi");
    fs.mkdirSync(markerCwd, { recursive: true });

    const child1 = spawn("sleep", ["30"], {
      cwd: markerCwd,
      env: { PATH: process.env.PATH || "/usr/bin" },
      stdio: "ignore",
    });
    const child2 = spawn("sleep", ["30"], {
      cwd: markerCwd,
      env: {
        TAMANDUA_WORKER_JOB_ID: "tamandua-test-wf-test-run-001_verifier",
        PATH: process.env.PATH || "/usr/bin",
      },
      stdio: "ignore",
    });
    children.push(child1, child2);

    return sleep(300).then(async () => {
      assert.ok(isAlive(child1.pid!), "child1 should be alive");
      assert.ok(isAlive(child2.pid!), "child2 should be alive");

      const result = sweepRunProcesses("test-run-001", fakeWorktreePath);
      assert.equal(
        result.killedPids.length,
        2,
        `should kill 2 processes, killed: ${JSON.stringify(result.killedPids)}`,
      );
      assert.ok(result.killedPids.includes(child1.pid!));
      assert.ok(result.killedPids.includes(child2.pid!));

      const bothExited = await Promise.all([
        waitForExit(child1, 2000),
        waitForExit(child2, 2000),
      ]);
      assert.ok(bothExited[0], "child1 should have exited");
      assert.ok(bothExited[1], "child2 should have exited");
    });
  });
});
