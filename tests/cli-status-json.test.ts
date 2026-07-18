/**
 * Tests for tamandua status --json (US-004).
 *
 * Validates:
 * 1. tamandua status --json outputs a single JSON object with services, info, runs, processes
 * 2. services section has dashboard, daemon, mcp, controlPlane each with up, pid?, port?
 * 3. info section has sourcePath, skillPath, version, sourceTreeSha
 * 4. runs section has total and statusCounts map
 * 5. processes section is an array of {pid, kind, uptimeSeconds?}
 * 6. Without --json, output matches current human-readable format structure
 * 7. With --json, stdout contains exactly one JSON object and nothing else
 * 8. getStatusHelp() documents --json flag
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
import crypto from "node:crypto";

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
 * Seed a temp DB with some runs so the status summary has data.
 */
function seedDb(dbPath: string): void {
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
      scheduling_status TEXT,
      scheduling_error TEXT,
      scheduling_requested_at TEXT,
      worker_lost_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS steps (
      id TEXT,
      step_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'waiting',
      type TEXT NOT NULL DEFAULT 'single',
      retry_count INTEGER NOT NULL DEFAULT 0,
      abandoned_count INTEGER NOT NULL DEFAULT 0,
      reroute_count INTEGER NOT NULL DEFAULT 0,
      claim_pid INTEGER,
      claim_updated_at TEXT,
      input_template TEXT NOT NULL DEFAULT '',
      expects TEXT NOT NULL DEFAULT '',
      output TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (step_id, run_id)
    )
  `);

  const now = new Date().toISOString();

  // Seed several runs with different statuses
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(), 1, "feature-dev-merge-worktree", "Add dark mode toggle", "running", "{}", 5432, now, now,
  );
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(), 2, "bug-fix-github-pr", "Fix login redirect loop", "paused", "{}", 3210, now, now,
  );
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(), 3, "feature-dev-merge", "Add --json to tamandua status", "completed", "{}", 8888, now, now,
  );
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(), 4, "code-review", "Review PR #42", "failed", "{}", 400, now, now,
  );

  db.close();
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe("tamandua status --json", () => {
  // AC 1: --json outputs a single JSON object with services, info, runs, processes
  it("--json outputs valid JSON with top-level sections", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-json-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    seedDb(dbPath);

    const { stdout, stderr } = await runCli(["status", "--json"], homeDir, tamanduaDir);
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    const parsed = JSON.parse(stdout);

    // Top-level sections
    assert.equal(typeof parsed.services, "object");
    assert.equal(typeof parsed.info, "object");
    assert.equal(typeof parsed.runs, "object");
    assert.ok(Array.isArray(parsed.processes), "processes must be an array");
  });

  // AC 2: services section has dashboard, daemon, mcp, controlPlane each with up, pid?, port?
  it("--json services section has correct shape", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-services-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    seedDb(dbPath);

    const { stdout } = await runCli(["status", "--json"], homeDir, tamanduaDir);
    const parsed = JSON.parse(stdout);

    const svc = parsed.services;

    // Dashboard
    assert.equal(typeof svc.dashboard, "object");
    assert.equal(typeof svc.dashboard.up, "boolean");
    assert.equal(typeof svc.dashboard.port, "number");
    // pid is optional per spec; when present when up, it's a number
    if (svc.dashboard.pid !== undefined) {
      assert.equal(typeof svc.dashboard.pid, "number");
    }

    // Daemon
    assert.equal(typeof svc.daemon, "object");
    assert.equal(typeof svc.daemon.up, "boolean");
    assert.equal(typeof svc.daemon.port, "number");
    // pid is optional per spec (synchronous PID-file check, always present when up)
    if (svc.daemon.up) {
      assert.equal(typeof svc.daemon.pid, "number", "pid should be a number when daemon is up");
    }

    // MCP
    assert.equal(typeof svc.mcp, "object");
    assert.equal(typeof svc.mcp.up, "boolean");
    assert.equal(typeof svc.mcp.port, "number");
    assert.equal(typeof svc.mcp.endpoint, "string");
    // pid is optional per spec (async HTTP probe may return up:true with pid:null)
    if (svc.mcp.pid !== undefined) {
      assert.equal(typeof svc.mcp.pid, "number");
    }

    // Control-plane
    assert.equal(typeof svc.controlPlane, "object");
    assert.equal(typeof svc.controlPlane.up, "boolean");
    assert.equal(typeof svc.controlPlane.port, "number");
    assert.equal(typeof svc.controlPlane.endpoint, "string");
    // pid is optional per spec (async HTTP probe may return up:true with pid:null)
    if (svc.controlPlane.pid !== undefined) {
      assert.equal(typeof svc.controlPlane.pid, "number");
    }
  });

  // AC 3: info section has sourcePath, skillPath, version, sourceTreeSha
  it("--json info section has correct fields", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-info-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    seedDb(dbPath);

    const { stdout } = await runCli(["status", "--json"], homeDir, tamanduaDir);
    const parsed = JSON.parse(stdout);

    const info = parsed.info;
    assert.equal(typeof info, "object");
    assert.equal(typeof info.sourcePath, "string");
    assert.ok(info.sourcePath.length > 0);
    assert.equal(typeof info.skillPath, "string");
    assert.ok(info.skillPath.length > 0);
    assert.equal(typeof info.version, "string");
    assert.ok(info.version.length > 0);
    assert.equal(typeof info.sourceTreeSha, "string");
    assert.ok(info.sourceTreeSha.length > 0);
  });

  // AC 4: runs section has total and statusCounts map
  it("--json runs section has total and statusCounts", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-runs-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    seedDb(dbPath);

    const { stdout } = await runCli(["status", "--json"], homeDir, tamanduaDir);
    const parsed = JSON.parse(stdout);

    const runs = parsed.runs;
    assert.equal(typeof runs.total, "number");
    assert.equal(runs.total, 4, "should have 4 seeded runs");
    assert.equal(typeof runs.statusCounts, "object");

    // Verify status counts
    assert.equal(runs.statusCounts.running, 1);
    assert.equal(runs.statusCounts.paused, 1);
    assert.equal(runs.statusCounts.completed, 1);
    assert.equal(runs.statusCounts.failed, 1);
  });

  // AC 5: processes section is an array of {pid, kind, uptimeSeconds?}
  it("--json processes section has correct shape when daemon down", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-process-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    seedDb(dbPath);

    const { stdout } = await runCli(["status", "--json"], homeDir, tamanduaDir);
    const parsed = JSON.parse(stdout);

    assert.ok(Array.isArray(parsed.processes));
    // When daemon is down, processes array should be empty (no ps scan needed)
    // or may have entries if somehow processes are found
    for (const p of parsed.processes) {
      assert.equal(typeof p.pid, "number");
      assert.equal(typeof p.kind, "string");
      assert.ok(["pi", "hermes", "tamandua", "unknown"].includes(p.kind));
      if (p.uptimeSeconds !== undefined) {
        assert.equal(typeof p.uptimeSeconds, "number");
      }
    }
  });

  // AC 6: Without --json, output has expected human-readable structure
  it("without --json outputs human-readable format structure", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-human-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    seedDb(dbPath);

    const { stdout, stderr } = await runCli(["status"], homeDir, tamanduaDir);
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    // Verify the human output structure hasn't changed
    assert.match(stdout, /^Tamandua Status\n/);
    assert.match(stdout, /===============/);
    assert.match(stdout, /Services/);
    assert.match(stdout, /--------/);
    assert.match(stdout, /---/);
    assert.match(stdout, /Tamandua Info/);
    assert.match(stdout, /Source tree:/);
    assert.match(stdout, /Workflow Runs/);
    assert.match(stdout, /Running Processes/);
  });

  // AC 7: With --json, stdout contains exactly one JSON object and nothing else
  it("--json stdout purity: exactly one JSON object", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-purity-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    seedDb(dbPath);

    const { stdout, stderr } = await runCli(["status", "--json"], homeDir, tamanduaDir);
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

  // AC 8: getStatusHelp() documents --json flag
  it("--help documents --json flag", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-help-");

    const { stdout } = await runCli(["status", "--help"], homeDir, tamanduaDir);
    assert.match(stdout, /--json/);
    assert.match(stdout, /machine consumption/);
  });

  // Edge case: status --json with no runs in DB
  it("--json with empty DB returns valid shape", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-empty-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    // Don't seed any runs — just create the schema so it doesn't crash
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
        tokens_spent INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.close();

    const { stdout } = await runCli(["status", "--json"], homeDir, tamanduaDir);
    const parsed = JSON.parse(stdout);

    assert.equal(typeof parsed.services, "object");
    assert.equal(typeof parsed.info, "object");
    assert.equal(typeof parsed.runs, "object");
    assert.equal(parsed.runs.total, 0);
    assert.equal(typeof parsed.runs.statusCounts, "object");
    assert.equal(Object.keys(parsed.runs.statusCounts).length, 0);
    assert.ok(Array.isArray(parsed.processes));
  });

  // Verify status command still works without --json (no regression)
  it("without --json produces non-JSON human output", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-non-json-");
    const dbPath = path.join(tamanduaDir, "tamandua.db");
    seedDb(dbPath);

    const { stdout } = await runCli(["status"], homeDir, tamanduaDir);

    // Should NOT parse as JSON
    assert.throws(() => JSON.parse(stdout));
    // Should have the expected human output markers
    assert.match(stdout, /Tamandua Status/);
  });
});
