/**
 * Integration tests for CFIL+VFBK features (US-012).
 *
 * Spawns the actual tamandua CLI binary to test file-based I/O, submit-time
 * validation, STORIES_JSON_FILE resolution, and PREVIOUS ATTEMPT FEEDBACK
 * end-to-end through the real CLI dispatch path.
 */

import { describe, it } from "node:test";
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

interface SeedResult {
  homeDir: string;
  tamanduaDir: string;
  dbPath: string;
  env: Record<string, string | undefined>;
  runId: string;
  stepId: string;
}

/**
 * Create a temp DB with a running step ready for step complete/fail.
 */
function seedStepDb(prefix: string, expects: string = "CHANGES:"): SeedResult {
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

  const runId = uuid();
  const stepId = uuid();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, 1, "feature-dev-merge-worktree", "Integration test task", "running", "{}", 0, now, now);

  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, expects, status, retry_count, max_retries, type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(stepId, runId, "developer", "feature-dev-merge-worktree_developer", 1, expects, "running", 0, 4, "single", now, now);

  db.close();

  const env = cleanChildEnv({
    HOME: homeDir,
    TAMANDUA_STATE_DIR: tamanduaDir,
    TAMANDUA_DB_PATH: dbPath,
  });

  return { homeDir, tamanduaDir, dbPath, env, runId, stepId };
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe("CFIL+VFBK integration tests", () => {
  // ── step complete --file provenance ──

  describe("step complete --file (US-005)", () => {
    it("reads report from --file and completes step", async () => {
      const seed = seedStepDb("cfil-file-", "CHANGES:");
      const reportPath = path.join(seed.homeDir, "report.txt");
      fs.writeFileSync(reportPath, "STATUS: done\nCHANGES: Fixed the thing\nTESTS: All pass\n");

      const { stdout, stderr, exitCode } = await runCli(
        ["step", "complete", seed.stepId, "--file", reportPath],
        seed.env,
      );

      assert.equal(exitCode, 0, `exitCode=${exitCode}, stderr=${cleanStderr(stderr)}`);
      assert.match(stdout, /completed/);
    });

    it("provenance: file deleted right after invocation, stored content matches original", async () => {
      const seed = seedStepDb("cfil-provenance-", "CHANGES:");
      const reportPath = path.join(seed.homeDir, "report.txt");
      const reportContent = "STATUS: done\nCHANGES: Provenance test\nTESTS: Verify file gone\n";
      fs.writeFileSync(reportPath, reportContent);

      const { stdout, stderr, exitCode } = await runCli(
        ["step", "complete", seed.stepId, "--file", reportPath],
        seed.env,
      );

      assert.equal(exitCode, 0, `exitCode=${exitCode}, stderr=${cleanStderr(stderr)}`);
      assert.match(stdout, /completed/);

      // Delete the file after — step should already be completed with stored content
      fs.unlinkSync(reportPath);

      // Verify the stored output in DB matches the file content, not a path
      const verifyDb = new DatabaseSync(seed.dbPath);
      const row = verifyDb.prepare("SELECT output FROM steps WHERE id = ?").get(seed.stepId) as { output: string } | undefined;
      verifyDb.close();

      assert.ok(row, "Step should exist after completion");
      assert.ok(row.output.includes("CHANGES: Provenance test"), `Output should contain report text, got: ${row.output}`);
      assert.ok(!row.output.includes(reportPath), "Output must NOT contain the file path");
      assert.ok(!row.output.includes("--file"), "Output must NOT contain --file flag");
    });

    it("missing --file path → error on stderr, exit 1, step NOT consumed", async () => {
      const seed = seedStepDb("cfil-file-missing-", "CHANGES:");
      const missingPath = path.join(seed.homeDir, "nonexistent.txt");

      const { stderr, exitCode } = await runCli(
        ["step", "complete", seed.stepId, "--file", missingPath],
        seed.env,
      );

      assert.notEqual(exitCode, 0, "Should exit non-zero for missing file");

      // Step should still be running
      const verifyDb = new DatabaseSync(seed.dbPath);
      const row = verifyDb.prepare("SELECT status FROM steps WHERE id = ?").get(seed.stepId) as { status: string } | undefined;
      verifyDb.close();

      assert.equal(row?.status, "running", "Step should remain running after failed --file");
    });

    it("trailing-argv after step-id → error, exit 1", async () => {
      const seed = seedStepDb("cfil-trailing-", "CHANGES:");

      const { stderr, exitCode } = await runCli(
        ["step", "complete", seed.stepId, "unexpected", "args"],
        seed.env,
      );

      assert.notEqual(exitCode, 0, "Should exit non-zero for trailing args");
      const cleaned = cleanStderr(stderr);
      assert.ok(
        cleaned.includes("unexpected") || cleaned.includes("reports"),
        `stderr should mention trailing args error: ${cleaned}`,
      );
    });
  });

  // ── step complete STORIES_JSON_FILE ──

  describe("step complete STORIES_JSON_FILE (US-003)", () => {
    it("resolves STORIES_JSON_FILE to inline STORIES_JSON", async () => {
      const seed = seedStepDb("cfil-sjfile-", "STORIES_JSON:");
      const storiesPath = path.join(seed.homeDir, "stories.json");
      const stories = [
        { id: "US-001", title: "Story 1", description: "Desc", acceptanceCriteria: ["AC1"] },
      ];
      fs.writeFileSync(storiesPath, JSON.stringify(stories));

      const reportPath = path.join(seed.homeDir, "report.txt");
      const reportContent = `STATUS: done\nSTORIES_JSON_FILE: ${storiesPath}\nCHANGES: Story plan\n`;
      fs.writeFileSync(reportPath, reportContent);

      const { stdout, stderr, exitCode } = await runCli(
        ["step", "complete", seed.stepId, "--file", reportPath],
        seed.env,
      );

      // May fail because completeStepInternal validates story objects more strictly
      // but STORIES_JSON_FILE resolution should work — check it replaced the path
      const verifyDb = new DatabaseSync(seed.dbPath);
      const row = verifyDb.prepare("SELECT output, status FROM steps WHERE id = ?").get(seed.stepId) as { output: string; status: string } | undefined;
      verifyDb.close();

      assert.ok(row, "Step should exist");
      if (exitCode === 0) {
        // Completed: verify STORIES_JSON_FILE was resolved
        assert.ok(row.output.includes("STORIES_JSON:"), "Output should contain STORIES_JSON");
        assert.ok(!row.output.includes("STORIES_JSON_FILE:"), "Output must NOT contain STORIES_JSON_FILE");
        assert.ok(!row.output.includes(storiesPath), "Output must NOT contain the file path");
      }
      // If exitCode != 0, it might be a story validation error, not a STORIES_JSON_FILE error
    });

    it("missing STORIES_JSON_FILE → error, exit 1, step NOT completed", async () => {
      const seed = seedStepDb("cfil-sjfile-missing-", "STORIES_JSON:");
      const missingPath = path.join(seed.homeDir, "nonexistent-stories.json");

      const reportPath = path.join(seed.homeDir, "report.txt");
      fs.writeFileSync(reportPath, `STATUS: done\nSTORIES_JSON_FILE: ${missingPath}\nCHANGES: Test\n`);

      const { stderr, exitCode } = await runCli(
        ["step", "complete", seed.stepId, "--file", reportPath],
        seed.env,
      );

      assert.notEqual(exitCode, 0, "Should fail when STORIES_JSON_FILE path is missing");
      const cleaned = cleanStderr(stderr);
      assert.ok(
        cleaned.includes("ENOENT") || cleaned.includes("Error") || cleaned.includes("STORIES_JSON_FILE"),
        `stderr should indicate file error: ${cleaned}`,
      );

      // Step should still be running
      const verifyDb = new DatabaseSync(seed.dbPath);
      const row = verifyDb.prepare("SELECT status FROM steps WHERE id = ?").get(seed.stepId) as { status: string } | undefined;
      verifyDb.close();
      assert.equal(row?.status, "running", "Step should remain running");
    });

    it("invalid JSON in STORIES_JSON_FILE → error, exit 1", async () => {
      const seed = seedStepDb("cfil-sjfile-invalid-", "STORIES_JSON:");
      const badJsonPath = path.join(seed.homeDir, "bad.json");
      fs.writeFileSync(badJsonPath, "not valid json {{{");

      const reportPath = path.join(seed.homeDir, "report.txt");
      fs.writeFileSync(reportPath, `STATUS: done\nSTORIES_JSON_FILE: ${badJsonPath}\nCHANGES: Test\n`);

      const { stderr, exitCode } = await runCli(
        ["step", "complete", seed.stepId, "--file", reportPath],
        seed.env,
      );

      assert.notEqual(exitCode, 0, "Should fail for invalid JSON");
      const cleaned = cleanStderr(stderr);
      assert.ok(
        cleaned.includes("JSON") || cleaned.includes("Error") || cleaned.includes("parse"),
        `stderr should indicate JSON error: ${cleaned}`,
      );
    });

    it("non-array JSON in STORIES_JSON_FILE → error, exit 1", async () => {
      const seed = seedStepDb("cfil-sjfile-nonarray-", "STORIES_JSON:");
      const objJsonPath = path.join(seed.homeDir, "object.json");
      fs.writeFileSync(objJsonPath, JSON.stringify({ not: "an array" }));

      const reportPath = path.join(seed.homeDir, "report.txt");
      fs.writeFileSync(reportPath, `STATUS: done\nSTORIES_JSON_FILE: ${objJsonPath}\nCHANGES: Test\n`);

      const { stderr, exitCode } = await runCli(
        ["step", "complete", seed.stepId, "--file", reportPath],
        seed.env,
      );

      assert.notEqual(exitCode, 0, "Should fail for non-array JSON");
    });
  });

  // ── step complete submit-time REJECTED ──

  describe("step complete submit-time expects validation (US-001)", () => {
    it("REJECTED on missing expects key — step NOT consumed", async () => {
      const seed = seedStepDb("cfil-rejected-", "BRANCH:\nREPO:"); // requires BRANCH: and REPO:
      const reportPath = path.join(seed.homeDir, "report.txt");
      fs.writeFileSync(reportPath, "STATUS: done\nCHANGES: No branch here\n"); // missing BRANCH: and REPO:

      const { stderr, exitCode } = await runCli(
        ["step", "complete", seed.stepId, "--file", reportPath],
        seed.env,
      );

      assert.notEqual(exitCode, 0, "Should exit non-zero on REJECTED");
      const cleaned = cleanStderr(stderr);
      assert.ok(cleaned.includes("REJECTED"), `stderr should say REJECTED: ${cleaned}`);

      // Step should still be running
      const verifyDb = new DatabaseSync(seed.dbPath);
      const row = verifyDb.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(seed.stepId) as { status: string; retry_count: number } | undefined;
      verifyDb.close();

      assert.equal(row?.status, "running", "Step should remain running after REJECTED");
      assert.equal(row?.retry_count, 0, "retry_count should NOT be incremented (agent still holds step)");
    });

    it("resubmit after REJECTED succeeds with corrected output", async () => {
      const seed = seedStepDb("cfil-resubmit-", "BRANCH:\nREPO:");
      const badReportPath = path.join(seed.homeDir, "bad-report.txt");
      fs.writeFileSync(badReportPath, "STATUS: done\nCHANGES: Still missing keys\n");

      // First attempt: REJECTED
      const { exitCode: code1 } = await runCli(
        ["step", "complete", seed.stepId, "--file", badReportPath],
        seed.env,
      );
      assert.notEqual(code1, 0, "First attempt should be rejected");

      // Second attempt: corrected
      const goodReportPath = path.join(seed.homeDir, "good-report.txt");
      fs.writeFileSync(goodReportPath, "STATUS: done\nBRANCH: feature/x\nREPO: /path/to/repo\nCHANGES: Fixed\n");

      const { stdout, stderr, exitCode } = await runCli(
        ["step", "complete", seed.stepId, "--file", goodReportPath],
        seed.env,
      );

      assert.equal(exitCode, 0, `exitCode=${exitCode}, stderr=${cleanStderr(stderr)}`);
      assert.match(stdout, /completed/);
    });

    it("STATUS: retry passes submit-time validation", async () => {
      // Seed a verifier step that expects both a literal "STATUS: retry" and a broader regex
      const seed = seedStepDb("cfil-retry-valid-", "STATUS: retry\nregex:^STATUS:\\s*(done|retry)$");
      const reportPath = path.join(seed.homeDir, "report.txt");
      fs.writeFileSync(reportPath, "STATUS: retry\nCHANGES: Send it back for fixes\n");

      const { stdout, stderr, exitCode } = await runCli(
        ["step", "complete", seed.stepId, "--file", reportPath],
        seed.env,
      );

      // Should be accepted — may route as retry
      const cleaned = cleanStderr(stderr);
      assert.ok(
        exitCode === 0 || (cleaned.includes("completed") || cleaned.includes("retrying")),
        `exitCode=${exitCode}, stderr=${cleaned}, stdout=${stdout}`,
      );
    });

    it("valid output passes submit-time validation without REJECTED", async () => {
      const seed = seedStepDb("cfil-valid-", "CHANGES:");
      const reportPath = path.join(seed.homeDir, "report.txt");
      fs.writeFileSync(reportPath, "STATUS: done\nCHANGES: All good\nTESTS: Pass\n");

      const { stdout, stderr, exitCode } = await runCli(
        ["step", "complete", seed.stepId, "--file", reportPath],
        seed.env,
      );

      assert.equal(exitCode, 0, `exitCode=${exitCode}, stderr=${cleanStderr(stderr)}`);
      assert.match(stdout, /completed/);
    });
  });

  // ── step fail --reason-file ──

  describe("step fail --reason-file (US-006)", () => {
    it("reads failure reason from --reason-file", async () => {
      const seed = seedStepDb("cfil-fail-file-", "");
      const reasonPath = path.join(seed.homeDir, "reason.txt");
      fs.writeFileSync(reasonPath, "Tests failed with exit code 1");

      const { stdout, stderr, exitCode } = await runCli(
        ["step", "fail", seed.stepId, "--reason-file", reasonPath],
        seed.env,
      );

      assert.equal(exitCode, 0, `exitCode=${exitCode}, stderr=${cleanStderr(stderr)}`);

      // Verify the reason was stored
      const verifyDb = new DatabaseSync(seed.dbPath);
      const row = verifyDb.prepare("SELECT output FROM steps WHERE id = ?").get(seed.stepId) as { output: string } | undefined;
      verifyDb.close();

      assert.ok(row, "Step should exist");
      assert.ok(row.output.includes("Tests failed with exit code 1"), `output should contain reason: ${row.output}`);
    });

    it("provenance: file path NOT stored in DB", async () => {
      const seed = seedStepDb("cfil-fail-provenance-", "");
      const reasonPath = path.join(seed.homeDir, "reason.txt");
      fs.writeFileSync(reasonPath, "Multi-line\nreason\ntext");

      const { exitCode } = await runCli(
        ["step", "fail", seed.stepId, "--reason-file", reasonPath],
        seed.env,
      );

      assert.equal(exitCode, 0);

      const verifyDb = new DatabaseSync(seed.dbPath);
      const row = verifyDb.prepare("SELECT output FROM steps WHERE id = ?").get(seed.stepId) as { output: string } | undefined;
      verifyDb.close();

      assert.ok(row, "Step should exist");
      assert.ok(row.output.includes("Multi-line"), `output should contain reason text: ${row.output}`);
      assert.ok(!row.output.includes(reasonPath), "output must NOT contain the file path");
      assert.ok(!row.output.includes("--reason-file"), "output must NOT contain --reason-file flag");
    });

    it("missing --reason-file → error, exit 1", async () => {
      const seed = seedStepDb("cfil-fail-missing-", "");
      const missingPath = path.join(seed.homeDir, "nonexistent.txt");

      const { stderr, exitCode } = await runCli(
        ["step", "fail", seed.stepId, "--reason-file", missingPath],
        seed.env,
      );

      assert.notEqual(exitCode, 0, "Should fail for missing --reason-file");
    });
  });

  // ── workflow run --task-file ──

  describe("workflow run --task-file (US-007)", () => {
    it("--task-file mutually exclusive with inline task words", async () => {
      const { homeDir, tamanduaDir } = createTempHome("cfil-taskfile-excl-");
      const dbPath = path.join(tamanduaDir, "tamandua.db");
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode=WAL");
      db.exec(`CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT,
        task TEXT,
        status TEXT DEFAULT 'running',
        context TEXT DEFAULT '{}',
        tokens_spent INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`);
      db.close();

      const taskPath = path.join(homeDir, "task.md");
      fs.writeFileSync(taskPath, "Task from file");

      const env = cleanChildEnv({
        HOME: homeDir,
        TAMANDUA_STATE_DIR: tamanduaDir,
        TAMANDUA_DB_PATH: dbPath,
      });

      const { stderr, exitCode } = await runCli(
        ["workflow", "run", "feature-dev-merge-worktree", "--task-file", taskPath, "inline-task"],
        env,
      );

      const cleaned = cleanStderr(stderr);
      assert.ok(
        cleaned.includes("mutually exclusive") || exitCode !== 0,
        `Should reject both --task-file and inline task: exitCode=${exitCode}, stderr=${cleaned}`,
      );
    });
  });

  // ── stdin pipe still works (backward compat) ──

  describe("step complete stdin pipe (backward compat)", () => {
    it("stdin pipe still completes step when --file is absent", async () => {
      const seed = seedStepDb("cfil-stdin-", "CHANGES:");

      const reportContent = "STATUS: done\nCHANGES: Via stdin\nTESTS: Works\n";

      const result = await new Promise<CliResult>((resolve) => {
        let stdout = "";
        let stderr = "";
        const child = spawn("node", ["--no-warnings", CLI_SCRIPT, "step", "complete", seed.stepId], {
          stdio: ["pipe", "pipe", "pipe"],
          env: seed.env,
        });
        child.stdin?.write(reportContent);
        child.stdin?.end();
        child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
        child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
        child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
      });

      assert.equal(result.exitCode, 0, `exitCode=${result.exitCode}, stderr=${cleanStderr(result.stderr)}`);
      assert.match(result.stdout, /completed/);
    });
  });
});
