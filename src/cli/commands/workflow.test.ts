import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";

import {
  getWorkflowAutoresearchHelp,
  getWorkflowDeleteHelp,
  getWorkflowFailHelp,
  getWorkflowGroupHelp,
  getWorkflowInstallHelp,
  getWorkflowListHelp,
  getWorkflowPauseAllHelp,
  getWorkflowPauseHelp,
  getWorkflowResumeAllHelp,
  getWorkflowResumeHelp,
  getWorkflowRunHelp,
  getWorkflowRunsHelp,
  getWorkflowStatusHelp,
  getWorkflowStopHelp,
  getWorkflowUninstallHelp,
  handleWorkflow,
} from "../../../dist/cli/commands/workflow.js";

class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.name = "ExitError";
    this.code = code;
  }
}

function mockProcessExit() {
  const origExit = process.exit;
  let exitCode = 0;
  (process.exit as unknown) = (code: number) => {
    exitCode = code;
    throw new ExitError(code);
  };
  return {
    getExitCode: () => exitCode,
    restore: () => { process.exit = origExit; },
  };
}

function setupTempDb(): { db: DatabaseSync; dbPath: string; tempDir: string } {
  const tempDir = tamanduaTempDir("tamandua-workflow-test-");
  const dbPath = join(tempDir, ".tamandua", "tamandua.db");

  mkdirSync(join(tempDir, ".tamandua"), { recursive: true });
  const db = new DatabaseSync(dbPath);
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
    run_number INTEGER,
    scheduling_status TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL DEFAULT 'dev',
    agent_id TEXT NOT NULL DEFAULT 'test-agent',
    step_index INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running',
    expects TEXT NOT NULL DEFAULT '',
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 4,
    type TEXT NOT NULL DEFAULT 'single',
    current_story_id TEXT,
    output TEXT,
    abandoned_count INTEGER DEFAULT 0,
    reroute_count INTEGER DEFAULT 0,
    claim_pid INTEGER,
    claim_updated_at TEXT,
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

  return { db, dbPath, tempDir };
}

