/**
 * DIAG-PRUNE US-003 — unit tests for the DB row collector.
 *
 * Pure (no child_process, no daemon, no temp files) — stays in the parallel
 * lane. The happy-path tests use a real in-memory `node:sqlite` database so
 * the projected SQL and every explicit column name are actually exercised; the
 * failure-path tests inject fake/partial databases to prove actor safety.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  collectDbRows,
  type DiagnosticsDb,
  type DiagnosticsDbStatement,
} from "../../dist/diagnostics/collect-db.js";

const RUN_ID = "aaaaaaaa-1111-4111-8111-111111111111";

const RUNS_DDL = `
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
`;

function makeFixtureDb(withWorktrees = true): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(RUNS_DDL);
  db.exec(`
    INSERT INTO runs (
      id, run_number, workflow_id, task, status, context, tokens_spent, parent_run_id,
      scheduling_status, scheduling_requested_at, scheduling_error,
      worker_lost_count, ceiling_expiry_count, instant_fail_count,
      harness_probe_status, harness_probe_at, test_cmd_established, test_cmd_source,
      matchlock_policy, created_at, updated_at
    ) VALUES (
      '${RUN_ID}', 9, 'feature-dev-merge-worktree', 'do the thing', 'failed', '{"harness_type":"pi"}', 123,
      NULL, 'error', '2026-09-22T00:00:00.000Z', 'harness workdir busy',
      2, 1, 3, 'ok', '2026-09-22T00:30:00.000Z', 'npm test', 'launch',
      '{"image":"igorhvr/bedlam-ubuntu","token":"secret"}', '2026-09-22T00:00:00.000Z', '2026-09-22T01:00:00.000Z'
    );
    INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status, type, retry_count, max_retries, preclaim_death_count, output, created_at, updated_at)
      VALUES ('step-1', '${RUN_ID}', 'implement', 'developer', 1, 'failed', 'single', 2, 4, 1, 'STATUS: failed', '2026-09-22T00:10:00.000Z', '2026-09-22T00:20:00.000Z');
    INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at)
      VALUES ('story-1', '${RUN_ID}', 0, 'US-001', 'Story one', 'desc', '[]', 'failed', 3, 4, '2026-09-22T00:05:00.000Z', '2026-09-22T00:25:00.000Z');
    INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, step_id, created_at)
      VALUES ('abn-1', 'story-1', '${RUN_ID}', 'worker_lost', 1, 'step-1', '2026-09-22T00:15:00.000Z');
    INSERT INTO run_worktrees (run_id, worktree_origin_repository, worktree_origin_git_common_dir, worktree_path, worktree_origin_ref, worktree_origin_sha, original_branch, status, cleanup_policy, created_at, removed_at, error)
      VALUES ('${RUN_ID}', '/origin', '/origin/.git', '/worktrees/${RUN_ID}', 'refs/heads/main', 'deadbeef', 'main', 'removed', 'remove_on_success', '2026-09-22T00:00:00.000Z', '2026-09-22T01:30:00.000Z', NULL);
  `);
  if (!withWorktrees) db.exec("DROP TABLE run_worktrees");
  return db;
}

function asInjected(db: DatabaseSync): DiagnosticsDb {
  return db as unknown as DiagnosticsDb;
}

describe("collectDbRows — fixture database", () => {
  it("returns the run/steps/stories/abandonments/worktrees arrays with explicit columns", () => {
    const db = makeFixtureDb();
    const result = collectDbRows({
      db: asInjected(db),
      runId: `run-${RUN_ID}`,
      bareRunId: RUN_ID,
    });

    assert.equal(result.status, "present");
    assert.equal(result.absenceReason, undefined);

    assert.equal(result.runs.length, 1);
    const run = result.runs[0];
    assert.equal(run.id, RUN_ID);
    assert.equal(run.run_number, 9);
    assert.equal(run.status, "failed");
    assert.equal(run.scheduling_status, "error");
    assert.equal(run.scheduling_error, "harness workdir busy");
    assert.equal(run.worker_lost_count, 2);
    assert.equal(run.ceiling_expiry_count, 1);
    assert.equal(run.instant_fail_count, 3);
    assert.equal(run.matchlock_policy_present, true);
    // The raw policy JSON is not embedded here (US-008 owns it).
    assert.equal("matchlock_policy" in run, false);

    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].step_id, "implement");
    assert.equal(result.steps[0].retry_count, 2);
    assert.equal(result.steps[0].preclaim_death_count, 1);
    assert.equal(result.steps[0].output, "STATUS: failed");

    assert.equal(result.stories.length, 1);
    assert.equal(result.stories[0].story_id, "US-001");
    assert.equal(result.stories[0].retry_count, 3);

    assert.equal(result.story_abandonments.length, 1);
    assert.equal(result.story_abandonments[0].reason, "worker_lost");

    assert.equal(result.run_worktrees.length, 1);
    assert.equal(result.run_worktrees[0].worktree_path, `/worktrees/${RUN_ID}`);
    assert.equal(result.run_worktrees[0].status, "removed");
    db.close();
  });

  it("reports matchlock_policy_present false for a native (NULL policy) run", () => {
    const db = makeFixtureDb();
    db.exec(`UPDATE runs SET matchlock_policy = NULL WHERE id = '${RUN_ID}'`);
    const result = collectDbRows({
      db: asInjected(db),
      runId: RUN_ID,
      bareRunId: RUN_ID,
    });
    assert.equal(result.runs[0].matchlock_policy_present, false);
    db.close();
  });

  it("returns an empty collection when the run has no child rows", () => {
    const db = makeFixtureDb();
    const other = "bbbbbbbb-2222-4222-8222-222222222222";
    db.exec(`INSERT INTO runs (id, status, created_at, updated_at) VALUES ('${other}', 'running', '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z')`);
    const result = collectDbRows({ db: asInjected(db), runId: other, bareRunId: other });
    assert.equal(result.status, "present");
    assert.equal(result.runs.length, 1);
    assert.deepEqual(result.steps, []);
    assert.deepEqual(result.stories, []);
    assert.deepEqual(result.story_abandonments, []);
    assert.deepEqual(result.run_worktrees, []);
    db.close();
  });
});

describe("collectDbRows — absent sources never throw", () => {
  it("reports status absent for a missing run", () => {
    const db = makeFixtureDb();
    const result = collectDbRows({
      db: asInjected(db),
      runId: "deadbeef-0000-4000-8000-000000000000",
      bareRunId: "deadbeef-0000-4000-8000-000000000000",
    });
    assert.equal(result.status, "absent");
    assert.match(result.absenceReason ?? "", /not found/);
    assert.deepEqual(result.runs, []);
    assert.deepEqual(result.steps, []);
    assert.deepEqual(result.stories, []);
    assert.deepEqual(result.story_abandonments, []);
    assert.deepEqual(result.run_worktrees, []);
    db.close();
  });

  it("reports status absent with the missing table named and keeps available rows", () => {
    const db = makeFixtureDb(false);
    const result = collectDbRows({
      db: asInjected(db),
      runId: RUN_ID,
      bareRunId: RUN_ID,
    });
    assert.equal(result.status, "absent");
    assert.match(result.absenceReason ?? "", /run_worktrees/);
    // Tables that answered still return their rows.
    assert.equal(result.runs.length, 1);
    assert.equal(result.steps.length, 1);
    assert.equal(result.stories.length, 1);
    assert.equal(result.story_abandonments.length, 1);
    assert.deepEqual(result.run_worktrees, []);
    db.close();
  });

  it("never throws when every prepare() fails", () => {
    const broken: DiagnosticsDb = {
      prepare(): DiagnosticsDbStatement {
        throw new Error("database is gone");
      },
    };
    const result = collectDbRows({ db: broken, runId: RUN_ID, bareRunId: RUN_ID });
    assert.equal(result.status, "absent");
    assert.match(result.absenceReason ?? "", /runs: database is gone/);
    assert.deepEqual(result.runs, []);
    assert.deepEqual(result.steps, []);
  });

  it("sanitizes a Buffer or BigInt that a drifted column could produce", () => {
    const fake: DiagnosticsDb = {
      prepare(sql: string): DiagnosticsDbStatement {
        return {
          all(): unknown[] {
            if (/FROM runs/.test(sql)) {
              return [
                {
                  id: RUN_ID,
                  task: Buffer.from("task-bytes"),
                  tokens_spent: 9007199254740993n,
                  matchlock_policy: null,
                },
              ];
            }
            return [];
          },
          get(): unknown {
            return undefined;
          },
        };
      },
    };
    const result = collectDbRows({ db: fake, runId: RUN_ID, bareRunId: RUN_ID });
    assert.equal(result.status, "present");
    assert.equal(result.runs[0].task, Buffer.from("task-bytes").toString("base64"));
    assert.equal(result.runs[0].tokens_spent, "9007199254740993");
    assert.equal(result.runs[0].matchlock_policy_present, false);
  });
});