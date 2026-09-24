/**
 * DIAG-PRUNE US-010 — unit tests for the diagnostics bundle orchestrator.
 *
 * `bundle.ts` transitively imports `src/installer/dsh-usage.ts` (through the
 * session-path collector), which owns a `node:child_process` import, so this
 * file is registered in `tests/serial-files.txt`.
 *
 * All fixtures are isolated temp dirs passed explicitly (state dir + `homes`
 * bag), so no real state dir, daemon, session store or database is touched.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  createDiagnosticsBundle,
  DIAGNOSTICS_BUNDLE_FILES,
  type DiagnosticsBundleDb,
} from "../../dist/diagnostics/bundle.js";
import { resolveDiagnosticsBundleDir } from "../../dist/diagnostics/paths.js";
import { projectKey } from "../../dist/installer/dsh-usage.js";

const RUN_ID = "dff0c254-3e7e-4767-9a66-489e8dbdd90e";
const RUN_NUMBER = 87;
const TIMESTAMP = "2026-09-23T12:00:00.000Z";

const created: string[] = [];

function makeTemp(prefix: string): string {
  const dir = tamanduaTempDir(prefix);
  created.push(dir);
  return dir;
}

/** An empty `homes` bag so no real session store is ever consulted. */
function emptyHomes(): NodeJS.ProcessEnv {
  return {
    PI_HOME: makeTemp("diag-bundle-pi-"),
    DSH_HOME: makeTemp("diag-bundle-dsh-"),
    HERMES_HOME: makeTemp("diag-bundle-hermes-"),
  };
}

after(() => {
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true });
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

interface Fixture {
  db: DatabaseSync;
  workdir: string;
}

function makeFixture(policyJson: string | null = null): Fixture {
  const workdir = makeTemp("diag-bundle-workdir-");
  const db = new DatabaseSync(":memory:");
  db.exec(FIXTURE_DDL);
  const context = JSON.stringify({
    harness_type: "pi",
    working_directory_for_harness: workdir,
  });
  db.exec(`
    INSERT INTO runs (
      id, run_number, workflow_id, task, status, context, tokens_spent, parent_run_id,
      scheduling_status, scheduling_requested_at, scheduling_error,
      worker_lost_count, ceiling_expiry_count, instant_fail_count,
      harness_probe_status, harness_probe_at, test_cmd_established, test_cmd_source,
      matchlock_policy, created_at, updated_at
    ) VALUES (
      '${RUN_ID}', ${RUN_NUMBER}, 'feature-dev-merge-worktree', 'do the thing', 'failed',
      '${context}', 4242, NULL, 'error', '2026-09-23T00:00:00.000Z', 'harness workdir busy',
      2, 1, 3, 'ok', '2026-09-23T00:30:00.000Z', 'npm test', 'launch',
      ${policyJson === null ? "NULL" : `'${policyJson}'`},
      '2026-09-23T00:00:00.000Z', '2026-09-23T01:00:00.000Z'
    );
    INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status, type, retry_count, max_retries, preclaim_death_count, output, created_at, updated_at)
      VALUES ('step-1', '${RUN_ID}', 'implement', 'developer', 1, 'failed', 'single', 2, 4, 1, 'STATUS: failed', '2026-09-23T00:10:00.000Z', '2026-09-23T00:20:00.000Z');
    INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at)
      VALUES ('story-1', '${RUN_ID}', 0, 'US-001', 'Story one', 'desc', '[]', 'failed', 3, 4, '2026-09-23T00:05:00.000Z', '2026-09-23T00:25:00.000Z');
    INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, step_id, created_at)
      VALUES ('abn-1', 'story-1', '${RUN_ID}', 'worker_lost', 1, 'step-1', '2026-09-23T00:15:00.000Z');
    INSERT INTO run_worktrees (run_id, worktree_origin_repository, worktree_origin_git_common_dir, worktree_path, worktree_origin_ref, worktree_origin_sha, original_branch, status, cleanup_policy, created_at, removed_at, error)
      VALUES ('${RUN_ID}', '/origin', '/origin/.git', '${workdir}', 'refs/heads/main', 'deadbeef', 'main', 'removed', 'remove_on_success', '2026-09-23T00:00:00.000Z', '2026-09-23T01:30:00.000Z', NULL);
  `);
  return { db, workdir };
}