describe("SPL2 workflow command module", () => {
  it("is backed by a reachable workflow command source module", () => {
    assert.equal(existsSync(join(process.cwd(), "src/cli/commands/workflow.ts")), true);
    const dispatcher = readFileSync(join(process.cwd(), "src/cli/cli.ts"), "utf8");
    assert.match(dispatcher, /from "\.\/commands\/workflow\.js"/);
  });

  it("owns the workflow group and every action help route", () => {
    assert.match(getWorkflowGroupHelp(), /Manage workflows and runs/);
    assert.match(getWorkflowListHelp(), /List available bundled workflows/);
    assert.match(getWorkflowListHelp(), /\[worktree\]/);
    assert.match(getWorkflowListHelp(), /\[direct\]/);
    assert.match(getWorkflowRunsHelp(), /List all workflow runs/);
    assert.match(getWorkflowInstallHelp(), /Install a specific workflow/);
    assert.match(getWorkflowUninstallHelp(), /Uninstall one or all workflows/);
    assert.match(getWorkflowRunHelp(), /Start a new workflow run/);
    assert.match(getWorkflowRunHelp(), /--task-file/);
    assert.match(getWorkflowStatusHelp(), /Show detailed run status/);
    assert.match(getWorkflowStatusHelp(), /red-ledger landing/i);
    assert.match(getWorkflowAutoresearchHelp(), /Show AutoResearch progress/);
    assert.match(getWorkflowDeleteHelp(), /Permanently delete a workflow run/);
    assert.match(getWorkflowStopHelp(), /Cancel a running workflow/);
    assert.match(getWorkflowPauseHelp(), /Pause a running workflow/);
    assert.match(getWorkflowResumeHelp(), /Resume a paused or failed workflow run/);
    assert.match(getWorkflowPauseAllHelp(), /Pause all running workflows/);
    assert.match(getWorkflowResumeAllHelp(), /Resume all paused workflows/);
    assert.match(getWorkflowFailHelp(), /Force a running or paused run to failed status/);
    assert.match(getWorkflowFailHelp(), /--reason/);
    assert.match(getWorkflowFailHelp(), /--force/);
  });

  it("preserves the exact workflow group help text", () => {
    assert.equal(getWorkflowGroupHelp(), `tamandua workflow — Manage workflows and runs

Usage: tamandua workflow <list|runs|install|uninstall|run|status|autoresearch|stop|delete|wait|pause|resume|pause-all|resume-all|fail>

Commands for managing Tamandua workflows and their runs.

Subcommands:
  list        List available bundled workflows
  runs        List all workflow runs with status, tokens, task preview
  install     Install a specific workflow by name
  uninstall   Uninstall a workflow (--all for all workflows, --force to skip
              active-runs check)
  run         Start a new workflow run with the given task
  status      Show detailed run status with step listing
  autoresearch
              Show AutoResearch progress for a run
  stop        Cancel a running workflow
  delete      Permanently delete a run and all its data (--force for active runs)
  wait        Block until workflow runs reach terminal status
  pause       Pause a running workflow via the daemon
  resume      Resume a paused or failed workflow run
  pause-all   Pause all running workflows
  resume-all  Resume all paused workflows
  fail        Force a running or paused run to failed status

Examples:
  tamandua workflow list
  tamandua workflow runs
  tamandua workflow install feature-dev-merge
  tamandua workflow run feature-dev-merge "Add a new feature"
  tamandua workflow status run-abc12345
  tamandua workflow autoresearch run-abc12345
  tamandua workflow wait run-abc12345
  tamandua workflow pause run-abc12345 --drain
  tamandua workflow fail run-abc12345 --reason "Stuck run"`);
  });

  it("declines commands owned by other command groups", async () => {
    assert.equal(await handleWorkflow("worktree", ["worktree", "list"], () => {}), false);
  });

  // ══════════════════════════════════════════════════════════════════
  // US-004: Accept both prefixed and bare run ids in workflow subcommands
  // ══════════════════════════════════════════════════════════════════

  describe("US-004: wrong-prefix detection (step-prefixed ids to run commands)", () => {
    it("workflow status step-<uuid> fails with wrong-prefix error", async () => {
      const stepId = crypto.randomUUID();

      const { getExitCode, restore } = mockProcessExit();
      let stderrOutput = "";
      const origStderr = process.stderr.write;
      (process.stderr as { write: typeof process.stderr.write }).write = (chunk: any, ...rest: any[]) => {
        stderrOutput += String(chunk);
        return true;
      };
      try {
        await handleWorkflow("workflow", ["workflow", "status", `step-${stepId}`], () => {});
      } catch (e) {
        if (!(e instanceof ExitError)) throw e;
      } finally {
        restore();
        (process.stderr as { write: typeof process.stderr.write }).write = origStderr;
      }

      assert.equal(getExitCode(), 1);
      assert.match(stderrOutput, /step id/);
      assert.match(stderrOutput, /run id/);
    });

    it("workflow stop step-<uuid> fails with wrong-prefix error", async () => {
      const stepId = crypto.randomUUID();

      const { getExitCode, restore } = mockProcessExit();
      let stderrOutput = "";
      const origStderr = process.stderr.write;
      (process.stderr as { write: typeof process.stderr.write }).write = (chunk: any, ...rest: any[]) => {
        stderrOutput += String(chunk);
        return true;
      };
      try {
        await handleWorkflow("workflow", ["workflow", "stop", `step-${stepId}`], () => {});
      } catch (e) {
        if (!(e instanceof ExitError)) throw e;
      } finally {
        restore();
        (process.stderr as { write: typeof process.stderr.write }).write = origStderr;
      }

      assert.equal(getExitCode(), 1);
      assert.match(stderrOutput, /step id/);
      assert.match(stderrOutput, /run id/);
    });

    it("workflow pause step-<uuid> fails with wrong-prefix error", async () => {
      const stepId = crypto.randomUUID();

      const { getExitCode, restore } = mockProcessExit();
      let stderrOutput = "";
      const origStderr = process.stderr.write;
      (process.stderr as { write: typeof process.stderr.write }).write = (chunk: any, ...rest: any[]) => {
        stderrOutput += String(chunk);
        return true;
      };
      try {
        await handleWorkflow("workflow", ["workflow", "pause", `step-${stepId}`], () => {});
      } catch (e) {
        if (!(e instanceof ExitError)) throw e;
      } finally {
        restore();
        (process.stderr as { write: typeof process.stderr.write }).write = origStderr;
      }

      assert.equal(getExitCode(), 1);
      assert.match(stderrOutput, /step id/);
      assert.match(stderrOutput, /run id/);
    });

    it("workflow resume step-<uuid> fails with wrong-prefix error", async () => {
      const stepId = crypto.randomUUID();

      const { getExitCode, restore } = mockProcessExit();
      let stderrOutput = "";
      const origStderr = process.stderr.write;
      (process.stderr as { write: typeof process.stderr.write }).write = (chunk: any, ...rest: any[]) => {
        stderrOutput += String(chunk);
        return true;
      };
      try {
        await handleWorkflow("workflow", ["workflow", "resume", `step-${stepId}`], () => {});
      } catch (e) {
        if (!(e instanceof ExitError)) throw e;
      } finally {
        restore();
        (process.stderr as { write: typeof process.stderr.write }).write = origStderr;
      }

      assert.equal(getExitCode(), 1);
      assert.match(stderrOutput, /step id/);
      assert.match(stderrOutput, /run id/);
    });

    it("workflow delete step-<uuid> fails with wrong-prefix error", async () => {
      const stepId = crypto.randomUUID();

      const { getExitCode, restore } = mockProcessExit();
      let stderrOutput = "";
      const origStderr = process.stderr.write;
      (process.stderr as { write: typeof process.stderr.write }).write = (chunk: any, ...rest: any[]) => {
        stderrOutput += String(chunk);
        return true;
      };
      try {
        await handleWorkflow("workflow", ["workflow", "delete", `step-${stepId}`], () => {});
      } catch (e) {
        if (!(e instanceof ExitError)) throw e;
      } finally {
        restore();
        (process.stderr as { write: typeof process.stderr.write }).write = origStderr;
      }

      assert.equal(getExitCode(), 1);
      assert.match(stderrOutput, /step id/);
      assert.match(stderrOutput, /run id/);
    });

    it("workflow fail step-<uuid> fails with wrong-prefix error", async () => {
      const stepId = crypto.randomUUID();

      const { getExitCode, restore } = mockProcessExit();
      let stderrOutput = "";
      const origStderr = process.stderr.write;
      (process.stderr as { write: typeof process.stderr.write }).write = (chunk: any, ...rest: any[]) => {
        stderrOutput += String(chunk);
        return true;
      };
      try {
        await handleWorkflow("workflow", ["workflow", "fail", `step-${stepId}`, "--reason", "test"], () => {});
      } catch (e) {
        if (!(e instanceof ExitError)) throw e;
      } finally {
        restore();
        (process.stderr as { write: typeof process.stderr.write }).write = origStderr;
      }

      assert.equal(getExitCode(), 1);
      assert.match(stderrOutput, /step id/);
      assert.match(stderrOutput, /run id/);
    });

    it("workflow autoresearch step-<uuid> fails with wrong-prefix error", async () => {
      const stepId = crypto.randomUUID();

      const { getExitCode, restore } = mockProcessExit();
      let stderrOutput = "";
      const origStderr = process.stderr.write;
      (process.stderr as { write: typeof process.stderr.write }).write = (chunk: any, ...rest: any[]) => {
        stderrOutput += String(chunk);
        return true;
      };
      try {
        await handleWorkflow("workflow", ["workflow", "autoresearch", `step-${stepId}`], () => {});
      } catch (e) {
        if (!(e instanceof ExitError)) throw e;
      } finally {
        restore();
        (process.stderr as { write: typeof process.stderr.write }).write = origStderr;
      }

      assert.equal(getExitCode(), 1);
      assert.match(stderrOutput, /step id/);
      assert.match(stderrOutput, /run id/);
    });
  });

  describe("US-004: prefixed and bare run-id acceptance (in-process with temp DB)", () => {
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

      const setup = setupTempDb();
      tempDir = setup.tempDir;
      dbPath = setup.dbPath;
      db = setup.db;

      process.env.TAMANDUA_DB_PATH = dbPath;
      process.env.HOME = tempDir;
      process.env.TAMANDUA_STATE_DIR = join(tempDir, ".tamandua");
    });

    afterEach(() => {
      if (originalDbPath) process.env.TAMANDUA_DB_PATH = originalDbPath;
      else delete process.env.TAMANDUA_DB_PATH;
      if (originalHome) process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (originalStateDir) process.env.TAMANDUA_STATE_DIR = originalStateDir;
      else delete process.env.TAMANDUA_STATE_DIR;

      db.close();
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it("getWorkflowStatus accepts run-<uuid> prefixed id", async () => {
      const runId = crypto.randomUUID();
      db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);

      const { getWorkflowStatus } = await import("../../../dist/installer/status.js");
      const detail = getWorkflowStatus(`run-${runId}`);
      assert.equal(detail.id, runId);
    });

    it("getWorkflowStatus accepts bare uuid (backward compat)", async () => {
      const runId = crypto.randomUUID();
      db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);

      const { getWorkflowStatus } = await import("../../../dist/installer/status.js");
      const detail = getWorkflowStatus(runId);
      assert.equal(detail.id, runId);
    });

    it("getWorkflowStatus accepts run-<prefix> prefix match", async () => {
      const runId = crypto.randomUUID();
      db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);

      const prefix = runId.slice(0, 8);
      const { getWorkflowStatus } = await import("../../../dist/installer/status.js");
      const detail = getWorkflowStatus(`run-${prefix}`);
      assert.equal(detail.id, runId);
    });

    it("getWorkflowStatus with bare prefix match still works", async () => {
      const runId = crypto.randomUUID();
      db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);

      const prefix = runId.slice(0, 8);
      const { getWorkflowStatus } = await import("../../../dist/installer/status.js");
      const detail = getWorkflowStatus(prefix);
      assert.equal(detail.id, runId);
    });
  });

  describe("US-004: displayStatus in --json output (in-process with temp DB)", () => {
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

      const setup = setupTempDb();
      tempDir = setup.tempDir;
      dbPath = setup.dbPath;
      db = setup.db;

      process.env.TAMANDUA_DB_PATH = dbPath;
      process.env.HOME = tempDir;
      process.env.TAMANDUA_STATE_DIR = join(tempDir, ".tamandua");
    });

    afterEach(() => {
      if (originalDbPath) process.env.TAMANDUA_DB_PATH = originalDbPath;
      else delete process.env.TAMANDUA_DB_PATH;
      if (originalHome) process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (originalStateDir) process.env.TAMANDUA_STATE_DIR = originalStateDir;
      else delete process.env.TAMANDUA_STATE_DIR;

      db.close();
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it("parked loop step has status=running AND displayStatus=verifying", async () => {
      const runId = crypto.randomUUID();
      db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
      db.prepare(`INSERT INTO steps (id, run_id, step_id, agent_id, status, type, current_story_id, step_index)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(crypto.randomUUID(), runId, 'dev', 'test_developer', 'running', 'loop', null, 0);

      const { getWorkflowStatus } = await import("../../../dist/installer/status.js");
      const detail = getWorkflowStatus(`run-${runId}`);
      const step = detail.steps[0];
      assert.equal(step.status, "running", "raw status must be running (invariant)");
      assert.equal(step.displayStatus, "verifying", "displayStatus must be verifying for parked loop");
      assert.equal(step.currentStoryId, null);
    });

    it("active loop step has status=running AND displayStatus=running", async () => {
      const runId = crypto.randomUUID();
      const storyId = "story-001";
      db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
      db.prepare(`INSERT INTO steps (id, run_id, step_id, agent_id, status, type, current_story_id, step_index)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(crypto.randomUUID(), runId, 'dev', 'test_developer', 'running', 'loop', storyId, 0);

      const { getWorkflowStatus } = await import("../../../dist/installer/status.js");
      const detail = getWorkflowStatus(`run-${runId}`);
      const step = detail.steps[0];
      assert.equal(step.status, "running");
      assert.equal(step.displayStatus, "running", "active loop must display as running");
    });

    it("non-loop step has displayStatus equal to raw status", async () => {
      const runId = crypto.randomUUID();
      db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
      db.prepare(`INSERT INTO steps (id, run_id, step_id, agent_id, status, type, step_index)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(crypto.randomUUID(), runId, 'dev', 'test_developer', 'failed', 'single', 0);

      const { getWorkflowStatus } = await import("../../../dist/installer/status.js");
      const detail = getWorkflowStatus(`run-${runId}`);
      const step = detail.steps[0];
      assert.equal(step.status, "failed");
      assert.equal(step.displayStatus, "failed", "non-loop displayStatus must equal raw status");
    });
  });

  describe("US-002: harness display in workflow status (in-process with temp DB)", () => {
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

      const setup = setupTempDb();
      tempDir = setup.tempDir;
      dbPath = setup.dbPath;
      db = setup.db;

      process.env.TAMANDUA_DB_PATH = dbPath;
      process.env.HOME = tempDir;
      process.env.TAMANDUA_STATE_DIR = join(tempDir, ".tamandua");
    });

    afterEach(() => {
      if (originalDbPath) process.env.TAMANDUA_DB_PATH = originalDbPath;
      else delete process.env.TAMANDUA_DB_PATH;
      if (originalHome) process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (originalStateDir) process.env.TAMANDUA_STATE_DIR = originalStateDir;
      else delete process.env.TAMANDUA_STATE_DIR;

      db.close();
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    function seedRun(runId: string, harnessType?: string): void {
      const context = harnessType ? JSON.stringify({ harness_type: harnessType }) : "{}";
      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context) VALUES (?, 'test', 'task', 'running', ?)",
      ).run(runId, context);
    }

    async function captureStatusOutput(runId: string, extraArgs: string[] = []): Promise<string> {
      let output = "";
      const origLog = console.log;
      console.log = (...chunks: unknown[]) => {
        output += chunks.map((c) => String(c)).join(" ") + "\n";
      };
      try {
        await handleWorkflow("workflow", ["workflow", "status", runId, ...extraArgs], () => {});
      } finally {
        console.log = origLog;
      }
      return output;
    }

    it("getWorkflowStatus exposes harnessType 'dsh' from context", async () => {
      const runId = crypto.randomUUID();
      seedRun(runId, "dsh");

      const { getWorkflowStatus } = await import("../../../dist/installer/status.js");
      const detail = getWorkflowStatus(`run-${runId}`);
      assert.equal(detail.harnessType, "dsh");
    });

    it("getWorkflowStatus defaults harnessType to 'pi' when context omits it", async () => {
      const runId = crypto.randomUUID();
      seedRun(runId);

      const { getWorkflowStatus } = await import("../../../dist/installer/status.js");
      const detail = getWorkflowStatus(`run-${runId}`);
      assert.equal(detail.harnessType, "pi");
    });

    it("workflow status text output carries the alpha label for dsh runs", async () => {
      const runId = crypto.randomUUID();
      seedRun(runId, "dsh");

      const output = await captureStatusOutput(runId);
      assert.match(output, /Harness: dsh \(alpha\)/);
    });

    it("workflow status text output shows plain harness for hermes runs", async () => {
      const runId = crypto.randomUUID();
      seedRun(runId, "hermes");

      const output = await captureStatusOutput(runId);
      assert.match(output, /Harness: hermes/);
      assert.doesNotMatch(output, /alpha/);
    });

    it("workflow status text output omits the Harness line for pi runs", async () => {
      const runId = crypto.randomUUID();
      seedRun(runId, "pi");

      const output = await captureStatusOutput(runId);
      assert.doesNotMatch(output, /Harness:/);
    });

    it("workflow status --json includes harnessType", async () => {
      const runId = crypto.randomUUID();
      seedRun(runId, "dsh");

      const output = await captureStatusOutput(runId, ["--json"]);
      const parsed = JSON.parse(output.trim());
      assert.equal(parsed.harnessType, "dsh");
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // WLST5: split round-termination counters surface
  // ══════════════════════════════════════════════════════════════════
  // worker_lost_count (wl:) counts harness_lost only; ceiling_expiry_count
  // (ce:) counts rounds the motor killed at the worker time ceiling. Both
  // are additive display fields.

  describe("WLST5: split counters display (in-process with temp DB)", () => {
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

      const setup = setupTempDb();
      tempDir = setup.tempDir;
      dbPath = setup.dbPath;
      db = setup.db;

      process.env.TAMANDUA_DB_PATH = dbPath;
      process.env.HOME = tempDir;
      process.env.TAMANDUA_STATE_DIR = join(tempDir, ".tamandua");
    });

    afterEach(() => {
      if (originalDbPath) process.env.TAMANDUA_DB_PATH = originalDbPath;
      else delete process.env.TAMANDUA_DB_PATH;
      if (originalHome) process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (originalStateDir) process.env.TAMANDUA_STATE_DIR = originalStateDir;
      else delete process.env.TAMANDUA_STATE_DIR;

      db.close();
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    function seedRun(runId: string, workerLost: number, ceilingExpiry: number): void {
      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, worker_lost_count, ceiling_expiry_count) VALUES (?, 'test', 'task', 'completed', '{}', 10, ?, ?)",
      ).run(runId, workerLost, ceilingExpiry);
    }

    async function captureOutput(args: string[]): Promise<string> {
      let output = "";
      const origLog = console.log;
      console.log = (...chunks: unknown[]) => {
        output += chunks.map((c) => String(c)).join(" ") + "\n";
      };
      try {
        await handleWorkflow("workflow", args, () => {});
      } finally {
        console.log = origLog;
      }
      return output;
    }

    it("workflow status text shows Rounds expired at ceiling and Worker lost separately", async () => {
      const runId = crypto.randomUUID();
      seedRun(runId, 2, 3);

      const output = await captureOutput(["workflow", "status", runId]);
      assert.match(output, /Rounds expired at ceiling: 3/);
      assert.match(output, /Worker lost: 2/);
    });

    it("workflow runs compact list shows wl: only for harness_lost and ce: for ceiling expiries", async () => {
      const runId = crypto.randomUUID();
      seedRun(runId, 1, 4);

      const output = await captureOutput(["workflow", "runs"]);
      assert.match(output, /wl:1/);
      assert.match(output, /ce:4/);
    });

    it("workflow runs compact list shows only wl: when ceiling_expiry_count is zero", async () => {
      const runId = crypto.randomUUID();
      seedRun(runId, 2, 0);

      const output = await captureOutput(["workflow", "runs"]);
      assert.match(output, /wl:2/);
      assert.doesNotMatch(output, /ce:/);
    });

    it("workflow status omits both counter lines when both counters are zero", async () => {
      const runId = crypto.randomUUID();
      seedRun(runId, 0, 0);

      const output = await captureOutput(["workflow", "status", runId]);
      assert.doesNotMatch(output, /Rounds expired at ceiling/);
      assert.doesNotMatch(output, /Worker lost/);
    });
  });
});
