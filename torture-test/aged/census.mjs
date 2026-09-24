// census.mjs — read-only census and receipts for the aged-state seed.
//
// The census never mutates run/step/status/event rows.  It counts DB rows,
// event-stream lines/hashes, managed worktrees (rows + directories + git
// worktree list), terminal/paused shapes, leftover claims, and git ref
// state.  Every census is written to a durable receipt under
// <root>/receipts/census-<tag>.json so validation can cite exact counts.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { utcNow, sha256FileStream, writeExclusive, appendJsonl } from "./seedcommon.mjs";

export function runDbCensus(db) {
  const q = (sql) => db.prepare(sql).get();
  const runRows = q("SELECT COUNT(*) AS c FROM runs").c;
  const stepRows = q("SELECT COUNT(*) AS c FROM steps").c;
  const storyRows = q("SELECT COUNT(*) AS c FROM stories").c;
  const wtRows = q("SELECT COUNT(*) AS c FROM run_worktrees").c;
  const abandonmentRows = q("SELECT COUNT(*) AS c FROM story_abandonments").c;
  const suiteRows = (() => {
    try {
      return q("SELECT COUNT(*) AS c FROM suite_results").c;
    } catch {
      return -1;
    }
  })();
  const byStatus = db.prepare("SELECT status, COUNT(*) AS c FROM runs GROUP BY status").all();
  const byWorkflow = db.prepare("SELECT workflow_id, COUNT(*) AS c FROM runs GROUP BY workflow_id ORDER BY workflow_id").all();
  const byWfStatus = db.prepare(
    "SELECT workflow_id, status, COUNT(*) AS c FROM runs GROUP BY workflow_id, status ORDER BY workflow_id, status",
  ).all();
  const terminal = db.prepare("SELECT COUNT(*) AS c FROM runs WHERE status IN ('completed','failed','canceled')").get().c;
  const paused = db.prepare("SELECT COUNT(*) AS c FROM runs WHERE status = 'paused'").get().c;
  const running = db.prepare("SELECT COUNT(*) AS c FROM runs WHERE status = 'running'").get().c;
  // Oracle-faithful leftovers.  The real O1 oracle (torture-test/oracles/lib/
  // o1.mjs O1_COMPLETED_STEP_NONTERMINAL) treats non-terminal steps as
  // corruption ONLY on COMPLETED runs: a run that failed/canceled mid-pipeline
  // legitimately leaves its downstream steps waiting (unclaimed, zero claim
  // evidence) — those are native leftover shapes, NOT corruption.  The real O4
  // oracle checks actual claim/dispatch evidence (claim_pid/pgid/job_id,
  // abandonment records), never unclaimed waiting status.  Counts below keep
  // the two semantics separate so suite legs can mirror the oracles instead of
  // reporting waiting-on-failed as corruption/dangling claims.
  const nonterminalOnCompleted = db.prepare(
    "SELECT COUNT(*) AS c FROM steps WHERE run_id IN (SELECT id FROM runs WHERE status = 'completed') AND status IN ('pending','running','waiting')",
  ).get().c;
  const waitingOnFailedCanceled = db.prepare(
    "SELECT COUNT(*) AS c FROM steps s JOIN runs r ON r.id = s.run_id WHERE r.status IN ('failed','canceled') AND s.status = 'waiting'",
  ).get().c;
  const pendingRunningOnFailedCanceled = db.prepare(
    "SELECT COUNT(*) AS c FROM steps s JOIN runs r ON r.id = s.run_id WHERE r.status IN ('failed','canceled') AND s.status IN ('pending','running')",
  ).get().c;
  // Real claim/dispatch evidence on terminal runs (O4 dimension): a step on a
  // terminal run that is still 'running', or that carries any claim identity
  // column, is a dangling claim.  Unclaimed waiting steps are not.
  const claimEvidenceOnTerminal = db.prepare(
    "SELECT COUNT(*) AS c FROM steps s JOIN runs r ON r.id = s.run_id WHERE r.status IN ('completed','failed','canceled') AND (s.status = 'running' OR s.claim_pid IS NOT NULL OR s.claim_pgid IS NOT NULL OR s.claim_job_id IS NOT NULL)",
  ).get().c;
  const runningWithPidOnTerminal = db.prepare(
    "SELECT COUNT(*) AS c FROM steps s JOIN runs r ON r.id = s.run_id WHERE r.status IN ('completed','failed','canceled') AND s.status = 'running' AND s.claim_pid IS NOT NULL",
  ).get().c;
  const scheduling = db.prepare(
    "SELECT scheduling_status, COUNT(*) AS c FROM runs WHERE scheduling_status IS NOT NULL GROUP BY scheduling_status",
  ).all();
  // Raw aggregate (any non-terminal step on any terminal run) — informational
  // only, kept for backward-compatible receipts.
  const leftover = db.prepare(
    "SELECT COUNT(*) AS c FROM steps WHERE run_id IN (SELECT id FROM runs WHERE status IN ('completed','failed','canceled')) AND status IN ('pending','running','waiting')",
  ).get().c;
  const tokens = q("SELECT COALESCE(SUM(tokens_spent),0) AS c FROM runs").c;
  const systemTokens = (() => {
    try {
      return q("SELECT COALESCE(SUM(system_tokens_spent),0) AS c FROM tamandua_stats").c;
    } catch {
      return -1;
    }
  })();
  return {
    runs: runRows,
    steps: stepRows,
    stories: storyRows,
    run_worktrees: wtRows,
    story_abandonments: abandonmentRows,
    suite_results: suiteRows,
    byStatus,
    byWorkflow,
    byWorkflowStatus: byWfStatus,
    terminal,
    paused,
    running,
    // Raw non-terminal-step count on terminal runs, retained for backward
    // compatibility with earlier receipts/contracts.  Suite legs MUST NOT use
    // this as O1 corruption or O4 dangling-claim evidence: the oracle-faithful
    // splits below are authoritative for the matrix.
    leftoverNonterminalStepsOnTerminalRuns: leftover,
    nonterminalStepsOnCompletedRuns: nonterminalOnCompleted,
    waitingStepsOnFailedCanceledRuns: waitingOnFailedCanceled,
    pendingRunningStepsOnFailedCanceledRuns: pendingRunningOnFailedCanceled,
    claimEvidenceStepsOnTerminalRuns: claimEvidenceOnTerminal,
    runningWithClaimPidOnTerminalRuns: runningWithPidOnTerminal,
    schedulingStatus: scheduling,
    tokensSpentTotal: tokens,
    systemTokensSpentTotal: systemTokens,
  };
}

