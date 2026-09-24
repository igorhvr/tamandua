/**
 * DIAG-PRUNE US-006 — unit tests for the evidence directory + suite-ledger
 * collector.
 *
 * Pure filesystem + in-memory `node:sqlite` fixtures (no child_process, no
 * daemon) — stays in the parallel lane. The happy-path ledger test creates the
 * real `suite_results` columns and exercises the projected SELECT; the
 * evidence tests write real files (including symlinks) under an isolated temp
 * state dir.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  collectEvidence,
  type CollectEvidenceOptions,
} from "../../dist/diagnostics/collect-evidence.js";
import type { DiagnosticsDb } from "../../dist/diagnostics/collect-db.js";

const BARE = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER = "bbbbbbbb-2222-4222-8222-222222222222";

const created: string[] = [];

function makeState(prefix = "diag-evidence-"): string {
  const dir = tamanduaTempDir(prefix);
  created.push(dir);
  return dir;
}

after(() => {
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SUITE_RESULTS_DDL = `
  CREATE TABLE suite_results (
    id INTEGER PRIMARY KEY,
    origin_repo TEXT NOT NULL,
    tree_hash TEXT NOT NULL,
    cmd_hash TEXT NOT NULL,
    cmd_display TEXT NOT NULL,
    exit_code INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    log_tail TEXT,
    log_path TEXT,
    run_id TEXT,
    step_id TEXT,
    created_at TEXT NOT NULL
  );
`;

function makeLedgerDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SUITE_RESULTS_DDL);
  db.exec(`
    INSERT INTO suite_results (id, origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, log_path, run_id, step_id, created_at)
      VALUES (1, '/origin', 'tree-a', 'cmd-a', 'npm test', 0, 1234, 'all green', '/state/suite-logs/1.log', '${BARE}', 'step-1', '2026-09-22T00:01:00.000Z');
    INSERT INTO suite_results (id, origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, log_path, run_id, step_id, created_at)
      VALUES (2, '/origin', 'tree-b', 'cmd-b', 'node test.mjs', 1, 50, NULL, NULL, 'run-${BARE}', 'step-2', '2026-09-22T00:02:00.000Z');
    INSERT INTO suite_results (id, origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, log_path, run_id, step_id, created_at)
      VALUES (3, '/origin', 'tree-c', 'cmd-c', 'other', 0, 5, NULL, NULL, '${OTHER}', NULL, '2026-09-22T00:03:00.000Z');
  `);
  return db;
}

function asInjected(db: DatabaseSync): DiagnosticsDb {
  return db as unknown as DiagnosticsDb;
}

function writeEvidenceFile(state: string, bare: string, rel: string, content: string): string {
  const full = path.join(state, "runs", bare, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe("collectEvidence — evidence directory", () => {
  it("lists nested evidence files with relative paths, sizes and totals", () => {
    const state = makeState();
    writeEvidenceFile(state, BARE, "stdout.log", "hello");
    writeEvidenceFile(state, BARE, "nested/deep/artifact.bin", "1234567890");

    const result = collectEvidence({ stateDir: state, bareRunId: BARE, db: asInjected(makeLedgerDb()) });

    assert.equal(result.status, "present");
    assert.equal(result.evidenceDir, path.join(state, "runs", BARE));
    assert.deepEqual(
      result.entries.map((entry) => entry.path),
      ["nested/deep/artifact.bin", "stdout.log"],
    );
    assert.equal(result.entries[0].sizeBytes, 10);
    assert.equal(result.entries[1].sizeBytes, 5);
    assert.equal(result.totalBytes, 15);
  });

  it("reports 'empty' when the evidence directory exists but holds no files", () => {
    const state = makeState();
    fs.mkdirSync(path.join(state, "runs", BARE), { recursive: true });

    const result = collectEvidence({ stateDir: state, bareRunId: BARE, db: asInjected(makeLedgerDb()) });

    assert.equal(result.status, "empty");
    assert.deepEqual(result.entries, []);
    assert.equal(result.totalBytes, 0);
  });

  it("tolerates a run- prefixed selector without double-prefixing the path", () => {
    const state = makeState();
    writeEvidenceFile(state, BARE, "one.txt", "x");

    const result = collectEvidence({ stateDir: state, runId: `run-${BARE}`, db: asInjected(makeLedgerDb()) });

    assert.equal(result.status, "present");
    assert.equal(result.evidenceDir, path.join(state, "runs", BARE));
    assert.equal(result.entries.length, 1);
  });

  it("never follows a symlink out of the evidence directory", () => {
    const state = makeState();
    writeEvidenceFile(state, BARE, "inside.txt", "in");
    const outside = makeState("diag-evidence-outside-");
    fs.writeFileSync(path.join(outside, "outside.txt"), "secret-outside");
    const evidenceDir = path.join(state, "runs", BARE);
    fs.symlinkSync(path.join(outside, "outside.txt"), path.join(evidenceDir, "link-out-file"));
    fs.symlinkSync(outside, path.join(evidenceDir, "link-out-dir"));
    // A symlink that stays inside IS followed.
    fs.symlinkSync(path.join(evidenceDir, "inside.txt"), path.join(evidenceDir, "link-in-file"));

    const result = collectEvidence({ stateDir: state, bareRunId: BARE, db: asInjected(makeLedgerDb()) });

    assert.equal(result.status, "present");
    const paths = result.entries.map((entry) => entry.path).sort();
    assert.deepEqual(paths, ["inside.txt", "link-in-file"]);
    assert.equal(result.totalBytes, 4);
  });

  it("does not loop on a symlinked directory that points back inside the root", () => {
    const state = makeState();
    writeEvidenceFile(state, BARE, "sub/deep.txt", "12345");
    const evidenceDir = path.join(state, "runs", BARE);
    fs.symlinkSync(path.join(evidenceDir, "sub"), path.join(evidenceDir, "back"));

    const result = collectEvidence({ stateDir: state, bareRunId: BARE, db: asInjected(makeLedgerDb()) });

    assert.equal(result.status, "present");
    const paths = result.entries.map((entry) => entry.path);
    // Exactly one real file is reported (the alias is deduped by realpath, so
    // readdir order decides which spelling wins) and there is no infinite loop.
    assert.equal(paths.length, 1);
    assert.match(paths[0], /(^|\/)(deep\.txt)$/);
    assert.equal(result.totalBytes, 5);
  });

  it("reports 'absent' with totalBytes 0 when there is no evidence directory", () => {
    const state = makeState();

    const result = collectEvidence({ stateDir: state, bareRunId: BARE, db: asInjected(makeLedgerDb()) });

    assert.equal(result.status, "absent");
    assert.equal(result.totalBytes, 0);
    assert.deepEqual(result.entries, []);
    assert.match(result.absenceReason ?? "", /evidence directory not found/);
  });

  it("never throws when the evidence path is a regular file", () => {
    const state = makeState();
    fs.mkdirSync(path.join(state, "runs"), { recursive: true });
    fs.writeFileSync(path.join(state, "runs", BARE), "not a dir");

    const result = collectEvidence({ stateDir: state, bareRunId: BARE, db: asInjected(makeLedgerDb()) });

    assert.equal(result.status, "absent");
    assert.match(result.absenceReason ?? "", /not a directory/);
  });
});

describe("collectEvidence — suite ledger", () => {
  it("returns ledger rows for the bare and run- prefixed run id with log_path and tail presence", () => {
    const state = makeState();
    fs.mkdirSync(path.join(state, "runs", BARE), { recursive: true });
    const db = makeLedgerDb();

    const result = collectEvidence({ stateDir: state, runId: `run-${BARE}`, db: asInjected(db) });

    assert.equal(result.suiteLedgerStatus, "present");
    assert.equal(result.suiteLedger.length, 2);
    assert.deepEqual(
      result.suiteLedger.map((row) => row.id),
      ["1", "2"],
    );
    assert.equal(result.suiteLedger[0].runId, BARE);
    assert.equal(result.suiteLedger[0].cmdDisplay, "npm test");
    assert.equal(result.suiteLedger[0].logPath, "/state/suite-logs/1.log");
    assert.equal(result.suiteLedger[0].hasLogTail, true);
    // The raw log body is never embedded in the row.
    assert.equal("log_tail" in result.suiteLedger[0], false);
    assert.equal(result.suiteLedger[1].runId, `run-${BARE}`);
    assert.equal(result.suiteLedger[1].logPath, null);
    assert.equal(result.suiteLedger[1].hasLogTail, false);
    db.close();
  });

  it("reports suiteLedgerStatus 'empty' when the run has no ledger rows", () => {
    const state = makeState();
    const db = makeLedgerDb();

    const result = collectEvidence({ stateDir: state, bareRunId: "cccccccc-3333-4333-8333-333333333333", db: asInjected(db) });

    assert.equal(result.suiteLedgerStatus, "empty");
    assert.deepEqual(result.suiteLedger, []);
    db.close();
  });

  it("degrades to suiteLedgerStatus 'absent' when suite_results is missing, without throwing", () => {
    const state = makeState();
    const db = new DatabaseSync(":memory:");

    const result = collectEvidence({ stateDir: state, bareRunId: BARE, db: asInjected(db) });

    // No evidence dir either, but the call must not throw.
    assert.equal(result.status, "absent");
    assert.equal(result.suiteLedgerStatus, "absent");
    assert.deepEqual(result.suiteLedger, []);
    db.close();
  });

  it("never throws when every prepare() fails", () => {
    const broken: DiagnosticsDb = {
      prepare() {
        throw new Error("database is gone");
      },
    };
    const opts: CollectEvidenceOptions = { stateDir: makeState(), bareRunId: BARE, db: broken };
    const result = collectEvidence(opts);

    assert.equal(result.suiteLedgerStatus, "absent");
    assert.deepEqual(result.suiteLedger, []);
    assert.equal(result.status, "absent");
  });
});