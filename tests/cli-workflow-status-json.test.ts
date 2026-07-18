/**
 * Tests for tamandua workflow status --json (US-003).
 *
 * Validates:
 * 1. tamandua workflow status <query> --json outputs valid JSON with expected shape
 * 2. Output includes runId, runNumber, workflowId, status, task (≤200 chars), tokensSpent, createdAt, updatedAt
 * 3. Steps array has stepId, stepIndex, agentRole, status, retryCount, abandonedCount?, rerouteCount?, claimPid?, claimUpdatedAt?, updatedAt
 * 4. Stories array has storyId, title, status, abandonedCount?
 * 5. workspaceMode, worktreePath, worktreeOriginRef present only for worktree runs
 * 6. Without --json, output matches current human-readable format
 * 7. With --json, stdout contains exactly one JSON object and nothing else
 * 8. getWorkflowStatusHelp() documents --json flag
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
 * Seed a temp DB with a single run, steps, and stories so workflow status
 * has data to query.
 */
function seedDb(dbPath: string, db: ReturnType<typeof getDb>): string {
  const runId = "a1b2c3d4-e5f6-7890-abcd-ef1234567891";
  const now = new Date().toISOString();

  // Run
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    42,
    "feature-dev-merge-worktree",
    "Add --json flag to step stories and workflow commands so agents can read state without scraping text output",
    "running",
    "{}",
    9876,
    now,
    now,
  );

  // Steps
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, type, status, retry_count, abandoned_count, reroute_count, claim_pid, claim_updated_at, updated_at, input_template, expects, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "step-uuid-1", runId, "feature-dev-merge-worktree_planner", "feature-dev-merge-worktree_planner",
    0, "single", "done", 0, 0, 0, 12345, now, now, "", "", now,
  );
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, type, status, retry_count, abandoned_count, reroute_count, claim_pid, claim_updated_at, updated_at, input_template, expects, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "step-uuid-2", runId, "feature-dev-merge-worktree_developer", "feature-dev-merge-worktree_developer",
    1, "single", "running", 0, 0, 0, 67890, now, now, "", "", now,
  );
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, type, status, retry_count, abandoned_count, reroute_count, claim_pid, claim_updated_at, updated_at, input_template, expects, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "step-uuid-3", runId, "feature-dev-merge-worktree_verifier", "feature-dev-merge-worktree_verifier",
    2, "single", "pending", 0, 0, 0, null, null, now, "", "", now,
  );
  // A failed step with non-zero abandoned/reroute counts
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, type, status, retry_count, abandoned_count, reroute_count, claim_pid, claim_updated_at, updated_at, input_template, expects, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "step-uuid-4", runId, "feature-dev-merge-worktree_pr", "feature-dev-merge-worktree_pr",
    3, "single", "failed", 2, 1, 2, null, null, now, "", "", now,
  );

  // Stories
  db.prepare(
    `INSERT INTO stories (id, run_id, story_id, title, description, acceptance_criteria, status, retry_count, abandoned_count, story_index, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "story-uuid-1", runId, "US-001", "Add --json to step stories",
    "Description here", "[]", "done", 1, 0, 0, now, now,
  );
  db.prepare(
    `INSERT INTO stories (id, run_id, story_id, title, description, acceptance_criteria, status, retry_count, abandoned_count, story_index, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "story-uuid-2", runId, "US-002", "Add --json to workflow runs",
    "Description here", "[]", "running", 0, 1, 1, now, now,
  );

  return runId;
}

/**
 * Seed a worktree run with steps and stories for workspaceMode tests.
 */
