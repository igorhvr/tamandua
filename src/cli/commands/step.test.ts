import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import {
  getStepClaimHelp,
  getStepCompleteHelp,
  getStepCurrentHelp,
  getStepFailHelp,
  getStepHelp,
  getStepPeekHelp,
  getStepReleaseHelp,
  getStepStoriesHelp,
  handleStep,
} from "../../../dist/cli/commands/step.js";

/**
 * Test helpers for submit-time expects validation (US-001).
 *
 * These tests exercise the submit-time REJECTED flow by calling handleStep
 * directly with a temporary DB. process.exit is mocked to throw a
 * predictable error so the test can catch the REJECTED path without
 * killing the test process.
 */

class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.name = "ExitError";
    this.code = code;
  }
}

function setupTempDb(): { db: DatabaseSync; dbPath: string; tempDir: string } {
  const tempDir = tamanduaTempDir("tamandua-step-test-");
  const dbPath = path.join(tempDir, ".tamandua", "tamandua.db");

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");

  db.exec(`CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL DEFAULT 'test',
    task TEXT NOT NULL DEFAULT 'test',
    status TEXT NOT NULL DEFAULT 'running',
    context TEXT NOT NULL DEFAULT '{}',
    tokens_spent INTEGER NOT NULL DEFAULT 0,
    scheduling_status TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL DEFAULT 'dev',
    agent_id TEXT NOT NULL DEFAULT 'test-agent',
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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // completeStepInternal merges context — stories table is needed for
  // writeStoryPlanToProgress (hoisted out of completeStepInternal in US-003
  // but still called from completeStep).
  db.exec(`CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    story_index INTEGER NOT NULL,
    story_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    acceptance_criteria TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    output TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 4,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  return { db, dbPath, tempDir };
}

describe("SPL2 step protocol command module", () => {
  it("is backed by a reachable step command source module", () => {
    assert.equal(fs.existsSync(path.join(process.cwd(), "src/cli/commands/step.ts")), true);
    const dispatcher = fs.readFileSync(path.join(process.cwd(), "src/cli/cli.ts"), "utf8");
    assert.match(dispatcher, /from "\.\/commands\/step\.js"/);
  });

  it("owns all step protocol help", () => {
    assert.match(getStepHelp(), /Worker step protocol commands/);
    assert.match(getStepHelp(), /release/);
    assert.match(getStepPeekHelp(), /Output:\n  HAS_WORK/);
    assert.match(getStepClaimHelp(), /On success: \{"stepId":"<UUID>"/);
    assert.match(getStepCurrentHelp(), /Read-only query for a held step/);
    assert.match(getStepCurrentHelp(), /Exit 0 either way; exit 1 on bad args/);
    assert.match(getStepCompleteHelp(), /--file <path>/);
    assert.match(getStepCompleteHelp(), /Read the report from a file instead of stdin/);
    assert.match(getStepCompleteHelp(), /Trailing non-flag arguments after the step-id/);
    assert.match(getStepFailHelp(), /"Unknown error" is used/);
    assert.match(getStepStoriesHelp(), /List all stories and their status for a run/);
    assert.match(getStepStoriesHelp(), /--json/);
    assert.match(getStepReleaseHelp(), /Reset a stuck claimed/);
    assert.match(getStepReleaseHelp(), /step.released/);
  });

  it("declines commands owned by other command groups", async () => {
    assert.equal(await handleStep("logs", ["logs"]), false);
  });

  it("getStepCurrentHelp is referenced from cli.ts --help dispatch", () => {
    const dispatcher = fs.readFileSync(path.join(process.cwd(), "src/cli/cli.ts"), "utf8");
    assert.match(dispatcher, /getStepCurrentHelp/);
    assert.match(dispatcher, /"current".*printHelp\(getStepCurrentHelp/);
  });

  it("getStepReleaseHelp is referenced from cli.ts --help dispatch", () => {
    const dispatcher = readFileSync(join(process.cwd(), "src/cli/cli.ts"), "utf8");
    assert.match(dispatcher, /getStepReleaseHelp/);
    assert.match(dispatcher, /"release".*printHelp\(getStepReleaseHelp/);
  });

  it("getStepHelp is referenced as step-group fallback in cli.ts", () => {
    const dispatcher = readFileSync(join(process.cwd(), "src/cli/cli.ts"), "utf8");
    assert.match(dispatcher, /getStepHelp/);
    assert.match(dispatcher, /printHelp\(getStepHelp\(\)\)/);
  });
});

describe("submit-time expects validation (US-001)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let originalDbPath: string | undefined;
  let originalHome: string | undefined;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    originalHome = process.env.HOME;
    originalStateDir = process.env.TAMANDUA_STATE_DIR;

    const setup = setupTempDb();
    tempDir = setup.tempDir;
    dbPath = setup.dbPath;
    db = setup.db;

    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.HOME = tempDir;
    process.env.TAMANDUA_STATE_DIR = path.join(tempDir, ".tamandua");
  });

  afterEach(() => {
    if (originalDbPath) process.env.TAMANDUA_DB_PATH = originalDbPath;
    else delete process.env.TAMANDUA_DB_PATH;
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalStateDir) process.env.TAMANDUA_STATE_DIR = originalStateDir;
    else delete process.env.TAMANDUA_STATE_DIR;

    db.close();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  /**
   * Mock process.exit so REJECTED validation tests don't kill the test
   * process. Returns a cleanup function that restores the original.
   */
  function mockProcessExit() {
    const origExit = process.exit;
    let exitCode = 0;
    (process.exit as unknown) = (code: number) => {
      exitCode = code;
      throw new ExitError(code);
    };
    return {
      getExitCode: () => exitCode,
      restore: () => { process.exit = origExit; },
    };
  }

  /**
   * Write step output to a temp file and return the path.
   * Helper for tests using the --file flag.
   */
  function writeOutputFile(tempDir: string, content: string): string {
    const filePath = path.join(tempDir, "report.txt");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("rejects output missing a required expects key with REJECTED message and exit 1", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "CHANGES:");

    const reportFile = writeOutputFile(tempDir, "STATUS: done\nTESTS: none");

    const { getExitCode, restore } = mockProcessExit();
    try {
      await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    } finally {
      restore();
    }

    assert.equal(getExitCode(), 1);
  });

  it("step remains in running state after REJECTED", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "CHANGES:");

    const reportFile = writeOutputFile(tempDir, "STATUS: done");

    const { restore } = mockProcessExit();
    try {
      await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    } finally {
      restore();
    }

    // Step should still be 'running' — not consumed by completeStep
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "running");
  });

  it("valid output proceeds to completeStep normally", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "CHANGES:");

    const reportFile = writeOutputFile(tempDir, "STATUS: done\nCHANGES: implemented feature");
    await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);

    // Step should now be 'done'
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "done");
  });

  it("steps with empty expects skip submit-time validation", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "");

    const reportFile = writeOutputFile(tempDir, "STATUS: done");
    await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);

    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "done");
  });

  it("steps with whitespace-only expects skip submit-time validation", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "   \n  ");

    const reportFile = writeOutputFile(tempDir, "STATUS: done");
    await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);

    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "done");
  });

  it("regex expects patterns reject non-matching output", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "regex:^CHANGES:");

    const reportFile = writeOutputFile(tempDir, "STATUS: done");

    const { getExitCode, restore } = mockProcessExit();
    try {
      await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    } finally {
      restore();
    }

    assert.equal(getExitCode(), 1);
    // Step still running
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "running");
  });

  it("regex expects patterns pass matching output", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "regex:^CHANGES:");

    const reportFile = writeOutputFile(tempDir, "STATUS: done\nCHANGES: fixed bug");
    await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);

    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "done");
  });

  // ══════════════════════════════════════════════════════════════════
  // US-002: Honest verdict validation (STATUS: retry/failed pass)
  // ══════════════════════════════════════════════════════════════════

  it("STATUS: retry passes submit-time expects validation and routes as retry", async () => {
    // AC #4: RSTY/RTRV verdict classes still route correctly.
    // STATUS: retry passes submit-time validation (not REJECTED), then
    // completeStep processes it as a retry verdict → step re-pended.
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "STATUS: done\nSTATUS: retry");

    const reportFile = writeOutputFile(tempDir, "STATUS: retry");
    await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);

    // Step should be retried (pending), not done — RSTY verdict routing preserved.
    const step = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(stepId) as { status: string; retry_count: number };
    assert.equal(step.status, "pending", "STATUS: retry should re-pend the step (retry verdict routing)");
  });

  it("STATUS: failed passes submit-time expects when expects lists STATUS: failed", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "STATUS: done\nSTATUS: failed");

    const reportFile = writeOutputFile(tempDir, "STATUS: failed\nREASON: timeout");
    await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);

    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "done", "STATUS: failed should complete when expects accepts it");
  });

  it("output with unrecognized STATUS and missing expects keys is REJECTED", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "CHANGES:");

    const reportFile = writeOutputFile(tempDir, "STATUS: unknown\nNO_CHANGES");

    const { getExitCode, restore } = mockProcessExit();
    try {
      await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    } finally {
      restore();
    }

    assert.equal(getExitCode(), 1);
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "running", "step should still be running after REJECTED");
  });

  it("STATUS: retry passes submit-time validation even when KEY lines are missing", async () => {
    // AC #1: verifier steps with STATUS: retry should pass even if
    // CHANGES:, TESTS:, etc. are absent — the honest verdict is accepted
    // by submit-time validation. The step then routes as retry (pending).
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "STATUS: done\nSTATUS: retry\nCHANGES:\nTESTS:");

    const reportFile = writeOutputFile(tempDir, "STATUS: retry");
    await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);

    // Step should be re-pended (pending) as retry, NOT done.
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "pending", "STATUS: retry should re-pend step even without KEY lines");
  });

  it("STATUS: retry passes submit-time validation with regex expects", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "regex:^STATUS:\\s*(done|retry|failed)$");

    const reportFile = writeOutputFile(tempDir, "STATUS: retry");
    await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);

    // Step routes as retry (pending) — RSTY verdict routing preserved.
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "pending", "STATUS: retry via regex enforcement routes as retry");
  });

  // ══════════════════════════════════════════════════════════════════
  // US-003: STORIES_JSON_FILE resolution at submit time
  // ══════════════════════════════════════════════════════════════════

  it("STORIES_JSON_FILE: path → resolved to inline STORIES_JSON: <json> before step completion", async () => {
    // AC #1: STORIES_JSON_FILE line replaced with STORIES_JSON: <contents>
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "CHANGES:");

    // Write a JSON array to a temp file
    const jsonFilePath = path.join(tempDir, "stories.json");
    const storiesData = [{ id: "US-001", title: "Test story", description: "desc", acceptanceCriteria: ["ac1"] }];
    fs.writeFileSync(jsonFilePath, JSON.stringify(storiesData, null, 2));

    const reportText = `STATUS: done
CHANGES: implemented feature
STORIES_JSON_FILE: ${jsonFilePath}`;
    const reportFile = writeOutputFile(tempDir, reportText);
    await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);

    // Step should be done
    const step = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepId) as { status: string; output: string };
    assert.equal(step.status, "done");
    // Output should contain inline STORIES_JSON, not the file path
    assert.match(step.output, /STORIES_JSON: \[/);
    assert.ok(!step.output.includes("STORIES_JSON_FILE:"), "file path should NOT appear in stored output");
    assert.ok(!step.output.includes(jsonFilePath), "file path should NOT appear in stored output");
  });

  it("missing STORIES_JSON_FILE → error on stderr, exit 1, step NOT completed", async () => {
    // AC #2: missing file → clear error, exit 1, step not consumed
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "CHANGES:");

    const missingPath = path.join(tempDir, "nonexistent.json");
    const reportText = `STATUS: done
CHANGES: stuff
STORIES_JSON_FILE: ${missingPath}`;
    const reportFile = writeOutputFile(tempDir, reportText);

    const { getExitCode, restore } = mockProcessExit();
    let stderrOutput = "";
    const origStderr = process.stderr.write;
    (process.stderr as { write: typeof process.stderr.write }).write = (chunk: any, ...rest: any[]) => {
      stderrOutput += String(chunk);
      return true;
    };
    try {
      await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    } finally {
      restore();
      (process.stderr as { write: typeof process.stderr.write }).write = origStderr;
    }

    assert.equal(getExitCode(), 1);
    assert.match(stderrOutput, /STORIES_JSON_FILE error/);
    assert.match(stderrOutput, /cannot read file/);
    // Step should still be running
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "running", "step should NOT be completed after STORIES_JSON_FILE error");
  });

  it("STORIES_JSON_FILE with non-array JSON → error on stderr, exit 1, step NOT completed", async () => {
    // AC #3: invalid JSON (not array) → clear error, exit 1, step not consumed
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "CHANGES:");

    // Write a JSON OBJECT (not array) to a temp file
    const jsonFilePath = path.join(tempDir, "stories-obj.json");
    fs.writeFileSync(jsonFilePath, JSON.stringify({ not: "an array" }));

    const reportText = `STATUS: done
CHANGES: stuff
STORIES_JSON_FILE: ${jsonFilePath}`;
    const reportFile = writeOutputFile(tempDir, reportText);

    const { getExitCode, restore } = mockProcessExit();
    let stderrOutput = "";
    const origStderr = process.stderr.write;
    (process.stderr as { write: typeof process.stderr.write }).write = (chunk: any, ...rest: any[]) => {
      stderrOutput += String(chunk);
      return true;
    };
    try {
      await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    } finally {
      restore();
      (process.stderr as { write: typeof process.stderr.write }).write = origStderr;
    }

    assert.equal(getExitCode(), 1);
    assert.match(stderrOutput, /STORIES_JSON_FILE error/);
    assert.match(stderrOutput, /must contain a JSON array/);
    // Step should still be running
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "running", "step should NOT be completed after STORIES_JSON_FILE error");
  });

  it("STORIES_JSON_FILE with invalid JSON syntax → error on stderr, exit 1", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "CHANGES:");

    // Write invalid JSON
    const jsonFilePath = path.join(tempDir, "stories-bad.json");
    fs.writeFileSync(jsonFilePath, "not valid json {{{[[[");

    const reportText = `STATUS: done
CHANGES: stuff
STORIES_JSON_FILE: ${jsonFilePath}`;
    const reportFile = writeOutputFile(tempDir, reportText);

    const { getExitCode, restore } = mockProcessExit();
    let stderrOutput = "";
    const origStderr = process.stderr.write;
    (process.stderr as { write: typeof process.stderr.write }).write = (chunk: any, ...rest: any[]) => {
      stderrOutput += String(chunk);
      return true;
    };
    try {
      await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    } finally {
      restore();
      (process.stderr as { write: typeof process.stderr.write }).write = origStderr;
    }

    assert.equal(getExitCode(), 1);
    assert.match(stderrOutput, /STORIES_JSON_FILE error/);
    assert.match(stderrOutput, /does not contain valid JSON/);
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "running", "step should NOT be completed after STORIES_JSON_FILE error");
  });

  it("STORIES_JSON_FILE path resolved relative to process.cwd()", async () => {
    // AC #4: file path resolved relative to process.cwd()
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "CHANGES:");

    // Write a file in the temp dir with a RELATIVE path from cwd
    const relativeName = "relative-stories.json";
    const storiesData = [{ id: "US-001", title: "Test", description: "desc", acceptanceCriteria: ["ac1"] }];
    // Need to write relative to process.cwd() — change cwd temp for this test
    fs.writeFileSync(path.join(tempDir, relativeName), JSON.stringify(storiesData));

    const reportText = `STATUS: done
CHANGES: feature
STORIES_JSON_FILE: ${relativeName}`;
    const reportFile = writeOutputFile(tempDir, reportText);

    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);
    } finally {
      process.chdir(originalCwd);
    }

    const step = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepId) as { status: string; output: string };
    assert.equal(step.status, "done", "step should complete when relative path resolves correctly");
    assert.match(step.output, /STORIES_JSON: \[/);
    assert.ok(!step.output.includes("STORIES_JSON_FILE:"), "file path should not appear in stored output");
  });

  it("STORIES_JSON_FILE resolution preserves other output lines and passes expects validation", async () => {
    // Test that after STORIES_JSON_FILE → STORIES_JSON resolution,
    // the resolved output is then validated against expects.
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "CHANGES:\nTESTS:");

    const jsonFilePath = path.join(tempDir, "stories.json");
    fs.writeFileSync(jsonFilePath, JSON.stringify([{ id: "US-001", title: "Test", description: "desc", acceptanceCriteria: ["ac1"] }]));

    const reportText = `STATUS: done
CHANGES: implemented feature
TESTS: wrote unit tests
STORIES_JSON_FILE: ${jsonFilePath}`;
    const reportFile = writeOutputFile(tempDir, reportText);
    await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);

    const step = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepId) as { status: string; output: string };
    assert.equal(step.status, "done");
    assert.match(step.output, /CHANGES: implemented feature/);
    assert.match(step.output, /TESTS: wrote unit tests/);
    assert.match(step.output, /STORIES_JSON: \[/);
    assert.ok(!step.output.includes("STORIES_JSON_FILE:"));
  });

  // ══════════════════════════════════════════════════════════════════
  // US-005: step complete --file flag and trailing-argv trap fix
  // ══════════════════════════════════════════════════════════════════

  it("US-005: --file reads report content identical to file", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "CHANGES:");

    const reportText = "STATUS: done\nCHANGES: implemented feature\nTESTS: wrote 5 tests";
    const reportFile = writeOutputFile(tempDir, reportText);
    await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);

    const step = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepId) as { status: string; output: string };
    assert.equal(step.status, "done");
    assert.match(step.output, /CHANGES: implemented feature/);
    assert.match(step.output, /TESTS: wrote 5 tests/);
  });

  it("US-005: provenance — file deleted after invocation, completion still succeeds with stored contents", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "CHANGES:");

    const reportText = "STATUS: done\nCHANGES: from file that will be deleted\nTESTS: none";
    const reportFile = writeOutputFile(tempDir, reportText);

    // Complete the step with --file
    await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);

    // Delete the file immediately after — should have no effect on the stored output
    fs.unlinkSync(reportFile);

    // Verify the step was completed with the correct output
    const step = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepId) as { status: string; output: string };
    assert.equal(step.status, "done");
    assert.match(step.output, /CHANGES: from file that will be deleted/);
    assert.ok(!step.output.includes(reportFile), "file path should NOT appear in stored output");
  });

  it("US-005: missing/unreadable --file → error on stderr, exit 1, step NOT completed", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "CHANGES:");

    const missingPath = path.join(tempDir, "nonexistent-report.txt");

    const { getExitCode, restore } = mockProcessExit();
    let stderrOutput = "";
    const origStderr = process.stderr.write;
    (process.stderr as { write: typeof process.stderr.write }).write = (chunk: any, ...rest: any[]) => {
      stderrOutput += String(chunk);
      return true;
    };
    try {
      await handleStep("step", ["step", "complete", stepId, "--file", missingPath]);
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    } finally {
      restore();
      (process.stderr as { write: typeof process.stderr.write }).write = origStderr;
    }

    assert.equal(getExitCode(), 1);
    assert.match(stderrOutput, /Cannot read --file/);
    // Step should still be running
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "running", "step should NOT be completed when --file is missing");
  });

  it("US-005: trailing non-flag argv after step-id → error, exit 1", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "CHANGES:");

    const { getExitCode, restore } = mockProcessExit();
    let stderrOutput = "";
    const origStderr = process.stderr.write;
    (process.stderr as { write: typeof process.stderr.write }).write = (chunk: any, ...rest: any[]) => {
      stderrOutput += String(chunk);
      return true;
    };
    try {
      // Old positional-arg form should now be rejected
      await handleStep("step", ["step", "complete", stepId, "STATUS: done", "CHANGES: stuff"]);
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    } finally {
      restore();
      (process.stderr as { write: typeof process.stderr.write }).write = origStderr;
    }

    assert.equal(getExitCode(), 1);
    assert.match(stderrOutput, /unexpected argument/);
    // Step should still be running (not consumed)
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "running", "step should NOT be consumed when trailing argv is passed");
  });

  it("US-005: --file path NOT stored in DB output (provenance)", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "CHANGES:");

    const reportFile = writeOutputFile(tempDir, "STATUS: done\nCHANGES: provenance test");
    await handleStep("step", ["step", "complete", stepId, "--file", reportFile]);

    const step = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepId) as { status: string; output: string };
    assert.equal(step.status, "done");
    // The file path must NOT appear in the stored output
    assert.ok(!step.output.includes(reportFile), `file path ${reportFile} must not appear in stored output: ${step.output}`);
    assert.match(step.output, /CHANGES: provenance test/);
  });

  it("US-005: --file= syntax works", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, expects, status) VALUES (?, ?, ?, 'running')"
    ).run(stepId, runId, "CHANGES:");

    const reportFile = writeOutputFile(tempDir, "STATUS: done\nCHANGES: equals-syntax test");
    await handleStep("step", ["step", "complete", stepId, `--file=${reportFile}`]);

    const step = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepId) as { status: string; output: string };
    assert.equal(step.status, "done");
    assert.match(step.output, /CHANGES: equals-syntax test/);
  });

  // ══════════════════════════════════════════════════════════════════
  // US-006: step fail --reason-file flag
  // ══════════════════════════════════════════════════════════════════

  it("US-006: --reason-file reads and passes file contents as error reason", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, retry_count, max_retries, type, status) VALUES (?, ?, ?, 0, 4, 'single', 'running')"
    ).run(stepId, runId, "test-step");

    const reasonFile = writeOutputFile(tempDir, "Test failure reason\nsecond line");
    await handleStep("step", ["step", "fail", stepId, "--reason-file", reasonFile]);

    // The step should be failed or retrying; the output should contain the reason
    const step = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepId) as { status: string; output: string | null };
    assert.ok(step.status === "retrying" || step.status === "pending", `expected retrying/pending, got ${step.status}`);
    assert.ok(step.output?.includes("Test failure reason"), `output should contain reason: ${step.output}`);
    assert.ok(step.output?.includes("second line"), `output should contain second line: ${step.output}`);
  });

  it("US-006: provenance — file path NOT stored in DB output", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, retry_count, max_retries, type, status) VALUES (?, ?, ?, 0, 4, 'single', 'running')"
    ).run(stepId, runId, "test-step");

    const reasonFile = writeOutputFile(tempDir, "some reason");
    await handleStep("step", ["step", "fail", stepId, "--reason-file", reasonFile]);

    const step = db.prepare("SELECT output FROM steps WHERE id = ?").get(stepId) as { output: string | null };
    assert.ok(!step.output?.includes(reasonFile), `file path ${reasonFile} must not appear in stored output: ${step.output}`);
  });

  it("US-006: missing/unreadable --reason-file → error on stderr, exit 1, step NOT failed", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, retry_count, max_retries, type, status) VALUES (?, ?, ?, 0, 4, 'single', 'running')"
    ).run(stepId, runId, "test-step");

    const missingPath = path.join(tempDir, "nonexistent-reason.txt");

    const { getExitCode, restore } = mockProcessExit();
    let stderrOutput = "";
    const origStderr = process.stderr.write;
    (process.stderr as { write: typeof process.stderr.write }).write = (chunk: any, ...rest: any[]) => {
      stderrOutput += String(chunk);
      return true;
    };
    try {
      await handleStep("step", ["step", "fail", stepId, "--reason-file", missingPath]);
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    } finally {
      restore();
      (process.stderr as { write: typeof process.stderr.write }).write = origStderr;
    }

    assert.equal(getExitCode(), 1);
    assert.match(stderrOutput, /Cannot read --reason-file/);
    // Step should still be running
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert.equal(step.status, "running", "step should NOT be failed when --reason-file is missing");
  });

  it("US-006: --reason-file takes precedence over inline reason", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, retry_count, max_retries, type, status) VALUES (?, ?, ?, 0, 4, 'single', 'running')"
    ).run(stepId, runId, "test-step");

    const reasonFile = writeOutputFile(tempDir, "reason from file");
    // Pass both --reason-file and inline reason; file should win
    await handleStep("step", ["step", "fail", stepId, "--reason-file", reasonFile, "reason from argv"]);

    const step = db.prepare("SELECT output FROM steps WHERE id = ?").get(stepId) as { output: string | null };
    assert.ok(step.output?.includes("reason from file"), `output should contain file reason: ${step.output}`);
    assert.ok(!step.output?.includes("reason from argv"), `output should NOT contain argv reason: ${step.output}`);
  });

  it("US-006: default Unknown error when no reason provided and no --reason-file", async () => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id) VALUES (?)").run(runId);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, retry_count, max_retries, type, status) VALUES (?, ?, ?, 0, 4, 'single', 'running')"
    ).run(stepId, runId, "test-step");

    await handleStep("step", ["step", "fail", stepId]);

    const step = db.prepare("SELECT output FROM steps WHERE id = ?").get(stepId) as { output: string | null };
    assert.ok(step.output?.includes("Unknown error"), `output should contain Unknown error: ${step.output}`);
  });
});
