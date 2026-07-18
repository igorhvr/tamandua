/**
 * US-004: step release CLI command.
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
  return content.split("\n").map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function setupDbWithRun(stateDir: string): { runId: string; homeDir: string; tamanduaDir: string; root: string } {
  const th = createTempHome("tamandua-release-");
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

    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      story_index INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const runId = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO runs (id, run_number, workflow_id, task, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(runId, 42, "test-workflow", "test task", "{}", "running", now, now);

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
  opts?: { claimPid?: number; claimPgid?: number; claimJobId?: string; retryCount?: number },
): void {
  const dbPath = path.join(stateDir, "tamandua.db");
  const db = new DatabaseSync(dbPath);

  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, status,
       claim_pid, claim_pgid, claim_job_id, claim_updated_at,
       retry_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    opts?.claimJobId ?? null,
    opts ? now : null,
    opts?.retryCount ?? 0,
    now,
    now,
  );

  db.close();
}

describe("US-004: step release CLI command", () => {
  describe("releaseStep backend", () => {
    it("releases a step with dead worker back to pending without retry bump", async () => {
      const th = createTempHome("tamandua-rel-back-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepId = crypto.randomUUID();
      insertStep(stateDir, stepId, runId, "agentX", 0, "running", {
        claimPid: 99999,
        claimPgid: 99999,
        claimJobId: "job-1",
        retryCount: 2,
      });

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      try {
        const { releaseStep } = await import("../dist/installer/step-ops.js");
        const result = releaseStep(runId, undefined, false);
        assert.ok(result.released, "should release the step");
        assert.equal(result.stepId, stepId);

        const db = new DatabaseSync(path.join(stateDir, "tamandua.db"));
        const step = db.prepare("SELECT status, retry_count, claim_pid, claim_pgid, claim_job_id, claim_updated_at FROM steps WHERE id = ?").get(stepId) as any;
        db.close();

        assert.equal(step.status, "pending");
        assert.equal(step.retry_count, 2, "retry_count should not be incremented");
        assert.equal(step.claim_pid, null);
        assert.equal(step.claim_pgid, null);
        assert.equal(step.claim_job_id, null);
        assert.equal(step.claim_updated_at, null);
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });

    it("emits step.released event", async () => {
      const th = createTempHome("tamandua-rel-event-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepId = crypto.randomUUID();
      insertStep(stateDir, stepId, runId, "agentY", 0, "running", {
        claimPid: 99998,
        claimPgid: 99998,
        claimJobId: "job-2",
      });

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      try {
        const { releaseStep } = await import("../dist/installer/step-ops.js");
        releaseStep(runId, undefined, false);

        const events = readRunEvents(stateDir, runId);
        const releasedEvents = events.filter((e) => e.event === "step.released");
        assert.equal(releasedEvents.length, 1);
        assert.equal(releasedEvents[0].stepId, stepId);
        assert.equal(releasedEvents[0].runId, runId);
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });

    it("refuses release when worker PID is still alive", async () => {
      const th = createTempHome("tamandua-rel-alive-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepId = crypto.randomUUID();
      insertStep(stateDir, stepId, runId, "agentZ", 0, "running", {
        claimPid: process.pid,
        claimPgid: process.pid,
        claimJobId: "job-3",
      });

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      try {
        const { releaseStep } = await import("../dist/installer/step-ops.js");
        const result = releaseStep(runId, undefined, false);
        assert.ok(!result.released, "should refuse release");
        assert.ok(result.reason!.includes("still alive"), `reason: ${result.reason}`);
        assert.ok(result.reason!.includes(String(process.pid)), `reason: ${result.reason}`);
        assert.equal(result.alivePid, process.pid);
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });

    it("releases with alive PID when --force is used", async () => {
      const th = createTempHome("tamandua-rel-force-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepId = crypto.randomUUID();
      insertStep(stateDir, stepId, runId, "agentF", 0, "running", {
        claimPid: process.pid,
        claimPgid: process.pid,
        claimJobId: "job-4",
      });

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      try {
        const { releaseStep } = await import("../dist/installer/step-ops.js");
        const result = releaseStep(runId, undefined, true);
        assert.ok(result.released, "should release with --force");

        const db = new DatabaseSync(path.join(stateDir, "tamandua.db"));
        const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as any;
        db.close();
        assert.equal(step.status, "pending");
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });

    it("with multiple running steps and no step-id, lists them", async () => {
      const th = createTempHome("tamandua-rel-multi-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepId1 = crypto.randomUUID();
      const stepId2 = crypto.randomUUID();
      insertStep(stateDir, stepId1, runId, "agentA", 0, "running", { claimPid: 99997 });
      insertStep(stateDir, stepId2, runId, "agentB", 1, "running", { claimPid: 99996 });

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      try {
        const { releaseStep } = await import("../dist/installer/step-ops.js");
        const result = releaseStep(runId, undefined, false);
        assert.ok(!result.released);
        assert.ok(result.reason!.includes("Multiple running steps"));
        assert.ok(result.claimedSteps);
        assert.equal(result.claimedSteps!.length, 2);
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });

    it("with explicit step-id, releases that specific step", async () => {
      const th = createTempHome("tamandua-rel-explicit-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepId1 = crypto.randomUUID();
      const stepId2 = crypto.randomUUID();
      insertStep(stateDir, stepId1, runId, "agentC", 0, "running", { claimPid: 99995 });
      insertStep(stateDir, stepId2, runId, "agentD", 1, "running", { claimPid: 99994 });

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      try {
        const { releaseStep } = await import("../dist/installer/step-ops.js");
        const result = releaseStep(runId, stepId2, false);
        assert.ok(result.released);
        assert.equal(result.stepId, stepId2);

        const db = new DatabaseSync(path.join(stateDir, "tamandua.db"));
        const s1 = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId1) as any;
        const s2 = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId2) as any;
        db.close();

        assert.equal(s1.status, "running");
        assert.equal(s2.status, "pending");
      } finally {
        delete process.env.TAMANDUA_STATE_DIR;
        delete process.env.TAMANDUA_DB_PATH;
      }
    });
  });

  describe("CLI integration", () => {
    it("step release --help prints help text", async () => {
      const th = createTempHome("tamandua-rel-help-");
      const result = await runCli(["step", "release", "--help"], th.homeDir, th.tamanduaDir);
      assert.ok(result.stdout.includes("tamandua step release"), `stdout: ${result.stdout}`);
      assert.ok(result.stdout.includes("--force"), `stdout: ${result.stdout}`);
      assert.equal(result.exitCode, 0);
    });

    it("step release with prefix run-id works", async () => {
      const th = createTempHome("tamandua-rel-prefix-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepId = crypto.randomUUID();
      insertStep(stateDir, stepId, runId, "agentP", 0, "running", { claimPid: 99993 });

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      const result = await runCli(["step", "release", runId.slice(0, 8)], th.homeDir, stateDir);
      assert.equal(result.exitCode, 0, `exit: ${result.exitCode}, stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes("released back to pending"), `stdout: ${result.stdout}`);
    });

    it("step release with alive PID refuses via CLI", async () => {
      const th = createTempHome("tamandua-rel-cli-alive-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepId = crypto.randomUUID();
      insertStep(stateDir, stepId, runId, "agentQ", 0, "running", {
        claimPid: process.pid,
      });

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      const result = await runCli(["step", "release", runId.slice(0, 8)], th.homeDir, stateDir);
      assert.notEqual(result.exitCode, 0, "should exit non-zero");
      assert.ok(
        result.stderr.includes("still alive") || result.stderr.includes(String(process.pid)),
        `stderr: ${result.stderr}`,
      );
    });

    it("step release with alive PID + --force succeeds via CLI", async () => {
      const th = createTempHome("tamandua-rel-cli-force-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepId = crypto.randomUUID();
      insertStep(stateDir, stepId, runId, "agentR", 0, "running", {
        claimPid: process.pid,
      });

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      const result = await runCli(["step", "release", runId.slice(0, 8), "--force"], th.homeDir, stateDir);
      assert.equal(result.exitCode, 0, `exit: ${result.exitCode}, stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes("released back to pending"), `stdout: ${result.stdout}`);
    });

    it("step release with #N run-id works", async () => {
      const th = createTempHome("tamandua-rel-hashn-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepId = crypto.randomUUID();
      insertStep(stateDir, stepId, runId, "agentS", 0, "running", { claimPid: 99992 });

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      const result = await runCli(["step", "release", "#42"], th.homeDir, stateDir);
      assert.equal(result.exitCode, 0, `exit: ${result.exitCode}, stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes("released back to pending"), `stdout: ${result.stdout}`);
    });

    it("step release with explicit step-id works", async () => {
      const th = createTempHome("tamandua-rel-explicit-cli-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepId1 = crypto.randomUUID();
      const stepId2 = crypto.randomUUID();
      insertStep(stateDir, stepId1, runId, "agent1", 0, "running", { claimPid: 99991 });
      insertStep(stateDir, stepId2, runId, "agent2", 1, "running", { claimPid: 99990 });

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      const result = await runCli(
        ["step", "release", runId.slice(0, 8), stepId2.slice(0, 8)],
        th.homeDir,
        stateDir,
      );
      assert.equal(result.exitCode, 0, `exit: ${result.exitCode}, stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes("released back to pending"));

      const db = new DatabaseSync(path.join(stateDir, "tamandua.db"));
      const s1 = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId1) as any;
      const s2 = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId2) as any;
      db.close();
      assert.equal(s1.status, "running");
      assert.equal(s2.status, "pending");
    });

    it("step release with multiple running lists them via CLI", async () => {
      const th = createTempHome("tamandua-rel-cli-multi-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      const stepId1 = crypto.randomUUID();
      const stepId2 = crypto.randomUUID();
      insertStep(stateDir, stepId1, runId, "agentM1", 0, "running", { claimPid: 99989 });
      insertStep(stateDir, stepId2, runId, "agentM2", 1, "running", { claimPid: 99988 });

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      const result = await runCli(["step", "release", runId.slice(0, 8)], th.homeDir, stateDir);
      assert.notEqual(result.exitCode, 0, "should exit non-zero with multiple steps");
      assert.ok(
        result.stdout.includes("Multiple running steps") || result.stdout.includes("agentM1"),
        `stdout: ${result.stdout}`,
      );
    });

    it("step release with no running steps prints message", async () => {
      const th = createTempHome("tamandua-rel-none-");
      const stateDir = th.tamanduaDir;
      const { runId } = setupDbWithRun(stateDir);

      process.env.TAMANDUA_STATE_DIR = stateDir;
      process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
      const result = await runCli(["step", "release", runId.slice(0, 8)], th.homeDir, stateDir);
      assert.notEqual(result.exitCode, 0, "should exit non-zero");
      assert.ok(result.stderr.includes("No running steps"), `stderr: ${result.stderr}`);
    });
  });
});
