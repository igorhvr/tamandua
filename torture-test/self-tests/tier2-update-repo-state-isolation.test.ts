// US-007 (T2.1) — W4.20-update-repo-state-classification must not inherit
// leftover active-run contamination from a preceding cell (W4.21).
//
// Campaign evidence (operator run on merged main): W4.20 exits 1 at
// run-update-repo-state.mjs:129 (strictEqual 1 vs 0) with stderr
// `Run tamandua update --force to continue despite active runs` naming run
// 85c4b27e... `[running] W4.21 bare non-interactive launch probe (rich
// shell)`. Diagnosis from the evidence:
//  1. The scripted cells share ONE ledger (torture-test/var/home-scripted/
//     .tamandua/tamandua.db — HOME/.tamandua/tamandua.db under the contained
//     scripted home). W4.20's legs run `tamandua update` in installed clones
//     that read that SAME ledger.
//  2. A cell that LAUNCHES a workflow run and fails BEFORE its scoped
//     cleanup leaves the run marked [running] in the shared ledger. The
//     campaign run 85c4b27e was a W4.21 branch-A probe whose launch-wait
//     timed out (daemon down mid-run) in an EARLIER campaign; the NEXT
//     campaign's W4.20 then hit it: the product refuses an update while ANY
//     run is active ("Active Tamandua runs detected ... Run `tamandua update
//     --force` to continue despite active runs") — correct product behavior,
//     never weakened here.
//  3. The main checkout's shared ledger still carries those stale rows
//     (85c4b27e + W4.24 probe runs 140/141 marked [running]) — the
//     contamination is cross-cell AND cross-campaign.
//
// Fix (confined to torture-test/, no product assertion weakened):
//  - W4.20's reset barrier (daemon already stopped — nothing can be
//    genuinely active) PURGES stale 'running'/'paused' rows from the shared
//    ledger by marking them 'failed' BEFORE the four update legs
//    (purgeStaleActiveRuns, recorded as purged_stale_runs in the summary).
//  - W4.21's runner registers the branch-A run id and deletes its rows on
//    EVERY failure path (exit + uncaughtException safety nets) so a failed
//    W4.21 can never leave its probe run behind for a sibling cell.
//
// This test pins (zero tokens, no daemon):
//  - the W4.20 purge shape + wiring (called in the reset barrier after the
//    daemon stop, before the legs; running/paused -> failed only),
//  - the W4.20 single-line PASS summary (see also
//    tier2-single-line-summary.test.ts, extended to W4.20),
//  - the W4.21 failure-path cleanup shape (exit + uncaughtException nets
//    delete the registered probe run),
//  - a HERMETIC behavioral run of the exact shipped purge function against
//    a scratch ledger: running/paused -> failed, completed/failed untouched,
//    purged ids returned, missing DB -> [].
// The end-to-end corridor (W4.21 -> W4.20 campaign order from a clean var,
// both PASS, zero active runs left) is driven via run-scripted-scenario in
// the campaign battery / US-010 re-proof.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");

function readSource(rel: string): string {
  return fs.readFileSync(path.join(ttRoot, rel), "utf8");
}

const W420_RUNNER = "scenarios/w4.20/update-repo-state-classification/run-update-repo-state.mjs";
const W421_RUNNER = "scenarios/w4.21/bare-noninteractive-launch/run-bare-noninteractive.mjs";

// Extract a top-level `function <name>(...) { ... }` block from a source
// string (brace-matched from the first `{`).
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `source must define function ${name}()`);
  const open = source.indexOf("{", start);
  assert.ok(open >= 0, `function ${name} must have a body`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`function ${name} body never closed`);
}

