import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { getDb } from "../../dist/db.js";
import { getRunEvents } from "../../dist/installer/events.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  STALE_LAUNCH_PHANTOM_AGE_MS,
  STALE_LAUNCH_PHANTOM_REASON,
  recoverStaleLaunchPhantoms,
} from "../../dist/installer/run-recovery.js";

describe("recoverStaleLaunchPhantoms", () => {
  let tempHome: string;
  let savedHome: string | undefined;
  let savedStateDir: string | undefined;
  let savedDbPath: string | undefined;

  before(() => {
    tempHome = tamanduaTempDir("tamandua-run-recovery-");
    const stateDir = path.join(tempHome, ".tamandua");
    savedHome = process.env.HOME;
    savedStateDir = process.env.TAMANDUA_STATE_DIR;
    savedDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    assertStatePathIsolation(process.env.TAMANDUA_DB_PATH, "run-recovery test database");
  });

  after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = savedStateDir;
    if (savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = savedDbPath;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("fails only old zero-step runs without managed-worktree state and is idempotent", () => {
    const db = getDb();
    const nowMs = Date.now();
    const oldTimestamp = new Date(nowMs - STALE_LAUNCH_PHANTOM_AGE_MS - 60_000).toISOString();
    const freshTimestamp = new Date(nowMs - STALE_LAUNCH_PHANTOM_AGE_MS + 60_000).toISOString();
    const oldPhantomId = crypto.randomUUID();
    const freshPhantomId = crypto.randomUUID();
    const withStepId = crypto.randomUUID();
    const withWorktreeId = crypto.randomUUID();
    const terminalId = crypto.randomUUID();

    const insertRun = db.prepare(
      `INSERT INTO runs
         (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at)
       VALUES (?, 'lncz-recovery-test', 'test', ?, '{}', 17, 'pending_register', ?, ?)`,
    );
    insertRun.run(oldPhantomId, "running", oldTimestamp, oldTimestamp);
    insertRun.run(freshPhantomId, "running", freshTimestamp, freshTimestamp);
    insertRun.run(withStepId, "running", oldTimestamp, oldTimestamp);
    insertRun.run(withWorktreeId, "running", oldTimestamp, oldTimestamp);
    insertRun.run(terminalId, "failed", oldTimestamp, oldTimestamp);

    db.prepare(
      `INSERT INTO steps
         (id, run_id, step_id, step_index, agent_id, type, status, input_template, expects,
          retry_count, max_retries, created_at, updated_at)
       VALUES (?, ?, 'implement', 0, 'developer', 'single', 'pending', 'work', '', 0, 3, ?, ?)`,
    ).run(crypto.randomUUID(), withStepId, oldTimestamp, oldTimestamp);
    db.prepare(
      `INSERT INTO run_worktrees
         (run_id, worktree_origin_repository, worktree_origin_git_common_dir, worktree_path,
          status, cleanup_policy, created_at)
       VALUES (?, '/origin', '/origin/.git', '/worktree', 'creating', 'remove_on_terminal', ?)`,
    ).run(withWorktreeId, oldTimestamp);

    const first = recoverStaleLaunchPhantoms(nowMs);
    assert.deepEqual(first, { recovered: 1, runIds: [oldPhantomId] });

    const rows = db.prepare(
      "SELECT id, status, scheduling_status, scheduling_error FROM runs ORDER BY id",
    ).all() as Array<{
      id: string;
      status: string;
      scheduling_status: string | null;
      scheduling_error: string | null;
    }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.equal(byId.get(oldPhantomId)?.status, "failed");
    assert.equal(byId.get(oldPhantomId)?.scheduling_status, null);
    assert.equal(byId.get(oldPhantomId)?.scheduling_error, STALE_LAUNCH_PHANTOM_REASON);
    assert.equal(byId.get(freshPhantomId)?.status, "running");
    assert.equal(byId.get(withStepId)?.status, "running");
    assert.equal(byId.get(withWorktreeId)?.status, "running");
    assert.equal(byId.get(terminalId)?.status, "failed");

    const recoveryEvents = getRunEvents(oldPhantomId).filter(
      (event) => event.event === "run.failed" && event.reason === "stale_launch_phantom_recovery",
    );
    assert.equal(recoveryEvents.length, 1);
    assert.equal(recoveryEvents[0].detail, STALE_LAUNCH_PHANTOM_REASON);
    assert.equal(recoveryEvents[0].tokensSpent, 17);

    const second = recoverStaleLaunchPhantoms(nowMs);
    assert.deepEqual(second, { recovered: 0, runIds: [] });
    assert.equal(
      getRunEvents(oldPhantomId).filter(
        (event) => event.event === "run.failed" && event.reason === "stale_launch_phantom_recovery",
      ).length,
      1,
    );
  });
});
