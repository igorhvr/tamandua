/**
 * DIAG-PRUNE US-013 — unit tests for the evidence prune planner.
 *
 * Pure filesystem + in-memory `node:sqlite` fixtures (no child_process, no
 * daemon, no real state dir) — stays in the parallel lane. The planner is a
 * dry-run: every test also asserts that no file was deleted.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { planEvidencePrune } from "../../dist/diagnostics/prune-plan.js";
import type { DiagnosticsDb } from "../../dist/diagnostics/collect-db.js";

const OLD = "aaaaaaaa-1111-4111-8111-111111111111";
const RUNNING = "bbbbbbbb-2222-4222-8222-222222222222";
const PAUSED = "cccccccc-3333-4333-8333-333333333333";
const PENDING = "dddddddd-4444-4444-8444-444444444444";
const BAD = "eeeeeeee-5555-4555-8555-555555555555";
const RECENT = "ffffffff-6666-4666-8666-666666666666";

const NOW = Date.parse("2026-09-23T00:00:00.000Z");
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

const created: string[] = [];

function makeState(prefix = "diag-prune-"): string {
  const dir = tamanduaTempDir(prefix);
  created.push(dir);
  return dir;
}

after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

const RUNS_DDL = `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    status TEXT,
    scheduling_status TEXT,
    updated_at TEXT
  );
`;

const WORKTREES_DDL = `
  CREATE TABLE run_worktrees (
    run_id TEXT,
    worktree_path TEXT NOT NULL,
    status TEXT NOT NULL
  );
`;

const SUITE_RESULTS_DDL = `
  CREATE TABLE suite_results (
    id INTEGER PRIMARY KEY,
    run_id TEXT,
    log_path TEXT
  );
`;

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(RUNS_DDL);
  db.exec(WORKTREES_DDL);
  db.exec(SUITE_RESULTS_DDL);
  const insertRun = db.prepare(
    "INSERT INTO runs (id, status, scheduling_status, updated_at) VALUES (?, ?, ?, ?)",
  );
  insertRun.run(OLD, "completed", null, "2026-09-01T00:00:00.000Z");
  insertRun.run(RUNNING, "running", "active", "2026-09-01T00:00:00.000Z");
  insertRun.run(PAUSED, "paused", "paused", "2026-09-01T00:00:00.000Z");
  insertRun.run(PENDING, "pending", null, "2026-09-01T00:00:00.000Z");
  insertRun.run(BAD, "completed", null, "not-a-valid-instant");
  insertRun.run(RECENT, "completed", null, "2026-09-22T00:00:00.000Z");
  return db;
}

function asInjected(db: DatabaseSync): DiagnosticsDb {
  return db as unknown as DiagnosticsDb;
}

function writeFile(state: string, rel: string, content: string): string {
  const full = path.join(state, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

interface Fixture {
  state: string;
  db: DatabaseSync;
  oldEvidence: string;
  oldBundle: string;
  oldSuiteLog: string;
  oldWorktree: string;
  runningEvidence: string;
  runningWorktree: string;
  pausedEvidence: string;
  pendingEvidence: string;
  badEvidence: string;
  recentEvidence: string;
  orphanBundle: string;
  orphanSuiteLog: string;
  leftoverSuiteLog: string;
}

function buildFixture(): Fixture {
  const state = makeState();
  const db = makeDb();

  const oldEvidence = writeFile(state, path.join("runs", OLD, "stdout.log"), "0123456789"); // 10
  const oldBundle = writeFile(
    state,
    path.join("diagnostics", `${OLD}-2026-09-20T00_00_00.000Z`, "SUMMARY.md"),
    "bundle", // 6
  );
  const oldSuiteLog = writeFile(state, path.join("suite-logs", "1.log"), "suite-log-body"); // 14
  db.prepare("INSERT INTO suite_results (id, run_id, log_path) VALUES (?, ?, ?)").run(
    1,
    OLD,
    oldSuiteLog,
  );
  // Orphan suite log: no matching ledger row.
  const orphanSuiteLog = writeFile(state, path.join("suite-logs", "99.log"), "orphan"); // 6
  // Pending temp log written before the row id exists.
  const leftoverSuiteLog = writeFile(state, path.join("suite-logs", ".pending-abc.log"), "temp"); // 4

  const oldWorktree = path.join(state, "worktrees", "old-wt");
  fs.mkdirSync(oldWorktree, { recursive: true });
  fs.writeFileSync(path.join(oldWorktree, "checkout.txt"), "wt-old"); // 6
  db.prepare(
    "INSERT INTO run_worktrees (run_id, worktree_path, status) VALUES (?, ?, 'removed')",
  ).run(OLD, oldWorktree);
  // A removed worktree whose path no longer exists must not appear in the plan.
  db.prepare(
    "INSERT INTO run_worktrees (run_id, worktree_path, status) VALUES (?, ?, 'removed')",
  ).run(OLD, path.join(state, "worktrees", "already-gone"));

  const runningEvidence = writeFile(state, path.join("runs", RUNNING, "out.log"), "run"); // 3
  const runningWorktree = path.join(state, "worktrees", "running-wt");
  fs.mkdirSync(runningWorktree, { recursive: true });
  fs.writeFileSync(path.join(runningWorktree, "f.txt"), "rw"); // 2
  db.prepare(
    "INSERT INTO run_worktrees (run_id, worktree_path, status) VALUES (?, ?, 'removed')",
  ).run(RUNNING, runningWorktree);

  const pausedEvidence = writeFile(state, path.join("runs", PAUSED, "out.log"), "paused"); // 6
  const pendingEvidence = writeFile(state, path.join("runs", PENDING, "out.log"), "pending"); // 7
  const badEvidence = writeFile(state, path.join("runs", BAD, "out.log"), "bad"); // 3
  const recentEvidence = writeFile(state, path.join("runs", RECENT, "out.log"), "recent"); // 6

  const orphanBundle = writeFile(
    state,
    path.join("diagnostics", "orphan-2026-09-20T00_00_00.000Z", "SUMMARY.md"),
    "orphan-bundle", // 13
  );

  return {
    state,
    db,
    oldEvidence,
    oldBundle,
    oldSuiteLog,
    oldWorktree,
    runningEvidence,
    runningWorktree,
    pausedEvidence,
    pendingEvidence,
    badEvidence,
    recentEvidence,
    orphanBundle,
    orphanSuiteLog,
    leftoverSuiteLog,
  };
}

describe("planEvidencePrune — eligibility", () => {
  it("marks an old terminal run's artifacts for removal and totals their sizes", () => {
    const fx = buildFixture();
    const plan = planEvidencePrune({
      olderThanMs: SEVEN_DAYS,
      stateDir: fx.state,
      db: asInjected(fx.db),
      now: NOW,
    });

    const byPath = new Map(plan.items.map((item) => [item.path, item]));
    const removed = plan.items.filter((item) => item.action === "remove");
    const removedPaths = removed.map((item) => item.path).sort();

    assert.deepEqual(removedPaths, [
      path.join(fx.state, "runs", OLD),
      path.join(fx.state, "diagnostics", `${OLD}-2026-09-20T00_00_00.000Z`),
      fx.oldSuiteLog,
      fx.oldWorktree,
    ].sort());
    for (const item of removed) {
      assert.equal(item.runId, OLD);
      assert.equal(item.bareRunId, OLD);
      assert.ok(item.reason.length > 0);
    }

    // No item points at the already-removed worktree path.
    assert.equal(byPath.has(path.join(fx.state, "worktrees", "already-gone")), false);

    // Totals: evidence 10 + bundle 6 + suite-log 14 + worktree 6.
    assert.equal(plan.totals.removeCount, 4);
    assert.equal(plan.totals.removeBytes, 36);
    assert.equal(plan.totals.itemCount, plan.items.length);
    assert.equal(plan.totals.keepCount, plan.items.filter((i) => i.action === "keep").length);
    assert.equal(plan.totals.totalBytes, plan.totals.removeBytes + plan.totals.keepBytes);
    assert.equal(plan.olderThanMs, SEVEN_DAYS);

    // Dry run: nothing deleted.
    assert.equal(fs.existsSync(fx.oldEvidence), true);
    assert.equal(fs.existsSync(fx.oldWorktree), true);
  });

  it("refuses live runs and never treats an unparseable instant as old", () => {
    const fx = buildFixture();
    const plan = planEvidencePrune({
      olderThanMs: SEVEN_DAYS,
      stateDir: fx.state,
      db: asInjected(fx.db),
      now: NOW,
    });

    const byPath = new Map(plan.items.map((item) => [item.path, item]));
    for (const [label, dir] of [
      ["running", path.join(fx.state, "runs", RUNNING)],
      ["paused", path.join(fx.state, "runs", PAUSED)],
      ["pending", path.join(fx.state, "runs", PENDING)],
      ["unparseable", path.join(fx.state, "runs", BAD)],
      ["recent", path.join(fx.state, "runs", RECENT)],
    ] as const) {
      const item = byPath.get(dir);
      assert.ok(item, `expected an item for the ${label} run`);
      assert.equal(item!.action, "keep", `${label} run artifact must be kept`);
      assert.ok(item!.reason.length > 0, `${label} keep must carry a reason`);
    }

    const refusedIds = new Set(plan.refusals.map((refusal) => refusal.bareRunId));
    assert.ok(refusedIds.has(RUNNING));
    assert.ok(refusedIds.has(PAUSED));
    assert.ok(refusedIds.has(PENDING));
    assert.ok(refusedIds.has(BAD));
    assert.ok(refusedIds.has(RECENT));
    const runningRefusal = plan.refusals.find((refusal) => refusal.bareRunId === RUNNING);
    assert.match(runningRefusal!.reason, /live/);
    assert.equal(runningRefusal!.status, "running");
    assert.equal(runningRefusal!.schedulingStatus, "active");
    const badRefusal = plan.refusals.find((refusal) => refusal.bareRunId === BAD);
    assert.match(badRefusal!.reason, /unparseable/);

    // A removed worktree belonging to a live run is kept too.
    assert.equal(byPath.get(fx.runningWorktree)?.action, "keep");
  });

  it("marks unmapped diagnostics dirs and orphan suite-logs as keep", () => {
    const fx = buildFixture();
    const plan = planEvidencePrune({
      olderThanMs: SEVEN_DAYS,
      stateDir: fx.state,
      db: asInjected(fx.db),
      now: NOW,
    });
    const byPath = new Map(plan.items.map((item) => [item.path, item]));

    const orphanBundle = byPath.get(path.join(fx.state, "diagnostics", "orphan-2026-09-20T00_00_00.000Z"));
    assert.equal(orphanBundle?.action, "keep");
    assert.match(orphanBundle!.reason, /unmapped/);

    assert.equal(byPath.get(fx.orphanSuiteLog)?.action, "keep");
    assert.match(byPath.get(fx.orphanSuiteLog)!.reason, /orphan/);
    assert.equal(byPath.get(fx.leftoverSuiteLog)?.action, "keep");
  });

  it("keeps every artifact when no run is older than the threshold", () => {
    const fx = buildFixture();
    // A threshold larger than the age of every run keeps even the OLD run.
    const plan = planEvidencePrune({
      olderThanMs: 60 * 24 * 60 * 60 * 1000,
      stateDir: fx.state,
      db: asInjected(fx.db),
      now: NOW,
    });
    assert.equal(plan.items.filter((item) => item.action === "remove").length, 0);
    assert.equal(plan.totals.removeBytes, 0);
  });

  it("degrades to keep (never removed) when the runs table is unavailable", () => {
    const state = makeState();
    writeFile(state, path.join("runs", OLD, "out.log"), "x");
    const db = new DatabaseSync(":memory:"); // no runs table
    const plan = planEvidencePrune({
      olderThanMs: 0,
      stateDir: state,
      db: db as unknown as DiagnosticsDb,
      now: NOW,
    });
    const item = plan.items.find((entry) => entry.path === path.join(state, "runs", OLD));
    assert.equal(item?.action, "keep");
    assert.match(item!.reason, /unmapped/);
  });
});