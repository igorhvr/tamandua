/**
 * DIAG-PRUNE US-011 — tests for `tamandua run diagnose`.
 *
 * Two layers are covered:
 *
 *  1. In-process handler tests (injected in-memory db + isolated state dir +
 *     captured streams) for the bundle path, the summary text, the `--json`
 *     shape and the error exits.
 *  2. Real CLI subprocess tests through `bin/tamandua` for the acceptance
 *     criteria (exit codes, `--help` routes, global usage) with an isolated
 *     temp HOME/state dir via `cleanChildEnv` (the test-isolation contract).
 *
 * The file imports `node:child_process` (the CLI subprocess), so it is
 * registered in `tests/serial-files.txt`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import {
  getRunDiagnoseHelp,
  getRunHelp,
  handleRun,
  type RunCommandDeps,
} from "../../../dist/cli/commands/run.js";
import { resolveDiagnosticsBundleDir } from "../../../dist/diagnostics/paths.js";
import { getDb } from "../../../dist/db.js";
import { cleanChildEnv, createTempHome } from "../../../tests/helpers/test-env.ts";

const RUN_ID = "dff0c254-3e7e-4767-9a66-489e8dbdd90e";
const OTHER_RUN_ID = "dff0c254-3e7e-4767-9a66-489e8dbddead";
const RUN_NUMBER = 87;
const TIMESTAMP = "2026-09-23T12:00:00.000Z";

const created: string[] = [];

function makeTemp(prefix: string): string {
  const dir = tamanduaTempDir(prefix);
  created.push(dir);
  return dir;
}

function emptyHomes(): NodeJS.ProcessEnv {
  return {
    PI_HOME: makeTemp("run-cli-pi-"),
    DSH_HOME: makeTemp("run-cli-dsh-"),
    HERMES_HOME: makeTemp("run-cli-hermes-"),
  };
}

after(() => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

const FIXTURE_DDL = `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    run_number INTEGER,
    workflow_id TEXT,
    task TEXT,
    status TEXT,
    context TEXT,
    tokens_spent INTEGER,
    parent_run_id TEXT,
    scheduling_status TEXT,
    scheduling_requested_at TEXT,
    scheduling_error TEXT,
    worker_lost_count INTEGER,
    ceiling_expiry_count INTEGER,
    instant_fail_count INTEGER,
    harness_probe_status TEXT,
    harness_probe_at TEXT,
    test_cmd_established TEXT,
    test_cmd_source TEXT,
    matchlock_policy TEXT,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE steps (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    step_id TEXT,
    agent_id TEXT,
    step_index INTEGER,
    status TEXT,
    type TEXT,
    current_story_id TEXT,
    retry_count INTEGER,
    max_retries INTEGER,
    abandoned_count INTEGER,
    reroute_count INTEGER,
    terminal_reroute_count INTEGER,
    target_moved_reroute_count INTEGER,
    preclaim_death_count INTEGER,
    ledger_concession_count INTEGER,
    claim_job_id TEXT,
    claim_pid INTEGER,
    claim_pgid INTEGER,
    claim_updated_at TEXT,
    claim_invalidated_by TEXT,
    conditional_condition TEXT,
    auto_completed INTEGER,
    auto_complete_reason TEXT,
    output TEXT,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE stories (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    story_index INTEGER,
    story_id TEXT,
    title TEXT,
    description TEXT,
    acceptance_criteria TEXT,
    status TEXT,
    retry_count INTEGER,
    max_retries INTEGER,
    abandoned_count INTEGER,
    resume_reset_count INTEGER,
    output TEXT,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE story_abandonments (
    id TEXT PRIMARY KEY,
    story_id TEXT,
    run_id TEXT,
    reason TEXT,
    abandoned_count INTEGER,
    step_id TEXT,
    created_at TEXT
  );
  CREATE TABLE run_worktrees (
    run_id TEXT PRIMARY KEY,
    worktree_origin_repository TEXT,
    worktree_origin_git_common_dir TEXT,
    worktree_path TEXT,
    worktree_origin_ref TEXT,
    worktree_origin_sha TEXT,
    original_branch TEXT,
    status TEXT,
    cleanup_policy TEXT,
    created_at TEXT,
    removed_at TEXT,
    error TEXT
  );
  CREATE TABLE suite_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT,
    step_id TEXT,
    cmd_display TEXT,
    exit_code INTEGER,
    duration_ms INTEGER,
    log_tail TEXT,
    log_path TEXT,
    created_at TEXT
  );
`;

function makeFixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(FIXTURE_DDL);
  const context = JSON.stringify({
    harness_type: "pi",
    working_directory_for_harness: "/fixture/workdir",
  });
  db.exec(`
    INSERT INTO runs (
      id, run_number, workflow_id, task, status, context, tokens_spent,
      scheduling_status, worker_lost_count, ceiling_expiry_count,
      instant_fail_count, created_at, updated_at
    ) VALUES (
      '${RUN_ID}', ${RUN_NUMBER}, 'feature-dev-merge-worktree', 'do the thing', 'failed',
      '${context}', 4242, 'error', 2, 1, 3,
      '2026-09-23T00:00:00.000Z', '2026-09-23T01:00:00.000Z'
    );
    INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status, type, retry_count, max_retries, preclaim_death_count, output, created_at, updated_at)
      VALUES ('step-1', '${RUN_ID}', 'implement', 'developer', 1, 'failed', 'single', 2, 4, 1, 'STATUS: failed', '2026-09-23T00:10:00.000Z', '2026-09-23T00:20:00.000Z');
  `);
  return db;
}

interface Captured {
  stdout: string;
  stderr: string;
  exits: number[];
}

function captureDeps(db: DatabaseSync, stateDir: string): { deps: RunCommandDeps; captured: Captured } {
  const captured: Captured = { stdout: "", stderr: "", exits: [] };
  const deps: RunCommandDeps = {
    db: db as unknown as RunCommandDeps["db"],
    stateDir,
    timestamp: TIMESTAMP,
    homes: emptyHomes(),
    stdout: (text) => { captured.stdout += text; },
    stderr: (text) => { captured.stderr += text; },
    exit: (code) => { captured.exits.push(code); },
  };
  return { deps, captured };
}

describe("tamandua run diagnose — in-process handler", () => {
  it("declines command groups it does not own", () => {
    assert.equal(handleRun("workflow", ["workflow", "list"]), false);
    assert.equal(handleRun("status", ["status"]), false);
  });

  it("owns the run group help text", () => {
    assert.match(getRunHelp(), /tamandua run — Inspect and diagnose workflow runs/);
    assert.match(getRunHelp(), /diagnose/);
    assert.match(getRunDiagnoseHelp(), /Usage: tamandua run diagnose/);
    assert.match(getRunDiagnoseHelp(), /READ-ONLY/);
    assert.match(getRunDiagnoseHelp(), /--out/);
    assert.match(getRunDiagnoseHelp(), /--json/);
  });

  it("writes the bundle, prints the summary and the bundle path, and does not fail", () => {
    const stateDir = makeTemp("run-cli-inproc-");
    const db = makeFixture();
    const { deps, captured } = captureDeps(db, stateDir);

    const handled = handleRun("run", ["run", "diagnose", String(RUN_NUMBER)], deps);

    assert.equal(handled, true);
    assert.deepEqual(captured.exits, []);
    assert.equal(captured.stderr, "");
    assert.match(captured.stdout, /# Diagnostics summary/);
    assert.match(captured.stdout, new RegExp(`Run: ${RUN_ID}`));
    assert.match(captured.stdout, /Run status: failed/);
    assert.match(captured.stdout, /Bundle: /);

    const expected = resolveDiagnosticsBundleDir({ stateDir, runId: RUN_ID, timestamp: TIMESTAMP });
    assert.ok(captured.stdout.includes(expected));
    assert.ok(fs.statSync(path.join(expected, "summary.json")).isFile());
    db.close();
  });

  it("emits exactly one JSON object with runId, bundlePath and summary under --json", () => {
    const stateDir = makeTemp("run-cli-json-");
    const db = makeFixture();
    const { deps, captured } = captureDeps(db, stateDir);

    handleRun("run", ["run", "diagnose", RUN_ID, "--json"], deps);

    assert.deepEqual(captured.exits, []);
    const parsed = JSON.parse(captured.stdout) as {
      runId: string;
      bundlePath: string;
      summary: Record<string, unknown>;
    };
    assert.equal(parsed.runId, RUN_ID);
    assert.equal(
      parsed.bundlePath,
      resolveDiagnosticsBundleDir({ stateDir, runId: RUN_ID, timestamp: TIMESTAMP }),
    );
    assert.equal((parsed.summary.run as Record<string, unknown>).runStatus, "failed");
    // Exactly one newline-terminated JSON document.
    assert.equal(captured.stdout.trim().split("\n").length, 1);
    db.close();
  });

  it("honours --out by writing <outRoot>/<run-id>", () => {
    const stateDir = makeTemp("run-cli-out-state-");
    const outRoot = makeTemp("run-cli-out-root-");
    const db = makeFixture();
    const { deps, captured } = captureDeps(db, stateDir);

    handleRun("run", ["run", "diagnose", RUN_ID, "--out", outRoot], deps);

    assert.deepEqual(captured.exits, []);
    assert.match(captured.stdout, new RegExp(`Bundle: ${path.join(outRoot, RUN_ID)}`));
    assert.ok(fs.statSync(path.join(outRoot, RUN_ID, "SUMMARY.md")).isFile());
    db.close();
  });

  it("exits non-zero with a stderr message for a missing selector", () => {
    const stateDir = makeTemp("run-cli-noSel-");
    const db = makeFixture();
    const { deps, captured } = captureDeps(db, stateDir);

    handleRun("run", ["run", "diagnose"], deps);

    assert.deepEqual(captured.exits, [1]);
    assert.match(captured.stderr, /Missing run selector/);
    db.close();
  });

  it("exits non-zero with a stderr message for an unknown flag", () => {
    const stateDir = makeTemp("run-cli-flag-");
    const db = makeFixture();
    const { deps, captured } = captureDeps(db, stateDir);

    handleRun("run", ["run", "diagnose", RUN_ID, "--bogus"], deps);

    assert.deepEqual(captured.exits, [1]);
    assert.match(captured.stderr, /Unknown option "--bogus"/);
    db.close();
  });

  it("exits non-zero with a stderr message for an unknown run", () => {
    const stateDir = makeTemp("run-cli-unknown-");
    const db = makeFixture();
    const { deps, captured } = captureDeps(db, stateDir);

    handleRun("run", ["run", "diagnose", "9999"], deps);

    assert.deepEqual(captured.exits, [1]);
    assert.match(captured.stderr, /No run found matching "9999"/);
    assert.equal(captured.stdout, "");
    db.close();
  });

  it("exits non-zero with a stderr message for an ambiguous prefix", () => {
    const stateDir = makeTemp("run-cli-ambiguous-");
    const db = makeFixture();
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      OTHER_RUN_ID,
      88,
      "feature-dev-merge-worktree",
      "other",
      "running",
      "{}",
      "2026-09-23T00:00:00.000Z",
      "2026-09-23T00:00:00.000Z",
    );
    const { deps, captured } = captureDeps(db, stateDir);

    handleRun("run", ["run", "diagnose", "dff0c254"], deps);

    assert.deepEqual(captured.exits, [1]);
    assert.match(captured.stderr, /Ambiguous run selector/);
    db.close();
  });

  it("exits non-zero with a stderr message for an unknown run action", () => {
    const { deps, captured } = captureDeps(new DatabaseSync(":memory:"), makeTemp("run-cli-action-"));
    handleRun("run", ["run", "bogus"], deps);
    assert.deepEqual(captured.exits, [1]);
    assert.match(captured.stderr, /Unknown run action: bogus/);
  });
});

describe("tamandua run diagnose — CLI subprocess", () => {
  function cli(args: string[], env: Record<string, string | undefined>) {
    const wrapperPath = path.resolve("bin/tamandua");
    return spawnSync("/bin/sh", [wrapperPath, ...args], {
      encoding: "utf8",
      env: cleanChildEnv(env),
      timeout: 60_000,
    });
  }

  function seedRun(dbPath: string): void {
    const prev = process.env.TAMANDUA_DB_PATH;
    process.env.TAMANDUA_DB_PATH = dbPath;
    try {
      const db = getDb();
      db.prepare(
        "INSERT INTO runs (id, run_number, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        RUN_ID,
        RUN_NUMBER,
        "feature-dev-merge-worktree",
        "do the thing",
        "failed",
        "{}",
        "2026-09-23T00:00:00.000Z",
        "2026-09-23T01:00:00.000Z",
      );
    } finally {
      if (prev === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = prev;
    }
  }

  it("prints the summary and bundle path and exits 0", () => {
    const th = createTempHome("tamandua-run-cli-ok-");
    const dbPath = path.join(th.tamanduaDir, "tamandua.db");
    seedRun(dbPath);

    const result = cli(["run", "diagnose", String(RUN_NUMBER)], {
      HOME: th.homeDir,
      TAMANDUA_DB_PATH: dbPath,
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /# Diagnostics summary/);
    assert.match(result.stdout, /Run status: failed/);
    assert.match(result.stdout, /Bundle: /);
    assert.match(result.stdout, new RegExp(RUN_ID));
  });

  it("emits a single JSON object under --json and exits 0", () => {
    const th = createTempHome("tamandua-run-cli-json-");
    const dbPath = path.join(th.tamanduaDir, "tamandua.db");
    seedRun(dbPath);

    const result = cli(["run", "diagnose", RUN_ID, "--json"], {
      HOME: th.homeDir,
      TAMANDUA_DB_PATH: dbPath,
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim()) as {
      runId: string;
      bundlePath: string;
      summary: Record<string, unknown>;
    };
    assert.equal(parsed.runId, RUN_ID);
    assert.ok(parsed.bundlePath.includes(RUN_ID));
    assert.equal((parsed.summary.run as Record<string, unknown>).runStatus, "failed");
  });

  it("exits non-zero for an unknown run with a stderr message", () => {
    const th = createTempHome("tamandua-run-cli-missing-");
    const result = cli(["run", "diagnose", "424242"], { HOME: th.homeDir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No run found matching "424242"/);
  });

  it("exits non-zero for a missing selector and an unknown flag", () => {
    const th = createTempHome("tamandua-run-cli-badargs-");
    const missing = cli(["run", "diagnose"], { HOME: th.homeDir });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Missing run selector/);

    const unknownFlag = cli(["run", "diagnose", "x", "--bogus"], { HOME: th.homeDir });
    assert.equal(unknownFlag.status, 1);
    assert.match(unknownFlag.stderr, /Unknown option "--bogus"/);
  });

  it("serves run/diagnose help and lists the command in the global usage", () => {
    const th = createTempHome("tamandua-run-cli-help-");
    const env = { HOME: th.homeDir };

    const diagnoseHelp = cli(["run", "diagnose", "--help"], env);
    assert.equal(diagnoseHelp.status, 0);
    assert.match(diagnoseHelp.stdout, /Usage: tamandua run diagnose/);

    const groupHelp = cli(["run", "--help"], env);
    assert.equal(groupHelp.status, 0);
    assert.match(groupHelp.stdout, /tamandua run — Inspect and diagnose workflow runs/);

    const globalHelp = cli(["--help"], env);
    assert.equal(globalHelp.status, 0);
    assert.match(globalHelp.stdout, /tamandua run diagnose/);
  });
});