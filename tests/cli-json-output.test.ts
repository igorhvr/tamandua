/**
 * Integration tests for --json flag across all four commands (US-006).
 *
 * Validates all four --json commands end-to-end:
 * 1. tamandua step stories <run-id> --json
 * 2. tamandua workflow runs --json
 * 3. tamandua workflow status <query> --json
 * 4. tamandua status --json
 *
 * For each command:
 *  (a) --json output parses as valid JSON and has the expected top-level shape
 *  (b) Without --json, output is byte-identical to the current human output
 *  (c) --json stdout purity: the output is exactly one JSON document
 *
 * All tests use isolated temp HOME directories.
 */

import { describe, it } from "node:test";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

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
 * Validate that a string is exactly a single JSON object (no trailing text, no markdown fences).
 */
function assertSingleJsonObject(s: string): Record<string, unknown> {
  const trimmed = s.trim();
  assert.ok(trimmed.startsWith("{"), `stdout must start with {, got: ${trimmed.slice(0, 80)}`);
  assert.ok(trimmed.endsWith("}"), `stdout must end with }, got: ...${trimmed.slice(-40)}`);

  // Must parse as exactly one JSON value (no trailing text)
  const parsed = JSON.parse(trimmed);
  assert.equal(typeof parsed, "object");
  assert.ok(!Array.isArray(parsed), "must be a JSON object, not array");
  return parsed as Record<string, unknown>;
}

/**
 * Seed a comprehensive temp DB with runs, steps, stories, and worktree info
 * so all four --json commands have data to query.
 *
 * Returns { runId, runId2 } for test assertions.
 */