describe("tier2 update-repo-state isolation (US-007)", () => {
  it("W4.20 reset barrier purges stale active runs BEFORE the update legs", () => {
    const source = readSource(W420_RUNNER);
    // The purge must run in the reset barrier, right after the daemon stop
    // (the daemon down = nothing can be genuinely active) and before the
    // legs / port assertions.
    const barrier = source.slice(source.indexOf("reset barrier"));
    const stopIdx = barrier.indexOf("stopScriptedDaemon();");
    const purgeIdx = barrier.indexOf("purgeStaleActiveRuns();");
    const portsIdx = barrier.indexOf("assertPortsFree();");
    assert.ok(stopIdx >= 0 && purgeIdx >= 0 && portsIdx > purgeIdx && purgeIdx > stopIdx,
      "the reset barrier must stop the daemon, purge stale runs, THEN assert ports free");
    // The purge result feeds the summary (evidence the corridor ran clean).
    assert.match(source, /purged_stale_runs: purgedStaleRuns/,
      "the summary must record the purged stale runs");
    // The purge must only clear ACTIVE-status rows: marking them failed is a
    // terminal status that unblocks the product's active-run gate without
    // weakening it (running/paused -> failed; nothing else is touched).
    const purgeFn = extractFunction(source, "purgeStaleActiveRuns");
    assert.match(purgeFn, /UPDATE runs SET status = 'failed'/,
      "the purge must mark stale active runs failed");
    assert.match(purgeFn, /WHERE status IN \('running', 'paused'\)/,
      "the purge must only touch running/paused rows");
    assert.ok(!/DELETE FROM runs/.test(purgeFn),
      "the purge must not delete evidence rows (mark failed, never delete)");
    assert.match(purgeFn, /fs\.existsSync\(dbPath\)/,
      "the purge must tolerate a missing ledger (fresh state, no DB yet)");
  });

  it("W4.21 failure paths delete the registered probe run (no [running] leak)", () => {
    const source = readSource(W421_RUNNER);
    // The branch-A run id is registered as soon as it is known, so a later
    // failure (e.g. the branch-B assertions, the zero-token proof, the
    // launch-wait timeout) cannot leave the run behind.
    assert.match(source, /registerCreatedRun\(runIdA\);/,
      "branch A's run id must be registered for failure-path cleanup");
    // Both safety nets must run the cleanup.
    const exitNet = source.slice(source.indexOf('process.on("exit"'));
    assert.match(exitNet, /cleanupCreatedRuns\(\);/,
      "the exit safety net must clean up registered runs");
    const uncaughtNet = source.slice(source.indexOf('process.on("uncaughtException"'));
    assert.match(uncaughtNet, /cleanupCreatedRuns\(\);/,
      "the uncaughtException safety net must clean up registered runs");
    // The cleanup removes every ledger trace (the W4.11 scoped-ledger shape):
    // the safety-net helper calls the CLI delete and the row delete.
    const cleanup = extractFunction(source, "cleanupCreatedRuns");
    assert.match(cleanup, /cliDeleteRun\(runId\);/,
      "cleanup must tell the product to delete the run (cron teardown)");
    assert.match(cleanup, /deleteRunRows\(runId\);/,
      "cleanup must remove the run's ledger rows");
    const rowDelete = extractFunction(source, "deleteRunRows");
    assert.match(rowDelete, /DELETE FROM steps WHERE run_id = \?/,
      "cleanup must remove the run's steps rows");
    assert.match(rowDelete, /DELETE FROM run_worktrees WHERE run_id = \?/,
      "cleanup must remove the run's worktree rows");
    assert.match(rowDelete, /DELETE FROM runs WHERE id = \?/,
      "cleanup must remove the run row itself");
  });

  it("hermetic behavior of the shipped purge: running/paused -> failed, others untouched", () => {
    const source = readSource(W420_RUNNER);
    const purgeSource = extractFunction(source, "purgeStaleActiveRuns")
      .replace(/^function purgeStaleActiveRuns\(\)/, "return (dbPath) =>");
    // eslint-disable-next-line no-new-func
    const purge = new Function("fs", "DatabaseSync", purgeSource)(fs, DatabaseSync);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-w420-purge-"));
    try {
      const dbPath = path.join(tmp, "tamandua.db");
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          run_number INTEGER,
          workflow_id TEXT NOT NULL,
          task TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          context TEXT NOT NULL DEFAULT '{}',
          tokens_spent INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const insert = db.prepare(
        "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'wf', ?, ?, '{}', 0, datetime('now'), datetime('now'))",
      );
      insert.run("r-running", "running task", "running");
      insert.run("r-paused", "paused task", "paused");
      insert.run("r-completed", "completed task", "completed");
      insert.run("r-failed", "failed task", "failed");
      db.close();

      const purged = purge(dbPath);

      // Only the active-status rows are returned as purged…
      assert.deepEqual(
        purged.map((r: { id: string }) => r.id).sort(),
        ["r-paused", "r-running"],
        "purge must report exactly the running/paused rows",
      );
      // …and they are marked failed, while terminal rows are untouched.
      const after = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = (after.prepare("SELECT id, status FROM runs ORDER BY id").all() as Array<{
          id: string;
          status: string;
        }>).map((r) => ({ id: String(r.id), status: String(r.status) }));
        assert.deepEqual(rows, [
          { id: "r-completed", status: "completed" },
          { id: "r-failed", status: "failed" },
          { id: "r-paused", status: "failed" },
          { id: "r-running", status: "failed" },
        ]);
      } finally {
        after.close();
      }

      // A second purge is a no-op (already terminal).
      assert.deepEqual(purge(dbPath), [], "a second purge must find nothing to clear");

      // A missing ledger is tolerated (fresh state dir before any run).
      assert.deepEqual(purge(path.join(tmp, "does-not-exist.db")), [],
        "purge must return [] when the ledger does not exist yet");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
