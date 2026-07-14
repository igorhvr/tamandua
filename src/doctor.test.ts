/**
 * Unit tests for the doctor module (US-002).
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../dist/lib/temp-dir.js";

import { DatabaseSync } from "node:sqlite";

import { runDoctorChecks, runLlmPromptAdherenceChecks, formatDoctorOutput } from "../dist/doctor.js";
import type { DoctorCheckResult, CheckGroup } from "../dist/doctor.js";
import {
  startDaemon,
  stopDaemon,
  isRunning,
  getLogFile,
  getPidFile,
  getMcpPidFile,
  getPortFile,
  getMcpPortFile,
  getControlPlanePortFile,
  readPort,
  writePort,
  readMcpPort,
  writeMcpPort,
} from "../dist/server/daemonctl.js";
import { spawn } from "node:child_process";
import { getBuildVersion } from "../dist/lib/version.js";

// ── Test-isolation DB setup ────────────────────────────────────

/** Isolated DB path set up before each test so STATE checks don't touch the real DB. */
let originalDbPath: string | undefined;
let guardHomeDir: string;

beforeEach(() => {
  originalDbPath = process.env.TAMANDUA_DB_PATH;
  guardHomeDir = createTempHome();
  const dbPath = path.join(guardHomeDir, ".tamandua", "tamandua.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  // Write an empty file; getDb() → migrate() creates all required tables.
  fs.writeFileSync(dbPath, "");
  process.env.TAMANDUA_DB_PATH = dbPath;
});

afterEach(() => {
  if (originalDbPath !== undefined) {
    process.env.TAMANDUA_DB_PATH = originalDbPath;
  } else {
    delete process.env.TAMANDUA_DB_PATH;
  }
  try { fs.rmSync(guardHomeDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ── Helpers ──────────────────────────────────────────────────────

function createTempHome(): string {
  // Use mkdtempSync directly because this function is called from
  // beforeEach(), and createTempHome's after() hook would fire
  // immediately after beforeEach() instead of after the tests.
  return tamanduaTempDir("tamandua-doctor-svc-");
}

/** Set up an empty isolated DB at the given homeDir, returning the dbPath. */
function setupEmptyDb(homeDir: string): string {
  const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  // createTables uses getDb() via our module — but we need a standalone
  // connection to pre-create tables. We'll just create an empty file;
  // getDb() will run migrate() which creates all required tables.
  fs.writeFileSync(dbPath, "");
  return dbPath;
}

/** Seed a DB with a zombie run (all steps terminal, run still 'running' for >60 min). */
function seedZombieRun(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running', context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, step_index INTEGER NOT NULL,
      input_template TEXT NOT NULL, expects TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting', output TEXT,
      retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 4,
      type TEXT NOT NULL DEFAULT 'single', loop_config TEXT,
      current_story_id TEXT, abandoned_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  const runId = "zombie-run-001";
  const now = new Date();
  const staleTime = new Date(now.getTime() - 75 * 60 * 1000); // 75 min ago
  db.prepare("INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(runId, "test-workflow", "test", "running", staleTime.toISOString(), staleTime.toISOString());
  // All steps are done (terminal) — no pending or running steps
  db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("z-step-1", runId, "dev", "dev-agent", 0, "do work", "STATUS:", "done", staleTime.toISOString(), staleTime.toISOString());
  db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("z-step-2", runId, "verify", "verify-agent", 1, "verify", "STATUS:", "done", staleTime.toISOString(), staleTime.toISOString());
  db.close();
}

/** Seed a DB with synthetic runs/steps/context for LLM PROMPT ADHERENCE testing. */
function seedPromptAdherenceDb(
  dbPath: string,
  runs: Array<{
    id: string;
    workflowId: string;
    status: string;
    context: Record<string, string>;
    updatedAt?: string;
    steps: Array<{
      stepId: string;
      inputTemplate: string;
      status?: string;
    }>;
  }>,
): void {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
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
      run_id TEXT NOT NULL,
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

  for (const run of runs) {
    const now = new Date();
    const updatedAt = run.updatedAt || now.toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(run.id, run.workflowId, "test task", run.status, JSON.stringify(run.context), updatedAt, updatedAt);

    for (let i = 0; i < run.steps.length; i++) {
      const step = run.steps[i];
      db.prepare(
        "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        `step-${run.id}-${i}`,
        run.id,
        step.stepId,
        `${step.stepId}-agent`,
        i,
        step.inputTemplate,
        "STATUS:",
        step.status ?? "done",
        now.toISOString(),
        now.toISOString(),
      );
    }
  }

  db.close();
}

async function getAvailablePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("No address")));
      }
    });
  });
}

describe("DoctorCheckResult type", () => {
  it("accepts a valid pass result", () => {
    const r: DoctorCheckResult = {
      name: "Node.js >= 22",
      status: "pass",
      message: "v22.0.0 detected",
    };
    assert.strictEqual(r.name, "Node.js >= 22");
    assert.strictEqual(r.status, "pass");
    assert.strictEqual(r.message, "v22.0.0 detected");
  });

  it("accepts a valid fail result with remedy", () => {
    const r: DoctorCheckResult = {
      name: "Node.js >= 22",
      status: "fail",
      message: "v18.0.0 is too old",
      remedy: "Install Node.js >= 22 from https://nodejs.org",
    };
    assert.strictEqual(r.status, "fail");
    assert.strictEqual(r.remedy, "Install Node.js >= 22 from https://nodejs.org");
  });

  it("accepts a valid warn result with remedy", () => {
    const r: DoctorCheckResult = {
      name: "Daemon build version",
      status: "warn",
      message: "Unable to determine staleness",
      remedy: "Run: tamandua daemon restart",
    };
    assert.strictEqual(r.status, "warn");
    assert.strictEqual(typeof r.remedy, "string");
  });

  it("accepts a valid info result without remedy", () => {
    const r: DoctorCheckResult = {
      name: "pi-token-saver",
      status: "info",
      message: "pi-token-saver not found (optional)",
    };
    assert.strictEqual(r.status, "info");
    assert.strictEqual(r.remedy, undefined);
  });

  it("DoctorCheckResult rejects invalid status at compile time (verified by typecheck)", () => {
    // This test verifies type shape at runtime — TypeScript ensures
    // invalid status values are caught at compile time.
    const r: DoctorCheckResult = { name: "test", status: "pass", message: "ok" };
    assert.ok(r);
  });
});

describe("CheckGroup type", () => {
  it("allows a group with label and checks", () => {
    const checks: DoctorCheckResult[] = [
      { name: "check1", status: "pass", message: "ok" },
      { name: "check2", status: "fail", message: "broken", remedy: "fix it" },
    ];
    const group: CheckGroup = { label: "ENVIRONMENT", checks };
    assert.strictEqual(group.label, "ENVIRONMENT");
    assert.strictEqual(group.checks.length, 2);
    assert.strictEqual(group.checks[0].status, "pass");
    assert.strictEqual(group.checks[1].status, "fail");
  });
});

describe("runDoctorChecks", () => {
  it("returns five check groups", async () => {
    const groups = await runDoctorChecks();
    assert.strictEqual(groups.length, 5, `Expected 5 check groups, got ${groups.length}`);
  });

  it("each group has a label and checks array", async () => {
    const groups = await runDoctorChecks();
    const labels = groups.map((g) => g.label);
    assert.deepStrictEqual(labels, ["ENVIRONMENT", "SERVICES", "STALENESS", "STATE", "LLM PROMPT ADHERENCE"]);
    for (const group of groups) {
      if (group.label === "LLM PROMPT ADHERENCE") {
        // LLM PROMPT ADHERENCE can have 0 checks on an empty database
        assert.ok(Array.isArray(group.checks), `Group "${group.label}" should have a checks array`);
      } else {
        assert.ok(group.checks.length > 0, `Group "${group.label}" should have checks`);
      }
      for (const check of group.checks) {
        assert.strictEqual(typeof check.name, "string");
        assert.ok(["pass", "fail", "warn", "info"].includes(check.status),
          `check "${check.name}" has invalid status: ${check.status}`);
        assert.strictEqual(typeof check.message, "string");
      }
    }
  });

  it("ENVIRONMENT group has at least 8 checks", async () => {
    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);
    assert.ok(env!.checks.length >= 8, `Expected at least 8 ENVIRONMENT checks, got ${env!.checks.length}`);
  });

  it("SERVICES group has 5 checks", async () => {
    const groups = await runDoctorChecks({ homeDir: guardHomeDir });
    const svc = groups.find((g) => g.label === "SERVICES");
    assert.ok(svc);
    assert.strictEqual(svc!.checks.length, 5);
  });

  it("STALENESS group has 2 checks", async () => {
    const groups = await runDoctorChecks();
    const staleness = groups.find((g) => g.label === "STALENESS");
    assert.ok(staleness);
    assert.strictEqual(staleness!.checks.length, 2);
  });

  it("STATE group has at least 2 checks", async () => {
    const groups = await runDoctorChecks();
    const state = groups.find((g) => g.label === "STATE");
    assert.ok(state);
    assert.ok(state!.checks.length >= 2,
      `Expected STATE group to have at least 2 checks, got ${state!.checks.length}`);
  });

  it("STATE group includes a Database opens check", async () => {
    const groups = await runDoctorChecks();
    const state = groups.find((g) => g.label === "STATE");
    assert.ok(state);
    const dbCheck = state!.checks.find((c) => c.name === "Database opens");
    assert.ok(dbCheck, "Expected 'Database opens' check");
    assert.ok(["pass", "fail"].includes(dbCheck!.status),
      `Database opens check should be pass or fail, got: ${dbCheck!.status}`);
  });
});

