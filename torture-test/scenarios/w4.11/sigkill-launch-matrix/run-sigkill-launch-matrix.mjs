#!/usr/bin/env node
/**
 * W4.11 SIGKILL/Ctrl-C `workflow run` launch-violence matrix — zero-token
 * scripted scenario cell (spec 08 §C W4.11).
 *
 * The most common signal any user ever sends tamandua (Ctrl-C) and the
 * harshest (SIGKILL) are exercised at deterministic phase markers of the
 * `workflow run` launch path, against the CONTAINED scripted daemon:
 *
 *   SIGKILL legs (kill -9 the whole launch process group):
 *     A. before the run INSERT      — held at the DIRECT-mode launch's first
 *                                     git call (rev-parse --abbrev-ref), which
 *                                     runs before the INSERT (nothing claimed,
 *                                     no row);
 *     B. during `git worktree add`  — held inside a PATH git wrapper at the
 *                                     worktree-add call (run row + run_worktrees
 *                                     'creating', id on stderr — DC9);
 *     C. before daemon registration — held at the tested_tree rev-parse after
 *                                     the worktree exists (row + 'ready'
 *                                     worktree, id on stderr, never
 *                                     registered).
 *   Ctrl-C (SIGINT to the launch process GROUP — the mechanical core of a
 *   real PTY Ctrl-C, which also hits just-spawned children) legs:
 *     D. pre-registration           — held at worktree-add, group SIGINT: the
 *                                     run continues detached (id printed); the
 *                                     daemon reconciler takes ownership within
 *                                     one tick — NEVER a half-registered orphan;
 *     E. during daemon auto-start   — daemon stopped, launch auto-starts it
 *                                     (detached), group SIGINT on the daemon
 *                                     pidfile: the daemon SURVIVES (full detach
 *                                     proof) and the run continues detached;
 *     F. during --wait              — run live + dispatching, group SIGINT to
 *                                     the waiter: exit code 130 distinguishes
 *                                     "interrupted, run continues" from
 *                                     failure; the run keeps progressing.
 *
 * Every arm asserts: no permanent zombie (the killed group is fully reaped),
 * worktree prunable-or-absent, run id on stderr where it existed (DC9), and
 * the contract invariants. Every arm leaves the contained scripted DB scoped
 * to this scenario (its own runs are deleted after capture). Zero tokens: no
 * real pi/hermes/dsh invocation — the scripted daemon drives any dispatched
 * agent from the behaviors file.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
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
assert.equal(scenarioId, "w4.11-sigkill-launch-matrix", "scenario id mismatch");

const cli = path.join(repoRoot, "bin", "tamandua");
const daemonControl = path.join(repoRoot, "torture-test", "bin", "daemon-control");
const dbPath = path.join(stateDir, "tamandua.db");
const work = path.join(invocationDir, "origin");
const wrapperDir = path.join(invocationDir, "bin-git");
const wrapperGit = path.join(wrapperDir, "git");
const eventsDir = path.join(stateDir, "events");
// W4.11's own arm E SIGINTs the launch CLI while startDaemon holds the
// product's O_EXCL daemon-start.lock — Node's default SIGINT skips
// startDaemon's finally-released lock, leaving a FRESH orphaned lock that
// wedges the NEXT cell's daemon bootstrap for 10s ("Timed out waiting for
// another daemon start attempt to finish" — the operator-campaign W4.12
// failure). The cell created the leak, so it must clean it: clear the lock
// right after arm E's SIGINT and in every safety net. The auto-started
// daemon itself is unaffected (it already wrote its pidfile before the
// SIGINT).
const daemonStartLock = path.join(stateDir, "daemon-start.lock");
function clearOrphanedStartLock() {
  fs.rmSync(daemonStartLock, { force: true });
}

// Every path this scenario mutates must stay under torture-test/var.
for (const candidate of [work, wrapperDir, wrapperGit]) {
  assert.ok(candidate === invocationDir || candidate.startsWith(`${invocationDir}${path.sep}`),
    `W4.11 mutable path escaped torture-test/var: ${candidate}`);
}
assert.ok(dbPath.startsWith(`${stateDir}${path.sep}`) || dbPath === stateDir,
  `W4.11 ledger path escaped the contained state dir: ${dbPath}`);
const varReal = fs.realpathSync(path.join(repoRoot, "torture-test", "var"));
const stateReal = fs.realpathSync(stateDir);
assert.ok(stateReal === varReal || stateReal.startsWith(`${varReal}${path.sep}`),
  `W4.11 state dir escaped torture-test/var: ${stateReal}`);

const realGit = (() => {
  const probe = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" });
  assert.equal(probe.status, 0, "real git not resolvable");
  return probe.stdout.trim();
})();

// ── helpers ─────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runSync(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeoutMs ?? 120_000,
  });
  return {
    status: result.status,
    signal: result.signal ?? null,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

// daemon-control spawns `tamandua` for stop/start — its run_under_env uses
// the CALLER's PATH. Ensure the repo bin (with the built CLI) is on it.
function runDaemonControl(args, options = {}) {
  return runSync(daemonControl, args, {
    ...options,
    env: { ...process.env, PATH: `${repoRoot}/bin:${process.env.PATH}` },
  });
}

// Probe a TCP listener (the auto-started daemon's control plane) without
// depending on daemon-control provenance.
function portListening(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

function git(args, cwd, options = {}) {
  const result = spawnSync(realGit, args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0 && !options.allowFail) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr?.trim() ?? result.stdout?.trim()}`);
  }
  return result;
}

function openDb() {
  return new DatabaseSync(dbPath, { readOnly: true });
}

function runRow(connection, runId) {
  return connection.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
}

function stepRows(connection, runId) {
  return connection.prepare("SELECT step_id, status FROM steps WHERE run_id = ? ORDER BY step_index").all(runId);
}

function runIdByNumber(connection, runNumber) {
  const row = connection.prepare("SELECT id FROM runs WHERE run_number = ?").get(runNumber);
  return row ? row.id : null;
}

function deleteRunRows(runId) {
  // Scoped DB cleanup: remove every trace of one of this scenario's runs from
  // the shared contained ledger (steps / run_worktrees / runs + its events
  // file). The daemon is told via `workflow delete --force` first so any crons
  // the reconciler set up are torn down by the product path.
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

function cliDeleteRun(runId) {
  const res = runSync(cli, ["workflow", "delete", `run-${runId}`, "--force"], { timeoutMs: 60_000 });
  if (res.status !== 0 && !/No run found matching/.test(res.stderr)) {
    throw new Error(`workflow delete run-${runId} failed: ${res.stdout}\n${res.stderr}`);
  }
}

async function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

// Spawn a launch CLI as its own process-group leader (detached) so we can
// deliver SIGKILL / SIGINT to the WHOLE group — the mechanical core of a real
// terminal Ctrl-C, which also hits just-spawned children. The runner keeps the
// handle and reaps the child (no permanent zombie).
const liveChildren = [];
function spawnLaunch(argv, cwd, holds) {
  const child = spawn(cli, argv, {
    cwd,
    env: holds.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    shell: false,
  });
  const state = { child, pgid: child.pid, ...holds, stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { state.stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { state.stderr += chunk.toString(); });
  liveChildren.push(state);
  return state;
}

function makeHolds({ holdPre = false, holdA = false, holdB = false }) {
  const paths = {
    markerPre: path.join(invocationDir, "hold-pre.marker"),
    releasePre: path.join(invocationDir, "hold-pre.release"),
    markerA: path.join(invocationDir, "hold-a.marker"),
    releaseA: path.join(invocationDir, "hold-a.release"),
    markerB: path.join(invocationDir, "hold-b.marker"),
    releaseB: path.join(invocationDir, "hold-b.release"),
  };
  for (const file of Object.values(paths)) fs.rmSync(file, { force: true });
  const env = {
    ...process.env,
    PATH: `${wrapperDir}:${process.env.PATH}`,
    GIT_HOLD_REAL_GIT: realGit,
    GIT_HOLD_MARKER_PRE: holdPre ? paths.markerPre : "",
    GIT_HOLD_RELEASE_PRE: paths.releasePre,
    GIT_HOLD_MARKER_A: holdA ? paths.markerA : "",
    GIT_HOLD_RELEASE_A: paths.releaseA,
    GIT_HOLD_MARKER_B: holdB ? paths.markerB : "",
    GIT_HOLD_RELEASE_B: paths.releaseB,
  };
  return { ...paths, env };
}

function launchWorkflowRun({ holdPre = false, holdA = false, holdB = false, wait = false, cwd = work, workflow = workflowId } = {}) {
  const holds = makeHolds({ holdPre, holdA, holdB });
  const argv = ["workflow", "run", workflow, "W4.11 SIGKILL launch-violence arm",
    "--worktree-origin-repository", work, "--worktree-origin-ref", "main"];
  if (wait) argv.push("--wait", "--timeout", "3m");
  return spawnLaunch(argv, cwd, holds);
}

async function waitForMarker(markerFile, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(markerFile)) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label ?? "launch hold marker"}: ${markerFile}`);
}

async function waitForFile(file, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}: ${file}`);
}

async function waitForStderrContains(state, text, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.stderr.includes(text)) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for stderr to contain ${label ?? text}:\n${state.stderr}`);
}

async function killGroup(state, signal) {
  try {
    process.kill(-state.pgid, signal);
  } catch {
    // group already gone
  }
  if (state.child.exitCode === null && state.child.signalCode === null) {
    await once(state.child, "close");
  }
  // Give the OS a beat to reap the group's orphans, then prove the group is
  // gone (no permanent zombie / orphan shape survives).
  await delay(300);
  assert.equal(await groupAlive(state.pgid), false,
    `launch process group ${state.pgid} still has live members after ${signal}`);
  return state.child;
}

function releaseHolds(state) {
  for (const file of [state.releasePre, state.releaseA, state.releaseB]) {
    fs.writeFileSync(file, "released", { encoding: "utf8", flag: "w" });
  }
}

// ── setup: scratch origin + git wrapper + direct-mode workflow ──────

fs.mkdirSync(work, { recursive: true });
git(["init", "-b", "main"], work);
git(["config", "user.email", "w4.11@tamandua.local"], work);
git(["config", "user.name", "W4.11 SIGKILL Launch Matrix"], work);
fs.writeFileSync(path.join(work, "value.txt"), "old\n");
fs.writeFileSync(path.join(work, ".gitignore"), ".env\nnode_modules/\n*.key\n*.pem\n");
git(["add", "."], work);
git(["commit", "-q", "-m", "baseline"], work);

fs.mkdirSync(wrapperDir, { recursive: true });
fs.writeFileSync(wrapperGit, `#!/usr/bin/env bash
set -u
real_git="\${GIT_HOLD_REAL_GIT:?}"
# Hold point PRE — direct-mode original-branch capture (before the run INSERT).
case "$*" in
  *"--abbrev-ref"*)
    if [ -n "\${GIT_HOLD_MARKER_PRE:-}" ]; then
      : > "$GIT_HOLD_MARKER_PRE"
      while [ ! -f "\${GIT_HOLD_RELEASE_PRE:-}" ]; do sleep 0.02; done
    fi
    ;;
esac
# Hold point A — the managed worktree-add call (during git worktree add).
# NOTE: worktree-manager's runGit invokes git with a "-C <origin>" prefix, so
# the hold must match anywhere in the args, not just the first two.
case "$*" in
  *"worktree add"*)
    if [ -n "\${GIT_HOLD_MARKER_A:-}" ]; then
      : > "$GIT_HOLD_MARKER_A"
      while [ ! -f "\${GIT_HOLD_RELEASE_A:-}" ]; do sleep 0.02; done
    fi
    ;;
esac
# Hold point B — the tested-tree rev-parse after the worktree exists
# (before registration).
case "$*" in
  *"^{tree}"*)
    if [ -n "\${GIT_HOLD_MARKER_B:-}" ]; then
      : > "$GIT_HOLD_MARKER_B"
      while [ ! -f "\${GIT_HOLD_RELEASE_B:-}" ]; do sleep 0.02; done
    fi
    ;;
esac
exec "$real_git" "$@"
`, { encoding: "utf8", mode: 0o755 });

// The before-INSERT arm needs a DIRECT-mode workflow launch (worktree-mode
// launches touch git only after the INSERT). Install the bundled do-now into
// the contained state so `workflow run do-now` can be held at its
// pre-INSERT `git rev-parse --abbrev-ref HEAD` call. Idempotent reinstall.
{
  const install = runSync(cli, ["workflow", "install", "do-now"], { timeoutMs: 120_000 });
  assert.equal(install.status, 0, `workflow install do-now failed:\n${install.stdout}\n${install.stderr}`);
}

// Spawned CLI children must never leak on failure — the harness kills only the
// scenario command's own group, and these launches are detached group leaders.
// The arm-E auto-started daemon (daemon-control-unprovenanced) is stopped via
// the CLI as a safety net so a failed scenario cannot leak a contained daemon.
let autoStartedDaemonUp = false;
function stopAutoStartedDaemon() {
  if (!autoStartedDaemonUp) return;
  autoStartedDaemonUp = false;
  for (const args of [["daemon", "stop"], ["dashboard", "stop"], ["mcp", "stop"]]) {
    runSync(cli, args, { timeoutMs: 60_000 });
  }
}
process.on("exit", () => {
  for (const state of liveChildren) {
    try { process.kill(-state.pgid, "SIGKILL"); } catch { /* gone */ }
  }
  stopAutoStartedDaemon();
  clearOrphanedStartLock();
});
process.on("uncaughtException", (error) => {
  for (const state of liveChildren) {
    try { process.kill(-state.pgid, "SIGKILL"); } catch { /* gone */ }
  }
  stopAutoStartedDaemon();
  clearOrphanedStartLock();
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});

