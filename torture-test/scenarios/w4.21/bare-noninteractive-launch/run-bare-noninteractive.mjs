#!/usr/bin/env node
/**
 * W4.21 bare non-interactive PATH — full launch (daemon + one bfmw), never
 * silent worker_lost loops (spec 08 §H W4.21). Zero-token scripted cell.
 *
 * The corridor: a FULL launch (contained scripted daemon + one
 * bug-fix-merge-worktree run) from a BARE NON-INTERACTIVE shell constructed
 * with `env -i` (no node/pi/hermes on PATH in the truly-bare arm). The
 * discovery contract: a working run OR a diagnosable refusal — never silent
 * worker_lost loops.
 *
 *   Branch A (rich default shell — node reachable): env -i with PATH rebuilt
 *   to the node bin dir + /usr/bin:/bin (node/git/coreutils found; pi/hermes/
 *   dsh NOT on the constructed PATH — self-verified). The full bfmw launch
 *   must COMPLETE with zero tokens and worker_lost_count 0.
 *
 *   Branch B (truly bare PATH — node NOT reachable): env -i with PATH
 *   pointing at a scratch bin carrying only the launcher's coreutils
 *   (readlink, dirname — symlinked) and NO node (self-verified). The same
 *   launch argv must REFUSE DIAGNOSABLY at the launcher (exit 127, stderr
 *   naming `node`), create NO run row, and append NO step.worker_lost event —
 *   a silent worker_lost loop would be a finding.
 *
 * Zero tokens: both runs (branch A's bfmw) execute on the scripted-pi
 * runtime; the ledger must show runs.tokens_spent 0 + system tripwire 0.
 * Every run the cell creates is deleted after capture (scoped ledger — the
 * W4.11 pattern) so the contained DB stays clean for sibling scenarios.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
assert.equal(scenarioId, "w4.21-bare-noninteractive-launch", "scenario id mismatch");

const cli = path.join(repoRoot, "bin", "tamandua");
const dbPath = path.join(stateDir, "tamandua.db");
const eventsDir = path.join(stateDir, "events");
const work = path.join(invocationDir, "origin");
const workdir = path.join(invocationDir, "probe-work");
const richBin = path.join(invocationDir, "rich-bin");
const bareBin = path.join(invocationDir, "bare-bin");

for (const candidate of [work, workdir, richBin, bareBin]) {
  assert.ok(
    candidate.startsWith(`${invocationDir}${path.sep}`),
    `W4.21 mutable path escaped torture-test/var: ${candidate}`,
  );
}
fs.mkdirSync(workdir, { recursive: true });
fs.mkdirSync(richBin, { recursive: true });
fs.mkdirSync(bareBin, { recursive: true });

// ── helpers ──────────────────────────────────────────────────────────

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? invocationDir,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function git(args, cwd) {
  const result = runSync("git", args, { cwd });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function dbRows(query, params = []) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(query).all(...params);
  } finally {
    db.close();
  }
}

function dbRunCount() {
  return dbRows("SELECT COUNT(*) AS c FROM runs")[0].c;
}

// Snapshot the events dir (file -> byte length) so appended bytes can be
// scanned for worker_lost events without racing a rotated log.
function eventsSnapshot() {
  const snapshot = {};
  if (!fs.existsSync(eventsDir)) return snapshot;
  for (const name of fs.readdirSync(eventsDir)) {
    const p = path.join(eventsDir, name);
    if (fs.statSync(p).isFile()) snapshot[name] = fs.statSync(p).size;
  }
  return snapshot;
}

function appendedEvents(snapshot) {
  let text = "";
  for (const [name, size] of Object.entries(snapshot)) {
    const p = path.join(eventsDir, name);
    if (!fs.existsSync(p)) continue;
    const st = fs.statSync(p);
    if (st.size > size) {
      const fd = fs.openSync(p, "r");
      try {
        const buf = Buffer.alloc(st.size - size);
        fs.readSync(fd, buf, 0, buf.length, size);
        text += buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  return text;
}

const launchArgv = (label) => [
  "workflow", "run", workflowId, label,
  "--worktree-origin-repository", work, "--worktree-origin-ref", "main",
  "--wait", "--timeout", "5m", "--json",
];

function completedRunId(stdout) {
  const line = String(stdout).trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  assert.ok(line, `no JSON payload in workflow run stdout:\n${stdout}`);
  const payload = JSON.parse(line);
  const record = Array.isArray(payload.runs) ? payload.runs[0] : payload;
  // The run id may surface with a "run-" prefix; the DB/events keys are the
  // bare uuid (the W4.11 scoped-ledger convention).
  const runId = String(record.runId ?? record.run_id ?? "").replace(/^run-/, "");
  return { record, runId };
}

function deleteRun(runId) {
  // The daemon is told via `workflow delete --force` first so any crons the
  // reconciler set up are torn down by the product path; then the run's rows
  // are removed from the shared contained ledger (steps / run_worktrees /
  // runs) + its events file — the W4.11 scoped-ledger pattern. The SUCCESS
  // path stays strict: a hard CLI failure or a leftover row fails the cell.
  const res = runSync(cli, ["workflow", "delete", `run-${runId}`, "--force"], { timeout: 60_000 });
  assert.equal(res.status, 0, `workflow delete run-${runId} failed:\n${res.stdout}\n${res.stderr}`);
  deleteRunRows(runId);
  const rows = dbRows("SELECT COUNT(*) AS c FROM runs WHERE id = ?", [runId]);
  assert.equal(rows[0].c, 0, `run ${runId} still present after delete`);
}

// T2.1 US-007: a FAILED W4.21 must not leave its branch-A probe run behind.
// The campaign evidence: the earlier operator campaign's W4.21 timed out on
// the branch-A launch wait (run 85c4b27e stayed [running] in the shared
// scripted ledger), and the NEXT campaign's W4.20 `tamandua update` then
// refused ("Active Tamandua runs detected ... Run tamandua update --force
// to continue despite active runs") and failed its behind leg. The success
// path already deletes the run; the safety nets below do the same on every
// failure path (assertion failure, uncaught exception, process exit) so a
// failed W4.21 can never contaminate the shared ledger for sibling cells.
const createdRunIds = [];
function registerCreatedRun(runId) {
  createdRunIds.push(runId);
}
function cleanupCreatedRuns() {
  for (const runId of createdRunIds) {
    cliDeleteRun(runId);
    deleteRunRows(runId);
  }
}
process.on("exit", cleanupCreatedRuns);
process.on("uncaughtException", (error) => {
  cleanupCreatedRuns();
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});

function cliDeleteRun(runId) {
  const res = runSync(cli, ["workflow", "delete", `run-${runId}`, "--force"], { timeout: 60_000 });
  // Best-effort from a safety net: a missing run (already deleted) is fine;
  // a hard CLI failure must not throw here.
  if (res.status !== 0 && !/No run found matching/.test(res.stderr)) {
    process.stderr.write(`w4.21: workflow delete run-${runId} failed (best-effort):\n${res.stdout}\n${res.stderr}\n`);
  }
}

function deleteRunRows(runId) {
  // Tolerant scoped-ledger removal: never throws from a safety net.
  try {
    const del = new DatabaseSync(dbPath);
    try {
      del.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
      del.prepare("DELETE FROM run_worktrees WHERE run_id = ?").run(runId);
      del.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    } finally {
      del.close();
    }
  } catch (error) {
    process.stderr.write(`w4.21: ledger cleanup for run ${runId} failed (best-effort): ${error}\n`);
  }
  try {
    fs.rmSync(path.join(eventsDir, `${runId}.jsonl`), { force: true });
  } catch {
    // ignore — events dir may not exist
  }
}

// ── setup: scratch origin + bare-shell scratch PATH ─────────────────

fs.mkdirSync(work, { recursive: true });
git(["init", "-b", "main"], work);
git(["config", "user.email", "w4.21@tamandua.local"], work);
git(["config", "user.name", "W4.21 Bare Non-Interactive Launch"], work);
fs.writeFileSync(path.join(work, "value.txt"), "old\n");
fs.writeFileSync(path.join(work, ".gitignore"), ".env\nnode_modules/\n*.key\n*.pem\n");
git(["add", "."], work);
git(["commit", "-q", "-m", "baseline"], work);

// The two bare-shell PATHs are built as scratch bins so the corridor is
// HOST-INDEPENDENT (a host whose pi/hermes live next to node in the node bin
// dir cannot be stripped by excluding directories):
//   * richBin — node + git + the launcher's coreutils (readlink, dirname),
//     with NO pi/hermes/dsh: the "rich default shell" branch (working run).
//   * bareBin — the launcher's coreutils ONLY, with NO node: the truly bare
//     branch (diagnosable refusal).
function linkTool(binDir, tool) {
  const src = runSync("/bin/sh", ["-c", `command -v ${tool}`]).stdout.trim();
  assert.ok(src.length > 0, `cannot resolve ${tool} for the bare PATH`);
  fs.symlinkSync(src, path.join(binDir, tool));
}
for (const tool of ["readlink", "dirname"]) {
  linkTool(richBin, tool);
  linkTool(bareBin, tool);
}
linkTool(richBin, "git");
fs.symlinkSync(process.execPath, path.join(richBin, "node"));

// ── Branch A: rich default shell (node reachable) ────────────────────

const barePathA = richBin;
const checkA = runSync("/bin/sh", ["-c",
  `printf 'node=%s pi=%s hermes=%s dsh=%s git=%s\\n' \
   "$(command -v node || true)" "$(command -v pi || true)" \
   "$(command -v hermes || true)" "$(command -v dsh || true)" \
   "$(command -v git || true)"`],
  { env: { ...process.env, PATH: barePathA } });
const foundA = checkA.stdout.trim();
assert.match(foundA, /node=\S+/, `branch A: node must be on the bare PATH (got: ${foundA})`);
assert.match(foundA, /pi=\s/, `branch A: pi must NOT be on the bare PATH (got: ${foundA})`);
assert.match(foundA, /hermes=\s/, `branch A: hermes must NOT be on the bare PATH (got: ${foundA})`);
assert.match(foundA, /dsh=\s/, `branch A: dsh must NOT be on the bare PATH (got: ${foundA})`);
assert.match(foundA, /git=\S+/, `branch A: git must be on the bare PATH (got: ${foundA})`);

const launchA = runSync(cli, launchArgv("W4.21 bare non-interactive launch probe (rich shell)"), {
  cwd: work,
  env: { ...process.env, PATH: barePathA },
  timeout: 8 * 60_000,
});
assert.equal(launchA.status, 0,
  `branch A: full launch must succeed from the bare shell:\n${launchA.stdout}\n${launchA.stderr}`);
const { record: recordA, runId: runIdA } = completedRunId(launchA.stdout);
assert.ok(runIdA.length > 0, `branch A: run id missing:\n${launchA.stdout}`);
registerCreatedRun(runIdA);
assert.equal(recordA.status, "completed",
  `branch A: the launched bfmw must complete (discovery tiers produce a working run): ${launchA.stdout}`);
const runARows = dbRows("SELECT tokens_spent, worker_lost_count FROM runs WHERE id = ?", [runIdA]);
assert.equal(runARows.length, 1, `branch A: run ${runIdA} must exist in the ledger`);
assert.equal(runARows[0].tokens_spent, 0, `branch A: run ${runIdA} must be zero-token`);
assert.equal(runARows[0].worker_lost_count, 0,
  `branch A: run ${runIdA} must have ZERO worker_lost events (no silent worker_lost loop): got ${runARows[0].worker_lost_count}`);

// ── Branch B: truly bare PATH (node NOT reachable) ───────────────────

const barePathB = bareBin;
const checkB = runSync("/bin/sh", ["-c",
  `printf 'node=%s readlink=%s dirname=%s\\n' \
   "$(command -v node || true)" "$(command -v readlink || true)" \
   "$(command -v dirname || true)"`],
  { env: { ...process.env, PATH: barePathB } });
const foundB = checkB.stdout.trim();
assert.match(foundB, /node=\s/, `branch B: node must NOT be on the bare PATH (got: ${foundB})`);
assert.match(foundB, /readlink=\S+/, `branch B: readlink must be on the bare PATH (got: ${foundB})`);
assert.match(foundB, /dirname=\S+/, `branch B: dirname must be on the bare PATH (got: ${foundB})`);

const runCountBeforeB = dbRunCount();
const eventsBeforeB = eventsSnapshot();
const launchB = runSync(cli, launchArgv("W4.21 bare non-interactive launch probe (truly bare PATH)"), {
  cwd: work,
  env: { ...process.env, PATH: barePathB },
  timeout: 60_000,
});
assert.notEqual(launchB.status, 0,
  `branch B: the launch must refuse (exit non-zero) from a PATH without node:\n${launchB.stdout}\n${launchB.stderr}`);
assert.match(`${launchB.stdout}\n${launchB.stderr}`, /node[^\n]{0,40}(not found|No such file)/i,
  `branch B: the refusal must be DIAGNOSABLE (name the missing node):\n${launchB.stdout}\n${launchB.stderr}`);
assert.equal(dbRunCount(), runCountBeforeB,
  `branch B: the refused launch must create NO run row (nothing registered):\n${launchB.stdout}\n${launchB.stderr}`);
const appendedB = appendedEvents(eventsBeforeB);
assert.ok(!appendedB.includes("step.worker_lost"),
  `branch B: the refused launch must append NO step.worker_lost event (never a silent loop):\n${appendedB}`);

// ── zero-token ledger proof + scoped cleanup ─────────────────────────

const runTokens = dbRows("SELECT COALESCE(SUM(tokens_spent), 0) AS total FROM runs")[0].total;
const systemTokens = dbRows("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1")[0].system_tokens_spent;
assert.equal(runTokens, 0, "W4.21 observed nonzero run tokens");
assert.equal(systemTokens, 0, "W4.21 system token tripwire moved");

deleteRun(runIdA);

process.stdout.write(`${JSON.stringify({
  scenario: scenarioId,
  result: "PASS",
  branch_a: {
    path: barePathA,
    self_check: foundA,
    run_id: runIdA,
    status: recordA.status,
    tokens_spent: runARows[0].tokens_spent,
    worker_lost_count: runARows[0].worker_lost_count,
  },
  branch_b: {
    path: barePathB,
    self_check: foundB,
    exit_code: launchB.status,
    refusal_diagnosable: true,
    run_rows_created: 0,
    worker_lost_events: 0,
  },
  tokens_spent: runTokens,
  system_tokens_spent: systemTokens,
})}\n`);