describe("ENVIRONMENT checks (US-003)", () => {
  it("Node.js check passes with version string", async () => {
    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);
    const nodeCheck = env!.checks.find((c) => c.name === "Node.js >= 22");
    assert.ok(nodeCheck, "Expected Node.js >= 22 check to exist");
    assert.strictEqual(nodeCheck!.status, "pass",
      `Node check should pass on Node 22+, got: ${nodeCheck!.status} (${nodeCheck!.message})`);
    assert.ok(nodeCheck!.message.includes("Node.js"),
      `Message should include Node.js version, got: ${nodeCheck!.message}`);
  });

  it("pi on PATH check passes when pi is available", async () => {
    const savedPath = process.env.PATH;
    const stubDir = tamanduaTempDir("tamandua-doctor-pi-stub-");
    try {
      // Create a stub pi binary so commandIsOnPath finds it regardless of host
      fs.writeFileSync(path.join(stubDir, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      process.env.PATH = `${stubDir}:${savedPath}`;
      const groups = await runDoctorChecks();
      const env = groups.find((g) => g.label === "ENVIRONMENT");
      assert.ok(env);
      const piCheck = env!.checks.find((c) => c.name === "pi present on PATH");
      assert.ok(piCheck, "Expected pi check to exist");
      assert.strictEqual(piCheck!.status, "pass",
        `pi check should pass on PATH, got: ${piCheck!.status} (${piCheck!.message})`);
    } finally {
      process.env.PATH = savedPath;
      try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("gh check returns pass or fail (not info)", async () => {
    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);
    const ghCheck = env!.checks.find((c) => c.name === "gh present");
    assert.ok(ghCheck, "Expected gh check to exist");
    // gh may or may not be present — both pass and fail are valid outcomes
    assert.ok(
      ghCheck!.status === "pass" || ghCheck!.status === "fail",
      `gh check should be pass or fail, got: ${ghCheck!.status}`,
    );
    if (ghCheck!.status === "fail") {
      assert.ok(ghCheck!.remedy, "Fail should have a remedy command");
    }
  });

  it("pi-token-saver check is always pass or info, never fail", async () => {
    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);
    const saverCheck = env!.checks.find((c) => c.name === "pi-token-saver detection");
    assert.ok(saverCheck, "Expected pi-token-saver check to exist");
    assert.notStrictEqual(saverCheck!.status, "fail",
      "pi-token-saver should never fail — it is optional");
    assert.ok(
      saverCheck!.status === "pass" || saverCheck!.status === "info",
      `pi-token-saver check should be pass or info, got: ${saverCheck!.status}`,
    );
    assert.ok(
      saverCheck!.message.toLowerCase().includes("optional") ||
        saverCheck!.message.toLowerCase().includes("token"),
      `Message should mention it's optional, got: ${saverCheck!.message}`,
    );
  });

  it("hermes-token-saver check returns pass when found on PATH with optional token-saving tool message", async () => {
    const savedPath = process.env.PATH;
    const stubDir = tamanduaTempDir("tamandua-doctor-hts-stub-");
    try {
      // Create a stub hermes-token-saver binary so commandIsOnPath finds it regardless of host
      fs.writeFileSync(path.join(stubDir, "hermes-token-saver"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      process.env.PATH = `${stubDir}:${savedPath}`;
      const groups = await runDoctorChecks();
      const env = groups.find((g) => g.label === "ENVIRONMENT");
      assert.ok(env);
      const saverCheck = env!.checks.find((c) => c.name === "hermes-token-saver detection");
      assert.ok(saverCheck, "Expected hermes-token-saver check to exist");
      assert.strictEqual(saverCheck!.status, "pass",
        `hermes-token-saver check should pass when found, got: ${saverCheck!.status} (${saverCheck!.message})`);
      assert.ok(
        saverCheck!.message.toLowerCase().includes("optional token-saving tool"),
        `Message should mention 'optional token-saving tool', got: ${saverCheck!.message}`,
      );
    } finally {
      process.env.PATH = savedPath;
      try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("hermes-token-saver check returns info with no-hurry reference when absent from PATH", async () => {
    const savedPath = process.env.PATH;
    // Use a controlled empty temp dir that explicitly excludes hermes-token-saver
    const stubDir = tamanduaTempDir("tamandua-doctor-hts-absent-");
    try {
      process.env.PATH = stubDir;
      const groups = await runDoctorChecks();
      const env = groups.find((g) => g.label === "ENVIRONMENT");
      assert.ok(env);
      const saverCheck = env!.checks.find((c) => c.name === "hermes-token-saver detection");
      assert.ok(saverCheck, "Expected hermes-token-saver check to exist");
      assert.strictEqual(saverCheck!.status, "info",
        `hermes-token-saver check should be info when absent, got: ${saverCheck!.status} (${saverCheck!.message})`);
      assert.ok(
        saverCheck!.message.toLowerCase().includes("optional") &&
          saverCheck!.message.toLowerCase().includes("no-hurry"),
        `Message should mention 'optional' and 'no-hurry', got: ${saverCheck!.message}`,
      );
    } finally {
      process.env.PATH = savedPath;
      try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("DOCP: ENVIRONMENT checks are hermetic — pi check responds to PATH, not host binaries", async () => {
    const savedPath = process.env.PATH;
    const stubDir = tamanduaTempDir("tamandua-doctor-pi-hermetic-");
    try {
      // Phase 1: pi absent from PATH → check reports fail
      process.env.PATH = stubDir;
      const groups1 = await runDoctorChecks();
      const env1 = groups1.find((g) => g.label === "ENVIRONMENT");
      assert.ok(env1);
      const piCheck1 = env1!.checks.find((c) => c.name === "pi present on PATH");
      assert.ok(piCheck1, "Expected pi check to exist");
      assert.strictEqual(piCheck1!.status, "fail",
        `pi check should fail when absent, got: ${piCheck1!.status}`);

      // Phase 2: add stub pi → check reports pass
      fs.writeFileSync(path.join(stubDir, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const groups2 = await runDoctorChecks();
      const env2 = groups2.find((g) => g.label === "ENVIRONMENT");
      assert.ok(env2);
      const piCheck2 = env2!.checks.find((c) => c.name === "pi present on PATH");
      assert.ok(piCheck2, "Expected pi check to exist");
      assert.strictEqual(piCheck2!.status, "pass",
        `pi check should pass when stub is on PATH, got: ${piCheck2!.status}`);
    } finally {
      process.env.PATH = savedPath;
      try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("Hermes binary discovery is always info (never fail)", async () => {
    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);
    const hermesCheck = env!.checks.find((c) => c.name === "Hermes binary discovery");
    assert.ok(hermesCheck, "Expected Hermes binary discovery check to exist");
    assert.strictEqual(hermesCheck!.status, "info",
      `Hermes check should be info-only, got: ${hermesCheck!.status} (${hermesCheck!.message})`);
    assert.ok(
      hermesCheck!.message.length > 0,
      "Hermes check message should not be empty",
    );
  });

  it("Hermes symlink check is always info (never fail)", async () => {
    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);
    const symlinkCheck = env!.checks.find((c) => c.name === "Hermes ~/.local/bin symlink");
    assert.ok(symlinkCheck, "Expected Hermes symlink check to exist");
    assert.strictEqual(symlinkCheck!.status, "info",
      `Hermes symlink check should be info-only, got: ${symlinkCheck!.status} (${symlinkCheck!.message})`);
    assert.ok(
      symlinkCheck!.message.length > 0,
      "Hermes symlink check message should not be empty",
    );
  });

  it("failed pi check has a remedy", async () => {
    // The pi check passes in this environment, but we verify the result
    // shape includes a remedy when status is fail by checking the
    // structure expectation — the check always includes message, and
    // if fail it must include a remedy string.
    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);
    for (const check of env!.checks) {
      assert.strictEqual(typeof check.name, "string");
      assert.strictEqual(typeof check.status, "string");
      assert.strictEqual(typeof check.message, "string");
      assert.ok(check.message.length > 0, `Check "${check.name}" has empty message`);
      if (check.status === "fail") {
        assert.strictEqual(typeof check.remedy, "string",
          `Check "${check.name}" failed but has no remedy`);
        assert.ok(check.remedy!.length > 0,
          `Check "${check.name}" has empty remedy`);
      }
    }
  });

  it("ENVIRONMENT checks are no longer placeholders", async () => {
    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);
    for (const check of env!.checks) {
      assert.notStrictEqual(
        check.message,
        "Not yet implemented",
        `Check "${check.name}" is still a placeholder`,
      );
    }
  });

  it("STATE group is no longer a placeholder", async () => {
    const groups = await runDoctorChecks();
    const state = groups.find((g) => g.label === "STATE");
    assert.ok(state, "Expected STATE group");
    for (const check of state!.checks) {
      assert.notStrictEqual(
        check.message,
        "Not yet implemented",
        `Check "${check.name}" should not be a placeholder`,
      );
    }
  });
});

// ── Hermes contract check helpers ────────────────────────────────

/** Create a fixture HERMES_HOME directory with a state.db. */
function seedHermesFixtureDb(hermesHome: string, options?: { missingColumns?: string[]; noSessionsTable?: boolean; noDb?: boolean }): void {
  if (options?.noDb) return;
  const dbPath = path.join(hermesHome, "state.db");
  const db = new DatabaseSync(dbPath);
  if (options?.noSessionsTable) {
    db.exec("CREATE TABLE other_table (x int)");
  } else if (options?.missingColumns && options.missingColumns.length > 0) {
    const allColumns = [
      "id TEXT PRIMARY KEY",
      "input_tokens INTEGER DEFAULT 0",
      "output_tokens INTEGER DEFAULT 0",
      "cache_read_tokens INTEGER DEFAULT 0",
      "cache_write_tokens INTEGER DEFAULT 0",
    ];
    const kept = allColumns.filter((c) => !options.missingColumns!.includes(c.split(" ")[0]));
    db.exec(`CREATE TABLE sessions (${kept.join(", ")})`);
  } else {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        reasoning_tokens INTEGER DEFAULT 0,
        estimated_cost_usd REAL
      )
    `);
  }
  db.close();
}

// ── ENVIRONMENT hermes contract check (US-004) ────────────────────

describe("ENVIRONMENT hermes contract check (US-004)", () => {
  let savedHermesBinary: string | undefined;
  let savedHermesHome: string | undefined;
  let savedPath: string | undefined;
  let fixtureDir: string | null = null;

  afterEach(() => {
    if (savedHermesBinary !== undefined) {
      process.env.TAMANDUA_HERMES_BINARY = savedHermesBinary;
    } else {
      delete process.env.TAMANDUA_HERMES_BINARY;
    }
    if (savedHermesHome !== undefined) {
      process.env.HERMES_HOME = savedHermesHome;
    } else {
      delete process.env.HERMES_HOME;
    }
    if (savedPath !== undefined) {
      process.env.PATH = savedPath;
    }
    if (fixtureDir) {
      try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
      fixtureDir = null;
    }
  });

  it("when no hermes binary, ENVIRONMENT group has exactly 7 checks (no contract check)", async () => {
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    delete process.env.TAMANDUA_HERMES_BINARY;
    // Remove hermes from PATH to ensure commandIsOnPath('hermes') returns false
    savedPath = process.env.PATH;

    // Create a fake zsh that won't find hermes via login shell
    // (the real zsh on this machine may have hermes on its login PATH)
    fixtureDir = createTempHome();
    const fakeZsh = path.join(fixtureDir, "zsh");
    fs.writeFileSync(fakeZsh, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    // PATH has fake zsh but no hermes
    process.env.PATH = `${fixtureDir}:/usr/bin:/bin`;

    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);

    // No Hermes state.db contract check should appear when hermes is absent
    const contractCheck = env!.checks.find((c) => c.name === "Hermes state.db contract");
    assert.strictEqual(contractCheck, undefined,
      "Should NOT have hermes contract check when hermes binary is absent");

    // Discovery + symlink checks always present; contract absent when no hermes
    assert.strictEqual(env!.checks.length, 7,
      `Expected exactly 7 ENVIRONMENT checks when no hermes, got ${env!.checks.length}: ${env!.checks.map((c: DoctorCheckResult) => c.name).join(", ")}`);
  });

  it("hermes contract check shows info with 'contract OK' when state.db is valid", async () => {
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    savedHermesHome = process.env.HERMES_HOME;

    // Create a fixture HERMES_HOME with a valid state.db
    fixtureDir = createTempHome();
    seedHermesFixtureDb(fixtureDir);

    // Set TAMANDUA_HERMES_BINARY to a stub — the doctor's discovery chain
    // will report it as the found binary and use it in the contract check message.
    const stubPath = path.join(fixtureDir, "stub-hermes");
    fs.writeFileSync(stubPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.TAMANDUA_HERMES_BINARY = stubPath;
    process.env.HERMES_HOME = fixtureDir;

    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);

    const contractCheck = env!.checks.find((c) => c.name === "Hermes state.db contract");
    assert.ok(contractCheck, "Expected Hermes state.db contract check when hermes binary is available");
    assert.strictEqual(contractCheck!.status, "info",
      `Contract check should be info when contract holds, got: ${contractCheck!.status} (${contractCheck!.message})`);
    assert.ok(contractCheck!.message.includes("contract OK"),
      `Message should say 'contract OK', got: ${contractCheck!.message}`);
    assert.ok(contractCheck!.message.includes("token accounting available"),
      `Message should mention token accounting, got: ${contractCheck!.message}`);
    // Contract check should reference the discovered binary
    assert.ok(contractCheck!.message.includes("probed against"),
      `Message should include 'probed against' with binary path, got: ${contractCheck!.message}`);
    assert.ok(contractCheck!.message.includes(stubPath),
      `Message should include the resolved binary path, got: ${contractCheck!.message}`);

    assert.strictEqual(env!.checks.length, 8,
      `Expected exactly 8 ENVIRONMENT checks with hermes available, got ${env!.checks.length}`);
  });

  it("hermes contract check shows warn when state.db has no sessions table", async () => {
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    savedHermesHome = process.env.HERMES_HOME;

    // Create a fixture with state.db but no sessions table
    fixtureDir = createTempHome();
    seedHermesFixtureDb(fixtureDir, { noSessionsTable: true });

    process.env.TAMANDUA_HERMES_BINARY = "/usr/bin/true";
    process.env.HERMES_HOME = fixtureDir;

    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);

    const contractCheck = env!.checks.find((c) => c.name === "Hermes state.db contract");
    assert.ok(contractCheck, "Expected Hermes state.db contract check");
    assert.strictEqual(contractCheck!.status, "warn",
      `Contract check should be warn when contract is broken, got: ${contractCheck!.status} (${contractCheck!.message})`);
    assert.ok(contractCheck!.message.includes("contract broken"),
      `Message should say 'contract broken', got: ${contractCheck!.message}`);
    assert.ok(contractCheck!.message.includes("no sessions table"),
      `Reason should mention no sessions table, got: ${contractCheck!.message}`);
    assert.ok(contractCheck!.message.includes("Hermes runs will report 0 tokens"),
      `Message should mention impact, got: ${contractCheck!.message}`);
    // Contract check should reference the discovered binary
    assert.ok(contractCheck!.message.includes("probed against"),
      `Message should include 'probed against' with binary path, got: ${contractCheck!.message}`);
  });

  it("hermes contract check shows warn when state.db has missing column", async () => {
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    savedHermesHome = process.env.HERMES_HOME;

    // Create a fixture with sessions table but missing cache_write_tokens column
    fixtureDir = createTempHome();
    seedHermesFixtureDb(fixtureDir, { missingColumns: ["cache_write_tokens"] });

    process.env.TAMANDUA_HERMES_BINARY = "/usr/bin/true";
    process.env.HERMES_HOME = fixtureDir;

    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);

    const contractCheck = env!.checks.find((c) => c.name === "Hermes state.db contract");
    assert.ok(contractCheck, "Expected Hermes state.db contract check");
    assert.strictEqual(contractCheck!.status, "warn",
      `Contract check should be warn when contract is broken, got: ${contractCheck!.status} (${contractCheck!.message})`);
    assert.ok(contractCheck!.message.includes("contract broken"),
      `Message should say 'contract broken', got: ${contractCheck!.message}`);
    assert.ok(contractCheck!.message.includes("missing columns"),
      `Reason should mention missing columns, got: ${contractCheck!.message}`);
    assert.ok(contractCheck!.message.includes("cache_write_tokens"),
      `Reason should list missing column name, got: ${contractCheck!.message}`);
    assert.ok(contractCheck!.message.includes("Hermes runs will report 0 tokens"),
      `Message should mention impact, got: ${contractCheck!.message}`);
  });

  it("hermes contract check shows warn with reason when state.db is missing", async () => {
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    savedHermesHome = process.env.HERMES_HOME;

    // Create a fixture HERMES_HOME without state.db
    fixtureDir = createTempHome();
    seedHermesFixtureDb(fixtureDir, { noDb: true });

    process.env.TAMANDUA_HERMES_BINARY = "/usr/bin/true";
    process.env.HERMES_HOME = fixtureDir;

    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);

    const contractCheck = env!.checks.find((c) => c.name === "Hermes state.db contract");
    assert.ok(contractCheck, "Expected Hermes state.db contract check");
    assert.strictEqual(contractCheck!.status, "warn",
      `Contract check should be warn when state.db is missing, got: ${contractCheck!.status} (${contractCheck!.message})`);
    assert.ok(contractCheck!.message.includes("contract broken"),
      `Message should say 'contract broken', got: ${contractCheck!.message}`);
    assert.ok(contractCheck!.message.includes("state.db not found"),
      `Reason should mention state.db not found, got: ${contractCheck!.message}`);
    assert.ok(contractCheck!.message.includes("Hermes runs will report 0 tokens"),
      `Message should mention impact, got: ${contractCheck!.message}`);
  });
});

// ── Hermes discovery chain and symlink tests (US-003) ────────────

describe("ENVIRONMENT hermes discovery chain (US-003)", () => {
  let savedHermesBinary: string | undefined;
  let savedPath: string | undefined;
  let savedHome: string | undefined;
  let savedHermesHome: string | undefined;
  let fixtureDir: string | null = null;

  afterEach(() => {
    if (savedHermesBinary !== undefined) {
      process.env.TAMANDUA_HERMES_BINARY = savedHermesBinary;
    } else {
      delete process.env.TAMANDUA_HERMES_BINARY;
    }
    if (savedPath !== undefined) {
      process.env.PATH = savedPath;
    }
    if (savedHome !== undefined) {
      process.env.HOME = savedHome;
    } else {
      delete process.env.HOME;
    }
    if (fixtureDir) {
      try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
      fixtureDir = null;
    }
    if (savedHermesHome !== undefined) {
      process.env.HERMES_HOME = savedHermesHome;
    } else {
      delete process.env.HERMES_HOME;
    }
  });

  it("discovery chain reports 'Found via TAMANDUA_HERMES_BINARY' when env var is set and executable", async () => {
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    fixtureDir = createTempHome();
    const stubPath = path.join(fixtureDir, "stub-hermes");
    fs.writeFileSync(stubPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.TAMANDUA_HERMES_BINARY = stubPath;

    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);

    const discoveryCheck = env!.checks.find((c) => c.name === "Hermes binary discovery");
    assert.ok(discoveryCheck, "Expected Hermes binary discovery check");
    assert.strictEqual(discoveryCheck!.status, "info");
    assert.ok(
      discoveryCheck!.message.includes("Found via TAMANDUA_HERMES_BINARY"),
      `Message should say 'Found via TAMANDUA_HERMES_BINARY', got: ${discoveryCheck!.message}`,
    );
    assert.ok(
      discoveryCheck!.message.includes(stubPath),
      `Message should include the binary path, got: ${discoveryCheck!.message}`,
    );
  });

  it("discovery chain reports 'TAMANDUA_HERMES_BINARY set but not executable' when env var points to missing file", async () => {
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    process.env.TAMANDUA_HERMES_BINARY = "/nonexistent/path/hermes";

    // Make sure PATH doesn't have hermes either
    savedPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";

    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);

    const discoveryCheck = env!.checks.find((c) => c.name === "Hermes binary discovery");
    assert.ok(discoveryCheck, "Expected Hermes binary discovery check");
    assert.strictEqual(discoveryCheck!.status, "info");
    assert.ok(
      discoveryCheck!.message.includes("not executable"),
      `Message should mention 'not executable', got: ${discoveryCheck!.message}`,
    );
  });

  it("discovery chain reports 'Found on PATH' when hermes is on PATH", async () => {
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    delete process.env.TAMANDUA_HERMES_BINARY;

    savedPath = process.env.PATH;
    fixtureDir = createTempHome();
    const hermesStub = path.join(fixtureDir, "hermes");
    fs.writeFileSync(hermesStub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = `${fixtureDir}:${savedPath}`;

    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);

    const discoveryCheck = env!.checks.find((c) => c.name === "Hermes binary discovery");
    assert.ok(discoveryCheck, "Expected Hermes binary discovery check");
    assert.strictEqual(discoveryCheck!.status, "info");
    assert.ok(
      discoveryCheck!.message.includes("Found on PATH"),
      `Message should say 'Found on PATH', got: ${discoveryCheck!.message}`,
    );
    assert.ok(
      discoveryCheck!.message.includes(hermesStub),
      `Message should include the resolved PATH, got: ${discoveryCheck!.message}`,
    );
  });

  it("discovery chain reports 'Found via login shell' when hermes is only on login-shell PATH", async () => {
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    delete process.env.TAMANDUA_HERMES_BINARY;

    // Remove hermes from PATH but put a fake zsh that reports hermes
    savedPath = process.env.PATH;
    fixtureDir = createTempHome();
    const hermesPath = path.join(fixtureDir, "real-hermes");
    fs.writeFileSync(hermesPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    // Create a fake zsh that just echoes the hermes path
    const fakeZsh = path.join(fixtureDir, "zsh");
    fs.writeFileSync(fakeZsh, `#!/bin/sh\necho "${hermesPath}"\n`, { mode: 0o755 });

    // PATH has fake zsh but no hermes
    process.env.PATH = `${fixtureDir}:/usr/bin:/bin`;

    // Isolate HOME to keep test self-contained
    savedHome = process.env.HOME;
    process.env.HOME = fixtureDir;

    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);

    const discoveryCheck = env!.checks.find((c) => c.name === "Hermes binary discovery");
    assert.ok(discoveryCheck, "Expected Hermes binary discovery check");
    assert.strictEqual(discoveryCheck!.status, "info");
    assert.ok(
      discoveryCheck!.message.includes("Found via login shell"),
      `Message should say 'Found via login shell', got: ${discoveryCheck!.message}`,
    );
  });

  it("discovery chain reports not found when hermes is absent from all tiers", async () => {
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    delete process.env.TAMANDUA_HERMES_BINARY;

    savedPath = process.env.PATH;
    fixtureDir = createTempHome();

    // Create a fake zsh that won't find hermes — echoes nothing
    const fakeZsh = path.join(fixtureDir, "zsh");
    fs.writeFileSync(fakeZsh, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    // PATH has our fake zsh (no hermes anywhere)
    process.env.PATH = `${fixtureDir}:/usr/bin:/bin`;

    // Isolate HOME so the login-shell fallback doesn't touch real fs
    savedHome = process.env.HOME;
    process.env.HOME = fixtureDir;

    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);

    const discoveryCheck = env!.checks.find((c) => c.name === "Hermes binary discovery");
    assert.ok(discoveryCheck, "Expected Hermes binary discovery check");
    assert.strictEqual(discoveryCheck!.status, "info");
    assert.ok(
      discoveryCheck!.message.includes("not found") || discoveryCheck!.message.includes("not set"),
      `Message should indicate hermes not found, got: ${discoveryCheck!.message}`,
    );
    assert.ok(
      discoveryCheck!.message.includes("optional"),
      `Message should mention optional, got: ${discoveryCheck!.message}`,
    );
  });

  it("symlink check reports correct target when symlink points to the discovered hermes", async () => {
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;

    fixtureDir = createTempHome();
    const hermesPath = path.join(fixtureDir, "hermes");
    fs.writeFileSync(hermesPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    // Create the symlink pointing to the right target
    savedHome = process.env.HOME;
    process.env.HOME = fixtureDir;
    const binDir = path.join(fixtureDir, ".local", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(hermesPath, path.join(binDir, "hermes"));

    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);

    const symlinkCheck = env!.checks.find((c) => c.name === "Hermes ~/.local/bin symlink");
    assert.ok(symlinkCheck, "Expected Hermes symlink check");
    assert.strictEqual(symlinkCheck!.status, "info");
    assert.ok(
      symlinkCheck!.message.includes("correct target"),
      `Message should say 'correct target', got: ${symlinkCheck!.message}`,
    );
  });

  it("symlink check reports wrong target when symlink points elsewhere", async () => {
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;

    fixtureDir = createTempHome();
    const hermesPath = path.join(fixtureDir, "hermes");
    fs.writeFileSync(hermesPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    // Create the symlink pointing to a DIFFERENT target
    savedHome = process.env.HOME;
    process.env.HOME = fixtureDir;
    const binDir = path.join(fixtureDir, ".local", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const wrongTarget = path.join(fixtureDir, "other-hermes");
    fs.writeFileSync(wrongTarget, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.symlinkSync(wrongTarget, path.join(binDir, "hermes"));

    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);

    const symlinkCheck = env!.checks.find((c) => c.name === "Hermes ~/.local/bin symlink");
    assert.ok(symlinkCheck, "Expected Hermes symlink check");
    assert.strictEqual(symlinkCheck!.status, "info");
    assert.ok(
      symlinkCheck!.message.includes("wrong target"),
      `Message should say 'wrong target', got: ${symlinkCheck!.message}`,
    );
    assert.ok(
      symlinkCheck!.message.includes(hermesPath),
      `Message should include expected path, got: ${symlinkCheck!.message}`,
    );
  });

  it("symlink check reports absent when no symlink exists", async () => {
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    delete process.env.TAMANDUA_HERMES_BINARY;

    // No hermes available → symlink check still runs with no path info
    savedPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";

    fixtureDir = createTempHome();
    savedHome = process.env.HOME;
    process.env.HOME = fixtureDir;
    // Don't create ~/.local/bin/hermes — should report absent

    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);

    const symlinkCheck = env!.checks.find((c) => c.name === "Hermes ~/.local/bin symlink");
    assert.ok(symlinkCheck, "Expected Hermes symlink check");
    assert.strictEqual(symlinkCheck!.status, "info");
    assert.ok(
      symlinkCheck!.message.includes("No symlink"),
      `Message should say 'No symlink', got: ${symlinkCheck!.message}`,
    );
    assert.ok(
      symlinkCheck!.message.includes("daemon PATH"),
      `Message should mention daemon PATH, got: ${symlinkCheck!.message}`,
    );
  });

  it("symlink check reports regular file when path exists but is not a symlink", async () => {
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    delete process.env.TAMANDUA_HERMES_BINARY;

    savedPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";

    fixtureDir = createTempHome();
    savedHome = process.env.HOME;
    process.env.HOME = fixtureDir;

    // Create a regular file at ~/.local/bin/hermes instead of a symlink
    const binDir = path.join(fixtureDir, ".local", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "hermes"), "regular file content", "utf-8");

    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);

    const symlinkCheck = env!.checks.find((c) => c.name === "Hermes ~/.local/bin symlink");
    assert.ok(symlinkCheck, "Expected Hermes symlink check");
    assert.strictEqual(symlinkCheck!.status, "info");
    assert.ok(
      symlinkCheck!.message.includes("regular file"),
      `Message should say 'regular file', got: ${symlinkCheck!.message}`,
    );
  });

  it("contract check references the discovered binary path", async () => {
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    savedHermesHome = process.env.HERMES_HOME;

    fixtureDir = createTempHome();
    const hermesPath = path.join(fixtureDir, "hermes");
    fs.writeFileSync(hermesPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    // Create a valid hermes state.db fixture
    seedHermesFixtureDb(fixtureDir);
    process.env.HERMES_HOME = fixtureDir;

    const groups = await runDoctorChecks();
    const env = groups.find((g) => g.label === "ENVIRONMENT");
    assert.ok(env);

    const contractCheck = env!.checks.find((c) => c.name === "Hermes state.db contract");
    assert.ok(contractCheck, "Expected Hermes state.db contract check");
    assert.ok(
      contractCheck!.message.includes("probed against"),
      `Contract message should mention 'probed against', got: ${contractCheck!.message}`,
    );
    assert.ok(
      contractCheck!.message.includes(hermesPath),
      `Contract message should reference the hermes binary path, got: ${contractCheck!.message}`,
    );
  });
});

describe("SERVICES checks (US-004)", () => {
  it("returns all fails when no daemon is running in temp HOME", async () => {
    const homeDir = createTempHome();
    try {
      const groups = await runDoctorChecks({ homeDir });
      const svc = groups.find((g) => g.label === "SERVICES");
      assert.ok(svc, "Expected SERVICES group");
      assert.strictEqual(svc!.checks.length, 5);

      // 1. Daemon PID
      const daemonCheck = svc!.checks.find((c) => c.name === "Daemon PID alive");
      assert.ok(daemonCheck);
      assert.strictEqual(daemonCheck!.status, "fail");
      assert.ok(daemonCheck!.message.includes("Daemon is not running"));
      assert.strictEqual(daemonCheck!.remedy, "tamandua daemon start");

      // 2. Control plane
      const cpCheck = svc!.checks.find((c) => c.name === "Control plane reachable");
      assert.ok(cpCheck);
      assert.strictEqual(cpCheck!.status, "fail");
      assert.ok(cpCheck!.message.includes("daemon is not running"));
      assert.strictEqual(cpCheck!.remedy, "tamandua daemon start");

      // 3. Dashboard PID
      const dashPidCheck = svc!.checks.find((c) => c.name === "Dashboard PID alive");
      assert.ok(dashPidCheck);
      assert.strictEqual(dashPidCheck!.status, "fail");
      assert.ok(dashPidCheck!.message.includes("Dashboard is not running"));
      assert.strictEqual(dashPidCheck!.remedy, "tamandua dashboard start");

      // 4. Dashboard HTTP
      const dashCheck = svc!.checks.find((c) => c.name === "Dashboard HTTP up");
      assert.ok(dashCheck);
      assert.strictEqual(dashCheck!.status, "fail");
      assert.ok(dashCheck!.message.includes("dashboard is not running"));
      assert.strictEqual(dashCheck!.remedy, "tamandua dashboard start");

      // 5. MCP — should be info since no pidfile
      const mcpCheck = svc!.checks.find((c) => c.name === "MCP server status");
      assert.ok(mcpCheck);
      assert.strictEqual(mcpCheck!.status, "info",
        `MCP check should be info when pidfile doesn't exist, got ${mcpCheck!.status}: ${mcpCheck!.message}`);
      assert.ok(mcpCheck!.message.toLowerCase().includes("optional") || mcpCheck!.message.toLowerCase().includes("not running"));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("reports all pass when daemon is running in isolated HOME", { timeout: 15000 }, async () => {
    const homeDir = createTempHome();
    const controlPort = await getAvailablePort();
    let child: import("node:child_process").ChildProcess | undefined;
    try {
      const result = await startDaemon(controlPort, { homeDir, keepHandle: true });
      child = (result as { child: import("node:child_process").ChildProcess }).child;

      // Wait a bit for the daemon to be fully ready
      await new Promise((resolve) => setTimeout(resolve, 500));

      const groups = await runDoctorChecks({ homeDir });
      const svc = groups.find((g) => g.label === "SERVICES");
      assert.ok(svc, "Expected SERVICES group");
      assert.strictEqual(svc!.checks.length, 5);

      // 1. Daemon PID
      const daemonCheck = svc!.checks.find((c) => c.name === "Daemon PID alive");
      assert.ok(daemonCheck);
      assert.strictEqual(daemonCheck!.status, "pass",
        `Daemon PID check should pass, got: ${daemonCheck!.status} (${daemonCheck!.message})`);
      assert.ok(daemonCheck!.message.includes("Daemon running"));

      // 2. Control plane
      const cpCheck = svc!.checks.find((c) => c.name === "Control plane reachable");
      assert.ok(cpCheck);
      assert.strictEqual(cpCheck!.status, "pass",
        `Control plane check should pass, got: ${cpCheck!.status} (${cpCheck!.message})`);
      assert.ok(cpCheck!.message.includes("responding"));

      // 3. Dashboard PID
      const dashPidCheck = svc!.checks.find((c) => c.name === "Dashboard PID alive");
      assert.ok(dashPidCheck);
      // Dashboard PID may or may not exist in isolated test
      assert.ok(["pass", "fail"].includes(dashPidCheck!.status),
        `Dashboard PID check valid status, got: ${dashPidCheck!.status} (${dashPidCheck!.message})`);

      // 4. Dashboard HTTP
      const dashCheck = svc!.checks.find((c) => c.name === "Dashboard HTTP up");
      assert.ok(dashCheck);
      // Dashboard HTTP may or may not be up depending on test
      assert.ok(["pass", "fail"].includes(dashCheck!.status),
        `Dashboard HTTP check valid status, got: ${dashCheck!.status} (${dashCheck!.message})`);

      // 5. MCP — info since no MCP pidfile
      const mcpCheck = svc!.checks.find((c) => c.name === "MCP server status");
      assert.ok(mcpCheck);
      assert.strictEqual(mcpCheck!.status, "info",
        `MCP check should be info when no pidfile, got: ${mcpCheck!.status} (${mcpCheck!.message})`);
    } finally {
      if (child) {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }
      // Give the process a moment to die
      await new Promise((resolve) => setTimeout(resolve, 200));
      try { stopDaemon({ homeDir }); } catch { /* ignore */ }
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("MCP pidfile exists but process dead reports fail", async () => {
    const homeDir = createTempHome();
    try {
      // Set up MCP pidfile with a fake PID
      const mcpPidFile = path.join(homeDir, ".tamandua", "mcp.pid");
      fs.mkdirSync(path.dirname(mcpPidFile), { recursive: true });
      // Use a PID that definitely doesn't exist (but is a valid number)
      fs.writeFileSync(mcpPidFile, "99999999", "utf-8");
      // Also need a valid MCP port file
      const mcpPortFile = path.join(homeDir, ".tamandua", "mcp-port");
      fs.writeFileSync(mcpPortFile, "3338", "utf-8");

      const groups = await runDoctorChecks({ homeDir });
      const svc = groups.find((g) => g.label === "SERVICES");
      assert.ok(svc);
      const mcpCheck = svc!.checks.find((c) => c.name === "MCP server status");
      assert.ok(mcpCheck);
      assert.strictEqual(mcpCheck!.status, "fail",
        `MCP check should fail when pidfile exists but process dead, got: ${mcpCheck!.status} (${mcpCheck!.message})`);
      assert.ok(mcpCheck!.message.includes("pidfile exists"),
        `Message should mention pidfile exists, got: ${mcpCheck!.message}`);
      assert.ok(mcpCheck!.remedy, "Should have a remedy");
      assert.ok(mcpCheck!.remedy!.includes("mcp restart"));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("daemon log tail appears in failure messages when daemon left logs", async () => {
    const homeDir = createTempHome();
    try {
      // Write a fake daemon log file so the log tail can be read
      const tamanduaDir = path.join(homeDir, ".tamandua");
      fs.mkdirSync(tamanduaDir, { recursive: true });
      const logFile = path.join(tamanduaDir, "dashboard.log");
      const logContent = "line1\nline2\nline3\nerror: something broke\ninfo: daemon started\n";
      fs.writeFileSync(logFile, logContent, "utf-8");

      const groups = await runDoctorChecks({ homeDir });
      const svc = groups.find((g) => g.label === "SERVICES");
      assert.ok(svc);
      const daemonCheck = svc!.checks.find((c) => c.name === "Daemon PID alive");
      assert.ok(daemonCheck);
      assert.strictEqual(daemonCheck!.status, "fail");
      assert.ok(daemonCheck!.message.includes("Daemon log tail:"),
        `Message should include daemon log tail. Got: ${daemonCheck!.message}`);
      assert.ok(daemonCheck!.message.includes("error: something broke"),
        `Log tail should include log line. Got: ${daemonCheck!.message}`);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("all SERVICE checks have valid structure on real HOME", async () => {
    const groups = await runDoctorChecks({ homeDir: guardHomeDir });
    const svc = groups.find((g) => g.label === "SERVICES");
    assert.ok(svc);
    assert.strictEqual(svc!.checks.length, 5);
    for (const check of svc!.checks) {
      assert.strictEqual(typeof check.name, "string");
      assert.strictEqual(typeof check.status, "string");
      assert.strictEqual(typeof check.message, "string");
      assert.ok(check.message.length > 0, `Check "${check.name}" has empty message`);
      assert.notStrictEqual(check.message, "Not yet implemented",
        `Check "${check.name}" should not be a placeholder`);
      if (check.status === "fail") {
        assert.strictEqual(typeof check.remedy, "string",
          `Check "${check.name}" failed but has no remedy`);
        assert.ok(check.remedy!.length > 0, `Check "${check.name}" has empty remedy`);
      }
    }
  });

  it("daemon not running: daemon and control plane checks reference correct remedies", async () => {
    const homeDir = createTempHome();
    try {
      const groups = await runDoctorChecks({ homeDir });
      const svc = groups.find((g) => g.label === "SERVICES");
      assert.ok(svc);

      for (const check of svc!.checks) {
        if (check.name === "Daemon PID alive" ||
            check.name === "Control plane reachable") {
          assert.strictEqual(check.status, "fail",
            `Check "${check.name}" should fail when daemon is not running`);
          assert.ok(check.remedy, `Check "${check.name}" should have a remedy`);
          assert.ok(
            check.remedy!.includes("tamandua daemon"),
            `Remedy for "${check.name}" should reference tamandua daemon: ${check.remedy}`,
          );
        }
        if (check.name === "Dashboard PID alive" ||
            check.name === "Dashboard HTTP up") {
          assert.strictEqual(check.status, "fail",
            `Check "${check.name}" should fail when dashboard is not running`);
          assert.ok(check.remedy, `Check "${check.name}" should have a remedy`);
          assert.ok(
            check.remedy!.includes("tamandua dashboard"),
            `Remedy for "${check.name}" should reference tamandua dashboard: ${check.remedy}`,
          );
        }
      }
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
  it("STALENESS group is no longer a placeholder", async () => {
    const groups = await runDoctorChecks();
    const staleness = groups.find((g) => g.label === "STALENESS");
    assert.ok(staleness, "Expected STALENESS group");
    assert.strictEqual(staleness!.checks.length, 2);
    for (const check of staleness!.checks) {
      assert.notStrictEqual(check.message, "Not yet implemented",
        "Staleness check should not be a placeholder");
    }
  });
});

describe("STALENESS check (US-005)", () => {
  it("passes when daemon buildVersion matches local version", { timeout: 15000 }, async () => {
    const homeDir = createTempHome();
    const controlPort = await getAvailablePort();
    let child: import("node:child_process").ChildProcess | undefined;
    try {
      const result = await startDaemon(controlPort, { homeDir, keepHandle: true });
      child = (result as { child: import("node:child_process").ChildProcess }).child;

      await new Promise((resolve) => setTimeout(resolve, 500));

      const groups = await runDoctorChecks({ homeDir });
      const staleness = groups.find((g) => g.label === "STALENESS");
      assert.ok(staleness);
      assert.strictEqual(staleness!.checks.length, 2);
      const check = staleness!.checks[0];
      assert.strictEqual(check.status, "pass",
        `Staleness check should pass when versions match, got: ${check.status} (${check.message})`);
      assert.ok(check.message.includes("matches"),
        `Message should say versions match, got: ${check.message}`);
    } finally {
      if (child) {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      try { stopDaemon({ homeDir }); } catch { /* ignore */ }
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("fails with dashboard restart remedy when buildVersion differs", async () => {
    const homeDir = createTempHome();
    const { createServer } = await import("node:http");

    try {
      // Start a mock HTTP server that returns a different buildVersion
      const mockPort = await getAvailablePort();
      const mockServer = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          pid: 12345,
          timestamp: new Date().toISOString(),
          buildVersion: "99999999_old_build",
        }));
      });

      await new Promise<void>((resolve) => mockServer.listen(mockPort, "127.0.0.1", resolve));

      // Write control plane port file pointing to the mock server
      const cpPortFile = getControlPlanePortFile({ homeDir });
      fs.mkdirSync(path.dirname(cpPortFile), { recursive: true });
      fs.writeFileSync(cpPortFile, String(mockPort), "utf-8");

      try {
        const groups = await runDoctorChecks({ homeDir });
        const staleness = groups.find((g) => g.label === "STALENESS");
        assert.ok(staleness);
        assert.strictEqual(staleness!.checks.length, 2);
        const check = staleness!.checks[0];
        assert.strictEqual(check.status, "fail",
          `Staleness check should fail when versions differ, got: ${check.status} (${check.message})`);
        assert.ok(check.message.includes("installed build is"),
          `Message should mention installed build, got: ${check.message}`);
        assert.ok(check.message.includes("99999999_old_build"),
          `Message should include daemon build version, got: ${check.message}`);
        assert.strictEqual(check.remedy, "Run: tamandua daemon restart",
          "Remedy should be tamandua daemon restart (not control-plane restart)");
      } finally {
        await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      }
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("reports warn when buildVersion field is missing from health response", async () => {
    const homeDir = createTempHome();
    const { createServer } = await import("node:http");

    try {
      const mockPort = await getAvailablePort();
      const mockServer = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          pid: 12345,
          timestamp: new Date().toISOString(),
          // buildVersion intentionally omitted — old daemon that predates US-001
        }));
      });

      await new Promise<void>((resolve) => mockServer.listen(mockPort, "127.0.0.1", resolve));

      const cpPortFile = getControlPlanePortFile({ homeDir });
      fs.mkdirSync(path.dirname(cpPortFile), { recursive: true });
      fs.writeFileSync(cpPortFile, String(mockPort), "utf-8");

      try {
        const groups = await runDoctorChecks({ homeDir });
        const staleness = groups.find((g) => g.label === "STALENESS");
        assert.ok(staleness);
        assert.strictEqual(staleness!.checks.length, 2);
        const check = staleness!.checks[0];
        assert.strictEqual(check.status, "warn",
          `Staleness check should warn when buildVersion is missing, got: ${check.status} (${check.message})`);
        assert.ok(check.message.includes("predates build version reporting"),
          `Message should mention predates build version reporting, got: ${check.message}`);
        assert.ok(check.remedy!.includes("tamandua daemon restart"),
          "Remedy should suggest tamandua daemon restart");
      } finally {
        await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      }
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("reports info (skip) when control plane is unreachable", async () => {
    const homeDir = createTempHome();
    try {
      // No daemon, no port file → control plane port defaults to 3339
      // which likely has nothing listening, so fetch will fail
      // Use an explicit random port that nothing listens on
      const unusedPort = await getAvailablePort();
      const cpPortFile = getControlPlanePortFile({ homeDir });
      fs.mkdirSync(path.dirname(cpPortFile), { recursive: true });
      fs.writeFileSync(cpPortFile, String(unusedPort), "utf-8");

      const groups = await runDoctorChecks({ homeDir });
      const staleness = groups.find((g) => g.label === "STALENESS");
      assert.ok(staleness);
      assert.strictEqual(staleness!.checks.length, 2);
      const check = staleness!.checks[0];
      assert.strictEqual(check.status, "info",
        `Staleness check should be info when control plane is unreachable, got: ${check.status} (${check.message})`);
      assert.ok(
        check.message.includes("unreachable") || check.message.includes("skipped"),
        `Message should indicate unreachable/skipped, got: ${check.message}`,
      );
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("non-200 health response is handled gracefully", async () => {
    const homeDir = createTempHome();
    const { createServer } = await import("node:http");

    try {
      const mockPort = await getAvailablePort();
      const mockServer = createServer((_req, res) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      });

      await new Promise<void>((resolve) => mockServer.listen(mockPort, "127.0.0.1", resolve));

      const cpPortFile = getControlPlanePortFile({ homeDir });
      fs.mkdirSync(path.dirname(cpPortFile), { recursive: true });
      fs.writeFileSync(cpPortFile, String(mockPort), "utf-8");

      try {
        const groups = await runDoctorChecks({ homeDir });
        const staleness = groups.find((g) => g.label === "STALENESS");
        assert.ok(staleness);
        assert.strictEqual(staleness!.checks.length, 2);
        const check = staleness!.checks[0];
        assert.strictEqual(check.status, "info",
          `Staleness check should be info on non-200 response, got: ${check.status} (${check.message})`);
      } finally {
        await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      }
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("Catalog staleness check (US-002)", () => {
  let savedStateDir: string | undefined;

  beforeEach(() => {
    savedStateDir = process.env.TAMANDUA_STATE_DIR;
  });

  afterEach(() => {
    if (savedStateDir !== undefined) {
      process.env.TAMANDUA_STATE_DIR = savedStateDir;
    } else {
      delete process.env.TAMANDUA_STATE_DIR;
    }
  });

  function setupCatalogStamp(homeDir: string, stampVersion: string | null): void {
    const stateDir = path.join(homeDir, ".tamandua");
    process.env.TAMANDUA_STATE_DIR = stateDir;

    const workflowsDir = path.join(stateDir, "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });

    if (stampVersion !== null) {
      fs.writeFileSync(
        path.join(workflowsDir, ".catalog-version.json"),
        JSON.stringify({
          version: stampVersion,
          sourcePath: "/test/path",
          installedAt: new Date().toISOString(),
        }, null, 2) + "\n",
        "utf-8",
      );
    }

    // DB must exist for STATE checks
    const dbPath = path.join(stateDir, "tamandua.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "");
  }

  it("returns pass when installed stamp version matches build version", async () => {
    const homeDir = createTempHome();
    try {
      const currentVersion = getBuildVersion();
      setupCatalogStamp(homeDir, currentVersion);

      const groups = await runDoctorChecks({ homeDir });
      const staleness = groups.find((g) => g.label === "STALENESS");
      assert.ok(staleness);
      assert.strictEqual(staleness!.checks.length, 2);

      const catalogCheck = staleness!.checks.find((c) => c.name === "Installed catalog vs bundled catalog");
      assert.ok(catalogCheck, "Expected catalog staleness check");
      assert.strictEqual(catalogCheck!.status, "pass",
        `Should pass when versions match, got: ${catalogCheck!.status} (${catalogCheck!.message})`);
      assert.ok(catalogCheck!.message.includes("matches"),
        `Message should say matches, got: ${catalogCheck!.message}`);
    } finally {
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("returns warn when stamp file is missing", async () => {
    const homeDir = createTempHome();
    try {
      setupCatalogStamp(homeDir, null);

      const groups = await runDoctorChecks({ homeDir });
      const staleness = groups.find((g) => g.label === "STALENESS");
      assert.ok(staleness);

      const catalogCheck = staleness!.checks.find((c) => c.name === "Installed catalog vs bundled catalog");
      assert.ok(catalogCheck, "Expected catalog staleness check");
      assert.strictEqual(catalogCheck!.status, "warn",
        `Should warn when stamp missing, got: ${catalogCheck!.status} (${catalogCheck!.message})`);
      assert.ok(catalogCheck!.message.toLowerCase().includes("no installed catalog stamp"),
        `Message should mention missing stamp, got: ${catalogCheck!.message}`);
      assert.ok(catalogCheck!.remedy, "Should have a remedy");
      assert.ok(catalogCheck!.remedy!.includes("tamandua update --force"),
        `Remedy should say tamandua update --force, got: ${catalogCheck!.remedy}`);
    } finally {
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("returns warn when stamp version differs from build version", async () => {
    const homeDir = createTempHome();
    try {
      setupCatalogStamp(homeDir, "old-version-12345");

      const groups = await runDoctorChecks({ homeDir });
      const staleness = groups.find((g) => g.label === "STALENESS");
      assert.ok(staleness);

      const catalogCheck = staleness!.checks.find((c) => c.name === "Installed catalog vs bundled catalog");
      assert.ok(catalogCheck, "Expected catalog staleness check");
      assert.strictEqual(catalogCheck!.status, "warn",
        `Should warn when versions differ, got: ${catalogCheck!.status} (${catalogCheck!.message})`);
      assert.ok(catalogCheck!.message.includes("older"),
        `Message should say older, got: ${catalogCheck!.message}`);
      assert.ok(catalogCheck!.message.includes("old-version-12345"),
        `Message should include old version, got: ${catalogCheck!.message}`);
      assert.ok(catalogCheck!.remedy, "Should have a remedy");
      assert.ok(catalogCheck!.remedy!.includes("tamandua update --force"),
        `Remedy should say tamandua update --force, got: ${catalogCheck!.remedy}`);
    } finally {
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("returns warn when readInstalledCatalogStamp returns null (invalid JSON)", async () => {
    const homeDir = createTempHome();
    try {
      const stateDir = path.join(homeDir, ".tamandua");
      process.env.TAMANDUA_STATE_DIR = stateDir;

      // Create stamp with invalid JSON
      const workflowsDir = path.join(stateDir, "workflows");
      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.writeFileSync(
        path.join(workflowsDir, ".catalog-version.json"),
        "not valid json",
        "utf-8",
      );

      // DB must exist for STATE checks
      const dbPath = path.join(stateDir, "tamandua.db");
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, "");

      const groups = await runDoctorChecks({ homeDir });
      const staleness = groups.find((g) => g.label === "STALENESS");
      assert.ok(staleness);

      const catalogCheck = staleness!.checks.find((c) => c.name === "Installed catalog vs bundled catalog");
      assert.ok(catalogCheck, "Expected catalog staleness check");
      assert.strictEqual(catalogCheck!.status, "warn",
        `Should warn when stamp is invalid, got: ${catalogCheck!.status} (${catalogCheck!.message})`);
      assert.ok(catalogCheck!.message.toLowerCase().includes("no installed catalog stamp"),
        `Message should mention missing/invalid stamp, got: ${catalogCheck!.message}`);
      assert.ok(catalogCheck!.remedy?.includes("tamandua update --force"),
        `Remedy should say tamandua update --force, got: ${catalogCheck!.remedy}`);
    } finally {
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("remedy message always includes 'tamandua update --force' for warn cases", async () => {
    const homeDir = createTempHome();
    try {
      setupCatalogStamp(homeDir, null);

      const groups = await runDoctorChecks({ homeDir });
      const staleness = groups.find((g) => g.label === "STALENESS");
      assert.ok(staleness);

      const catalogCheck = staleness!.checks.find((c) => c.name === "Installed catalog vs bundled catalog");
      assert.ok(catalogCheck, "Expected catalog staleness check");
      assert.strictEqual(catalogCheck!.status, "warn");
      assert.strictEqual(catalogCheck!.remedy, "Run: tamandua update --force");
    } finally {
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("STATE checks (US-006)", () => {
  it("database fails to open → fail check with remedy", async () => {
    // Save current DB path and point to a nonexistent directory
    const savedDbPath = process.env.TAMANDUA_DB_PATH;
    const homeDir = createTempHome();
    // Point to a path where the parent directory doesn't exist
    process.env.TAMANDUA_DB_PATH = path.join(homeDir, "nonexistent", "subdir", "tamandua.db");
    // Don't create the directory — so getDb() will fail trying to mkdir or open
    // But getDb() calls fs.mkdirSync on the parent dir, so it might create it.
    // Instead, make the parent dir a file so mkdir fails.
    const parentDir = path.dirname(process.env.TAMANDUA_DB_PATH);
    const grandparent = path.dirname(parentDir);
    fs.mkdirSync(grandparent, { recursive: true });
    fs.writeFileSync(parentDir, "blocked"); // parent dir is a file, not a directory

    try {
      const groups = await runDoctorChecks();
      const state = groups.find((g) => g.label === "STATE");
      assert.ok(state);
      const dbCheck = state!.checks.find((c) => c.name === "Database opens");
      assert.ok(dbCheck, "Expected 'Database opens' check");
      assert.strictEqual(dbCheck!.status, "fail",
        `Database opens should fail when DB path is blocked, got: ${dbCheck!.status} (${dbCheck!.message})`);
      assert.ok(dbCheck!.remedy, "Failed DB check should have a remedy");
      assert.ok(
        dbCheck!.message.toLowerCase().includes("fail") || dbCheck!.message.includes("blocked") || dbCheck!.message.includes("EISDIR") || dbCheck!.message.includes("ENOTDIR") || dbCheck!.message.includes("error"),
        `Message should indicate failure, got: ${dbCheck!.message}`,
      );
    } finally {
      process.env.TAMANDUA_DB_PATH = savedDbPath;
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("database opens → pass check", async () => {
    const groups = await runDoctorChecks();
    const state = groups.find((g) => g.label === "STATE");
    assert.ok(state);
    const dbCheck = state!.checks.find((c) => c.name === "Database opens");
    assert.ok(dbCheck, "Expected 'Database opens' check");
    assert.strictEqual(dbCheck!.status, "pass",
      `Database opens should pass with isolated temp DB, got: ${dbCheck!.status} (${dbCheck!.message})`);
    assert.ok(dbCheck!.message.includes("success") || dbCheck!.message.includes("opened"),
      `Message should indicate success, got: ${dbCheck!.message}`);
  });

  it("no medic anomalies → pass with clear message", async () => {
    const groups = await runDoctorChecks();
    const state = groups.find((g) => g.label === "STATE");
    assert.ok(state);
    // On a clean temp DB, medic should find no anomalies
    const medicCheck = state!.checks.find((c) => c.name === "Run-level anomalies");
    assert.ok(medicCheck, "Expected 'Run-level anomalies' check when no findings exist");
    assert.strictEqual(medicCheck!.status, "pass",
      `Clean DB should have no anomalies, got: ${medicCheck!.status} (${medicCheck!.message})`);
    assert.ok(
      medicCheck!.message.includes("No run-level anomalies") || medicCheck!.message.includes("no issues"),
      `Message should say no anomalies, got: ${medicCheck!.message}`,
    );
  });

  it("zombie run findings are reported as critical", async () => {
    // Seed the DB with a zombie run so medic finds it
    const savedDbPath = process.env.TAMANDUA_DB_PATH;
    const homeDir = createTempHome();
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "");
    seedZombieRun(dbPath);
    process.env.TAMANDUA_DB_PATH = dbPath;

    try {
      const groups = await runDoctorChecks();
      const state = groups.find((g) => g.label === "STATE");
      assert.ok(state);
      const anomalyChecks = state!.checks.filter((c) => c.name === "Run-level anomaly");
      // Should find the zombie run
      const zombieCheck = anomalyChecks.find((c) => c.message.includes("zombie") || c.message.includes("ZOMBIE"));
      assert.ok(zombieCheck,
        `Expected a zombie run finding, got anomalies: ${JSON.stringify(anomalyChecks.map(c => c.message))}`);
      assert.strictEqual(zombieCheck!.status, "fail",
        `Zombie run should be critical/fail, got: ${zombieCheck!.status}`);
      assert.ok(zombieCheck!.remedy, "Zombie check should have a remedy");
      assert.ok(zombieCheck!.remedy!.includes("tamandua medic"),
        `Remedy should mention medic, got: ${zombieCheck!.remedy}`);
    } finally {
      process.env.TAMANDUA_DB_PATH = savedDbPath;
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("STATE run-process-leak checks (US-004)", () => {
  /** Seed a DB with a terminal run + worktree record. */
  function seedTerminalRunWithWorktree(
    dbPath: string,
    runId: string,
    worktreePath: string,
  ): void {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running', context TEXT NOT NULL DEFAULT '{}',
        tokens_spent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
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
      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, step_index INTEGER NOT NULL,
        input_template TEXT NOT NULL, expects TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'waiting', output TEXT,
        retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 4,
        type TEXT NOT NULL DEFAULT 'single', loop_config TEXT,
        current_story_id TEXT, abandoned_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-workflow", "test", "completed", now, now);
    db.prepare(
      "INSERT INTO run_worktrees (run_id, worktree_origin_repository, worktree_origin_git_common_dir, worktree_path, status, cleanup_policy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "/fake/repo", "/fake/repo/.git", worktreePath, "ready", "remove_on_terminal", now);
    db.close();
  }

  it("reports process leak for terminal run with surviving process", { timeout: 10000 }, async () => {
    const homeDir = createTempHome();
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    // Create a fake worktree directory
    const worktreePath = path.join(homeDir, "worktrees", "test-run");
    fs.mkdirSync(worktreePath, { recursive: true });

    // Seed DB with terminal run
    fs.writeFileSync(dbPath, "");
    seedTerminalRunWithWorktree(dbPath, "terminal-run-001", worktreePath);

    // Spawn a marker process whose cwd is the worktree path
    const child = spawn("sleep", ["10"], {
      cwd: worktreePath,
      detached: false,
      stdio: "ignore",
    });

    // Wait for the process to start
    await new Promise<void>((resolve) => {
      child.on("spawn", () => resolve());
      setTimeout(() => resolve(), 500);
    });

    const childPid = child.pid!;

    try {
      const groups = await runDoctorChecks({ homeDir });
      const state = groups.find((g) => g.label === "STATE");
      assert.ok(state);

      const leakChecks = state!.checks.filter((c) => c.name === "Run-process leak");
      assert.ok(leakChecks.length >= 1,
        `Expected at least 1 leak check, got ${leakChecks.length}. STATE checks: ${JSON.stringify(state!.checks.map((c) => c.name))}`);

      // Find the check for our specific process
      const ourLeak = leakChecks.find((c) => c.message.includes(String(childPid)));
      assert.ok(ourLeak,
        `Expected leak check for PID ${childPid}. Leak checks: ${leakChecks.map((c) => c.message).join(" | ")}`);
      assert.strictEqual(ourLeak!.status, "warn",
        `Leak check should be warn, got: ${ourLeak!.status}`);
      assert.ok(ourLeak!.message.includes("terminal-run-001"),
        `Message should include run ID. Got: ${ourLeak!.message}`);
      assert.ok(ourLeak!.message.includes("cwd under worktree") || ourLeak!.message.includes("environ"),
        `Message should include evidence. Got: ${ourLeak!.message}`);
      assert.strictEqual(
        ourLeak!.remedy,
        `Manual cleanup: kill ${childPid}`,
        `Remedy should suggest manual kill. Got: ${ourLeak!.remedy}`,
      );

      // Assert the process is NOT killed by the doctor (report-only)
      let procExists = true;
      try {
        process.kill(childPid, 0);
      } catch {
        procExists = false;
      }
      assert.ok(procExists,
        `Process ${childPid} should still be alive — doctor must NEVER kill processes`);
    } finally {
      // Kill the marker process
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("does not report processes belonging to active runs", { timeout: 10000 }, async () => {
    const homeDir = createTempHome();
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "");

    const worktreePath = path.join(homeDir, "worktrees", "active-run");
    fs.mkdirSync(worktreePath, { recursive: true });

    // Seed DB with an ACTIVE (running) run with worktree
    const now = new Date().toISOString();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running', context TEXT NOT NULL DEFAULT '{}',
        tokens_spent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
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
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("active-run-001", "test-workflow", "test", "running", now, now);
    db.prepare(
      "INSERT INTO run_worktrees (run_id, worktree_origin_repository, worktree_origin_git_common_dir, worktree_path, status, cleanup_policy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("active-run-001", "/fake/repo", "/fake/repo/.git", worktreePath, "ready", "remove_on_success", now);
    db.close();

    // Spawn marker process in the worktree
    const child = spawn("sleep", ["10"], {
      cwd: worktreePath,
      detached: false,
      stdio: "ignore",
    });
    await new Promise<void>((resolve) => {
      child.on("spawn", () => resolve());
      setTimeout(() => resolve(), 500);
    });

    const childPid = child.pid!;

    try {
      const groups = await runDoctorChecks({ homeDir });
      const state = groups.find((g) => g.label === "STATE");
      assert.ok(state);

      const leakChecks = state!.checks.filter((c) => c.name === "Run-process leak");

      // None should reference our process — it belongs to an active run
      const activeLeaks = leakChecks.filter((c) => c.message.includes(String(childPid)));
      assert.strictEqual(activeLeaks.length, 0,
        `Process ${childPid} belongs to an active run — should NOT be reported as leak. Leaks: ${activeLeaks.map((c) => c.message).join(" | ")}`);
    } finally {
      try { child.kill("SIGKILL"); } catch {}
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("handles missing worktree gracefully", async () => {
    const homeDir = createTempHome();
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "");

    // Seed DB with a terminal run but NO worktree record
    // getRunWorktree returns null — check must not crash
    const now = new Date().toISOString();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running', context TEXT NOT NULL DEFAULT '{}',
        tokens_spent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("no-wt-run", "test-workflow", "test", "completed", now, now);
    db.close();

    try {
      // Must not throw — missing worktree should be skipped gracefully
      const groups = await runDoctorChecks({ homeDir });
      const state = groups.find((g) => g.label === "STATE");
      assert.ok(state);

      // No leak checks for this run since there's no worktree
      const leakChecks = state!.checks.filter((c) => c.name === "Run-process leak");
      const noWtLeaks = leakChecks.filter((c) => c.message.includes("no-wt-run"));
      assert.strictEqual(noWtLeaks.length, 0,
        `Run with no worktree should have no leak reports. Got: ${noWtLeaks.map((c) => c.message).join(" | ")}`);
    } finally {
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("zero matches produces no additional check", async () => {
    const homeDir = createTempHome();
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const worktreePath = path.join(homeDir, "worktrees", "clean-run");
    fs.mkdirSync(worktreePath, { recursive: true });

    fs.writeFileSync(dbPath, "");
    seedTerminalRunWithWorktree(dbPath, "clean-terminal-run", worktreePath);

    // Spawn NO process — the worktree is empty, no processes attached

    try {
      const groups = await runDoctorChecks({ homeDir });
      const state = groups.find((g) => g.label === "STATE");
      assert.ok(state);

      const leakChecks = state!.checks.filter((c) => c.name === "Run-process leak");
      // Should have zero leak reports since no processes are attached
      assert.strictEqual(
        leakChecks.length,
        0,
        `Expected 0 leak reports for clean run with no attached processes, got ${leakChecks.length}: ${leakChecks.map((c) => c.message).join(" | ")}`,
      );
    } finally {
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("warnings include remedy text suggesting manual kill", { timeout: 10000 }, async () => {
    const homeDir = createTempHome();
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const worktreePath = path.join(homeDir, "worktrees", "leak-run");
    fs.mkdirSync(worktreePath, { recursive: true });

    fs.writeFileSync(dbPath, "");
    seedTerminalRunWithWorktree(dbPath, "leak-run-001", worktreePath);

    const child = spawn("sleep", ["10"], {
      cwd: worktreePath,
      detached: false,
      stdio: "ignore",
    });
    await new Promise<void>((resolve) => {
      child.on("spawn", () => resolve());
      setTimeout(() => resolve(), 500);
    });

    const childPid = child.pid!;

    try {
      const groups = await runDoctorChecks({ homeDir });
      const state = groups.find((g) => g.label === "STATE");
      assert.ok(state);

      const ourLeak = state!.checks.find(
        (c) => c.name === "Run-process leak" && c.message.includes(String(childPid)),
      );
      assert.ok(ourLeak, `Expected leak check for PID ${childPid}`);
      assert.strictEqual(ourLeak!.status, "warn");
      assert.ok(ourLeak!.remedy, "Leak check should have a remedy");
      assert.ok(
        ourLeak!.remedy!.includes("kill"),
        `Remedy should mention kill. Got: ${ourLeak!.remedy}`,
      );
      assert.ok(
        ourLeak!.remedy!.includes(String(childPid)),
        `Remedy should include PID. Got: ${ourLeak!.remedy}`,
      );
      assert.ok(
        ourLeak!.remedy!.includes("Manual cleanup"),
        `Remedy should suggest manual cleanup. Got: ${ourLeak!.remedy}`,
      );
    } finally {
      try { child.kill("SIGKILL"); } catch {}
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("LLM PROMPT ADHERENCE checks (US-002)", () => {
  it("full emission: all keys at 100%, only summary line", async () => {
    const dbPath = process.env.TAMANDUA_DB_PATH!;
    const template = "Instructions here\n\nReply with:\nBRANCH: main\nVERIFIED: true\n";
    seedPromptAdherenceDb(dbPath, Array.from({ length: 5 }, (_, i) => ({
      id: `fe-${i}`,
      workflowId: "test-workflow",
      status: "completed",
      context: { branch: "main", verified: "true" },
      steps: [{ stepId: "dev", inputTemplate: template }],
    })));

    const checks = await runLlmPromptAdherenceChecks();
    // Only the summary line — no entries below 100%
    assert.strictEqual(checks.length, 1, `Expected 1 check (summary only), got ${checks.length}: ${JSON.stringify(checks.map((c: DoctorCheckResult) => c.message))}`);
    const summary = checks[0];
    assert.strictEqual(summary.name, "Summary");
    assert.strictEqual(summary.status, "info");
    assert.ok(summary.message.includes("100%"), `Summary should show 100%, got: ${summary.message}`);
    assert.ok(summary.message.includes("10 keys"), `Summary should count 10 keys, got: ${summary.message}`);
  });

  it("partial emission: correct rates computed and displayed", async () => {
    const dbPath = process.env.TAMANDUA_DB_PATH!;
    const template = "Reply with:\nBRANCH: main\nVERIFIED: true\n";
    seedPromptAdherenceDb(dbPath, Array.from({ length: 15 }, (_, i) => ({
      id: `pe-${i}`,
      workflowId: "test-workflow",
      status: "completed",
      // First 10 runs have BRANCH, all 15 have VERIFIED
      context: i < 10 ? { branch: "main", verified: "true" } : { verified: "true" },
      steps: [{ stepId: "dev", inputTemplate: template }],
    })));

    const checks = await runLlmPromptAdherenceChecks();
    // BRANCH at 10/15 (67%) should appear as info
    const branchCheck = checks.find((c: DoctorCheckResult) => c.message.includes("BRANCH"));
    assert.ok(branchCheck, `Expected a check for BRANCH key, got: ${JSON.stringify(checks.map((c: DoctorCheckResult) => c.message))}`);
    assert.ok(branchCheck!.message.includes("10/15"), `Expected 10/15, got: ${branchCheck!.message}`);
    assert.ok(branchCheck!.message.includes("67%"), `Expected 67%, got: ${branchCheck!.message}`);
    assert.strictEqual(branchCheck!.status, "info", "67% should be info, not warn");
    // VERIFIED at 100% should NOT appear
    const verifiedCheck = checks.find((c: DoctorCheckResult) => c.message.includes("VERIFIED"));
    assert.strictEqual(verifiedCheck, undefined, "VERIFIED at 100% should not appear");
    // Summary should exist with 30 keys tracked
    const summary = checks.find((c: DoctorCheckResult) => c.name === "Summary");
    assert.ok(summary, "Expected summary check");
    assert.ok(summary!.message.includes("30 keys"), `Summary should count 30 keys, got: ${summary!.message}`);
  });

  it("sub-50% warn with remedy: keys below 50% over >=5 samples trigger warn", async () => {
    const dbPath = process.env.TAMANDUA_DB_PATH!;
    const template = "Reply with:\nBRANCH: main\nSEVERITY: high\n";
    seedPromptAdherenceDb(dbPath, Array.from({ length: 6 }, (_, i) => ({
      id: `warn-${i}`,
      workflowId: "test-workflow",
      status: "completed",
      // Only 2 out of 6 runs have the keys → 33% each
      context: i < 2 ? { branch: "main", severity: "high" } : {},
      steps: [{ stepId: "dev", inputTemplate: template }],
    })));

    const checks = await runLlmPromptAdherenceChecks();

    // BRANCH: 2/6 = 33%, below 50%, >=5 samples → warn
    const branchCheck = checks.find((c: DoctorCheckResult) => c.message.includes("BRANCH") && c.message.includes("2/6"));
    assert.ok(branchCheck, `Expected warn check for BRANCH, got: ${JSON.stringify(checks.map((c: DoctorCheckResult) => c.message))}`);
    assert.strictEqual(branchCheck!.status, "warn", `BRANCH at 33% should be warn, got: ${branchCheck!.status}`);
    assert.ok(branchCheck!.remedy, "Warn check should have remedy");
    assert.ok(branchCheck!.remedy!.includes("step prompt"), `Remedy should mention step prompt, got: ${branchCheck!.remedy}`);
    assert.ok(branchCheck!.remedy!.includes("BRANCH"), `Remedy should include key name, got: ${branchCheck!.remedy}`);

    // SEVERITY: 2/6 = 33%, below 50%, >=5 samples → warn
    const severityCheck = checks.find((c: DoctorCheckResult) => c.message.includes("SEVERITY") && c.message.includes("2/6"));
    assert.ok(severityCheck, "Expected warn check for SEVERITY");
    assert.strictEqual(severityCheck!.status, "warn");
    assert.ok(severityCheck!.remedy, "Warn check should have remedy");
  });

  it("insufficient data: fewer than 5 terminal runs produces info message", async () => {
    const dbPath = process.env.TAMANDUA_DB_PATH!;
    const template = "Reply with:\nBRANCH: main\n";
    seedPromptAdherenceDb(dbPath, Array.from({ length: 3 }, (_, i) => ({
      id: `id-${i}`,
      workflowId: "test-workflow",
      status: "completed",
      context: { branch: "main" },
      steps: [{ stepId: "dev", inputTemplate: template }],
    })));

    const checks = await runLlmPromptAdherenceChecks();
    assert.strictEqual(checks.length, 1);
    assert.strictEqual(checks[0].name, "Key-emission rates");
    assert.strictEqual(checks[0].status, "info");
    assert.ok(checks[0].message.toLowerCase().includes("insufficient data"), `Expected 'insufficient data', got: ${checks[0].message}`);
    assert.ok(checks[0].message.includes("3"), `Message should mention run count (3), got: ${checks[0].message}`);
  });

  it("empty database: no terminal runs returns empty array", async () => {
    // beforeEach creates an empty file with no runs/steps — no seed needed
    const checks = await runLlmPromptAdherenceChecks();
    assert.strictEqual(checks.length, 0, `Expected empty array for empty DB, got ${checks.length} checks`);
  });

  it("legacy runs with no expected keys are silently skipped", async () => {
    const dbPath = process.env.TAMANDUA_DB_PATH!;
    // Runs with steps that have NO Reply-with block
    seedPromptAdherenceDb(dbPath, Array.from({ length: 5 }, (_, i) => ({
      id: `legacy-${i}`,
      workflowId: "old-workflow",
      status: "completed",
      context: { whatever: "value" },
      steps: [
        { stepId: "old-step", inputTemplate: "Just do some work\nNo Reply-with section here.\n" },
      ],
    })));

    // Should not throw — steps without expected keys are skipped
    const checks = await runLlmPromptAdherenceChecks();
    // Should have a summary with 0 keys tracked
    const summary = checks.find((c: DoctorCheckResult) => c.name === "Summary");
    assert.ok(summary, "Expected summary check even with no expected keys");
    assert.ok(summary!.message.includes("0 keys"), `Summary should show 0 keys, got: ${summary!.message}`);
  });

  it("US-004: STORIES_JSON is excluded from key-emission tracking", async () => {
    const dbPath = process.env.TAMANDUA_DB_PATH!;
    // Template with STORIES_JSON as an expected key alongside other keys
    const template = "Reply with:\nBRANCH: main\nSTORIES_JSON: [...]\nVERIFIED: true\n";
    seedPromptAdherenceDb(dbPath, Array.from({ length: 5 }, (_, i) => ({
      id: `sjsn-excl-${i}`,
      workflowId: "test-workflow",
      status: "completed",
      context: { branch: "main", verified: "true" },
      steps: [{ stepId: "plan", inputTemplate: template }],
    })));

    const checks = await runLlmPromptAdherenceChecks();

    // STORIES_JSON should NOT appear in any check — it is excluded from tracking
    const sjsnCheck = checks.find((c: DoctorCheckResult) =>
      c.message.toUpperCase().includes("STORIES_JSON"));
    assert.strictEqual(sjsnCheck, undefined,
      `STORIES_JSON should be excluded from tracking, got: ${JSON.stringify(sjsnCheck)}`);

    // BRANCH should appear at 100% (present in all 5 runs)
    const branchCheck = checks.find((c: DoctorCheckResult) => c.message.includes("BRANCH"));
    assert.strictEqual(branchCheck, undefined,
      "BRANCH at 100% should not appear in per-key checks");

    // VERIFIED also at 100%, should not appear
    const verifiedCheck = checks.find((c: DoctorCheckResult) => c.message.includes("VERIFIED"));
    assert.strictEqual(verifiedCheck, undefined,
      "VERIFIED at 100% should not appear");

    // Summary should count 10 keys (2 keys × 5 runs), not 15
    const summary = checks.find((c: DoctorCheckResult) => c.name === "Summary");
    assert.ok(summary, "Expected summary check");
    assert.ok(summary!.message.includes("10 keys"),
      `Summary should count 10 keys (BRANCH + VERIFIED × 5 runs), got: ${summary!.message}`);
    assert.ok(summary!.message.includes("100%"),
      `Summary should show 100% emission rate, got: ${summary!.message}`);
  });

  it("US-004: STORIES_JSON exclusion works even when it is the only key", async () => {
    const dbPath = process.env.TAMANDUA_DB_PATH!;
    // Template with ONLY STORIES_JSON as expected key
    const template = "Reply with:\nSTORIES_JSON: [...]\n";
    seedPromptAdherenceDb(dbPath, Array.from({ length: 5 }, (_, i) => ({
      id: `sjsn-only-${i}`,
      workflowId: "test-workflow",
      status: "completed",
      context: {},
      steps: [{ stepId: "plan", inputTemplate: template }],
    })));

    const checks = await runLlmPromptAdherenceChecks();
    // Should have summary with 0 keys (all filtered out)
    const summary = checks.find((c: DoctorCheckResult) => c.name === "Summary");
    assert.ok(summary, "Expected summary check even with only STORIES_JSON");
    assert.ok(summary!.message.includes("0 keys"),
      `Summary should show 0 keys when all are STORIES_JSON, got: ${summary!.message}`);
  });
});

describe("formatDoctorOutput", () => {
  it("returns a string with hasFailures=false for all-pass groups", () => {
    const groups: CheckGroup[] = [
      {
        label: "ENVIRONMENT",
        checks: [
          { name: "Node.js >= 22", status: "pass", message: "v22.0.0 detected" },
        ],
      },
    ];
    const { output, hasFailures } = formatDoctorOutput(groups);
    assert.strictEqual(typeof output, "string");
    assert.strictEqual(hasFailures, false);
    assert.ok(output.includes("All checks passed."), "Should report all passed");
  });

  it("returns hasFailures=true when a check fails", () => {
    const groups: CheckGroup[] = [
      {
        label: "SERVICES",
        checks: [
          { name: "Daemon PID alive", status: "fail", message: "not running", remedy: "tamandua daemon start" },
        ],
      },
    ];
    const { output, hasFailures } = formatDoctorOutput(groups);
    assert.strictEqual(hasFailures, true);
    assert.ok(output.includes("Some checks failed."), "Should report failures");
    assert.ok(output.includes("✗"), "Should include fail icon");
    assert.ok(output.includes("remedy:"), "Should include remedy line");
  });

  it("includes remedy text when provided", () => {
    const groups: CheckGroup[] = [
      {
        label: "ENVIRONMENT",
        checks: [
          { name: "Node.js", status: "fail", message: "missing", remedy: "install node" },
        ],
      },
    ];
    const { output } = formatDoctorOutput(groups);
    assert.ok(output.includes("→ remedy: install node"));
  });

  it("does not include remedy text when not provided", () => {
    const groups: CheckGroup[] = [
      {
        label: "ENVIRONMENT",
        checks: [
          { name: "Node.js", status: "pass", message: "present" },
        ],
      },
    ];
    const { output } = formatDoctorOutput(groups);
    assert.ok(!output.includes("remedy"));
  });

  it("renders correct icons for each status", () => {
    const groups: CheckGroup[] = [
      {
        label: "TEST",
        checks: [
          { name: "pass", status: "pass", message: "all good" },
          { name: "fail", status: "fail", message: "broken", remedy: "fix" },
          { name: "warn", status: "warn", message: "caution" },
          { name: "info", status: "info", message: "note" },
        ],
      },
    ];
    const { output, hasFailures } = formatDoctorOutput(groups);
    assert.strictEqual(hasFailures, true);
    assert.ok(output.includes("✓ pass"));
    assert.ok(output.includes("✗ fail"));
    assert.ok(output.includes("⚠ warn"));
    assert.ok(output.includes("ℹ info"));
  });

  it("renders group labels", () => {
    const groups: CheckGroup[] = [
      { label: "FIRST", checks: [{ name: "a", status: "pass", message: "ok" }] },
      { label: "SECOND", checks: [{ name: "b", status: "pass", message: "ok" }] },
    ];
    const { output } = formatDoctorOutput(groups);
    assert.ok(output.includes("─── FIRST ───"));
    assert.ok(output.includes("─── SECOND ───"));
  });

  it("reports warning count when only warnings are present (no failures)", () => {
    const groups: CheckGroup[] = [
      {
        label: "STALENESS",
        checks: [
          { name: "Daemon build version vs installed", status: "warn", message: "Staleness check inconclusive — daemon predates build version reporting", remedy: "Run: tamandua daemon restart to update" },
        ],
      },
    ];
    const { output, hasFailures } = formatDoctorOutput(groups);
    assert.strictEqual(hasFailures, false, "Warnings-only should not set hasFailures");
    assert.ok(output.includes("All checks passed with 1 warning(s)"),
      `Should report warning count. Got: ${output}`);
    assert.ok(!output.includes("All checks passed.\n"),
      `Should NOT include bare "All checks passed." when warnings present. Got: ${output}`);
    assert.ok(output.includes("review items marked with the warning symbol above"),
      `Should instruct user to review warnings. Got: ${output}`);
  });

  it("reports plural warning count for multiple warnings", () => {
    const groups: CheckGroup[] = [
      {
        label: "TEST",
        checks: [
          { name: "check-a", status: "warn", message: "warning one" },
          { name: "check-b", status: "pass", message: "all good" },
          { name: "check-c", status: "warn", message: "warning two" },
        ],
      },
    ];
    const { output, hasFailures } = formatDoctorOutput(groups);
    assert.strictEqual(hasFailures, false);
    assert.ok(output.includes("All checks passed with 2 warning(s)"),
      `Should report count of 2 warnings. Got: ${output}`);
  });

  it("reports failures normally when both warnings and failures present", () => {
    const groups: CheckGroup[] = [
      {
        label: "MIXED",
        checks: [
          { name: "check-a", status: "warn", message: "caution" },
          { name: "check-b", status: "fail", message: "broken", remedy: "fix it" },
        ],
      },
    ];
    const { output, hasFailures } = formatDoctorOutput(groups);
    assert.strictEqual(hasFailures, true);
    assert.ok(output.includes("Some checks failed."),
      `Should report failures when mixed with warnings. Got: ${output}`);
    assert.ok(!output.includes("All checks passed"),
      `Should not claim all checks passed when failures exist. Got: ${output}`);
  });
});

// ── STORIES_JSON rejection check tests (US-005) ───────────────────

/** Seed the global events JSONL with step.retry events for testing. */
function seedEventsJsonl(stateDir: string, events: Array<{ event: string; runId: string; workflowId?: string; stepId?: string; detail: string }>): void {
  const eventsDir = path.join(stateDir, "events");
  fs.mkdirSync(eventsDir, { recursive: true });
  const eventsFile = path.join(eventsDir, "all.jsonl");
  const lines = events.map((e) =>
    JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n",
  ).join("");
  fs.writeFileSync(eventsFile, lines, "utf-8");
}

function seedEmptyStateDir(stateDir: string): void {
  const eventsDir = path.join(stateDir, "events");
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.writeFileSync(path.join(eventsDir, "all.jsonl"), "", "utf-8");
}

describe("STORIES_JSON validation rejection check (US-005)", () => {
  it("no rejections: info status with 'no recent rejections' message", async () => {
    const homeDir = createTempHome();
    try {
      const stateDir = path.join(homeDir, ".tamandua");
      seedEmptyStateDir(stateDir);

      const groups = await runDoctorChecks({ homeDir });
      const state = groups.find((g) => g.label === "STATE");
      assert.ok(state);
      const check = state!.checks.find((c) => c.name === "STORIES_JSON validation rejections");
      assert.ok(check, "Expected STORIES_JSON validation rejections check");
      assert.strictEqual(check!.status, "info",
        `Should be info when no rejections, got: ${check!.status}`);
      assert.ok(check!.message.includes("No recent STORIES_JSON"),
        `Should say no recent rejections, got: ${check!.message}`);
    } finally {
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("rejections found: warn status with count, affected runs, and error categories", async () => {
    const homeDir = createTempHome();
    try {
      const stateDir = path.join(homeDir, ".tamandua");
      seedEventsJsonl(stateDir, [
        {
          event: "step.retry",
          runId: "run-001",
          workflowId: "feature-dev-merge-worktree",
          stepId: "plan",
          detail: 'STORIES_JSON structural mismatch: the raw JSON contains 7 "id" keys but parsed to only 1 story. Each story must be a separate {...} object separated by },{. Resetting to pending for retry 1/4.',
        },
        {
          event: "step.retry",
          runId: "run-001",
          workflowId: "feature-dev-merge-worktree",
          stepId: "plan",
          detail: 'STORIES_JSON has duplicate key "title" in story object at index 0 (lines 3,5). Resetting to pending for retry 2/4.',
        },
        {
          event: "step.retry",
          runId: "run-002",
          workflowId: "security-audit-merge-worktree",
          stepId: "prioritizer",
          detail: "Failed to parse STORIES_JSON: Unexpected token. Resetting to pending for retry 1/4.",
        },
        {
          event: "step.retry",
          runId: "run-002",
          workflowId: "security-audit-merge-worktree",
          stepId: "prioritizer",
          detail: "STORIES_JSON story at index 0 (id \"fix-001\") has empty or whitespace-only title. Each story title must be non-empty. Resetting to pending for retry 2/4.",
        },
      ]);

      const groups = await runDoctorChecks({ homeDir });
      const state = groups.find((g) => g.label === "STATE");
      assert.ok(state);
      const check = state!.checks.find((c) => c.name === "STORIES_JSON validation rejections");
      assert.ok(check, "Expected STORIES_JSON validation rejections check");
      assert.strictEqual(check!.status, "warn",
        `Should be warn when rejections found, got: ${check!.status}`);

      // Check count
      assert.ok(check!.message.includes("4 STORIES_JSON validation rejections"),
        `Should mention 4 rejections, got: ${check!.message}`);

      // Check affected runs
      assert.ok(check!.message.includes("run-001"),
        `Should mention run-001, got: ${check!.message}`);
      assert.ok(check!.message.includes("run-002"),
        `Should mention run-002, got: ${check!.message}`);
      assert.ok(check!.message.includes("2 runs"),
        `Should mention 2 runs, got: ${check!.message}`);

      // Check error categories
      assert.ok(check!.message.includes("structural_mismatch"),
        `Should include structural_mismatch category, got: ${check!.message}`);
      assert.ok(check!.message.includes("duplicate_key"),
        `Should include duplicate_key category, got: ${check!.message}`);
      assert.ok(check!.message.includes("parse_error"),
        `Should include parse_error category, got: ${check!.message}`);
      assert.ok(check!.message.includes("schema_validation"),
        `Should include schema_validation category, got: ${check!.message}`);

      // Check remedy
      assert.ok(check!.remedy, "Should have remedy");
      assert.ok(check!.remedy!.includes("C20"),
        `Remedy should reference C20, got: ${check!.remedy}`);
    } finally {
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("correctly categorizes each error shape", async () => {
    const homeDir = createTempHome();
    try {
      const stateDir = path.join(homeDir, ".tamandua");
      seedEventsJsonl(stateDir, [
        { event: "step.retry", runId: "run-sm", workflowId: "wf", stepId: "plan", detail: 'STORIES_JSON structural mismatch: raw JSON contains 7 "id" keys but parsed to only 1 story. Resetting to pending for retry 1/4.' },
        { event: "step.retry", runId: "run-dk", workflowId: "wf", stepId: "plan", detail: 'STORIES_JSON has duplicate key "title" in story object at index 0 (lines 3,5). Resetting to pending for retry 1/4.' },
        { event: "step.retry", runId: "run-pe", workflowId: "wf", stepId: "plan", detail: "Failed to parse STORIES_JSON: Unexpected token at line 1. Resetting to pending for retry 1/4." },
        { event: "step.retry", runId: "run-pe2", workflowId: "wf", stepId: "plan", detail: "STORIES_JSON must be an array. Resetting to pending for retry 1/4." },
        { event: "step.retry", runId: "run-sv1", workflowId: "wf", stepId: "plan", detail: 'STORIES_JSON story at index 0 has invalid id "foo". Resetting to pending for retry 1/4.' },
        { event: "step.retry", runId: "run-sv2", workflowId: "wf", stepId: "plan", detail: 'STORIES_JSON story at index 0 (id "US-001") has empty or whitespace-only title. Resetting to pending for retry 1/4.' },
        { event: "step.retry", runId: "run-sv3", workflowId: "wf", stepId: "plan", detail: 'STORIES_JSON story at index 0 (id "US-001") has empty or whitespace-only description. Resetting to pending for retry 1/4.' },
        { event: "step.retry", runId: "run-sv4", workflowId: "wf", stepId: "plan", detail: 'STORIES_JSON story at index 0 (id "US-001") has empty or non-string acceptanceCriteria[0]. Resetting to pending for retry 1/4.' },
        { event: "step.retry", runId: "run-sv5", workflowId: "wf", stepId: "plan", detail: "STORIES_JSON is present but contains zero stories. Resetting to pending for retry 1/4." },
        { event: "step.retry", runId: "run-sv6", workflowId: "wf", stepId: "plan", detail: 'STORIES_JSON has duplicate story id "US-001". Resetting to pending for retry 1/4.' },
        { event: "step.retry", runId: "run-sv7", workflowId: "wf", stepId: "plan", detail: "STORIES_JSON has 25 stories, max is 20. Resetting to pending for retry 1/4." },
        { event: "step.retry", runId: "run-sv8", workflowId: "wf", stepId: "plan", detail: 'STORIES_JSON story at index 0 missing required fields (id, title, description, acceptanceCriteria). Resetting to pending for retry 1/4.' },
      ]);

      const groups = await runDoctorChecks({ homeDir });
      const state = groups.find((g) => g.label === "STATE");
      assert.ok(state);
      const check = state!.checks.find((c) => c.name === "STORIES_JSON validation rejections");
      assert.ok(check, "Expected STORIES_JSON validation rejections check");
      assert.strictEqual(check!.status, "warn");

      // Check category counts in message
      assert.ok(check!.message.includes("structural_mismatch=1"),
        `Expected structural_mismatch=1, got: ${check!.message}`);
      assert.ok(check!.message.includes("duplicate_key=1"),
        `Expected duplicate_key=1, got: ${check!.message}`);
      assert.ok(check!.message.includes("parse_error=2"),
        `Expected parse_error=2, got: ${check!.message}`);
      assert.ok(check!.message.includes("schema_validation=8"),
        `Expected schema_validation=8, got: ${check!.message}`);
    } finally {
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("non-STORIES_JSON step.retry events are not counted", async () => {
    const homeDir = createTempHome();
    try {
      const stateDir = path.join(homeDir, ".tamandua");
      // Seed with non-STORIES_JSON step.retry events
      seedEventsJsonl(stateDir, [
        { event: "step.retry", runId: "run-a", workflowId: "wf", stepId: "dev", detail: "Expects validation failed: BRANCH not found. Resetting to pending for retry 1/4." },
        { event: "step.retry", runId: "run-b", workflowId: "wf", stepId: "verify", detail: "Output missing STATUS marker. Resetting to pending for retry 1/4." },
        { event: "run.completed", runId: "run-c", detail: "ok" },
      ]);

      const groups = await runDoctorChecks({ homeDir });
      const state = groups.find((g) => g.label === "STATE");
      assert.ok(state);
      const check = state!.checks.find((c) => c.name === "STORIES_JSON validation rejections");
      assert.ok(check, "Expected STORIES_JSON validation rejections check");
      assert.strictEqual(check!.status, "info",
        `Should be info when no STORIES_JSON rejections, got: ${check!.status}`);
      assert.ok(check!.message.includes("No recent STORIES_JSON"),
        `Should say no recent rejections, got: ${check!.message}`);
    } finally {
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("truncates long run/workflow lists with total count", async () => {
    const homeDir = createTempHome();
    try {
      const stateDir = path.join(homeDir, ".tamandua");
      // Create rejections across 5 different runs
      const events: Array<{ event: string; runId: string; workflowId: string; stepId: string; detail: string }> = [];
      for (let i = 0; i < 5; i++) {
        events.push({
          event: "step.retry",
          runId: `run-${String(i).padStart(3, "0")}`,
          workflowId: `workflow-${String(i).padStart(3, "0")}`,
          stepId: "plan",
          detail: `STORIES_JSON structural mismatch in run-${String(i).padStart(3, "0")}. Resetting to pending for retry 1/4.`,
        });
      }
      seedEventsJsonl(stateDir, events);

      const groups = await runDoctorChecks({ homeDir });
      const state = groups.find((g) => g.label === "STATE");
      assert.ok(state);
      const check = state!.checks.find((c) => c.name === "STORIES_JSON validation rejections");
      assert.ok(check);
      assert.strictEqual(check!.status, "warn");

      // Should mention truncation for both runs and workflows
      assert.ok(check!.message.includes("5 total"),
        `Should include total count, got: ${check!.message}`);
      assert.ok(check!.message.includes("5 runs"),
        `Should mention 5 runs, got: ${check!.message}`);
    } finally {
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("handles missing events file gracefully", async () => {
    const homeDir = createTempHome();
    try {
      // No events directory at all — should not crash
      const groups = await runDoctorChecks({ homeDir });
      const state = groups.find((g) => g.label === "STATE");
      assert.ok(state);
      const check = state!.checks.find((c) => c.name === "STORIES_JSON validation rejections");
      assert.ok(check, "Expected STORIES_JSON validation rejections check");
      assert.strictEqual(check!.status, "info",
        `Should be info when no events file, got: ${check!.status}`);
    } finally {
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    }
  });
});
