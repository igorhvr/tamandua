/**
 * Tests for tamandua step stories --json (US-001).
 *
 * Validates:
 * 1. tamandua step stories <run-id> --json outputs valid JSON with runId and stories array
 * 2. Each story has storyId, title, status, abandonedCount (omitted when 0), updatedAt
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
 * Seed a temp DB with a run and stories so step stories has data to query.
 * Returns the full run ID used.
 */
function seedDb(dbPath: string, db: ReturnType<typeof getDb>): string {
  const runId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  const now = new Date().toISOString();

  // Insert a run
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    1,
    "feature-dev-merge-worktree",
    "Test task for step stories",
    "running",
    "{}",
    1234,
    now,
    now,
  );

  // Insert stories
  db.prepare(
    `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, abandoned_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("s001", runId, 0, "US-001", "Add --json to step stories", "Implement --json flag", '["AC1","AC2"]', "done", 0, 4, 0, now, now);
  db.prepare(
    `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, abandoned_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("s002", runId, 1, "US-002", "Add --json to workflow runs", "Implement --json for runs", '["AC1"]', "running", 1, 4, 0, now, now);
  db.prepare(
    `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, abandoned_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("s003", runId, 2, "US-003", "Upcoming story", "Future work", '["AC1"]', "pending", 0, 4, 0, now, now);

  return runId;
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe("tamandua step stories --json", () => {
  // AC 1: --json outputs a single JSON object with runId and stories array
  it("--json outputs valid JSON with runId and stories array", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-stories-json-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();
    const runId = seedDb(dbPath, db);

    const { stdout, stderr } = await runCli(["step", "stories", runId, "--json"], homeDir, tamanduaDir, dbPath);
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    const parsed = JSON.parse(stdout);
    assert.equal(typeof parsed.runId, "string");
    assert.equal(parsed.runId, runId);
    assert.ok(Array.isArray(parsed.stories), "stories must be an array");
    assert.equal(parsed.stories.length, 3);

    // Check first story (US-001, done)
    const s1 = parsed.stories[0];
    assert.equal(s1.storyId, "US-001");
    assert.equal(s1.title, "Add --json to step stories");
    assert.equal(s1.status, "done");
    assert.equal("abandonedCount" in s1, false, "abandonedCount should be omitted when 0");
    assert.ok(s1.updatedAt, "updatedAt should be present");

    // Check second story (US-002, running)
    const s2 = parsed.stories[1];
    assert.equal(s2.storyId, "US-002");
    assert.equal(s2.status, "running");
    assert.equal("abandonedCount" in s2, false, "abandonedCount should be omitted when 0");

    // Check third story (US-003, pending)
    const s3 = parsed.stories[2];
    assert.equal(s3.storyId, "US-003");
    assert.equal(s3.status, "pending");
    assert.equal("abandonedCount" in s3, false, "abandonedCount should be omitted when 0");
  });

  // AC 2: abandonedCount is present when > 0
  it("--json includes abandonedCount when > 0", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-stories-json-abn-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");

    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();

    const runId = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(runId, 2, "feature-dev-merge-worktree", "Test", "running", "{}", 0, now, now);
    db.prepare(
      `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, abandoned_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("sab1", runId, 0, "US-001", "Abandoned story", "A story that was abandoned", '["AC1"]', "pending", 0, 4, 3, now, now);

    const { stdout, stderr } = await runCli(["step", "stories", runId, "--json"], homeDir, tamanduaDir, dbPath);
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.stories.length, 1);
    assert.equal(parsed.stories[0].abandonedCount, 3, "abandonedCount should be present when > 0");
  });

  // AC 3: Without --json, output matches human-readable format
  it("without --json outputs human-readable format (snapshot)", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-stories-nonjson-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();
    const runId = seedDb(dbPath, db);

    const { stdout, stderr } = await runCli(["step", "stories", runId], homeDir, tamanduaDir, dbPath);
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    // Snapshot of human-readable format
    const lines = stdout.trim().split("\n");
    assert.equal(lines.length, 3, "should have 3 story lines");

    // Line 0: US-001 [done   ] (padEnd(8) + space + [padEnd(7)])
    assert.match(lines[0], /^US-001\s+\[done\s+\]/);
    assert.match(lines[0], /Add --json to step stories$/);

    // Line 1: US-002 [running] with retry
    assert.match(lines[1], /^US-002\s+\[running\]/);
    assert.match(lines[1], /Add --json to workflow runs/);
    assert.match(lines[1], /\(retry 1\)/);

    // Line 2: US-003 [pending]
    assert.match(lines[2], /^US-003\s+\[pending\]/);
    assert.match(lines[2], /Upcoming story$/);
  });

  // AC 4: With --json, stdout contains exactly one JSON object and nothing else
  it("--json stdout purity: exactly one JSON object", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-stories-purity-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();
    const runId = seedDb(dbPath, db);

    const { stdout, stderr } = await runCli(["step", "stories", runId, "--json"], homeDir, tamanduaDir, dbPath);
    assert.equal(cleanStderr(stderr), "", `stderr should be empty: ${cleanStderr(stderr)}`);

    // Verify the entire stdout is exactly a single JSON object
    const trimmed = stdout.trim();
    // Must start with { and end with }
    assert.ok(trimmed.startsWith("{"), "stdout must start with {");
    assert.ok(trimmed.endsWith("}"), "stdout must end with }");

    // Must parse as a single JSON value
    const parsed = JSON.parse(trimmed);
    assert.equal(typeof parsed, "object");
    assert.ok(!Array.isArray(parsed), "must be an object, not array");

    // No trailing content after the JSON
    assert.match(stdout, /^\{[\s\S]*\}\s*$/);
  });

  // AC 5: Empty stories with --json returns {runId, stories:[]}
  it("--json with no stories returns empty array", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-stories-empty-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");

    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();

    const runId = "c3d4e5f6-a7b8-9012-cdef-123456789012";
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(runId, 3, "feature-dev-merge-worktree", "Empty run", "running", "{}", 0, now, now);

    const { stdout, stderr } = await runCli(["step", "stories", runId, "--json"], homeDir, tamanduaDir, dbPath);
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.runId, runId);
    assert.deepStrictEqual(parsed.stories, []);
  });

  // AC 6: --help documents --json flag
  it("--help documents --json flag", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-stories-help-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");

    const { stdout } = await runCli(["step", "stories", "--help"], homeDir, tamanduaDir, dbPath);
    assert.match(stdout, /--json/);
    assert.match(stdout, /machine consumption/);
  });
});
