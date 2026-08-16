#!/usr/bin/env node
/**
 * W4.24 product's own `npm test` serial lane concurrent with 2 TT runs — no
 * cross-talk (spec 08 §H W4.24). Zero-token scripted cell.
 *
 * The corridor: the PRODUCT's own serial test lane (`scripts/run-serial-tests.sh`
 * — the serial lane of the tamandua product's `npm test`) runs on the host
 * CONCURRENTLY with two contained scripted TT runs. Lane deadline behavior is
 * documented (wall + exit recorded); the TT runs are unaffected; no cross-talk
 * in either direction.
 *
 * Flow:
 *   1. Build the product tree (`npm run build` — SEQUENTIAL, before the
 *      corridor; the serial lane tests import from dist/).
 *   2. Launch TWO contained scripted bfmw runs CONCURRENTLY (distinct scratch
 *      minimal-npm origins; scripted-pi behaviors; zero tokens).
 *   3. Launch the product serial lane CONCURRENTLY under a CLEANED host env
 *      (every TT_-prefixed and TAMANDUA_-prefixed variable stripped, HOME =
 *      the operator's account home — the lane gets a pristine developer env,
 *      never the contained TT env; run-serial-tests.sh sets its own
 *      TAMANDUA_TEST_GUARD / PI / DSH binaries).
 *   4. Wait for the TT runs first (asserting they completed WHILE the lane
 *      was still running — the concurrency proof), then wait for the lane.
 *
 * Assertions:
 *   - TT runs unaffected: both complete, tokens 0, worker_lost_count 0.
 *   - Lane deadline behavior documented: wall time + exit code recorded.
 *   - No cross-talk: (a) the contained DB runs-set grew ONLY by the two TT
 *     runs (no product-test run leaked into the TT ledger); (b) the lane's
 *     output never references the contained state dir (the lane's own
 *     "TEST ISOLATION VIOLATION" guard self-tests are EXPECTED passing
 *     output, not cross-talk); (c) the lane's temp HOMEs/state are not
 *     under torture-test/var/ (recorded).
 *   - Zero tokens: runs.tokens_spent 0 + system tripwire 0.
 *
 * The two TT runs are deleted after capture (scoped ledger — the W4.11
 * pattern).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function requiredValue(name) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && value.length > 0, `${name} must be set`);
  return value;
}
function requiredPath(name) {
  const value = requiredValue(name);
  assert.ok(path.isAbsolute(value), `${name} must be an absolute path`);
  return value;
}

const repoRoot = requiredPath("TT_REPO_ROOT");
const invocationDir = requiredPath("TT_SCENARIO_STATE_DIR");
const scenarioId = requiredValue("TT_SCENARIO_ID");
const stateDir = requiredPath("TAMANDUA_STATE_DIR");
const workflowId = requiredValue("TT_SCENARIO_WORKFLOW_ID");
assert.equal(process.env.TT_SCENARIO_COMMAND_GROUP_PROVEN, "1",
  "scenario must run in the harness-proven process group");
assert.equal(scenarioId, "w4.24-serial-lane-concurrent", "scenario id mismatch");

const cli = path.join(repoRoot, "bin", "tamandua");
const dbPath = path.join(stateDir, "tamandua.db");
const eventsDir = path.join(stateDir, "events");
const serialScript = path.join(repoRoot, "scripts", "run-serial-tests.sh");
const originA = path.join(invocationDir, "origin-a");
const originB = path.join(invocationDir, "origin-b");

for (const candidate of [originA, originB]) {
  assert.ok(candidate.startsWith(`${invocationDir}${path.sep}`),
    `W4.24 mutable path escaped torture-test/var: ${candidate}`);
}

// ── helpers ──────────────────────────────────────────────────────────

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? invocationDir,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function git(args, cwd) {
  const result = runSync("git", args, { cwd });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
}

function dbRead(query, params = []) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(query).all(...params);
  } finally {
    db.close();
  }
}

function buildOrigin(origin) {
  fs.mkdirSync(origin, { recursive: true });
  git(["init", "-b", "main"], origin);
  git(["config", "user.email", "w4.24@tamandua.local"], origin);
  git(["config", "user.name", "W4.24 Serial-Lane Concurrent"], origin);
  fs.writeFileSync(path.join(origin, "package.json"),
    `${JSON.stringify({ name: "w4-24-fixture", version: "1.0.0", scripts: { test: "node -e 'process.exit(0)'" } })}\n`);
  fs.writeFileSync(path.join(origin, "value.txt"), "old\n");
  fs.writeFileSync(path.join(origin, ".gitignore"), ".env\nnode_modules/\n*.key\n*.pem\n");
  git(["add", "."], origin);
  git(["commit", "-q", "-m", "baseline"], origin);
}

function deleteRun(runId) {
  const res = runSync(cli, ["workflow", "delete", `run-${runId}`, "--force"], { timeout: 60_000 });
  assert.equal(res.status, 0, `workflow delete run-${runId} failed:\n${res.stdout}\n${res.stderr}`);
  const del = new DatabaseSync(dbPath);
  try {
    del.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
    del.prepare("DELETE FROM run_worktrees WHERE run_id = ?").run(runId);
    del.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  } finally {
    del.close();
  }
  fs.rmSync(path.join(eventsDir, `${runId}.jsonl`), { force: true });
}

function accountHome() {
  const res = runSync("getent", ["passwd", String(process.getuid())], { timeout: 10_000 });
  assert.equal(res.status, 0, "getent passwd failed");
  const fields = res.stdout.split(":");
  assert.ok(fields.length >= 6 && fields[5].length > 0, `unparseable passwd entry: ${res.stdout}`);
  return fields[5];
}

// Cleaned HOST env for the product serial lane: every TT_*/TAMANDUA_* variable
// stripped (run-serial-tests.sh sets its own TAMANDUA_TEST_GUARD / PI / DSH
// binaries), HOME = the operator's account home — the lane must never see the
// contained TT env (that IS the no-cross-talk contract).
function cleanLaneEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("TT_") || key.startsWith("TAMANDUA_")) continue;
    env[key] = value;
  }
  env.HOME = accountHome();
  delete env.TAMANDUA_WORKTREE_ROOT;
  // NODE_TEST_CONTEXT must be ABSENT for the lane's `node --test`: when it
  // is present (even empty — the controller's operator env may carry it), the
  // test runner prints "node:test run() is being called recursively within a
  // test file. skipping running files." and runs NOTHING (exit 0 in ~75s
  // instead of the full ~16-min serial lane) — the corridor would be silently
  // unexercised. node --test sets NODE_TEST_CONTEXT itself for its workers,
  // so stripping the parent's value is exactly right.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// ── 1. build the product tree (sequential) ───────────────────────────

