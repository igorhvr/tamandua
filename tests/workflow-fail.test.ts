/**
 * US-005: workflow fail CLI command.
 */

import { describe, it } from "node:test";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_SCRIPT = path.resolve(__dirname, "..", "dist", "cli", "cli.js");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCli(args: string[], homeDir: string, stateDir: string): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("node", ["--no-warnings", CLI_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanChildEnv({
        HOME: homeDir,
        TAMANDUA_STATE_DIR: stateDir,
      }),
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.once("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function readRunEvents(stateDir: string, runId: string): any[] {
  const eventsDir = path.join(stateDir, "events");
  const filePath = path.join(eventsDir, `${runId}.jsonl`);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function setupDbWithRun(
  stateDir: string,
  opts?: { status?: string; runNumber?: number },
): { runId: string; homeDir: string; tamanduaDir: string; root: string } {
  const th = createTempHome("tamandua-wf-fail-");
  const statePath = stateDir || th.tamanduaDir;
  const dbPath = path.join(statePath, "tamandua.db");

  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL DEFAULT 'test-workflow',
      task TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'running',
      notify_url TEXT,
      scheduling_status TEXT,
      scheduling_requested_at TEXT,
      scheduling_error TEXT,
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      worker_lost_count INTEGER NOT NULL DEFAULT 0,
      author_role TEXT NOT NULL DEFAULT 'write',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      input_template TEXT NOT NULL,
      expects TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'waiting',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      type TEXT NOT NULL DEFAULT 'single',
      loop_config TEXT,
      current_story_id TEXT,
      abandoned_count INTEGER DEFAULT 0,
      claim_job_id TEXT,
      claim_pid INTEGER,
      claim_pgid INTEGER,
      claim_updated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  const status = opts?.status ?? "running";
  const runNumber = opts?.runNumber ?? 42;

  db.prepare(
    "INSERT INTO runs (id, run_number, workflow_id, task, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, runNumber, "test-workflow", "test task", "{}", status, now, now);

  db.close();

  return { runId, homeDir: th.homeDir, tamanduaDir: th.tamanduaDir, root: th.root };
}

function insertStep(
  stateDir: string,
  stepId: string,
  runId: string,
  agentId: string,
  stepIndex: number,
  status: string,
  opts?: { claimPid?: number; claimPgid?: number },
): void {
  const dbPath = path.join(stateDir, "tamandua.db");
  const db = new DatabaseSync(dbPath);

  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, status,
       claim_pid, claim_pgid, claim_updated_at, retry_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    stepId,
    runId,
    `dev-${stepIndex}`,
    agentId,
    stepIndex,
    "test input",
    status,
    opts?.claimPid ?? null,
    opts?.claimPgid ?? null,
    opts ? now : null,
    0,
    now,
    now,
  );

  db.close();
}

describe("US-005: workflow fail CLI command", () => {
  describe("forceFailRun backend", () => {
    it("force-fails a running run and emits run.force_failed event", async () => {
      const th = createTempHome("tamandua-ff-back-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      try {
        const { forceFailRun } = await import("../dist/installer/status.js");
        const result = await forceFailRun(runId, "Test force-fail reason");
        assert.ok(result.ok, "should succeed");
        assert.equal(result.status, "failed");
        assert.equal(result.reason, "Test force-fail reason");

        const db = new DatabaseSync(path.join(stateDir, "tamandua.db"));
        const run = db.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as any;
        db.close();

        assert.equal(run.status, "failed");
        assert.equal(run.scheduling_status, null);

        const events = readRunEvents(stateDir, runId);
        const ffEvents = events.filter((e) => e.event === "run.force_failed");
        assert.equal(ffEvents.length, 1);
        assert.equal(ffEvents[0].detail, "Test force-fail reason");
        assert.equal(ffEvents[0].runId, runId);
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });

    it("cancels pending/waiting/running steps", async () => {
      const th = createTempHome("tamandua-ff-steps-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepPending = crypto.randomUUID();
      const stepRunning = crypto.randomUUID();
      const stepDone = crypto.randomUUID();
      insertStep(stateDir, stepPending, runId, "agentA", 0, "pending");
      insertStep(stateDir, stepRunning, runId, "agentB", 1, "running", { claimPid: 99999 });
      insertStep(stateDir, stepDone, runId, "agentC", 2, "done");

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      try {
        const { forceFailRun } = await import("../dist/installer/status.js");
        await forceFailRun(runId, "Cancelling steps");

        const db = new DatabaseSync(path.join(stateDir, "tamandua.db"));
        const s1 = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepPending) as any;
        const s2 = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepRunning) as any;
        const s3 = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDone) as any;
        db.close();

        assert.equal(s1.status, "canceled");
        assert.equal(s2.status, "canceled");
        assert.equal(s3.status, "done", "already-done steps should not be changed");
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });

    it("refuses to force-fail a completed run", async () => {
      const th = createTempHome("tamandua-ff-completed-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir, { status: "completed" });

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      try {
        const { forceFailRun } = await import("../dist/installer/status.js");
        await assert.rejects(
          () => forceFailRun(runId, "Should fail"),
          /already completed/,
        );
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });

    it("refuses to force-fail a canceled run", async () => {
      const th = createTempHome("tamandua-ff-canceled-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir, { status: "canceled" });

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      try {
        const { forceFailRun } = await import("../dist/installer/status.js");
        await assert.rejects(
          () => forceFailRun(runId, "Should fail"),
          /already canceled/,
        );
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });

    it("refuses with alive worker unless --force", async () => {
      const th = createTempHome("tamandua-ff-alive-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepId = crypto.randomUUID();
      insertStep(stateDir, stepId, runId, "agentX", 0, "running", {
        claimPid: process.pid,
      });

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      try {
        const { forceFailRun } = await import("../dist/installer/status.js");

        // Without force — should refuse
        const result = await forceFailRun(runId, "Has alive worker");
        assert.ok(!result.ok, "should refuse");
        assert.ok(result.reason!.includes("alive worker"), `reason: ${result.reason}`);
        assert.ok(result.aliveWorkers!.length > 0);
        assert.equal(result.aliveWorkers![0].pid, process.pid);

        // With force — should succeed
        const result2 = await forceFailRun(runId, "Has alive worker", true);
        assert.ok(result2.ok, "should succeed with --force");
        assert.equal(result2.status, "failed");
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });

    it("force-fails a paused run", async () => {
      const th = createTempHome("tamandua-ff-paused-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir, { status: "paused" });

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      try {
        const { forceFailRun } = await import("../dist/installer/status.js");
        const result = await forceFailRun(runId, "Paused run force-fail");
        assert.ok(result.ok);
        assert.equal(result.status, "failed");
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });
  });

  describe("CLI integration", () => {
    it("workflow fail --help prints help text", async () => {
      const th = createTempHome("tamandua-wff-help-");
      const result = await runCli(["workflow", "fail", "--help"], th.homeDir, th.tamanduaDir);
      assert.ok(result.stdout.includes("tamandua workflow fail"), `stdout: ${result.stdout}`);
      assert.ok(result.stdout.includes("--reason"), `stdout: ${result.stdout}`);
      assert.ok(result.stdout.includes("--force"), `stdout: ${result.stdout}`);
      assert.equal(result.exitCode, 0);
    });

    it("workflow fail with prefix run-id works", async () => {
      const th = createTempHome("tamandua-wff-prefix-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const result = await runCli(
        ["workflow", "fail", runId.slice(0, 8), "--reason", "Test prefix match"],
        th.homeDir,
        stateDir,
      );
      assert.equal(result.exitCode, 0, `exit: ${result.exitCode}, stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes("Force-failed"), `stdout: ${result.stdout}`);

      // Verify event was emitted
      const events = readRunEvents(stateDir, runId);
      const ffEvents = events.filter((e) => e.event === "run.force_failed");
      assert.equal(ffEvents.length, 1);
      assert.equal(ffEvents[0].detail, "Test prefix match");
    });

    it("workflow fail with #N run-id works", async () => {
      const th = createTempHome("tamandua-wff-hashn-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir, { runNumber: 99 });

      const result = await runCli(
        ["workflow", "fail", "#99", "--reason", "HashN test"],
        th.homeDir,
        stateDir,
      );
      assert.equal(result.exitCode, 0, `exit: ${result.exitCode}, stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes("Force-failed"), `stdout: ${result.stdout}`);
    });

    it("workflow fail with alive worker refuses via CLI", async () => {
      const th = createTempHome("tamandua-wff-alive-cli-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepId = crypto.randomUUID();
      insertStep(stateDir, stepId, runId, "agentZ", 0, "running", {
        claimPid: process.pid,
      });

      const result = await runCli(
        ["workflow", "fail", runId.slice(0, 8), "--reason", "Alive worker"],
        th.homeDir,
        stateDir,
      );
      assert.notEqual(result.exitCode, 0, "should exit non-zero");
      assert.ok(
        result.stderr.includes("alive worker") || result.stderr.includes(String(process.pid)),
        `stderr: ${result.stderr}`,
      );
    });

    it("workflow fail with alive worker + --force succeeds via CLI", async () => {
      const th = createTempHome("tamandua-wff-force-cli-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepId = crypto.randomUUID();
      insertStep(stateDir, stepId, runId, "agentF", 0, "running", {
        claimPid: process.pid,
      });

      const result = await runCli(
        ["workflow", "fail", runId.slice(0, 8), "--reason", "Force override", "--force"],
        th.homeDir,
        stateDir,
      );
      assert.equal(result.exitCode, 0, `exit: ${result.exitCode}, stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes("Force-failed"), `stdout: ${result.stdout}`);
    });

    it("workflow fail without --reason fails", async () => {
      const th = createTempHome("tamandua-wff-no-reason-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const result = await runCli(
        ["workflow", "fail", runId.slice(0, 8)],
        th.homeDir,
        stateDir,
      );
      assert.notEqual(result.exitCode, 0, "should exit non-zero");
      assert.ok(result.stderr.includes("--reason"), `stderr: ${result.stderr}`);
    });

    it("workflow fail on completed run fails", async () => {
      const th = createTempHome("tamandua-wff-completed-cli-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir, { status: "completed" });

      const result = await runCli(
        ["workflow", "fail", runId.slice(0, 8), "--reason", "Too late"],
        th.homeDir,
        stateDir,
      );
      assert.notEqual(result.exitCode, 0, "should exit non-zero");
      assert.ok(
        result.stderr.includes("already completed") || result.stderr.toLowerCase().includes("cannot force-fail"),
        `stderr: ${result.stderr}`,
      );
    });
  });
});
