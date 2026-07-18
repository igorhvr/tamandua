/**
 * Tests for tamandua workflow runs --json (US-002).
 *
 * Validates:
 * 1. tamandua workflow runs --json outputs valid JSON with runs array
 * 2. Each run has runId, runNumber, workflowId, status, tokensSpent, task (≤120 chars), createdAt, updatedAt
 * 3. Without --json, output matches snapshot of current human-readable format
 * 4. With --json, stdout contains exactly one JSON object and nothing else
 * 5. --help documents --json flag
 *
 * All tests use isolated temp HOME directories.
 */

import { describe, it } from "node:test";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getDb } from "../dist/db.js";

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

function runCli(args: string[], homeDir: string, stateDir: string, dbPath: string): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("node", ["--no-warnings", CLI_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanChildEnv({
        HOME: homeDir,
        TAMANDUA_STATE_DIR: stateDir,
        TAMANDUA_DB_PATH: dbPath,
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

/**
 * Filter harmless node warnings from stderr
 */
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

/**
 * Seed a temp DB with multiple runs so workflow runs has data to query.
 */
function seedDb(dbPath: string, db: ReturnType<typeof getDb>): void {
  const t1 = new Date(Date.now() - 120000).toISOString();  // 2 min ago
  const t2 = new Date(Date.now() - 60000).toISOString();   // 1 min ago
  const t3 = new Date(Date.now() - 86400000).toISOString(); // 1 day ago

  // Oldest (runNumber 1)
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    1,
    "feature-dev-merge-worktree",
    "Add --json flag to step stories",
    "done",
    "{}",
    1234,
    t3,
    t3,
  );

  // Recent (runNumber 2)
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    2,
    "feature-dev-merge-worktree",
    "This is a very long task description that goes on and on and on and should be truncated at 120 characters in JSON output but stays at 50 in human output",
    "running",
    "{}",
    567,
    t2,
    t2,
  );

  // Most recent (runNumber 3)
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "c3d4e5f6-a7b8-9012-cdef-123456789012",
    3,
    "feature-dev-merge",
    "Add dark mode toggle",
    "failed",
    "{}",
    0,
    t1,
    t1,
  );
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe("tamandua workflow runs --json", () => {
  // AC 1: --json outputs a single JSON object with runs array
  it("--json outputs valid JSON with runs array", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-runs-json-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();
    seedDb(dbPath, db);

    const { stdout, stderr } = await runCli(["workflow", "runs", "--json"], homeDir, tamanduaDir, dbPath);
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.runs), "runs must be an array");
    assert.equal(parsed.runs.length, 3, "should have 3 runs");

    // Most recent first (ordering matches listRuns: ORDER BY created_at DESC)
    const r1 = parsed.runs[0];
    assert.equal(typeof r1.runId, "string");
    assert.equal(typeof r1.runNumber, "number");
    assert.equal(typeof r1.workflowId, "string");
    assert.equal(typeof r1.status, "string");
    assert.equal(typeof r1.tokensSpent, "number");
    assert.equal(typeof r1.task, "string");
    assert.equal(typeof r1.createdAt, "string");
    assert.equal(typeof r1.updatedAt, "string");

    // Check runNumber values (ORDER BY created_at DESC: most recent first)
    // t2 (1 min ago, runNumber 2) > t1 (2 min ago, runNumber 3) > t3 (1 day ago, runNumber 1)
    assert.equal(parsed.runs[0].runNumber, 2);
    assert.equal(parsed.runs[1].runNumber, 3);
    assert.equal(parsed.runs[2].runNumber, 1);

    // Task truncation at 120 chars
    const longTaskRun = parsed.runs.find((r: any) => r.runNumber === 2);
    assert.ok(longTaskRun.task.length <= 120, `task should be ≤120 chars, got ${longTaskRun.task.length}`);

    // Short task stays intact
    const shortTaskRun = parsed.runs.find((r: any) => r.runNumber === 3);
    assert.equal(shortTaskRun.task.length <= 120, true);
    assert.equal(shortTaskRun.task, "Add dark mode toggle");
  });

  // AC 2: Each run has expected fields
  it("--json each run has all required fields", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-runs-fields-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();
    seedDb(dbPath, db);

    const { stdout } = await runCli(["workflow", "runs", "--json"], homeDir, tamanduaDir, dbPath);
    const parsed = JSON.parse(stdout);

    const requiredFields = ["runId", "runNumber", "workflowId", "status", "tokensSpent", "task", "createdAt", "updatedAt"];
    for (const run of parsed.runs) {
      for (const field of requiredFields) {
        assert.ok(field in run, `run must have ${field}`);
      }
    }
  });

  // AC 3: Without --json, output matches human-readable format
  it("without --json outputs human-readable format (snapshot)", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-runs-nonjson-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();
    seedDb(dbPath, db);

    const { stdout, stderr } = await runCli(["workflow", "runs"], homeDir, tamanduaDir, dbPath);
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    const lines = stdout.trim().split("\n");
    assert.equal(lines.length, 4, "should have header + 3 run lines");
    assert.equal(lines[0], "Workflow runs:", "header line");

    // Line format:
    //   [status    ] runId      workflow        tokens  task
    // Status is 9-char padded, ID is 8 chars + 2 spaces, workflow 14-char padded

    // Line 1: most recent run (running, runNumber 2) — t2 = 1 min ago
    assert.match(lines[1], /^  \[running  \] b2c3d4e5/);
    assert.ok(lines[1].includes("567 tokens"));

    // Line 2: next recent (failed, runNumber 3) — t1 = 2 min ago
    assert.match(lines[2], /^  \[failed   \] c3d4e5f6/);
    assert.match(lines[2], /Add dark mode toggle$/);

    // Line 3: oldest (done, runNumber 1) — t3 = 1 day ago
    assert.match(lines[3], /^  \[done     \] a1b2c3d4/);
  });

  // AC 4: With --json, stdout contains exactly one JSON object and nothing else
  it("--json stdout purity: exactly one JSON object", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-runs-purity-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();
    seedDb(dbPath, db);

    const { stdout, stderr } = await runCli(["workflow", "runs", "--json"], homeDir, tamanduaDir, dbPath);
    assert.equal(cleanStderr(stderr), "", `stderr should be empty: ${cleanStderr(stderr)}`);

    // Verify the entire stdout is exactly a single JSON object
    const trimmed = stdout.trim();
    assert.ok(trimmed.startsWith("{"), "stdout must start with {");
    assert.ok(trimmed.endsWith("}"), "stdout must end with }");

    const parsed = JSON.parse(trimmed);
    assert.equal(typeof parsed, "object");
    assert.ok(!Array.isArray(parsed), "must be an object, not array");

    // No trailing content after the JSON
    assert.match(stdout, /^\{[\s\S]*\}\s*$/);
  });

  // AC 5: Empty runs with --json returns {runs:[]}
  it("--json with no runs returns empty array", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-runs-empty-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();

    // No seeding — empty DB

    const { stdout, stderr } = await runCli(["workflow", "runs", "--json"], homeDir, tamanduaDir, dbPath);
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.runs));
    assert.deepStrictEqual(parsed.runs, []);
  });

  // AC 6: --help documents --json flag
  it("--help documents --json flag", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-runs-help-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");

    const { stdout } = await runCli(["workflow", "runs", "--help"], homeDir, tamanduaDir, dbPath);
    assert.match(stdout, /--json/);
    assert.match(stdout, /machine consumption/);
  });
});