const observations = {};
const arms = {};
function armsPassed() {
  return Object.values(arms).every((arm) => arm.passed === true);
}

// ── arm A: SIGKILL before the run INSERT ────────────────────────────

{
  const holds = makeHolds({ holdPre: true });
  const child = spawn(cli, ["workflow", "run", "do-now", "W4.11 SIGKILL pre-INSERT arm"], {
    cwd: work,
    env: holds.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    shell: false,
  });
  const state = { child, pgid: child.pid, ...holds, stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { state.stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { state.stderr += chunk.toString(); });
  liveChildren.push(state);

  // The launch is held at its FIRST git call BEFORE the run INSERT: the do-now
  // (direct-mode) original-branch rev-parse is the first git the launch makes.
  await waitForMarker(state.markerPre, 30_000, "pre-INSERT hold marker");
  const rowsBefore = openDb();
  const beforeCount = rowsBefore.prepare("SELECT COUNT(*) AS c FROM runs").get().c;
  const wtBefore = rowsBefore.prepare("SELECT COUNT(*) AS c FROM run_worktrees").get().c;
  rowsBefore.close();

  const killed = await killGroup(state, "SIGKILL");
  assert.equal(killed.signalCode, "SIGKILL", "arm A: launch must die by SIGKILL");
  // DC9: the run id did not exist yet — the launch must NOT have claimed one.
  assert.ok(!state.stderr.includes("created; preparing workspace"),
    `arm A: stderr must not claim a run id before the INSERT:\n${state.stderr}`);
  const rowsAfter = openDb();
  const afterCount = rowsAfter.prepare("SELECT COUNT(*) AS c FROM runs").get().c;
  const wtAfter = rowsAfter.prepare("SELECT COUNT(*) AS c FROM run_worktrees").get().c;
  rowsAfter.close();
  assert.equal(afterCount, beforeCount, "arm A: SIGKILL before INSERT must create NO run row");
  assert.equal(wtAfter, wtBefore, "arm A: SIGKILL before INSERT must create NO worktree row");
  releaseHolds(state);
  arms.a_sigkill_before_insert = { passed: true, signal: "SIGKILL", run_row_created: false, dc9: "no id claimed" };
  observations.a = { signal: killed.signalCode, run_row_created: false, stderr_claimed_id: state.stderr.includes("created; preparing workspace") };
}

// ── arm B: SIGKILL during git worktree add ──────────────────────────

{
  const launch = launchWorkflowRun({ holdA: true });
  await waitForMarker(launch.markerA, 60_000, "worktree-add hold marker");
  await waitForStderrContains(launch, "created; preparing workspace", 10_000, "run-id claim");
  // The INSERT happened and the id was claimed on stderr (DC9) BEFORE the
  // blocking worktree-add.
  const preDb = openDb();
  const match = launch.stderr.match(/run #(\d+)/);
  assert.ok(match, `arm B: stderr must carry the run id (DC9):\n${launch.stderr}`);
  const runId = runIdByNumber(preDb, Number(match[1]));
  assert.ok(runId, `arm B: run row must exist for run #${match[1]}`);
  const row = runRow(preDb, runId);
  const wtRow = preDb.prepare("SELECT * FROM run_worktrees WHERE run_id = ?").get(runId);
  preDb.close();
  assert.equal(row.status, "running", "arm B: run row must be running");
  assert.equal(row.scheduling_status, "pending_register", "arm B: run must not be registered yet");
  assert.equal(wtRow.status, "creating", "arm B: worktree row must still be 'creating' (git worktree add held)");

  const killed = await killGroup(launch, "SIGKILL");
  assert.equal(killed.signalCode, "SIGKILL", "arm B: launch must die by SIGKILL");
  // The held `git worktree add` never ran real git: the origin lists ONLY its
  // main worktree (the held add's linked worktree never materialized) —
  // prunable-or-absent → absent.
  const list = git(["worktree", "list", "--porcelain"], work);
  const worktreeEntries = (list.stdout.match(/^worktree /gm) ?? []).length;
  assert.equal(worktreeEntries, 1,
    `arm B: origin must list only the main worktree (held add never ran real git):\n${list.stdout}`);
  // Every orphan shape recovered: the run row stays queryable (the reconciler
  // owns it), no zombie processes remain (killGroup asserted group death).
  const postDb = openDb();
  const postRow = runRow(postDb, runId);
  postDb.close();
  assert.ok(postRow, "arm B: run row must survive the SIGKILL (no phantom loss)");
  releaseHolds(launch);
  cliDeleteRun(runId);
  deleteRunRows(runId);
  arms.b_sigkill_during_worktree_add = { passed: true, signal: "SIGKILL", run_row_kept: true, worktree_absent: true, dc9: "id claimed before worktree add" };
  observations.b = { signal: killed.signalCode, run_id: runId, worktree_absent: true };
}

// ── arm C: SIGKILL before registration (after worktree creation) ────

{
  const launch = launchWorkflowRun({ holdB: true });
  await waitForMarker(launch.markerB, 60_000, "tested-tree hold marker");
  await waitForStderrContains(launch, "created; preparing workspace", 10_000, "run-id claim");
  const preDb = openDb();
  const match = launch.stderr.match(/run #(\d+)/);
  assert.ok(match, `arm C: stderr must carry the run id (DC9):\n${launch.stderr}`);
  const runId = runIdByNumber(preDb, Number(match[1]));
  assert.ok(runId, `arm C: run row must exist for run #${match[1]}`);
  const row = runRow(preDb, runId);
  const wtRow = preDb.prepare("SELECT * FROM run_worktrees WHERE run_id = ?").get(runId);
  const steps = preDb.prepare("SELECT COUNT(*) AS c FROM steps WHERE run_id = ?").get(runId).c;
  preDb.close();
  assert.equal(row.scheduling_status, "pending_register", "arm C: run must not be registered yet");
  assert.equal(wtRow.status, "ready", "arm C: worktree row must be 'ready' (worktree add completed)");
  assert.equal(steps, 0, "arm C: steps must not be inserted yet (registration is later in the launch)");

  const killed = await killGroup(launch, "SIGKILL");
  assert.equal(killed.signalCode, "SIGKILL", "arm C: launch must die by SIGKILL");
  // The worktree EXISTS and is prunable: `git worktree remove --force` on the
  // recorded path succeeds (the "worktree prunable or absent" leg).
  const wtPath = openDb()
    .prepare("SELECT worktree_path FROM run_worktrees WHERE run_id = ?").get(runId).worktree_path;
  assert.ok(fs.existsSync(wtPath), `arm C: worktree dir must exist: ${wtPath}`);
  const removed = runSync(realGit, ["worktree", "remove", "--force", wtPath], { cwd: work });
  assert.equal(removed.status, 0, `arm C: worktree must be prunable (git worktree remove --force):\n${removed.stdout}\n${removed.stderr}`);
  const postDb = openDb();
  assert.ok(runRow(postDb, runId), "arm C: run row must survive the SIGKILL");
  postDb.close();
  releaseHolds(launch);
  cliDeleteRun(runId);
  deleteRunRows(runId);
  arms.c_sigkill_before_registration = { passed: true, signal: "SIGKILL", worktree_prunable: true, dc9: "id claimed" };
  observations.c = { signal: killed.signalCode, run_id: runId, worktree_prunable: true };
}

// ── arm D: Ctrl-C pre-registration — run continues detached ─────────

{
  const launch = launchWorkflowRun({ holdA: true });
  await waitForMarker(launch.markerA, 60_000, "worktree-add hold marker");
  await waitForStderrContains(launch, "created; preparing workspace", 10_000, "run-id claim");
  const preDb = openDb();
  const match = launch.stderr.match(/run #(\d+)/);
  assert.ok(match, `arm D: stderr must carry the run id (DC9):\n${launch.stderr}`);
  const runId = runIdByNumber(preDb, Number(match[1]));
  assert.ok(runId, "arm D: run row must exist");
  preDb.close();

  // SIGINT to the WHOLE launch process group (CLI + the held git child — a
  // real Ctrl-C also hits just-spawned children).
  const killed = await killGroup(launch, "SIGINT");
  assert.equal(killed.signalCode, "SIGINT", "arm D: launch must die by SIGINT (no handler in source)");
  const postDb = openDb();
  const row = runRow(postDb, runId);
  postDb.close();
  assert.ok(row, "arm D: run row must survive the Ctrl-C");
  assert.equal(row.status, "running", "arm D: run must not be canceled/failed by the waiter death");
  // Release the held worktree-add so nothing wedges; the reconciler then owns
  // the run.
  releaseHolds(launch);
  // Never a half-registered orphan: the daemon reconciler takes ownership
  // within one tick (30s) — the run leaves pending_register (admission error
  // for the worktree-less launch, or admission/queueing) instead of being a
  // state no machinery reaches.
  const deadline = Date.now() + 45_000;
  let admitted = null;
  while (Date.now() < deadline) {
    const probe = openDb();
    const current = runRow(probe, runId);
    probe.close();
    if (current && current.scheduling_status !== "pending_register") {
      admitted = current.scheduling_status;
      break;
    }
    await delay(1000);
  }
  assert.ok(admitted !== null,
    "arm D: reconciler must take ownership of the Ctrl-C'd run within one tick (never a half-registered orphan)");
  cliDeleteRun(runId);
  deleteRunRows(runId);
  arms.d_sigint_pre_registration = { passed: true, signal: "SIGINT", reconciler_ownership: admitted, dc9: "id claimed" };
  observations.d = { signal: killed.signalCode, run_id: runId, reconciler_scheduling_status: admitted };
}

// ── arm E: Ctrl-C during daemon auto-start — daemon survives (full detach) ──

{
  // Stop the scripted daemon so the launch auto-starts it.
  const stopped = runDaemonControl(["scripted", "stop"], { timeoutMs: 120_000 });
  assert.equal(stopped.status, 0, `daemon-control scripted stop failed:\n${stopped.stdout}\n${stopped.stderr}`);

  const launch = launchWorkflowRun({});
  // The launch INSERTs, builds the worktree, inserts steps, then
  // ensureDaemonControlAvailable auto-starts the (stopped) daemon. Wait for
  // the daemon's pidfile to appear — the daemon is mid-start when we SIGINT.
  const daemonPidFile = path.join(stateDir, "tamandua.pid");
  fs.rmSync(daemonPidFile, { force: true });
  await waitForFile(daemonPidFile, 60_000, "auto-started daemon pidfile");
  const killed = await killGroup(launch, "SIGINT");
  assert.equal(killed.signalCode, "SIGINT", "arm E: launch must die by SIGINT");
  // The SIGINT hit the launch CLI mid-startDaemon: its O_EXCL daemon-start.lock
  // is left orphaned (the finally-released lock never ran). Clear it so the
  // NEXT cell's daemon bootstrap cannot wedge on it (the W4.12 campaign
  // failure). The auto-started daemon below already wrote its pidfile.
  clearOrphanedStartLock();

  // The auto-starting daemon is spawned DETACHED — the group SIGINT must not
  // touch it: it survives and its control plane (5339) comes up.
  const ctrlDeadline = Date.now() + 30_000;
  let controlUp = false;
  while (Date.now() < ctrlDeadline) {
    if (await portListening(5339)) { controlUp = true; break; }
    await delay(500);
  }
  assert.equal(controlUp, true, "arm E: the auto-started daemon must survive the group SIGINT (full detach)");
  // The run continues detached: the daemon's reconciler admits the run and
  // dispatch starts (a step is claimed by a scripted agent).
  const preDb = openDb();
  const match = launch.stderr.match(/run #(\d+)/);
  assert.ok(match, `arm E: stderr must carry the run id (DC9):\n${launch.stderr}`);
  const runId = runIdByNumber(preDb, Number(match[1]));
  preDb.close();
  assert.ok(runId, "arm E: run row must exist");
  const claimDeadline = Date.now() + 90_000;
  let claimed = false;
  while (Date.now() < claimDeadline) {
    const probe = openDb();
    const steps = stepRows(probe, runId);
    probe.close();
    if (steps.some((step) => step.status === "running" || step.status === "done")) { claimed = true; break; }
    await delay(1000);
  }
  assert.equal(claimed, true, "arm E: the run must continue detached — a step must be claimed by the auto-started daemon");
  cliDeleteRun(runId);
  deleteRunRows(runId);

  // The auto-started (daemon-control-unprovenanced) daemon STAYS UP for arm F
  // (arm F's launch registers with it deterministically; stopping it here and
  // letting arm F re-auto-start races the dying daemon's control plane). It is
  // stopped via the CLI at the scenario end (and by the exit-handler safety
  // net on failure) so the harness teardown finds the contained ports free.
  autoStartedDaemonUp = true;
  arms.e_sigint_during_daemon_autostart = { passed: true, signal: "SIGINT", daemon_survived: true, run_continued: true };
  observations.e = { signal: killed.signalCode, run_id: runId, daemon_survived: true, step_claimed: true };
}

// ── arm F: Ctrl-C during --wait — interrupted, run continues ────────

{
  const launch = launchWorkflowRun({ wait: true });
  await waitForStderrContains(launch, "created; preparing workspace", 15_000, "run-id claim");
  const preDb = openDb();
  const match = launch.stderr.match(/run #(\d+)/);
  assert.ok(match, `arm F: stderr must carry the run id (DC9):\n${launch.stderr}`);
  const runId = runIdByNumber(preDb, Number(match[1]));
  preDb.close();
  assert.ok(runId, "arm F: run row must exist");
  // Wait until the run is live and dispatching — a step is claimed by the
  // scripted agent (the waiter is inside handleWait). Scripted steps complete
  // in ~300ms, so accept 'running' OR 'done' (the 'running' window is
  // transient and can fall between polls).
  const liveDeadline = Date.now() + 90_000;
  while (Date.now() < liveDeadline) {
    const probe = openDb();
    const row = runRow(probe, runId);
    const steps = stepRows(probe, runId);
    probe.close();
    if (row && row.status === "running" && steps.some((step) => step.status === "running" || step.status === "done")) break;
    await delay(250);
  }
  const liveProbe = openDb();
  const liveRow = runRow(liveProbe, runId);
  const liveSteps = stepRows(liveProbe, runId);
  liveProbe.close();
  assert.ok(liveRow && liveRow.status === "running" && liveSteps.some((step) => step.status === "running" || step.status === "done"),
    "arm F: run must be live and dispatching before the waiter SIGINT");

  const killed = await killGroup(launch, "SIGINT");
  // The waiter's exit code distinguishes "interrupted, run continues" from
  // failure: 128+SIGINT with no handler in source (signalCode SIGINT, exit
  // code null).
  assert.equal(killed.signalCode, "SIGINT", "arm F: waiter must die by SIGINT");
  assert.equal(killed.exitCode, null, "arm F: waiter killed by signal (no handler in source)");

  // The run continues detached: still alive shortly after (never canceled by
  // the waiter's death), with step progress observed (the daemon owns
  // dispatch, not the waiter).
  await delay(2000);
  const postProbe = openDb();
  const postRow = runRow(postProbe, runId);
  postProbe.close();
  assert.ok(postRow, "arm F: run row must survive the waiter SIGINT");
  assert.notEqual(postRow.status, "canceled",
    "arm F: the run must continue detached after the waiter SIGINT (never canceled by the waiter death)");
  const progressDeadline = Date.now() + 30_000;
  let progressed = false;
  while (Date.now() < progressDeadline) {
    const probe = openDb();
    const steps = stepRows(probe, runId);
    const row = runRow(probe, runId);
    probe.close();
    if (row && row.status !== "running") { progressed = true; break; }
    if (steps.some((step) => step.status === "done")) { progressed = true; break; }
    await delay(250);
  }
  assert.equal(progressed, true, "arm F: run must keep progressing after the waiter SIGINT (continue detached)");
  cliDeleteRun(runId);
  deleteRunRows(runId);
  arms.f_sigint_during_wait = { passed: true, signal: "SIGINT", waiter_exit_signal: "SIGINT", run_continued: true };
  observations.f = { signal: killed.signalCode, run_id: runId, waiter_exit_code: killed.exitCode, run_continued: true };
}

// ── scenario-end daemon cleanup ─────────────────────────────────────
// The arm-E auto-started daemon was left up for arm F; stop it via the CLI now
// (it is daemon-control-unprovenanced) so the harness teardown finds the
// contained ports free.
stopAutoStartedDaemon();

// ── token + ledger hygiene ──────────────────────────────────────────

const db = openDb();
let runTokens = 0;
let systemTokens = 0;
try {
  runTokens = db.prepare("SELECT COALESCE(SUM(tokens_spent), 0) AS total FROM runs").get().total;
  systemTokens = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get().system_tokens_spent;
} finally {
  db.close();
}
assert.equal(runTokens, 0, "W4.11 observed nonzero run tokens");
assert.equal(systemTokens, 0, "W4.11 system token tripwire moved");

assert.ok(armsPassed(), `W4.11 corridor incomplete: ${JSON.stringify(arms, null, 2)}`);

process.stdout.write(`${JSON.stringify({
  scenario: scenarioId,
  result: "PASS",
  arms: Object.fromEntries(Object.entries(arms).map(([key, value]) => [key, value])),
  observations,
  tokens_spent: runTokens,
  system_tokens_spent: systemTokens,
})}\n`);