function asBundleDb(db: DatabaseSync): DiagnosticsBundleDb {
  return db as unknown as DiagnosticsBundleDb;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("createDiagnosticsBundle — default bundle layout", () => {
  it("writes every named file into the default diagnostics bundle and returns its path plus summary", () => {
    const stateDir = makeTemp("diag-bundle-default-");
    const fixture = makeFixture();
    const result = createDiagnosticsBundle({
      runId: `run-${RUN_ID}`,
      stateDir,
      db: asBundleDb(fixture.db),
      timestamp: TIMESTAMP,
      homes: emptyHomes(),
    });

    const expected = resolveDiagnosticsBundleDir({
      stateDir,
      runId: RUN_ID,
      timestamp: TIMESTAMP,
    });
    assert.equal(result.bundlePath, expected);
    assert.equal(result.bareRunId, RUN_ID);
    assert.equal(result.runId, RUN_ID);
    assert.deepEqual(result.files, [...DIAGNOSTICS_BUNDLE_FILES]);
    for (const name of DIAGNOSTICS_BUNDLE_FILES) {
      assert.ok(
        fs.statSync(path.join(result.bundlePath, name)).isFile(),
        `expected ${name} to be written`,
      );
    }

    const runFile = readJson(path.join(result.bundlePath, "run.json"));
    assert.equal(runFile.status, "present");
    assert.equal((runFile.rows as unknown[]).length, 1);
    assert.equal(readJson(path.join(result.bundlePath, "steps.json")).status, "present");
    assert.equal(readJson(path.join(result.bundlePath, "stories.json")).status, "present");
    assert.equal(
      readJson(path.join(result.bundlePath, "story_abandonments.json")).status,
      "present",
    );
    assert.equal(
      readJson(path.join(result.bundlePath, "run_worktrees.json")).status,
      "present",
    );

    assert.equal(result.summary.run.runStatus, "failed");
    assert.equal(result.summary.run.runNumber, RUN_NUMBER);
    assert.equal(result.summary.timelineStatus, "present");
    const summaryFile = readJson(path.join(result.bundlePath, "summary.json"));
    assert.equal(
      (summaryFile.run as Record<string, unknown>).runStatus,
      "failed",
    );
    const markdown = fs.readFileSync(
      path.join(result.bundlePath, "SUMMARY.md"),
      "utf8",
    );
    assert.match(markdown, /Run status: failed/);
    fixture.db.close();
  });

  it("writes <outRoot>/<bareRunId> when outRoot is supplied", () => {
    const stateDir = makeTemp("diag-bundle-outstate-");
    const outRoot = makeTemp("diag-bundle-outroot-");
    const fixture = makeFixture();
    const result = createDiagnosticsBundle({
      runId: RUN_ID,
      stateDir,
      outRoot,
      db: asBundleDb(fixture.db),
      timestamp: TIMESTAMP,
      homes: emptyHomes(),
    });

    assert.equal(result.bundlePath, path.join(outRoot, RUN_ID));
    assert.ok(fs.statSync(path.join(result.bundlePath, "summary.json")).isFile());
    fixture.db.close();
  });
});

describe("createDiagnosticsBundle — missing sources are explicit and never throw", () => {
  it("produces a complete bundle with absent markers for absent event/log/evidence/session/matchlock sources", () => {
    const stateDir = makeTemp("diag-bundle-absent-");
    const fixture = makeFixture();
    const result = createDiagnosticsBundle({
      runId: RUN_ID,
      stateDir,
      db: asBundleDb(fixture.db),
      timestamp: TIMESTAMP,
      homes: emptyHomes(),
    });

    // No source threw: the bundle is complete.
    for (const name of DIAGNOSTICS_BUNDLE_FILES) {
      assert.ok(fs.statSync(path.join(result.bundlePath, name)).isFile());
    }

    const events = fs.readFileSync(path.join(result.bundlePath, "events.jsonl"), "utf8");
    assert.match(events, /"absent":true/);
    const log = fs.readFileSync(path.join(result.bundlePath, "daemon-log.txt"), "utf8");
    assert.match(log, /absent/);
    assert.equal(
      readJson(path.join(result.bundlePath, "session-paths.json")).status,
      "absent",
    );
    // The pi store candidate is the escaped-cwd project dir used by token
    // attribution (this import is also what pins the serial-lane dependency).
    const sessionPaths = readJson(
      path.join(result.bundlePath, "session-paths.json"),
    );
    const piEntry = (sessionPaths.entries as Array<Record<string, unknown>>).find(
      (entry) => entry.harness === "pi",
    );
    assert.ok(
      (piEntry?.candidatePaths as string[]).some((candidate) =>
        candidate.includes(projectKey(fixture.workdir)),
      ),
      "pi candidate path carries the project key",
    );
    assert.equal(
      readJson(path.join(result.bundlePath, "evidence.json")).status,
      "absent",
    );
    assert.equal(
      readJson(path.join(result.bundlePath, "matchlock.json")).status,
      "absent",
    );
    assert.equal(
      readJson(path.join(result.bundlePath, "suite-ledger.json")).status,
      "empty",
    );
    assert.equal(result.summary.sources.events, "absent");
    assert.equal(result.summary.sources.logs, "absent");
    assert.equal(result.summary.sources.evidence, "absent");
    assert.equal(result.summary.sources.sessions, "absent");
    assert.equal(result.summary.sources.matchlock, "absent");
    fixture.db.close();
  });

  it("never throws when the database is unusable", () => {
    const stateDir = makeTemp("diag-bundle-brokendb-");
    const broken = {
      prepare(): never {
        throw new Error("database is gone");
      },
    } as unknown as DiagnosticsBundleDb;

    const result = createDiagnosticsBundle({
      runId: RUN_ID,
      stateDir,
      db: broken,
      timestamp: TIMESTAMP,
      homes: emptyHomes(),
    });

    for (const name of DIAGNOSTICS_BUNDLE_FILES) {
      assert.ok(fs.statSync(path.join(result.bundlePath, name)).isFile());
    }
    assert.equal(readJson(path.join(result.bundlePath, "run.json")).status, "absent");
    assert.equal(result.summary.run.status, "absent");
    assert.equal(result.summary.sources.db, "absent");
  });
});

describe("createDiagnosticsBundle — Matchlock-shaped run", () => {
  it("writes matchlock.json with VM ids and a redacted policy", () => {
    const stateDir = makeTemp("diag-bundle-matchlock-");
    const policyJson = JSON.stringify({
      version: 2,
      harness: "pi",
      requestedImage: "igorhvr/bedlam-ubuntu",
      registryToken: "super-secret-token",
    });
    const fixture = makeFixture(policyJson);
    const vmDir = path.join(stateDir, "runs", RUN_ID, "matchlock", "vm-394274ee");
    fs.mkdirSync(vmDir, { recursive: true });
    fs.writeFileSync(path.join(vmDir, "console.log"), "console-bytes");
    fs.writeFileSync(
      path.join(stateDir, "runs", RUN_ID, "matchlock", "orphans.json"),
      JSON.stringify([{ vmId: "vm-394274ee", secret: "s3cr3t", phase: "close" }]),
    );

    const result = createDiagnosticsBundle({
      runId: RUN_ID,
      stateDir,
      db: asBundleDb(fixture.db),
      timestamp: TIMESTAMP,
      homes: emptyHomes(),
    });

    const raw = fs.readFileSync(path.join(result.bundlePath, "matchlock.json"), "utf8");
    assert.ok(!raw.includes("super-secret-token"), "policy secret must not leak");
    assert.ok(!raw.includes("s3cr3t"), "record secret must not leak");
    const matchlock = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(matchlock.status, "present");
    assert.equal(matchlock.policyStatus, "present");
    assert.equal((matchlock.policy as Record<string, unknown>).registryToken, "<redacted>");
    const vms = matchlock.vms as Array<Record<string, unknown>>;
    assert.equal(vms.length, 1);
    assert.equal(vms[0].vmId, "vm-394274ee");
    const errorRecords = matchlock.errorRecords as Array<Record<string, unknown>>;
    assert.equal(errorRecords.length, 1);
    assert.equal(
      (errorRecords[0].record as Array<Record<string, unknown>>)[0].secret,
      "<redacted>",
    );
    fixture.db.close();
  });
});

describe("createDiagnosticsBundle — read-only", () => {
  it("leaves the event stream, daemon log and DB row unchanged", () => {
    const stateDir = makeTemp("diag-bundle-readonly-");
    const fixture = makeFixture();
    const eventsDir = path.join(stateDir, "events");
    fs.mkdirSync(eventsDir, { recursive: true });
    const eventLine = JSON.stringify({
      event: "run.completed",
      runId: RUN_ID,
      ts: "2026-09-23T00:59:00.000Z",
    });
    const eventFile = path.join(eventsDir, `${RUN_ID}.jsonl`);
    fs.writeFileSync(eventFile, `${eventLine}\n`);
    const logFile = path.join(stateDir, "tamandua.log");
    fs.writeFileSync(
      logFile,
      `2026-09-23T00:00:00.000Z INFO scheduler run=${RUN_ID} dispatched\n`,
    );
    const evidenceFile = path.join(stateDir, "runs", RUN_ID, "round.log");
    fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
    fs.writeFileSync(evidenceFile, "round-bytes");

    const beforeEvents = fs.readFileSync(eventFile, "utf8");
    const beforeLog = fs.readFileSync(logFile, "utf8");
    const beforeEvidence = fs.readFileSync(evidenceFile, "utf8");

    const result = createDiagnosticsBundle({
      runId: RUN_ID,
      stateDir,
      db: asBundleDb(fixture.db),
      timestamp: TIMESTAMP,
      homes: emptyHomes(),
    });

    assert.equal(fs.readFileSync(eventFile, "utf8"), beforeEvents);
    assert.equal(fs.readFileSync(logFile, "utf8"), beforeLog);
    assert.equal(fs.readFileSync(evidenceFile, "utf8"), beforeEvidence);

    const row = fixture.db
      .prepare("SELECT status, tokens_spent FROM runs WHERE id = ?")
      .get(RUN_ID) as { status: string; tokens_spent: number };
    assert.equal(row.status, "failed");
    assert.equal(row.tokens_spent, 4242);

    // The collected sources are represented, not fabricated.
    const eventsJsonl = fs.readFileSync(
      path.join(result.bundlePath, "events.jsonl"),
      "utf8",
    );
    assert.match(eventsJsonl, /run\.completed/);
    const daemonLog = fs.readFileSync(
      path.join(result.bundlePath, "daemon-log.txt"),
      "utf8",
    );
    assert.match(daemonLog, new RegExp(RUN_ID));
    const evidence = readJson(path.join(result.bundlePath, "evidence.json"));
    assert.equal(evidence.status, "present");
    fixture.db.close();
  });
});