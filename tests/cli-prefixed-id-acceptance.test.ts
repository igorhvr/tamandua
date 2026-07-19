/**
 * Integration tests for prefixed ID acceptance and wrong-prefix error detection (US-016).
 *
 * Spawns the actual tamandua CLI binary to test that:
 * 1. Prefixed ids (run-<uuid>, step-<uuid>) are accepted on all commands
 * 2. Bare UUIDs still work (backward compat)
 * 3. Wrong-prefix ids produce clear error messages
 *
 * These are full-subprocess integration tests that exercise the complete
 * CLI handler → argument parsing → step-ops/status path.
 */

import { describe, it, before } from "node:test";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_SCRIPT = path.resolve(__dirname, "..", "dist", "cli", "cli.js");

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCli(args: string[], env: Record<string, string | undefined>): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("node", ["--no-warnings", CLI_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
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
      if (line.includes("ExperimentalWarning")) return false;
      if (line.includes("node --trace-warnings")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function uuid(): string {
  return crypto.randomUUID();
}

interface SeedRunResult {
  homeDir: string;
  tamanduaDir: string;
  dbPath: string;
  env: Record<string, string | undefined>;
  runId: string;
}

/**
 * Create a temp DB with a single run (no steps).
 */
function seedRunDb(prefix: string, status: string = "running"): SeedRunResult {
  const { homeDir, tamanduaDir } = createTempHome(prefix);
  const dbPath = path.join(tamanduaDir, "tamandua.db");

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");

  db.exec(`CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    run_number INTEGER DEFAULT 1,
    workflow_id TEXT NOT NULL DEFAULT 'feature-dev-merge-worktree',
    task TEXT NOT NULL DEFAULT 'Integration test task',
    status TEXT NOT NULL DEFAULT 'running',
    context TEXT NOT NULL DEFAULT '{}',
    tokens_spent INTEGER NOT NULL DEFAULT 0,
    scheduling_status TEXT,
    working_directory_for_harness TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Also create run_worktrees table for autoresearch lookup
  db.exec(`CREATE TABLE IF NOT EXISTS run_worktrees (
    run_id TEXT PRIMARY KEY,
    worktree_origin_repository TEXT NOT NULL DEFAULT '',
    worktree_origin_git_common_dir TEXT NOT NULL DEFAULT '',
    worktree_path TEXT NOT NULL DEFAULT '',
    worktree_origin_ref TEXT,
    worktree_origin_sha TEXT,
    original_branch TEXT,
    status TEXT NOT NULL DEFAULT 'ready',
    cleanup_policy TEXT NOT NULL DEFAULT 'keep',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    removed_at TEXT,
    error TEXT
  )`);

  const runId = uuid();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, 1, "feature-dev-merge-worktree", "Integration test task", status, "{}", 0, now, now);

  db.close();

  const env = cleanChildEnv({
    HOME: homeDir,
    TAMANDUA_STATE_DIR: tamanduaDir,
    TAMANDUA_DB_PATH: dbPath,
  });

  return { homeDir, tamanduaDir, dbPath, env, runId };
}

interface SeedStepResult extends SeedRunResult {
  stepId: string;
}

/**
 * Create a temp DB with a run and a single running step ready for step complete/fail.
 */
function seedStepDb(prefix: string, expects: string = "CHANGES:"): SeedStepResult {
  const base = seedRunDb(prefix, "running");

  const db = new DatabaseSync(base.dbPath);

  db.exec(`CREATE TABLE IF NOT EXISTS steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL DEFAULT 'dev',
    agent_id TEXT NOT NULL DEFAULT 'feature-dev-merge-worktree_developer',
    step_index INTEGER NOT NULL DEFAULT 0,
    input_template TEXT NOT NULL DEFAULT '',
    expects TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',
    output TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 4,
    type TEXT NOT NULL DEFAULT 'single',
    loop_config TEXT,
    current_story_id TEXT,
    abandoned_count INTEGER DEFAULT 0,
    claim_invalidated_by TEXT,
    claim_updated_at TEXT,
    claim_pid INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const stepId = uuid();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, expects, status, retry_count, max_retries, type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(stepId, base.runId, "developer", "feature-dev-merge-worktree_developer", 1, expects, "running", 0, 4, "single", now, now);

  db.close();

  return { ...base, stepId };
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

// ── Wrong-prefix error tests (no DB needed) ──

describe("US-016: wrong-prefix CLI integration tests", () => {
  let bareEnv: Record<string, string | undefined>;

  before(() => {
    const { homeDir } = createTempHome("us16-wrong-");
    bareEnv = cleanChildEnv({ HOME: homeDir });
  });

  // Step complete with run-prefixed id
  it("step complete run-<uuid> fails with wrong-prefix error", async () => {
    const { stderr, exitCode } = await runCli(
      ["step", "complete", `run-${uuid()}`],
      bareEnv,
    );
    assert.equal(exitCode, 1);
    const cleaned = cleanStderr(stderr);
    assert.match(cleaned, /run id/);
    assert.match(cleaned, /stepId/);
  });

  // Step fail with run-prefixed id
  it("step fail run-<uuid> fails with wrong-prefix error", async () => {
    const { stderr, exitCode } = await runCli(
      ["step", "fail", `run-${uuid()}`],
      bareEnv,
    );
    assert.equal(exitCode, 1);
    const cleaned = cleanStderr(stderr);
    assert.match(cleaned, /run id/);
    assert.match(cleaned, /stepId/);
  });

  // Workflow status with step-prefixed id
  it("workflow status step-<uuid> fails with wrong-prefix error", async () => {
    const { stderr, exitCode } = await runCli(
      ["workflow", "status", `step-${uuid()}`],
      bareEnv,
    );
    assert.equal(exitCode, 1);
    const cleaned = cleanStderr(stderr);
    assert.match(cleaned, /step id/);
    assert.match(cleaned, /run id/);
  });

  // Workflow stop with step-prefixed id
  it("workflow stop step-<uuid> fails with wrong-prefix error", async () => {
    const { stderr, exitCode } = await runCli(
      ["workflow", "stop", `step-${uuid()}`],
      bareEnv,
    );
    assert.equal(exitCode, 1);
    const cleaned = cleanStderr(stderr);
    assert.match(cleaned, /step id/);
    assert.match(cleaned, /run id/);
  });

  // Workflow pause with step-prefixed id
  it("workflow pause step-<uuid> fails with wrong-prefix error", async () => {
    const { stderr, exitCode } = await runCli(
      ["workflow", "pause", `step-${uuid()}`],
      bareEnv,
    );
    assert.equal(exitCode, 1);
    const cleaned = cleanStderr(stderr);
    assert.match(cleaned, /step id/);
    assert.match(cleaned, /run id/);
  });

  // Workflow resume with step-prefixed id
  it("workflow resume step-<uuid> fails with wrong-prefix error", async () => {
    const { stderr, exitCode } = await runCli(
      ["workflow", "resume", `step-${uuid()}`],
      bareEnv,
    );
    assert.equal(exitCode, 1);
    const cleaned = cleanStderr(stderr);
    assert.match(cleaned, /step id/);
    assert.match(cleaned, /run id/);
  });

  // Workflow delete with step-prefixed id
  it("workflow delete step-<uuid> fails with wrong-prefix error", async () => {
    const { stderr, exitCode } = await runCli(
      ["workflow", "delete", `step-${uuid()}`],
      bareEnv,
    );
    assert.equal(exitCode, 1);
    const cleaned = cleanStderr(stderr);
    assert.match(cleaned, /step id/);
    assert.match(cleaned, /run id/);
  });

  // Workflow fail with step-prefixed id
  it("workflow fail step-<uuid> fails with wrong-prefix error", async () => {
    const { stderr, exitCode } = await runCli(
      ["workflow", "fail", `step-${uuid()}`, "--reason", "test"],
      bareEnv,
    );
    assert.equal(exitCode, 1);
    const cleaned = cleanStderr(stderr);
    assert.match(cleaned, /step id/);
    assert.match(cleaned, /run id/);
  });

  // Workflow autoresearch with step-prefixed id
  it("workflow autoresearch step-<uuid> fails with wrong-prefix error", async () => {
    const { stderr, exitCode } = await runCli(
      ["workflow", "autoresearch", `step-${uuid()}`],
      bareEnv,
    );
    assert.equal(exitCode, 1);
    const cleaned = cleanStderr(stderr);
    assert.match(cleaned, /step id/);
    assert.match(cleaned, /run id/);
  });

  // Step peek --run-id with step-prefixed id
  it("step peek agent --run-id step-<uuid> fails with wrong-prefix error", async () => {
    const { stderr, exitCode } = await runCli(
      ["step", "peek", "test-agent", "--run-id", `step-${uuid()}`],
      bareEnv,
    );
    assert.equal(exitCode, 1);
    const cleaned = cleanStderr(stderr);
    assert.match(cleaned, /step id/);
    assert.match(cleaned, /run id/);
  });

  // Step claim --run-id with step-prefixed id
  it("step claim agent --run-id step-<uuid> fails with wrong-prefix error", async () => {
    const { stderr, exitCode } = await runCli(
      ["step", "claim", "test-agent", "--run-id", `step-${uuid()}`],
      bareEnv,
    );
    assert.equal(exitCode, 1);
    const cleaned = cleanStderr(stderr);
    assert.match(cleaned, /step id/);
    assert.match(cleaned, /run id/);
  });

  // Step current --run-id with step-prefixed id
  it("step current agent --run-id step-<uuid> fails with wrong-prefix error", async () => {
    const { stderr, exitCode } = await runCli(
      ["step", "current", "test-agent", "--run-id", `step-${uuid()}`],
      bareEnv,
    );
    assert.equal(exitCode, 1);
    const cleaned = cleanStderr(stderr);
    assert.match(cleaned, /step id/);
    assert.match(cleaned, /run id/);
  });
});

// ── Step command acceptance tests (prefixed id works from full CLI) ──

describe("US-016: step command prefixed id acceptance (full CLI)", () => {
  it("step complete step-<uuid> succeeds via full CLI", async () => {
    const seed = seedStepDb("us16-step-acc-");
    const reportPath = path.join(seed.homeDir, "report.txt");
    fs.writeFileSync(reportPath, "STATUS: done\nCHANGES: test\nTESTS: test\n");

    const { stdout, stderr, exitCode } = await runCli(
      ["step", "complete", `step-${seed.stepId}`, "--file", reportPath],
      seed.env,
    );

    assert.equal(exitCode, 0, `exitCode=${exitCode}, stderr=${cleanStderr(stderr)}`);
    assert.match(stdout, /completed/);
  });

  it("step complete bare step id succeeds (backward compat)", async () => {
    const seed = seedStepDb("us16-step-bare-");
    const reportPath = path.join(seed.homeDir, "report.txt");
    fs.writeFileSync(reportPath, "STATUS: done\nCHANGES: test\nTESTS: test\n");

    const { stdout, stderr, exitCode } = await runCli(
      ["step", "complete", seed.stepId, "--file", reportPath],
      seed.env,
    );

    assert.equal(exitCode, 0, `exitCode=${exitCode}, stderr=${cleanStderr(stderr)}`);
    assert.match(stdout, /completed/);
  });

  it("step fail step-<uuid> succeeds via full CLI", async () => {
    const seed = seedStepDb("us16-step-fail-");

    const { stdout, stderr, exitCode } = await runCli(
      ["step", "fail", `step-${seed.stepId}`, "integration test reason"],
      seed.env,
    );

    assert.equal(exitCode, 0, `exitCode=${exitCode}, stderr=${cleanStderr(stderr)}`);
    assert.match(stdout, /failed|retrying/);
  });

  it("step fail bare step id succeeds (backward compat)", async () => {
    const seed = seedStepDb("us16-step-fail-bare-");

    const { stdout, stderr, exitCode } = await runCli(
      ["step", "fail", seed.stepId, "backward compat test"],
      seed.env,
    );

    assert.equal(exitCode, 0, `exitCode=${exitCode}, stderr=${cleanStderr(stderr)}`);
    assert.match(stdout, /failed|retrying/);
  });
});

// ── Step --run-id acceptance tests ──

describe("US-016: step --run-id prefixed acceptance (full CLI)", () => {
  it("step peek agent --run-id run-<uuid> works via full CLI", async () => {
    const seed = seedStepDb("us16-peek-prefix-");

    const { stdout, stderr, exitCode } = await runCli(
      ["step", "peek", "test-agent", "--run-id", `run-${seed.runId}`],
      seed.env,
    );

    assert.equal(exitCode, 0, `exitCode=${exitCode}, stderr=${cleanStderr(stderr)}`);
    // Should report no pending step (NO_WORK or similar)
    assert.match(stdout, /NO_WORK|No pending steps|no work/);
  });

  it("step claim agent --run-id run-<uuid> works via full CLI", async () => {
    const seed = seedStepDb("us16-claim-prefix-");

    const { stdout, stderr, exitCode } = await runCli(
      ["step", "claim", "test-agent", "--run-id", `run-${seed.runId}`],
      seed.env,
    );

    // Claim may fail (no pending step) but should not fail with wrong-prefix
    const cleanedStderr = cleanStderr(stderr);
    assert.ok(
      !cleanedStderr.includes("that is a run id") && !cleanedStderr.includes("step id, not a run id"),
      `Should not get wrong-prefix error, got: ${cleanedStderr}`,
    );
  });

  it("step current agent --run-id run-<uuid> works via full CLI", async () => {
    const seed = seedStepDb("us16-current-prefix-");

    const { stdout, stderr, exitCode } = await runCli(
      ["step", "current", "test-agent", "--run-id", `run-${seed.runId}`],
      seed.env,
    );

    const cleanedStderr = cleanStderr(stderr);
    assert.ok(
      !cleanedStderr.includes("that is a step id") && !cleanedStderr.includes("step id, not a run id"),
      `Should not get wrong-prefix error, got: ${cleanedStderr}`,
    );
  });
});

// ── Workflow command acceptance tests (prefixed id works from full CLI) ──

describe("US-016: workflow command prefixed id acceptance (full CLI)", () => {
  it("workflow status run-<uuid> succeeds via full CLI", async () => {
    const seed = seedRunDb("us16-wf-status-prefix-");

    const { stdout, stderr, exitCode } = await runCli(
      ["workflow", "status", `run-${seed.runId}`],
      seed.env,
    );

    assert.equal(exitCode, 0, `exitCode=${exitCode}, stderr=${cleanStderr(stderr)}`);
    // Output should contain the prefixed run id
    assert.match(stdout, new RegExp(`Run: run-${seed.runId}`));
  });

  it("workflow status bare uuid succeeds (backward compat)", async () => {
    const seed = seedRunDb("us16-wf-status-bare-");

    const { stdout, stderr, exitCode } = await runCli(
      ["workflow", "status", seed.runId],
      seed.env,
    );

    assert.equal(exitCode, 0, `exitCode=${exitCode}, stderr=${cleanStderr(stderr)}`);
    // Output should still show prefixed id in display
    assert.match(stdout, new RegExp(`Run: run-${seed.runId}`));
  });

  it("workflow status run-<prefix> prefix match succeeds", async () => {
    const seed = seedRunDb("us16-wf-status-prefixmatch-");
    const prefix = seed.runId.slice(0, 8);

    const { stdout, stderr, exitCode } = await runCli(
      ["workflow", "status", `run-${prefix}`],
      seed.env,
    );

    assert.equal(exitCode, 0, `exitCode=${exitCode}, stderr=${cleanStderr(stderr)}`);
    assert.match(stdout, new RegExp(`Run: run-${seed.runId}`));
  });

  it("workflow status bare prefix match still works", async () => {
    const seed = seedRunDb("us16-wf-status-bareprefix-");
    const prefix = seed.runId.slice(0, 8);

    const { stdout, stderr, exitCode } = await runCli(
      ["workflow", "status", prefix],
      seed.env,
    );

    assert.equal(exitCode, 0, `exitCode=${exitCode}, stderr=${cleanStderr(stderr)}`);
    assert.match(stdout, new RegExp(`Run: run-${seed.runId}`));
  });

  it("workflow stop run-<uuid> cancels run via full CLI", async () => {
    const seed = seedRunDb("us16-wf-stop-");

    const { stdout, stderr, exitCode } = await runCli(
      ["workflow", "stop", `run-${seed.runId}`],
      seed.env,
    );

    assert.equal(exitCode, 0, `exitCode=${exitCode}, stderr=${cleanStderr(stderr)}`);
    assert.match(stdout, /Cancelled run/);
  });

  it("workflow delete run-<uuid> --force deletes run via full CLI", async () => {
    const seed = seedRunDb("us16-wf-delete-", "done");

    const { stdout, stderr, exitCode } = await runCli(
      ["workflow", "delete", `run-${seed.runId}`, "--force"],
      seed.env,
    );

    assert.equal(exitCode, 0, `exitCode=${exitCode}, stderr=${cleanStderr(stderr)}`);
    assert.match(stdout, /Deleted run/);
  });
});
