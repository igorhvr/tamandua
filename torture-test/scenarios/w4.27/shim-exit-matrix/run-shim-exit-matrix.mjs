#!/usr/bin/env node
/**
 * W4.27 shim exit-code matrix — zero-token scripted scenario cell.
 *
 * Exercises the `tamandua-test` shim's O9 special-exit corridor (spec 08 §C
 * W4.27) against a scratch git repo, recording into the CONTAINED scripted
 * daemon's sqlite ledger:
 *
 *   (a) SIGTERM the shim mid-execution   -> exit 87, EXACTLY one red-87 row,
 *                                          claim released (same-key re-run
 *                                          executes fresh, never wedges);
 *   (b) SIGKILL the shim mid-execution   -> NO row; the next same-key
 *                                          invocation executes fresh within
 *                                          seconds (dead-owner reclaim — no
 *                                          30-min wedge), no CACHED replay;
 *   (c) tracked file mutated mid-suite   -> exit 86 (tree drift), NO row;
 *   (d) invoke on a dirty tracked tree   -> exit 88 FAILURE_CLASS: tree_dirty,
 *                                          command NOT executed, NO row;
 *   (e) prompt-order collision probe     -> bfmw fixer sequence
 *                                          (edit -> wrapped test -> commit):
 *                                          the wrapped test runs BEFORE the
 *                                          commit on a dirty tree; the outcome
 *                                          is classified as PRODUCT behavior
 *                                          (exit-88 fail-closed refusal OR
 *                                          shim passthrough), then the commit
 *                                          lands and the clean-tree re-run
 *                                          executes fresh.
 *
 * Every arm leaves its junk probe untracked. Zero tokens: no real pi/hermes/
 * dsh invocation — the shim records through the scripted daemon's control
 * plane (the daemon run-scripted-scenario started).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
assert.equal(process.env.TT_SCENARIO_COMMAND_GROUP_PROVEN, "1",
  "scenario must run in the harness-proven process group");
assert.equal(scenarioId, "w4.27-shim-exit-matrix", "scenario id mismatch");

const shim = path.join(repoRoot, "bin", "tamandua-test");
const shimJs = path.join(repoRoot, "dist", "suite", "shim.js");
const dbPath = path.join(stateDir, "tamandua.db");
const work = path.join(invocationDir, "shim-exit-repo");
const junkProbe = ".tamandua-w4.27-junk-probe";
const junkProbePath = path.join(work, junkProbe);
const markerPath = path.join(invocationDir, "dirty-refusal-executed.marker");

for (const candidate of [work, junkProbePath, markerPath]) {
  assert.ok(candidate === invocationDir || candidate.startsWith(`${invocationDir}${path.sep}`),
    `W4.27 mutable path escaped torture-test/var: ${candidate}`);
}
assert.ok(dbPath.startsWith(`${stateDir}${path.sep}`) || dbPath === stateDir,
  `W4.27 ledger path escaped the contained state dir: ${dbPath}`);

assert.ok(fs.existsSync(shim), `shim not found: ${shim}`);
assert.ok(fs.existsSync(shimJs), `built shim missing (run npm run build?): ${shimJs}`);
assert.ok(fs.existsSync(dbPath), `contained scripted ledger missing: ${dbPath}`);

const env = { ...process.env, TAMANDUA_TSTX_JUNK_PROBE: junkProbe };

// ── git / repo helpers ──────────────────────────────────────────────

function git(args, cwd, { allowFail = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr?.trim() ?? result.stdout?.trim()}`);
  }
  return result;
}

function writeExecutable(file, content) {
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o755 });
}

function suiteRows(runId, stepId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(
      "SELECT id, exit_code, run_id, step_id FROM suite_results WHERE run_id = ? AND step_id = ? ORDER BY id",
    ).all(runId, stepId);
  } finally {
    db.close();
  }
}

function rowCount(runId, stepId) {
  return suiteRows(runId, stepId).length;
}

function runShimSync(runId, stepId, command, options = {}) {
  const args = ["--repo", work, "--run", runId, "--step", stepId];
  if (options.force) args.push("--force");
  args.push("--", command);
  return spawnSync(shim, args, { cwd: work, env, encoding: "utf8", timeout: options.timeoutMs ?? 30_000 });
}

// Spawn the shim, wait for the marker on stdout, then deliver the signal.
function runShimSignaled(runId, stepId, command, signal, marker) {
  return new Promise((resolve, reject) => {
    const child = spawn(shim, ["--repo", work, "--run", runId, "--step", stepId, "--", command], {
      cwd: work, env, stdio: ["ignore", "pipe", "pipe"], shell: false,
    });
    let stdout = "";
    let stderr = "";
    let signaled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`shim ${runId}/${stepId} did not reach '${marker}' in time; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (!signaled && stdout.includes(marker)) {
        signaled = true;
        child.kill(signal);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, closeSignal) => {
      clearTimeout(timeout);
      resolve({ exitCode: code, signal: closeSignal, stdout, stderr });
    });
  });
}

// ── setup: scratch repo ─────────────────────────────────────────────

fs.mkdirSync(work, { recursive: true });
git(["init", "-q"], work);
git(["config", "user.email", "w4.27@tamandua.local"], work);
git(["config", "user.name", "W4.27 Shim Exit Matrix"], work);
fs.writeFileSync(path.join(work, "README.md"), "# W4.27 shim exit-code matrix\n");
fs.writeFileSync(path.join(work, "tracked.txt"), "tracked content\n");
git(["add", "."], work);
git(["commit", "-q", "-m", "baseline"], work);

// Untracked helper scripts (untracked artifacts do not affect ledger evidence).
// interruptible.sh is BOUNDED (sleep 2, then exit 0) so the same-key recovery
// leg can re-run the EXACT same command after the interruption: the red-87 row
// is never replayed and the released claim must not wedge the re-run.
const interruptibleScript = path.join(work, "interruptible.sh");
const killableScript = path.join(work, "killable.sh");
const driftScript = path.join(work, "drift.sh");
const passScript = path.join(work, "pass.sh");
writeExecutable(interruptibleScript,
  "#!/bin/sh\ntrap 'exit 99' TERM INT\necho 'W4.27 INTERRUPTIBLE STARTED'\nsleep 2\necho 'W4.27 INTERRUPTIBLE DONE'\nexit 0\n");
writeExecutable(killableScript,
  "#!/bin/sh\necho 'W4.27 KILLABLE STARTED'\nsleep 2\necho 'W4.27 KILLABLE DONE'\nexit 0\n");
writeExecutable(driftScript,
  "#!/bin/sh\necho 'drift line' >> tracked.txt\necho 'W4.27 DRIFT DONE'\nexit 0\n");
writeExecutable(passScript, "#!/bin/sh\nexit 0\n");

fs.writeFileSync(junkProbePath, "w4.27 junk probe\n", { mode: 0o600 });

const observations = {};
const arms = {};

function armsPassed() {
  return Object.values(arms).every((arm) => arm.passed === true);
}

// ── preflight: control-plane + ledger wiring proof ──────────────────

{
  const pre = runShimSync("run-w4.27-preflight", "s-preflight", passScript);
  assert.equal(pre.status, 0, `preflight shim run must pass:\n${pre.stderr}\n${pre.stdout}`);
  assert.equal(rowCount("run-w4.27-preflight", "s-preflight"), 1,
    "preflight must record exactly one green row (proves the scripted control plane + ledger wiring)");
}

// ── arm (a): SIGTERM mid-execution -> exit 87, red row, claim released ──

{
  const runId = "run-w4.27-a";
  const stepId = "s-a";
  const before = Date.now();
  const result = await runShimSignaled(runId, stepId, interruptibleScript, "SIGTERM", "W4.27 INTERRUPTIBLE STARTED");
  const after = Date.now();
  assert.equal(result.exitCode, 87, `arm (a): SIGTERM must yield shim exit 87 (got ${result.exitCode}/${result.signal})`);
  const rows = suiteRows(runId, stepId);
  assert.equal(rows.length, 1, `arm (a): exactly one red-87 row expected, got ${rows.length}`);
  assert.equal(rows[0].exit_code, 87, `arm (a): row exit_code must be 87`);
  // Recovery leg: the SAME key (same repo/tree/cmd), no --force -> the red row
  // is never replayed and the released claim must not wedge; the re-run
  // executes fresh and records a second (green) row.
  const rerun = runShimSync(runId, stepId, interruptibleScript);
  const rerunMs = Date.now() - after;
  assert.equal(rerun.status, 0, `arm (a) recovery: same-key re-run must pass:\n${rerun.stderr}\n${rerun.stdout}`);
  assert.ok(!rerun.stdout.includes("TAMANDUA-TEST CACHED"), "arm (a) recovery: red rows are never replayed — fresh execution expected");
  const rowsAfter = suiteRows(runId, stepId);
  assert.equal(rowsAfter.length, 2, "arm (a) recovery: the re-run must record a second row");
  assert.equal(rowsAfter[1].exit_code, 0, "arm (a) recovery: the second row must be green");
  assert.ok(rerunMs < 30_000, `arm (a) recovery: claim released — re-run must execute within seconds (took ${rerunMs}ms)`);
  arms.a_sigterm_exit_87 = { passed: true, exit_87: true, red_row_count: 1, recovery_fresh: true, first_leg_ms: after - before };
  observations.a = { signal: "SIGTERM", shim_exit: result.exitCode, rows_after_interrupt: rows.length, recovery_rerun_exit: rerun.status };
}

// ── arm (b): SIGKILL mid-execution -> no row, same-key fresh execute ──

{
  const runId = "run-w4.27-b";
  const stepId = "s-b";
  const result = await runShimSignaled(runId, stepId, killableScript, "SIGKILL", "W4.27 KILLABLE STARTED");
  assert.equal(result.signal, "SIGKILL", `arm (b): shim must be killed by SIGKILL (got signal ${result.signal})`);
  assert.equal(rowCount(runId, stepId), 0, `arm (b): SIGKILL must record NO row (got ${rowCount(runId, stepId)})`);
  // Same-key invocation (same repo/tree/cmd), no --force: dead-owner reclaim
  // must let it execute fresh within seconds — no 30-min wedge, no CACHED
  // replay of a nonexistent green row.
  const rerun = runShimSync(runId, stepId, killableScript, { timeoutMs: 60_000 });
  assert.equal(rerun.status, 0, `arm (b) recovery: same-key re-run must execute fresh and pass:\n${rerun.stderr}\n${rerun.stdout}`);
  assert.ok(!rerun.stdout.includes("TAMANDUA-TEST CACHED"), "arm (b) recovery: no row existed — fresh execution expected, not a replay");
  assert.equal(rowCount(runId, stepId), 1, "arm (b) recovery: the fresh execution must record exactly one green row");
  arms.b_sigkill_no_row_fresh_execute = { passed: true, sigkill: true, rows_after_kill: 0, recovery_fresh: true };
  observations.b = { signal: "SIGKILL", rows_after_kill: 0, rerun_exit: rerun.status, rerun_recorded_rows: 1 };
}

// ── arm (c): tracked file mutated mid-suite -> exit 86, no row ──────

{
  const runId = "run-w4.27-c";
  const stepId = "s-c";
  const result = runShimSync(runId, stepId, driftScript);
  assert.equal(result.status, 86, `arm (c): tree drift must yield shim exit 86 (got ${result.status})`);
  assert.match(result.stderr, /could not be attributed|not recorded|stable-tree rerun/,
    `arm (c): stderr must explain the drift (got: ${result.stderr.trim()})`);
  assert.equal(rowCount(runId, stepId), 0, `arm (c): drift must record NO row`);
  // Restore the tree for the remaining arms.
  git(["checkout", "-q", "--", "tracked.txt"], work);
  assert.equal(git(["status", "--porcelain", "--untracked-files=no"], work).stdout.trim(), "", "arm (c): tree must be restored to clean");
  arms.c_tree_drift_exit_86 = { passed: true, exit_86: true, rows: 0 };
  observations.c = { exit: result.status, rows: 0, restored: true };
}

// ── arm (d): dirty tracked tree -> exit 88 refusal, no execution ────

{
  const runId = "run-w4.27-d";
  const stepId = "s-d";
  fs.writeFileSync(path.join(work, "README.md"), "# W4.27 shim exit-code matrix\npre-dirtied\n");
  const result = runShimSync(runId, stepId, `sh -c 'touch ${markerPath}'`);
  assert.equal(result.status, 88, `arm (d): tracked-dirty must yield shim exit 88 (got ${result.status})`);
  assert.match(result.stderr, /FAILURE_CLASS: tree_dirty/, `arm (d): stderr must carry FAILURE_CLASS: tree_dirty (got: ${result.stderr.trim()})`);
  assert.ok(!fs.existsSync(markerPath), "arm (d): the refused command must NOT be executed");
  assert.equal(rowCount(runId, stepId), 0, `arm (d): refusal must record NO row`);
  git(["checkout", "-q", "--", "README.md"], work);
  assert.equal(git(["status", "--porcelain", "--untracked-files=no"], work).stdout.trim(), "", "arm (d): tree must be restored to clean");
  arms.d_tree_dirty_exit_88 = { passed: true, exit_88: true, command_executed: false, rows: 0 };
  observations.d = { exit: result.status, command_executed: false, rows: 0 };
}

// ── arm (e): prompt-order collision probe (edit -> wrapped test -> commit) ──

{
  const runId = "run-w4.27-e";
  const stepId = "s-e";
  // The bfmw fixer's edit: a tracked file changes but is NOT yet committed.
  fs.writeFileSync(path.join(work, "README.md"), "# W4.27 shim exit-code matrix\nfixer edit\n");
  // The wrapped test runs BEFORE the commit, i.e. on a dirty tracked tree.
  const wrapped = runShimSync(runId, stepId, passScript);
  let classification;
  if (wrapped.status === 88 && /FAILURE_CLASS: tree_dirty/.test(wrapped.stderr)) {
    classification = "shim-fails-closed-on-pre-commit-wrapped-test";
    assert.equal(rowCount(runId, stepId), 0,
      "arm (e): the refused pre-commit wrapped test must record NO row");
  } else if (wrapped.status === 0) {
    classification = "shim-passthrough-executes-pre-commit-wrapped-test";
  } else {
    assert.fail(`arm (e): pre-commit wrapped test must be exit 88 (fail-closed) or exit 0 (passthrough), got ${wrapped.status}: ${wrapped.stderr}`);
  }
  // Commit the edit (the persona's third step), then re-run on the clean tree.
  git(["add", "README.md"], work);
  git(["commit", "-q", "-m", "fixer commit"], work);
  const afterCommit = runShimSync(runId, stepId, passScript);
  assert.equal(afterCommit.status, 0, `arm (e): post-commit wrapped test must pass on the clean tree:\n${afterCommit.stderr}\n${afterCommit.stdout}`);
  assert.equal(rowCount(runId, stepId), 1,
    `arm (e): the post-commit run must record exactly one row (classification ${classification})`);
  arms.e_prompt_order = { passed: true, classification, post_commit_exit: afterCommit.status };
  observations.e = { classification, pre_commit_wrapped_exit: wrapped.status, post_commit_exit: afterCommit.status };
}

// ── junk-probe hygiene: every special arm leaves the probe untracked ──

{
  const tracked = git(["ls-files", "--error-unmatch", "--", junkProbe], work, { allowFail: true }).status === 0;
  assert.equal(tracked, false, "the O9 junk probe must never become tracked");
  arms.junk_probe_untracked = { passed: true };
}

// ── token + ledger hygiene ──────────────────────────────────────────

const db = new DatabaseSync(dbPath, { readOnly: true });
let runTokens = 0;
let systemTokens = 0;
try {
  runTokens = db.prepare("SELECT COALESCE(SUM(tokens_spent), 0) AS total FROM runs").get().total;
  systemTokens = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get().system_tokens_spent;
} finally {
  db.close();
}
assert.equal(runTokens, 0, "W4.27 observed nonzero run tokens");
assert.equal(systemTokens, 0, "W4.27 system token tripwire moved");

assert.ok(armsPassed(), `W4.27 corridor incomplete: ${JSON.stringify(arms, null, 2)}`);

// ── cleanup: drop this scenario's ledger rows (scoped to its own runs) ──

try {
  const cleanDb = new DatabaseSync(dbPath);
  try {
    cleanDb.prepare("DELETE FROM suite_results WHERE run_id LIKE 'run-w4.27-%'").run();
  } finally {
    cleanDb.close();
  }
} catch {
  // Best-effort only — leftover rows are origin-scoped and harmless.
}

process.stdout.write(`${JSON.stringify({
  scenario: scenarioId,
  result: "PASS",
  arms: Object.fromEntries(Object.entries(arms).map(([key, value]) => [key, value])),
  observations,
  tokens_spent: runTokens,
  system_tokens_spent: systemTokens,
})}\n`);