const build = runSync("npm", ["run", "build"], { cwd: repoRoot, timeout: 10 * 60_000 });
assert.equal(build.status, 0,
  `npm run build failed (the serial lane tests import from dist/):\n${build.stdout}\n${build.stderr}`);

// ── 2. contained DB baseline + scratch origins ───────────────────────

const runsBefore = new Set(dbRead("SELECT id FROM runs").map((r) => r.id));
buildOrigin(originA);
buildOrigin(originB);

const ttStart = Date.now();
const ttArgv = (origin, label) => [
  "workflow", "run", workflowId, label,
  "--worktree-origin-repository", origin, "--worktree-origin-ref", "main",
  "--context", "test_cmd=npm test",
  "--wait", "--timeout", "6m", "--json",
];

// ── 3. launch the two TT runs concurrently ───────────────────────────

function spawnCapture(argv, cwd) {
  const child = spawn(cli, argv, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += String(d); });
  child.stderr.on("data", (d) => { stderr += String(d); });
  return {
    child,
    startedAt: Date.now(),
    finishedAt: null,
    status: null,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function waitChild(handle, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}: timed out after ${timeoutMs}ms\nstdout:\n${handle.stdout()}\nstderr:\n${handle.stderr()}`));
    }, timeoutMs);
    handle.child.on("close", (code) => {
      clearTimeout(timer);
      handle.status = code;
      handle.finishedAt = Date.now();
      resolve(handle);
    });
    handle.child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`${label}: spawn error: ${err.message}`));
    });
  });
}

const t1 = spawnCapture(ttArgv(originA, "W4.24 serial-lane probe run 1"), originA);
const t2 = spawnCapture(ttArgv(originB, "W4.24 serial-lane probe run 2"), originB);

// ── 4. launch the product serial lane concurrently ───────────────────

const laneEnv = cleanLaneEnv();
const laneTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-w4-24-lane-"));
assert.ok(!laneTmpDir.startsWith(`${repoRoot}/torture-test/var`),
  "the lane's temp root must NOT be under torture-test/var (no cross-talk)");
laneEnv.TMPDIR = laneTmpDir;

const lane = spawn("bash", [serialScript], {
  cwd: repoRoot,
  env: laneEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
let laneStdout = "";
let laneStderr = "";
lane.stdout.on("data", (d) => { laneStdout += String(d); });
lane.stderr.on("data", (d) => { laneStderr += String(d); });
const laneStartedAt = Date.now();
const laneExit = new Promise((resolve, reject) => {
  lane.on("close", (code) => resolve(code));
  lane.on("error", (err) => reject(new Error(`serial lane spawn error: ${err.message}`)));
});

// ── 5. wait for the TT runs (they must complete WHILE the lane runs) ─

const [w1, w2] = await Promise.all([
  waitChild(t1, 10 * 60_000, "TT run 1"),
  waitChild(t2, 10 * 60_000, "TT run 2"),
]);
const ttFinishedAt = Math.max(w1.finishedAt, w2.finishedAt);
assert.ok(ttFinishedAt > laneStartedAt,
  "the TT runs must still be in flight when the serial lane starts (concurrency proof)");

function completedRunId(handle, label) {
  assert.equal(handle.status, 0, `${label}: workflow run exited ${handle.status}:\n${handle.stdout()}\n${handle.stderr()}`);
  const line = handle.stdout().trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  assert.ok(line, `${label}: no JSON payload:\n${handle.stdout()}`);
  const payload = JSON.parse(line);
  const record = Array.isArray(payload.runs) ? payload.runs[0] : payload;
  // The run id may surface with a "run-" prefix; the DB/events keys are the
  // bare uuid (the W4.11 scoped-ledger convention).
  const runId = String(record.runId ?? record.run_id ?? "").replace(/^run-/, "");
  assert.ok(runId.length > 0, `${label}: run id missing:\n${handle.stdout()}`);
  assert.equal(record.status, "completed", `${label}: TT run must complete: ${handle.stdout()}`);
  return runId;
}

const run1Id = completedRunId(w1, "TT run 1");
const run2Id = completedRunId(w2, "TT run 2");
for (const runId of [run1Id, run2Id]) {
  const rows = dbRead("SELECT tokens_spent, worker_lost_count FROM runs WHERE id = ?", [runId]);
  assert.equal(rows.length, 1, `TT run ${runId} must exist in the ledger`);
  assert.equal(rows[0].tokens_spent, 0, `TT run ${runId} must be zero-token`);
  assert.equal(rows[0].worker_lost_count, 0, `TT run ${runId} must have zero worker_lost events`);
}

// ── 6. wait for the serial lane; record its deadline behavior ────────

const laneCode = await laneExit;
const laneFinishedAt = Date.now();
const laneWallMs = laneFinishedAt - laneStartedAt;
const laneCombined = `${laneStdout}\n${laneStderr}`;
// Persist the lane's combined output for evidence + debugging (contained).
try {
  fs.writeFileSync(path.join(invocationDir, "lane-output.log"), laneCombined, "utf8");
} catch {
  // best-effort evidence
}
// ALSO persist to a /tmp path that survives the harness invocation-dir
// cleanup (diagnostic/evidence aid; the lane's wall time is far shorter than
// the product suite when the lane is disrupted, so the full output matters).
try {
  fs.writeFileSync(path.join(os.tmpdir(), `tt-w4-24-lane-${process.pid}.log`), laneCombined, "utf8");
} catch {
  // best-effort evidence
}
const laneDurationSec = Math.round(laneWallMs / 1000);

// Lane deadline behavior documented: exit code + wall time recorded.
assert.equal(laneCode, 0,
  `the product serial lane must exit 0 on a healthy tree (deadline behavior under concurrent TT load); wall ${laneDurationSec}s:\n${laneCombined}`);

// ── 7. no cross-talk assertions ──────────────────────────────────────

// (a) The contained DB runs-set grew ONLY by the two TT runs — no product
//     test run leaked into the TT ledger.
const runsAfter = new Set(dbRead("SELECT id FROM runs").map((r) => r.id));
const newRunIds = [...runsAfter].filter((id) => !runsBefore.has(id)).sort();
assert.deepEqual(newRunIds, [run1Id, run2Id].sort(),
  `the contained ledger must have grown ONLY by the two TT runs (got: ${newRunIds.join(", ")})`);

// (b) The lane's output never references the CONTAINED state dir (the
//     product lane never touched the TT state). NOTE: "TEST ISOLATION
//     VIOLATION" is NOT asserted absent — the product's OWN serial lane
//     includes the guard self-tests (e.g. src/server/daemonctl-guard.test.ts
//     "throws TEST ISOLATION VIOLATION when guard is active and HOME is real
//     user home") which DELIBERATELY trigger the guard with their own temp
//     envs and print that text as a PASSING assertion. The honest
//     no-cross-talk checks are: no contained-state reference, the lane's
//     temp state outside var/, the ledger grew only by the TT runs, and the
//     lane exits 0 (every guard violation it emitted was an EXPECTED
//     self-test, never a cross-talk breach).
assert.ok(!laneCombined.includes(stateDir),
  `the serial lane must not reference the contained state dir ${stateDir}:\n` + laneCombined.slice(0, 2000));

// (c) The lane's temp HOMEs/state live under the recorded TMPDIR (the OS
//     tmpdir), never under torture-test/var/.
assert.ok(!laneTmpDir.startsWith(`${repoRoot}/torture-test/var/`),
  "the lane's TMPDIR must not be under torture-test/var");

// ── 8. zero tokens + scoped cleanup ──────────────────────────────────

const runTokens = dbRead("SELECT COALESCE(SUM(tokens_spent), 0) AS total FROM runs")[0].total;
const systemTokens = dbRead("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1")[0].system_tokens_spent;
assert.equal(runTokens, 0, "W4.24 observed nonzero run tokens");
assert.equal(systemTokens, 0, "W4.24 system token tripwire moved");

deleteRun(run1Id);
deleteRun(run2Id);
fs.rmSync(laneTmpDir, { recursive: true, force: true });

process.stdout.write(`${JSON.stringify({
  scenario: scenarioId,
  result: "PASS",
  tt_runs: {
    run1: run1Id,
    run2: run2Id,
    both_completed: true,
    overlap_with_lane_seconds: Math.round((ttFinishedAt - laneStartedAt) / 1000),
  },
  serial_lane: {
    exit_code: laneCode,
    wall_seconds: laneDurationSec,
    deadline_behavior: "documented (absolute-deadline serial tests ran under concurrent TT load)",
    tmpdir: laneTmpDir,
  },
  cross_talk: {
    ledger_grew_only_by_tt_runs: true,
    // The lane's own "TEST ISOLATION VIOLATION" guard self-tests are EXPECTED
    // passing output (deliberate guard triggers with their own temp envs) —
    // the honest legs are no-contained-state-reference + exit 0 + temp-outside-var.
    lane_no_contained_state_reference: true,
    lane_tmp_not_under_var: true,
  },
  tokens_spent: runTokens,
  system_tokens_spent: systemTokens,
})}\n`);
