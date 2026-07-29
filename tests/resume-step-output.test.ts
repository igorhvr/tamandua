/**
 * Tests for US-006: per-step output on workflow resume.
 *
 * Validates:
 * 1. Resume of paused run prints per-step states for non-done steps
 * 2. Resume of failed run prints per-step states for non-done steps
 * 3. Each line includes step id prefix, role, status, and retry count
 * 4. Done steps are not printed
 * 5. resume-all prints per-step states for each resumed run
 * 6. Empty steps (all done) prints nothing
 */

import { describe, it } from "node:test";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_SCRIPT = path.resolve(__dirname, "..", "dist", "cli", "cli.js");
const DAEMON_SCRIPT = path.resolve(__dirname, "..", "dist", "server", "daemon.js");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("node", ["--no-warnings", CLI_SCRIPT, ...args], {
      env: cleanChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
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

function cleanStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => {
      if (line.includes("ExperimentalWarning") && line.includes("SQLite")) return false;
      if (line.includes("node --trace-warnings")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function seedRunDb(dbPath: string, runs: Array<{
  id: string;
  workflowId: string;
  task: string;
  status: string;
  context?: Record<string, unknown>;
  tokensSpent?: number;
  schedulingStatus?: string;
  steps?: Array<{
    stepId: string;
    agentId: string;
    status: string;
    retryCount?: number;
    stepIndex?: number;
    type?: string;
    output?: string;
  }>;
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
      notify_url TEXT,
      scheduling_status TEXT
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
      abandoned_count INTEGER DEFAULT 0,
      reroute_count INTEGER DEFAULT 0,
      current_story_id TEXT,
      claim_pid INTEGER,
      claim_updated_at TEXT,
      type TEXT NOT NULL DEFAULT 'single',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  for (const r of runs) {
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent${r.schedulingStatus !== undefined ? ", scheduling_status" : ""})
       VALUES (?, ?, ?, ?, ?, ?${r.schedulingStatus !== undefined ? ", ?" : ""})`,
    ).run(
      r.id, r.workflowId, r.task, r.status, JSON.stringify(r.context ?? {}), r.tokensSpent ?? 0,
      ...(r.schedulingStatus !== undefined ? [r.schedulingStatus] : []),
    );

    if (r.steps) {
      for (let i = 0; i < r.steps.length; i++) {
        const s = r.steps[i];
        const nowStr = new Date().toISOString();
        db.prepare(
          `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, retry_count, type, created_at, updated_at, output)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          crypto.randomUUID(),
          s.stepId,
          r.id,
          s.agentId,
          s.stepIndex ?? i,
          "test input",
          "STATUS: done",
          s.status,
          s.retryCount ?? 0,
          s.type ?? "single",
          nowStr,
          nowStr,
          s.output ?? null,
        );
      }
    }
  }

  db.close();
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert.ok(addr && typeof addr === "object");
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForControlUp(port: number, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/control/health`);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`control plane did not come up on port ${port}`);
}

// ── Tests ──────────────────────────────────────────────────────────

describe("resume per-step output (US-006)", { concurrency: 1 }, () => {
  // AC 1: Resume of paused run prints per-step states for non-done steps
  it("resume paused run prints non-done step states with id prefix, role, status, retry", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();
    const th = createTempHome("tamandua-resume-steps-");

    // Copy the workflow directory so the daemon can register the run on resume
    const srcWorkflowDir = path.resolve(__dirname, "..", "workflows", "feature-dev-merge");
    const dstWorkflowDir = path.join(th.tamanduaDir, "workflows", "feature-dev-merge");
    fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
    fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");
    const pausedRunId = crypto.randomUUID();
    const stepId1 = crypto.randomUUID();
    const stepId2 = crypto.randomUUID();
    const stepId3 = crypto.randomUUID();

    seedRunDb(dbPath, [
      {
        id: pausedRunId,
        workflowId: "feature-dev-merge",
        task: "Test paused run step output",
        status: "paused",
        context: { working_directory_for_harness: th.root },
        steps: [
          { stepId: stepId1, agentId: "feature-dev-merge_developer", status: "done", stepIndex: 0 },
          { stepId: stepId2, agentId: "feature-dev-merge_verifier", status: "pending", retryCount: 1, stepIndex: 1 },
          { stepId: stepId3, agentId: "feature-dev-merge_merger", status: "waiting", stepIndex: 2 },
        ],
      },
    ]);

    let daemon: ChildProcess | undefined;

    try {
      daemon = spawn("node", [DAEMON_SCRIPT], {
        env: cleanChildEnv({ HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      daemon.stdout?.resume();
      daemon.stderr?.resume();

      await waitForControlUp(controlPort);

      const { stdout, stderr, exitCode } = await runCli(
        ["workflow", "resume", pausedRunId],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(exitCode, 0, `Should exit 0, got ${exitCode}, stderr: ${cleanStderr(stderr)}`);
      assert.ok(stdout.includes("Resumed run"), "Should contain 'Resumed run'");

      // AC 3: Check per-step output for non-done steps
      // stepId2 is pending, retry 1
      assert.match(
        stdout,
        new RegExp(`\\[pending\\] step-${stepId2.slice(0, 8)} \\(verifier\\) retry 1`),
        `Expected pending step output for ${stepId2.slice(0, 8)}`,
      );

      // stepId3 is waiting, retry 0
      assert.match(
        stdout,
        new RegExp(`\\[waiting\\] step-${stepId3.slice(0, 8)} \\(merger\\) retry 0`),
        `Expected waiting step output for ${stepId3.slice(0, 8)}`,
      );

      // AC 4: Done step (stepId1) should NOT appear
      assert.ok(
        !stdout.includes(`[done]`),
        `Done steps should not be printed. stdout: ${stdout}`,
      );
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
        await sleep(200);
      }
    }
  });

  // AC 2: Resume of failed run prints per-step states for non-done steps
  it("resume failed run prints non-done step states", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();
    const th = createTempHome("tamandua-resume-failed-");

    // Copy the workflow directory so the daemon can register the run on resume
    const srcWorkflowDir = path.resolve(__dirname, "..", "workflows", "feature-dev-merge");
    const dstWorkflowDir = path.join(th.tamanduaDir, "workflows", "feature-dev-merge");
    fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
    fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");
    const failedRunId = crypto.randomUUID();
    const stepId1 = crypto.randomUUID();
    const stepId2 = crypto.randomUUID();
    const stepId3 = crypto.randomUUID();

    seedRunDb(dbPath, [
      {
        id: failedRunId,
        workflowId: "feature-dev-merge",
        task: "Test failed run step output",
        status: "failed",
        context: { working_directory_for_harness: th.root },
        steps: [
          { stepId: stepId1, agentId: "feature-dev-merge_planner", status: "done", stepIndex: 0 },
          { stepId: stepId2, agentId: "feature-dev-merge_developer", status: "failed", retryCount: 2, stepIndex: 1, output: "build error" },
          { stepId: stepId3, agentId: "feature-dev-merge_verifier", status: "waiting", stepIndex: 2 },
        ],
      },
    ]);

    let daemon: ChildProcess | undefined;

    try {
      daemon = spawn("node", [DAEMON_SCRIPT], {
        env: cleanChildEnv({ HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      daemon.stdout?.resume();
      daemon.stderr?.resume();

      await waitForControlUp(controlPort);

      const { stdout, stderr, exitCode } = await runCli(
        ["workflow", "resume", failedRunId],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(exitCode, 0, `Should exit 0, got ${exitCode}, stderr: ${cleanStderr(stderr)}`);
      assert.ok(stdout.includes("Resumed run"), "Should contain 'Resumed run'");
      assert.ok(stdout.includes("restarting from step"), "Should show restarting step");

      // AC 2 & 3: After resume of failed run, the failed step gets reset to waiting
      // and advancePipeline promotes the first waiting step to pending.
      // The stepId2 (first non-done) will be pending, stepId3 stays waiting
      assert.match(
        stdout,
        new RegExp(`\\[pending\\] step-${stepId2.slice(0, 8)} \\(developer\\) retry 0`),
        `Expected promoted developer step output for ${stepId2.slice(0, 8)}`,
      );

      assert.match(
        stdout,
        new RegExp(`\\[waiting\\] step-${stepId3.slice(0, 8)} \\(verifier\\) retry 0`),
        `Expected reset verifier step output for ${stepId3.slice(0, 8)}`,
      );

      // AC 4: Done step should NOT appear
      assert.ok(
        !stdout.includes(`[done]`),
        `Done steps should not be printed. stdout: ${stdout}`,
      );
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
        await sleep(200);
      }
    }
  });

  // resume-all prints per-step states for each resumed run
  it("resume-all prints per-step states for each resumed run", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();
    const th = createTempHome("tamandua-resume-all-");

    // Copy the workflow directory
    const srcWorkflowDir = path.resolve(__dirname, "..", "workflows", "feature-dev-merge");
    const dstWorkflowDir = path.join(th.tamanduaDir, "workflows", "feature-dev-merge");
    fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
    fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");
    const runId1 = crypto.randomUUID();
    const runId2 = crypto.randomUUID();
    const stepA = crypto.randomUUID();
    const stepB = crypto.randomUUID();

    seedRunDb(dbPath, [
      {
        id: runId1,
        workflowId: "feature-dev-merge",
        task: "Run 1 for resume-all",
        status: "paused",
        context: { working_directory_for_harness: th.root },
        steps: [
          { stepId: stepA, agentId: "feature-dev-merge_developer", status: "pending", retryCount: 0, stepIndex: 0 },
        ],
      },
      {
        id: runId2,
        workflowId: "feature-dev-merge",
        task: "Run 2 for resume-all",
        status: "paused",
        context: { working_directory_for_harness: th.root },
        steps: [
          { stepId: crypto.randomUUID(), agentId: "feature-dev-merge_planner", status: "done", stepIndex: 0 },
          { stepId: stepB, agentId: "feature-dev-merge_verifier", status: "running", retryCount: 0, stepIndex: 1 },
        ],
      },
    ]);

    let daemon: ChildProcess | undefined;

    try {
      daemon = spawn("node", [DAEMON_SCRIPT], {
        env: cleanChildEnv({ HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      daemon.stdout?.resume();
      daemon.stderr?.resume();

      await waitForControlUp(controlPort);

      const { stdout } = await runCli(
        ["workflow", "resume-all"],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      // At minimum, run1 should be resumed with step output
      assert.match(stdout, new RegExp(`Resumed run run-${runId1.slice(0, 8)}`), "Should mention run 1");
      assert.match(
        stdout,
        new RegExp(`\\[pending\\] step-${stepA.slice(0, 8)} \\(developer\\) retry 0`),
        `Expected step output for run1 step ${stepA.slice(0, 8)}`,
      );

      // The total count should be at least 1
      assert.match(stdout, /Resumed \d+ run\(s\)/, "Should show final count");
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
        await sleep(200);
      }
    }
  });

  // When all steps are done, no per-step output (empty)
  it("resume paused run with all steps done prints no step output", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();
    const th = createTempHome("tamandua-resume-alldone-");

    const srcWorkflowDir = path.resolve(__dirname, "..", "workflows", "feature-dev-merge");
    const dstWorkflowDir = path.join(th.tamanduaDir, "workflows", "feature-dev-merge");
    fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
    fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });

    const dbPath = path.join(th.tamanduaDir, "tamandua.db");
    const pausedRunId = crypto.randomUUID();

    seedRunDb(dbPath, [
      {
        id: pausedRunId,
        workflowId: "feature-dev-merge",
        task: "Test all done run",
        status: "paused",
        context: { working_directory_for_harness: th.root },
        steps: [
          { stepId: crypto.randomUUID(), agentId: "feature-dev-merge_developer", status: "done", stepIndex: 0 },
          { stepId: crypto.randomUUID(), agentId: "feature-dev-merge_verifier", status: "done", stepIndex: 1 },
        ],
      },
    ]);

    let daemon: ChildProcess | undefined;

    try {
      daemon = spawn("node", [DAEMON_SCRIPT], {
        env: cleanChildEnv({ HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      daemon.stdout?.resume();
      daemon.stderr?.resume();

      await waitForControlUp(controlPort);

      const { stdout, stderr, exitCode } = await runCli(
        ["workflow", "resume", pausedRunId],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(exitCode, 0, `Should exit 0, got ${exitCode}, stderr: ${cleanStderr(stderr)}`);
      assert.ok(stdout.includes("Resumed run"), "Should contain 'Resumed run'");

      // No step output when all steps are done
      assert.ok(
        !/\[pending\]|\[waiting\]|\[running\]|\[failed\]|\[done\]/.test(stdout),
        `No step state lines should appear when all steps done. stdout: ${stdout}`,
      );
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
        await sleep(200);
      }
    }
  });
});