function seedWorktreeDb(dbPath: string, db: ReturnType<typeof getDb>): string {
  const runId = "b2c3d4e5-f6a7-8901-bcde-f12345678902";
  const now = new Date().toISOString();

  // Run with worktree context
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    7,
    "feature-dev-merge-worktree",
    "Build dark mode toggle",
    "done",
    JSON.stringify({ workspace_mode: "worktree" }),
    4200,
    now,
    now,
  );

  // Worktree record
  db.prepare(
    `INSERT INTO run_worktrees (run_id, worktree_path, worktree_origin_repository, worktree_origin_git_common_dir, worktree_origin_ref, worktree_origin_sha, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    "/tmp/tamandua-worktrees/dark-mode/7-b2c3d4e5",
    "/home/user/project",
    "/home/user/project/.git",
    "feature/dark-mode",
    "abc123def",
    "ready",
    now,
  );

  // Steps
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, type, status, retry_count, abandoned_count, reroute_count, updated_at, input_template, expects, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "step-uuid-wt-1", runId, "feature-dev-merge-worktree_developer", "feature-dev-merge-worktree_developer",
    0, "single", "done", 0, 0, 0, now, "", "", now,
  );

  // Stories
  db.prepare(
    `INSERT INTO stories (id, run_id, story_id, title, description, acceptance_criteria, status, retry_count, abandoned_count, story_index, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "story-uuid-wt-1", runId, "US-001", "Add dark mode toggle",
    "Description", "[]", "done", 0, 0, 0, now, now,
  );

  return runId;
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe("tamandua workflow status --json", () => {
  // AC 1: --json outputs a single JSON object with runId, runNumber, workflowId, status,
  // task (≤200 chars), tokensSpent, createdAt, updatedAt
  it("--json outputs valid JSON with top-level run fields", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-json-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();
    const runId = seedDb(dbPath, db);

    const { stdout, stderr } = await runCli(["workflow", "status", runId, "--json"], homeDir, tamanduaDir, dbPath);
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    const parsed = JSON.parse(stdout);

    // Top-level fields
    assert.equal(typeof parsed.runId, "string");
    assert.equal(typeof parsed.runNumber, "number");
    assert.equal(parsed.runNumber, 42);
    assert.equal(typeof parsed.workflowId, "string");
    assert.equal(typeof parsed.status, "string");
    assert.equal(parsed.status, "running");
    assert.equal(typeof parsed.task, "string");
    assert.ok(parsed.task.length <= 200, `task must be ≤200 chars, got ${parsed.task.length}`);
    assert.equal(typeof parsed.tokensSpent, "number");
    assert.equal(parsed.tokensSpent, 9876);
    assert.equal(typeof parsed.createdAt, "string");
    assert.equal(typeof parsed.updatedAt, "string");
  });

  // AC 3: Steps array has stepId, stepIndex, agentRole, status, retryCount,
  // abandonedCount?, rerouteCount?, claimPid?, claimUpdatedAt?, updatedAt
  it("--json steps array has all expected fields", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-steps-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();
    const runId = seedDb(dbPath, db);

    const { stdout } = await runCli(["workflow", "status", runId, "--json"], homeDir, tamanduaDir, dbPath);
    const parsed = JSON.parse(stdout);

    assert.ok(Array.isArray(parsed.steps), "steps must be an array");
    assert.equal(parsed.steps.length, 4, "should have 4 steps");

    // Step 1 (done, planner → agentRole: planner)
    const s1 = parsed.steps[0];
    assert.equal(typeof s1.stepId, "string");
    assert.equal(typeof s1.stepIndex, "number");
    assert.equal(s1.stepIndex, 0);
    assert.equal(typeof s1.agentRole, "string");
    assert.equal(s1.agentRole, "planner");
    assert.equal(s1.status, "done");
    assert.equal(typeof s1.retryCount, "number");
    assert.equal(s1.retryCount, 0);
    // abandonedCount/rerouteCount omitted when 0
    assert.equal(s1.abandonedCount, undefined);
    assert.equal(s1.rerouteCount, undefined);
    // claimPid present for claimed step
    assert.equal(typeof s1.claimPid, "number");
    assert.equal(s1.claimPid, 12345);
    assert.equal(typeof s1.claimUpdatedAt, "string");
    assert.equal(typeof s1.updatedAt, "string");

    // Step 2 (running, developer → agentRole: developer)
    const s2 = parsed.steps[1];
    assert.equal(s2.agentRole, "developer");
    assert.equal(s2.status, "running");
    assert.equal(s2.claimPid, 67890);

    // Step 3 (pending, verifier → agentRole: verifier)
    const s3 = parsed.steps[2];
    assert.equal(s3.agentRole, "verifier");
    assert.equal(s3.status, "pending");
    assert.equal(s3.claimPid, undefined);

    // Step 4 (failed, pr → agentRole: pr, with abandoned/reroute counts)
    const s4 = parsed.steps[3];
    assert.equal(s4.agentRole, "pr");
    assert.equal(s4.status, "failed");
    assert.equal(s4.retryCount, 2);
    assert.equal(s4.abandonedCount, 1);
    assert.equal(s4.rerouteCount, 2);
  });

  // AC 4: Stories array has storyId, title, status, abandonedCount?
  it("--json stories array has correct fields", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-stories-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();
    const runId = seedDb(dbPath, db);

    const { stdout } = await runCli(["workflow", "status", runId, "--json"], homeDir, tamanduaDir, dbPath);
    const parsed = JSON.parse(stdout);

    assert.ok(Array.isArray(parsed.stories), "stories must be an array");
    assert.equal(parsed.stories.length, 2, "should have 2 stories");

    const st1 = parsed.stories[0];
    assert.equal(st1.storyId, "US-001");
    assert.equal(st1.title, "Add --json to step stories");
    assert.equal(st1.status, "done");
    // abandonedCount omitted when 0
    assert.equal(st1.abandonedCount, undefined);

    const st2 = parsed.stories[1];
    assert.equal(st2.storyId, "US-002");
    assert.equal(st2.status, "running");
    assert.equal(st2.abandonedCount, 1);
  });

  // AC 5: workspaceMode, worktreePath, worktreeOriginRef present only for worktree runs
  it("--json includes workspaceMode for worktree runs", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-wt-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();
    const runId = seedWorktreeDb(dbPath, db);

    const { stdout } = await runCli(["workflow", "status", runId, "--json"], homeDir, tamanduaDir, dbPath);
    const parsed = JSON.parse(stdout);

    assert.equal(parsed.workspaceMode, "worktree");
    assert.equal(parsed.worktreePath, "/tmp/tamandua-worktrees/dark-mode/7-b2c3d4e5");
    assert.equal(parsed.worktreeOriginRef, "feature/dark-mode");
    assert.equal(parsed.status, "done");
    assert.equal(parsed.runNumber, 7);

    // Steps present for worktree runs too
    assert.ok(Array.isArray(parsed.steps));
    assert.equal(parsed.steps.length, 1);
    assert.equal(parsed.steps[0].agentRole, "developer");
  });

  it("--json does NOT include workspaceMode for non-worktree runs", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-direct-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();
    const runId = seedDb(dbPath, db);

    const { stdout } = await runCli(["workflow", "status", runId, "--json"], homeDir, tamanduaDir, dbPath);
    const parsed = JSON.parse(stdout);

    assert.equal(parsed.workspaceMode, undefined, "no workspaceMode for direct runs");
    assert.equal(parsed.worktreePath, undefined);
    assert.equal(parsed.worktreeOriginRef, undefined);
  });

  // AC 6: Without --json, output matches human-readable format
  it("without --json outputs human-readable format (snapshot)", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-human-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();
    const runId = seedDb(dbPath, db);

    const { stdout, stderr } = await runCli(["workflow", "status", runId], homeDir, tamanduaDir, dbPath);
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    const lines = stdout.trim().split("\n");

    // Check for expected human output lines
    assert.match(lines[0], /^Run: a1b2c3d4/);
    assert.match(lines[1], /^Workflow: feature-dev-merge-worktree/);
    assert.match(lines[2], /^Task: Add --json flag to step stories/);
    assert.match(lines[3], /^Status: running/);
    assert.match(lines[4], /^Tokens: 9,876/);

    // Steps listing
    const stepsIdx = lines.indexOf("Steps:");
    assert.ok(stepsIdx > 0, "should have Steps: header");

    // Step status indicators with agent role in parens
    const stepLines = lines.slice(stepsIdx + 1);
    assert.match(stepLines[0], /\[done   \] feature-dev-merge-worktree_planner/);
    assert.match(stepLines[0], /\(planner\)/);
    assert.match(stepLines[1], /\[running\] feature-dev-merge-worktree_developer/);
    assert.match(stepLines[1], /\(developer\)/);
    assert.match(stepLines[2], /\[pending\] feature-dev-merge-worktree_verifier/);
    assert.match(stepLines[2], /\(verifier\)/);
    assert.match(stepLines[3], /\[failed \] feature-dev-merge-worktree_pr/);
    assert.match(stepLines[3], /\(pr\)/);
  });

  // AC 7: With --json, stdout contains exactly one JSON object and nothing else
  it("--json stdout purity: exactly one JSON object", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-purity-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();
    const runId = seedDb(dbPath, db);

    const { stdout, stderr } = await runCli(["workflow", "status", runId, "--json"], homeDir, tamanduaDir, dbPath);
    assert.equal(cleanStderr(stderr), "", `stderr should be empty: ${cleanStderr(stderr)}`);

    const trimmed = stdout.trim();
    assert.ok(trimmed.startsWith("{"), "stdout must start with {");
    assert.ok(trimmed.endsWith("}"), "stdout must end with }");

    const parsed = JSON.parse(trimmed);
    assert.equal(typeof parsed, "object");
    assert.ok(!Array.isArray(parsed), "must be an object, not array");

    // No trailing content after the JSON
    assert.match(stdout, /^\{[\s\S]*\}\s*$/);
  });

  // AC 8: getWorkflowStatusHelp() documents --json flag
  it("--help documents --json flag", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-help-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");

    const { stdout } = await runCli(["workflow", "status", "--help"], homeDir, tamanduaDir, dbPath);
    assert.match(stdout, /--json/);
    assert.match(stdout, /machine consumption/);
    assert.match(stdout, /workspaceMode/);
  });

  // AC: task substr match also works with --json
  it("--json with task substring match", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-substr-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();
    seedDb(dbPath, db);

    const { stdout } = await runCli(["workflow", "status", "scraping text output", "--json"], homeDir, tamanduaDir, dbPath);
    const parsed = JSON.parse(stdout);

    assert.equal(parsed.workflowId, "feature-dev-merge-worktree");
    assert.equal(parsed.runNumber, 42);
    assert.ok(Array.isArray(parsed.steps));
  });

  // AC: id prefix match works with --json
  it("--json with run-id prefix match", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-prefix-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();
    const runId = seedDb(dbPath, db);

    const prefix = runId.slice(0, 8);
    const { stdout } = await runCli(["workflow", "status", prefix, "--json"], homeDir, tamanduaDir, dbPath);
    const parsed = JSON.parse(stdout);

    assert.equal(parsed.runId, runId);
    assert.ok(Array.isArray(parsed.steps));
  });

  // Edge case: no steps, no stories
  it("--json with run that has no steps or stories", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-empty-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    const db = getDb();
    const now = new Date().toISOString();
    const runId = "cccc5555-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    db.prepare(
      `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(runId, 1, "feature-dev-merge", "Simple task", "pending", "{}", 0, now, now);

    const { stdout } = await runCli(["workflow", "status", runId, "--json"], homeDir, tamanduaDir, dbPath);
    const parsed = JSON.parse(stdout);

    assert.equal(parsed.runId, runId);
    assert.equal(parsed.runNumber, 1);
    assert.ok(Array.isArray(parsed.steps));
    assert.equal(parsed.steps.length, 0);
    // stories omitted when none
    assert.equal(parsed.stories, undefined);
  });
});