export function eventStreamCensus(stateDir) {
  const eventsDir = path.join(stateDir, "events");
  if (!fs.existsSync(eventsDir)) {
    return { exists: false, dir: eventsDir };
  }
  const perRun = [];
  let runLinesTotal = 0;
  let globalLinesTotal = 0;
  let globalArchives = [];
  for (const entry of fs.readdirSync(eventsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(eventsDir, entry.name);
    const lines = countJsonLines(full);
    if (entry.name === "all.jsonl") {
      globalLinesTotal = lines;
    } else if (/^all\.jsonl\.\d+$/.test(entry.name)) {
      globalArchives.push({ name: entry.name, lines });
    } else if (entry.name.endsWith(".jsonl")) {
      perRun.push({ name: entry.name, lines, sha256: sha256FileStream(full) });
      runLinesTotal += lines;
    }
  }
  perRun.sort((a, b) => a.name.localeCompare(b.name));
  globalArchives.sort((a, b) => a.name.localeCompare(b.name));
  return {
    exists: true,
    dir: eventsDir,
    perRunFiles: perRun.length,
    perRunLogicalLines: runLinesTotal,
    globalLiveLines: globalLinesTotal,
    globalArchiveLines: globalArchives.reduce((acc, a) => acc + a.lines, 0),
    globalArchives,
  };
}

function countJsonLines(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.split("\n").filter((l) => l.trim() !== "").length;
  } catch {
    return 0;
  }
}

export function worktreeCensus({ db, worktreesRoot }) {
  const rows = db.prepare(
    "SELECT run_id, worktree_path, status, cleanup_policy, worktree_origin_repository, worktree_origin_ref FROM run_worktrees ORDER BY run_id",
  ).all();
  const byStatus = db.prepare("SELECT status, COUNT(*) AS c FROM run_worktrees GROUP BY status").all();
  const rowDirs = [];
  const missingDirs = [];
  for (const row of rows) {
    if (fs.existsSync(row.worktree_path)) rowDirs.push(row.worktree_path);
    else missingDirs.push(row.worktree_path);
  }
  // git worktree list for the origin repos involved (read-only).
  const origins = [...new Set(rows.map((r) => r.worktree_origin_repository))];
  const originWorktreeLists = {};
  for (const origin of origins) {
    originWorktreeLists[origin] = gitWorktreeList(origin);
  }
  return {
    rowCount: rows.length,
    byStatus,
    directoryCount: rowDirs.length,
    missingDirectoryCount: missingDirs.length,
    origins,
    originWorktreeLists,
    rows,
  };
}

export function gitWorktreeList(repoDir) {
  const res = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) return { error: (res.stderr || "").trim() };
  return { output: res.stdout.trim() };
}

export function gitRefCensus(repoDir) {
  const res = spawnSync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) return { error: (res.stderr || "").trim() };
  return { refs: res.stdout.trim().split("\n").filter(Boolean) };
}

// Write a census receipt with exclusive-create semantics (one per tag).
export function writeCensusReceipt(root, tag, payload) {
  const file = path.join(root, "receipts", `census-${tag}.json`);
  const created = writeExclusive(file, JSON.stringify(payload, null, 2) + "\n");
  return { file, created: created.created };
}

// Timestamped census-receipt tag for the census-snapshot phase.  A FIXED tag
// ("<kind>-post") combined with writeCensusReceipt's exclusive-create
// semantics froze the receipt at the FIRST census-snapshot run: a post-volume
// re-run (which must record >=500000 logical events) silently dropped its
// census because the receipt file already existed.  Each census-snapshot run
// therefore stamps its tag so it writes an immutable, uniquely-identified
// receipt, and the manifest records the latest path
// (manifest.snapshot.censusReceipt).  Historical receipts (pre-volume,
// post-volume) are all retained, never overwritten.
export function postCensusReceiptTag(seedKind, stamp) {
  return `${seedKind}-post-${stamp}`;
}