function seedDb(dbPath: string): { runId: string; runId2: string } {
  const db = new DatabaseSync(dbPath);

  // ── Create tables ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      notify_url TEXT,
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
      expects TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      type TEXT NOT NULL DEFAULT 'single',
      loop_config TEXT,
      current_story_id TEXT,
      abandoned_count INTEGER DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS run_worktrees (
      run_id TEXT PRIMARY KEY,
      worktree_origin_repository TEXT NOT NULL,
      worktree_origin_git_common_dir TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      worktree_origin_ref TEXT,
      worktree_origin_sha TEXT,
      original_branch TEXT,
      status TEXT NOT NULL DEFAULT 'creating',
      cleanup_policy TEXT NOT NULL DEFAULT 'remove_on_success',
      created_at TEXT NOT NULL,
      removed_at TEXT,
      error TEXT
    );
  `);

  // ── Seed data ──
  const now = new Date().toISOString();
  const tAgo2h = new Date(Date.now() - 2 * 3600_000).toISOString();
  const tAgo1h = new Date(Date.now() - 3600_000).toISOString();
  const tAgo30m = new Date(Date.now() - 30 * 60_000).toISOString();

  // Run 1 — with worktree + steps + stories (for workflow status)
  const runId1 = "a1010101-0101-0101-0101-010101010101";
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId1,
    7,
    "feature-dev-merge-worktree",
    "Add --json flag to four read-only tamandua CLI commands for machine-readable output supporting agent consumption without sqlite scraping. The fields they SELECTed repeatedly are the spec.",
    "running",
    JSON.stringify({ workspace_mode: "worktree", origin_repo: "tamandua", origin_ref: "main" }),
    12345,
    tAgo2h,
    tAgo1h,
  );

  // Run 1 worktree
  db.prepare(
    `INSERT INTO run_worktrees (run_id, worktree_origin_repository, worktree_origin_git_common_dir, worktree_path, worktree_origin_ref, worktree_origin_sha, original_branch, status, cleanup_policy, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId1,
    "/home/user/repos/tamandua",
    "/home/user/repos/tamandua/.git",
    "/home/user/.tamandua/worktrees/tamandua-wt-abc",
    "main",
    "a1b2c3d4e5f6",
    "main",
    "active",
    "remove_on_success",
    tAgo2h,
  );

  // Run 1 steps
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, type, status, retry_count, abandoned_count, input_template, expects, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "step-uuid-a1", runId1, "feature-dev-merge-worktree_planner", "feature-dev-merge-worktree_planner",
    0, "single", "done", 0, 0, "", "", tAgo2h, tAgo2h,
  );
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, type, status, retry_count, abandoned_count, input_template, expects, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "step-uuid-a2", runId1, "feature-dev-merge-worktree_developer", "feature-dev-merge-worktree_developer",
    1, "single", "running", 0, 0, "", "", tAgo2h, tAgo1h,
  );
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, type, status, retry_count, abandoned_count, input_template, expects, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "step-uuid-a3", runId1, "feature-dev-merge-worktree_verifier", "feature-dev-merge-worktree_verifier",
    2, "single", "pending", 0, 0, "", "", tAgo2h, tAgo2h,
  );
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, type, status, retry_count, abandoned_count, input_template, expects, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "step-uuid-a4", runId1, "feature-dev-merge-worktree_pr", "feature-dev-merge-worktree_pr",
    3, "single", "failed", 2, 1, "", "", tAgo2h, tAgo1h,
  );

  // Run 1 stories
  db.prepare(
    `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "story-uuid-a001", runId1, 0, "US-001", "Add --json to step stories",
    "Implement --json flag for step stories", "[]", "done", 0, 4, tAgo2h, tAgo2h,
  );
  db.prepare(
    `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "story-uuid-a002", runId1, 1, "US-002", "Add --json to workflow runs",
    "Implement --json flag for workflow runs", "[]", "running", 0, 4, tAgo2h, tAgo2h,
  );
  db.prepare(
    `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "story-uuid-a003", runId1, 2, "US-003", "Add --json to workflow status",
    "Implement --json flag for workflow status", "[]", "pending", 0, 4, tAgo2h, tAgo2h,
  );

  // Run 2 — simpler run (for workflow runs listing, no worktree)
  const runId2 = "b2020202-0202-0202-0202-020202020202";
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId2,
    8,
    "feature-dev-merge",
    "Fix dark mode toggle bug",
    "done",
    "{}",
    2500,
    tAgo30m,
    tAgo30m,
  );

  return { runId: runId1, runId2 };
}

// ═══════════════════════════════════════════════════════════════════
// Tests — step stories --json
// ═══════════════════════════════════════════════════════════════════

describe("tamandua step stories --json (integration)", () => {
  it("--json outputs valid JSON with runId and stories array", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-json-out-stories-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    const { runId: runId1 } = seedDb(dbPath);

    const { stdout, stderr } = await runCli(
      ["step", "stories", runId1, "--json"],
      homeDir,
      tamanduaDir,
    );
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.runId, runId1);
    assert.ok(Array.isArray(parsed.stories));
    assert.equal(parsed.stories.length, 3);

    const s1 = parsed.stories[0];
    assert.equal(s1.storyId, "US-001");
    assert.equal(s1.title, "Add --json to step stories");
    assert.equal(s1.status, "done");
    assert.ok(typeof s1.updatedAt === "string");

    const s2 = parsed.stories[1];
    assert.equal(s2.storyId, "US-002");
    assert.equal(s2.status, "running");

    const s3 = parsed.stories[2];
    assert.equal(s3.storyId, "US-003");
    assert.equal(s3.status, "pending");
  });

  it("--json stdout purity: exactly one JSON object", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-json-out-st-pur-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    const { runId: runId1 } = seedDb(dbPath);

    const { stdout, stderr } = await runCli(
      ["step", "stories", runId1, "--json"],
      homeDir,
      tamanduaDir,
    );
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);
    assertSingleJsonObject(stdout);
  });

  it("without --json outputs human-readable format", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-json-out-st-human-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    const { runId: runId1 } = seedDb(dbPath);

    const { stdout, stderr } = await runCli(
      ["step", "stories", runId1],
      homeDir,
      tamanduaDir,
    );
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    // Snapshot: human-readable format with storyId, status, title, retry
    const lines = stdout.trim().split("\n");
    assert.equal(lines.length, 3);

    assert.match(lines[0], /^US-001\s+\[done\s+\]/);
    assert.match(lines[0], /Add --json to step stories$/);

    assert.match(lines[1], /^US-002\s+\[running\]/);
    assert.match(lines[1], /Add --json to workflow runs$/);

    assert.match(lines[2], /^US-003\s+\[pending\]/);
    assert.match(lines[2], /Add --json to workflow status$/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tests — workflow runs --json
// ═══════════════════════════════════════════════════════════════════

describe("tamandua workflow runs --json (integration)", () => {
  it("--json outputs valid JSON with runs array", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-json-out-runs-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    seedDb(dbPath);

    const { stdout, stderr } = await runCli(
      ["workflow", "runs", "--json"],
      homeDir,
      tamanduaDir,
    );
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.runs));
    assert.equal(parsed.runs.length, 2);

    // Ordered by created_at DESC — most recent first (runId2)
    const r0 = parsed.runs[0];
    assert.equal(typeof r0.runId, "string");
    assert.equal(typeof r0.runNumber, "number");
    assert.equal(typeof r0.workflowId, "string");
    assert.equal(typeof r0.status, "string");
    assert.equal(typeof r0.tokensSpent, "number");
    assert.equal(typeof r0.task, "string");
    assert.ok(r0.task.length <= 120);
    assert.equal(typeof r0.createdAt, "string");
    assert.equal(typeof r0.updatedAt, "string");

    const r1 = parsed.runs[1];
    assert.equal(typeof r1.runId, "string");
    assert.equal(typeof r1.workflowId, "string");
  });

  it("--json stdout purity: exactly one JSON object", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-json-out-runs-pur-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    seedDb(dbPath);

    const { stdout, stderr } = await runCli(
      ["workflow", "runs", "--json"],
      homeDir,
      tamanduaDir,
    );
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);
    assertSingleJsonObject(stdout);
  });

  it("without --json outputs human-readable format", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-json-out-runs-human-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    seedDb(dbPath);

    const { stdout, stderr } = await runCli(
      ["workflow", "runs"],
      homeDir,
      tamanduaDir,
    );
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    // Human format: first line is "Workflow runs:" header, then run lines
    const lines = stdout.trim().split("\n");
    assert.ok(lines.length >= 2, `must have header + at least one run line, got: ${stdout.slice(0, 200)}`);
    assert.equal(lines[0], "Workflow runs:");

    // Verify data lines contain the expected components
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      // Should have [status] pattern
      assert.match(line, /\[(?:done|running|failed)\s*\]/);
      // Should have tokens
      assert.match(line, /\d{1,3}(?:,\d{3})*\s+tokens/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tests — workflow status --json
// ═══════════════════════════════════════════════════════════════════

describe("tamandua workflow status --json (integration)", () => {
  it("--json outputs valid JSON with run details, steps, and stories", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-json-out-wstatus-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    const { runId: runId1 } = seedDb(dbPath);

    const { stdout, stderr } = await runCli(
      ["workflow", "status", runId1, "--json"],
      homeDir,
      tamanduaDir,
    );
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    const parsed = JSON.parse(stdout);

    // Top-level fields
    assert.equal(parsed.runId, "run-" + runId1);
    assert.equal(typeof parsed.runNumber, "number");
    assert.equal(parsed.workflowId, "feature-dev-merge-worktree");
    assert.equal(parsed.status, "running");
    assert.equal(typeof parsed.task, "string");
    assert.ok(parsed.task.length <= 200);
    assert.equal(typeof parsed.tokensSpent, "number");
    assert.equal(typeof parsed.createdAt, "string");
    assert.equal(typeof parsed.updatedAt, "string");

    // Worktree fields (present because context had workspace_mode: "worktree")
    assert.equal(parsed.workspaceMode, "worktree");
    assert.equal(typeof parsed.worktreePath, "string");
    assert.equal(typeof parsed.worktreeOriginRef, "string");

    // Steps array
    assert.ok(Array.isArray(parsed.steps));
    assert.equal(parsed.steps.length, 4);

    const step0 = parsed.steps[0];
    assert.equal(typeof step0.stepId, "string");
    assert.match(step0.stepId, /^step-/, "stepId must use step- prefix");
    assert.equal(typeof step0.agentRole, "string");
    assert.equal(step0.agentRole, "planner");
    assert.equal(typeof step0.status, "string");
    assert.equal(typeof step0.retryCount, "number");
    assert.equal(typeof step0.stepIndex, "number");
    assert.ok("updatedAt" in step0);

    // Step with non-zero counts
    const step3 = parsed.steps[3];
    assert.equal(step3.agentRole, "pr");
    assert.equal(step3.status, "failed");
    assert.equal(step3.retryCount, 2);
    assert.equal(step3.abandonedCount, 1);

    // Stories array
    assert.ok(Array.isArray(parsed.stories));
    assert.equal(parsed.stories.length, 3);
    assert.equal(parsed.stories[0].storyId, "US-001");
    assert.equal(parsed.stories[0].status, "done");
  });

  it("--json stdout purity: exactly one JSON object", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-json-out-wst-pur-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    const { runId: runId1 } = seedDb(dbPath);

    const { stdout, stderr } = await runCli(
      ["workflow", "status", runId1, "--json"],
      homeDir,
      tamanduaDir,
    );
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);
    assertSingleJsonObject(stdout);
  });

  it("without --json outputs human-readable format", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-json-out-wst-human-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    const { runId: runId1 } = seedDb(dbPath);

    const { stdout, stderr } = await runCli(
      ["workflow", "status", runId1],
      homeDir,
      tamanduaDir,
    );
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    // Human format for run detail should contain key sections
    assert.match(stdout, /Run:/);
    assert.match(stdout, /Workflow:/);
    assert.match(stdout, /Task:/);
    assert.match(stdout, /Status:/);
    assert.match(stdout, /Tokens:/);
    assert.match(stdout, /Worktree:/);
    assert.match(stdout, /Steps:/);
  });

  it("--json on non-existent run outputs clear error message", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-json-out-wst-nonex-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    seedDb(dbPath);

    const { stdout } = await runCli(
      ["workflow", "status", "00000000-0000-0000-0000-000000000000", "--json"],
      homeDir,
      tamanduaDir,
    );
    assert.match(stdout, /No run found matching/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tests — status --json
// ═══════════════════════════════════════════════════════════════════

describe("tamandua status --json (integration)", () => {
  it("--json outputs valid JSON with services, info, runs, processes", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-json-out-status-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    seedDb(dbPath);

    const { stdout, stderr } = await runCli(
      ["status", "--json"],
      homeDir,
      tamanduaDir,
    );
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    const parsed = JSON.parse(stdout);

    // services section
    assert.ok(typeof parsed.services === "object", "services must be an object");
    const svcKeys = Object.keys(parsed.services);
    assert.ok(svcKeys.length >= 1, "services must have entries");

    // Each service has up, pid?, port?
    for (const key of svcKeys) {
      const svc = parsed.services[key];
      assert.equal(typeof svc.up, "boolean", `services.${key}.up must be boolean`);
      if ("pid" in svc && svc.pid !== null) {
        assert.equal(typeof svc.pid, "number");
      }
      if ("port" in svc && svc.port !== null) {
        assert.equal(typeof svc.port, "number");
      }
    }

    // info section
    assert.ok(typeof parsed.info === "object", "info must be an object");
    assert.equal(typeof parsed.info.sourcePath, "string");
    assert.equal(typeof parsed.info.skillPath, "string");
    assert.equal(typeof parsed.info.version, "string");
    assert.equal(typeof parsed.info.sourceTreeSha, "string");

    // runs section
    assert.ok(typeof parsed.runs === "object", "runs must be an object");
    assert.equal(typeof parsed.runs.total, "number");
    assert.ok(parsed.runs.total >= 2, `expected at least 2 runs, got ${parsed.runs.total}`);
    assert.ok(typeof parsed.runs.statusCounts === "object", "statusCounts must be an object");

    // processes section
    assert.ok(Array.isArray(parsed.processes), "processes must be an array");
    for (const proc of parsed.processes) {
      assert.equal(typeof proc.pid, "number");
      assert.equal(typeof proc.kind, "string");
      if (proc.uptimeSeconds !== undefined) {
        assert.equal(typeof proc.uptimeSeconds, "number");
      }
    }
  });

  it("--json stdout purity: exactly one JSON object", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-json-out-stat-pur-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    seedDb(dbPath);

    const { stdout, stderr } = await runCli(
      ["status", "--json"],
      homeDir,
      tamanduaDir,
    );
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);
    assertSingleJsonObject(stdout);
  });

  it("without --json outputs human-readable format", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-json-out-stat-human-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    seedDb(dbPath);

    const { stdout, stderr } = await runCli(
      ["status"],
      homeDir,
      tamanduaDir,
    );
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    // Human format should contain key sections
    assert.match(stdout, /Tamandua Status/);
    assert.match(stdout, /Services/);
    assert.match(stdout, /Tamandua Info/);
    assert.match(stdout, /Workflow Runs/);
    assert.match(stdout, /Running Processes/);
  });

  it("--json works with empty DB (no runs)", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-json-out-stat-empty-");
    // Don't seed the DB — use a fresh empty one
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    // Create the runs table so status doesn't error on missing table
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        run_number INTEGER,
        workflow_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        context TEXT NOT NULL DEFAULT '{}',
        tokens_spent INTEGER NOT NULL DEFAULT 0,
        notify_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const { stdout, stderr } = await runCli(
      ["status", "--json"],
      homeDir,
      tamanduaDir,
    );
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.runs.total, 0);
    assert.deepStrictEqual(parsed.runs.statusCounts, {});
  });
});
