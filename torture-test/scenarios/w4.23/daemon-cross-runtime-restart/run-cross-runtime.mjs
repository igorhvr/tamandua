#!/usr/bin/env node
/**
 * W4.23 daemon stop under node runtime A, start under runtime B, same DB —
 * zero behavioral drift (DC44) (spec 08 §H W4.23). Zero-token scripted cell.
 *
 * The corridor: the contained scripted daemon is stopped under runtime A and
 * started under runtime B against the SAME DB. Zero behavioral drift (DC44):
 * the schema is byte-identical, the pre-restart run's rows survive
 * byte-identically, the control plane responds identically, and a run under
 * B completes with the same behavior as under A.
 *
 * Host adaptation: the manifest gates `capabilities ["node-runtimes-2"]` —
 * recorded by W0.0 as `capabilities.node-runtimes-2` (>= 2 DISTINCT node
 * runtimes/versions discovered from volta image dirs + nvm version dirs,
 * deduped by version, each with a sqlite probe). The runner re-runs the same
 * discovery, picks runtime A (the current node) and runtime B (a SECOND
 * distinct runtime that loads `node:sqlite` — probed; fails closed with a
 * diagnosable message if none exists), and switches the daemon across them
 * via daemon-control.
 *
 * Runtime-switch mechanism (post-S24/US-006): daemon-control reconstructs
 * the contained launch PATH itself (contained_path_for_kind — var/
 * adapters-bin first, the env-script PATH next, the caller PATH last with
 * operator bin dirs reordered) and spawns via `env -i $(env_for_kind ...)
 * PATH=...`, so a caller-PATH prepend of runtime B's node dir is DROPPED —
 * the restarted daemon would stay on the env script's node. The sanctioned
 * switch is daemon-control's TT_DC_ENV_SCRIPTED env-script seam (the MACP7
 * US-001 test seam daemon-control.test.sh uses): the runner writes a
 * CONTAINED env-script variant under torture-test/var that sources
 * env/tt-env-scripted.sh and pins TT_NODE_BIN/TT_NODE_BIN_DIR + PATH to
 * runtime B, and runs `daemon-control scripted start/status/stop` with
 * TT_DC_ENV_SCRIPTED=<variant> for the runtime-B phase ONLY. The launcher's
 * `exec node` then resolves from the variant's PATH, so the daemon process
 * lands on runtime B's binary (asserted via /proc/<pid>/exe); phase 4
 * restores the default env script (runtime A).
 *
 * Zero tokens: both probe runs execute on the scripted-pi runtime; the
 * ledger must show runs.tokens_spent 0 + system tripwire 0. The runs are
 * deleted after capture (scoped ledger — the W4.11 pattern). The daemon is
 * restored under runtime A before returning (the harness cleanup stops it).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeRuntimeBEnvScript } from "../../lib/runtime-switch-env.mjs";

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
assert.equal(scenarioId, "w4.23-daemon-cross-runtime-restart", "scenario id mismatch");

const cli = path.join(repoRoot, "bin", "tamandua");
const daemonControl = path.join(repoRoot, "torture-test", "bin", "daemon-control");
const dbPath = path.join(stateDir, "tamandua.db");
const pidFile = path.join(stateDir, "tamandua.pid");
const workDir = path.join(invocationDir, "probe-work");
assert.ok(workDir.startsWith(`${invocationDir}${path.sep}`),
  `W4.23 mutable path escaped torture-test/var: ${workDir}`);
fs.mkdirSync(workDir, { recursive: true });

// The scripted-behaviors knobs must be forwarded to daemon-control so the
// restarted daemon keeps the materialized scenario behaviors.
const behaviorsFile = process.env.TAMANDUA_SCRIPTED_BEHAVIORS;
const counterDir = process.env.TAMANDUA_SCRIPTED_STATE;
assert.ok(typeof behaviorsFile === "string" && behaviorsFile.length > 0,
  "TAMANDUA_SCRIPTED_BEHAVIORS must be set (scenario harness)");
assert.ok(typeof counterDir === "string" && counterDir.length > 0,
  "TAMANDUA_SCRIPTED_STATE must be set (scenario harness)");

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
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function dbRead(query, params = []) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(query).all(...params);
  } finally {
    db.close();
  }
}

function dbRunCount() {
  return dbRead("SELECT COUNT(*) AS c FROM runs")[0].c;
}

function schemaSnapshot() {
  return JSON.stringify(dbRead("SELECT name, sql FROM sqlite_master ORDER BY name"));
}

function runSnapshot(runId) {
  const runs = dbRead("SELECT * FROM runs WHERE id = ?", [runId]);
  const steps = dbRead("SELECT step_id, status FROM steps WHERE run_id = ? ORDER BY step_index", [runId]);
  const stories = dbRead("SELECT id, status FROM stories WHERE run_id = ? ORDER BY id", [runId]);
  return JSON.stringify({ runs, steps, stories });
}

// The BEHAVIORAL shape of a run — statuses in step order (ids are unique per
// run, so parity is judged on the shape, never the ids).
function runBehavior(runId) {
  const steps = dbRead("SELECT status FROM steps WHERE run_id = ? ORDER BY step_index", [runId]);
  const stories = dbRead("SELECT status FROM stories WHERE run_id = ? ORDER BY id", [runId]);
  const run = dbRead("SELECT status, workflow_id, tokens_spent FROM runs WHERE id = ?", [runId]);
  return JSON.stringify({ run, steps, stories });
}

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

function runDaemonControl(operation, env) {
  const res = runSync(daemonControl, ["scripted", operation], {
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  assert.equal(res.status, 0,
    `daemon-control scripted ${operation} failed:\n${res.stdout}\n${res.stderr}`);
  return `${res.stdout}\n${res.stderr}`;
}

function daemonUp(env) {
  const res = runSync(daemonControl, ["scripted", "status"], {
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return `${res.stdout}\n${res.stderr}`;
}

function daemonPid() {
  assert.ok(fs.existsSync(pidFile), `daemon pidfile missing: ${pidFile}`);
  const pid = Number(String(fs.readFileSync(pidFile, "utf8")).trim());
  assert.ok(Number.isInteger(pid) && pid > 0, `unparseable daemon pidfile: ${pidFile}`);
  return pid;
}

function processExe(pid) {
  try {
    return fs.realpathSync(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
}

function waitForRunning(env, label) {
  const deadline = Date.now() + 30_000;
  let status = "";
  while (Date.now() < deadline) {
    status = daemonUp(env);
    if (/STATUS: RUNNING/.test(status)) return status;
    // cmd_status reads daemon-control provenance (var/daemon-control/
    // scripted.json), never the state-dir pidfile — do NOT touch the
    // pidfile here: deleting it while the daemon is (re)writing it could
    // race the identity-verified provenance and the daemonPid() read below.
    const sleep = runSync("/bin/sh", ["-c", "sleep 0.2"]);
    assert.equal(sleep.status, 0, "sleep failed");
  }
  throw new Error(`${label}: daemon did not report RUNNING:\n${status}`);
}

function launchDoNow(label) {
  const res = runSync(cli, [
    "workflow", "run", workflowId, label,
    "--working-directory-for-harness", workDir,
    "--wait", "--timeout", "3m", "--json",
  ], { cwd: workDir, timeout: 5 * 60_000 });
  assert.equal(res.status, 0, `${label}: do-now run failed:\n${res.stdout}\n${res.stderr}`);
  const { record, runId } = completedRunId(res.stdout);
  assert.ok(runId.length > 0, `${label}: run id missing:\n${res.stdout}`);
  assert.equal(record.status, "completed", `${label}: do-now must complete: ${res.stdout}`);
  return runId;
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
  const rows = dbRead("SELECT COUNT(*) AS c FROM runs WHERE id = ?", [runId]);
  assert.equal(rows[0].c, 0, `run ${runId} still present after delete`);
}

// ── node runtime discovery (the W0.0 node-runtimes-2 source) ─────────

function discoverNodeRuntimes() {
  const candidates = [];
  const seen = new Set();
  const add = (bin) => {
    if (typeof bin !== "string" || bin.length === 0) return;
    let real;
    try {
      real = fs.realpathSync(bin);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    candidates.push(real);
  };
  add(process.execPath);
  const home = os.homedir();
  const voltaHome = process.env.VOLTA_HOME || path.join(home, ".volta");
  try {
    const imageRoot = path.join(voltaHome, "tools", "image", "node");
    for (const entry of fs.readdirSync(imageRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) add(path.join(imageRoot, entry.name, "bin", "node"));
    }
  } catch { /* no volta image dir */ }
  try {
    const nvmRoot = path.join(home, ".nvm", "versions", "node");
    for (const entry of fs.readdirSync(nvmRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) add(path.join(nvmRoot, entry.name, "bin", "node"));
    }
  } catch { /* no nvm dir */ }
  const runtimes = [];
  const versions = new Set();
  for (const bin of candidates) {
    const probe = runSync(bin, ["-e", "process.stdout.write(process.version)"], { timeout: 15_000 });
    if (probe.status !== 0) continue;
    const version = probe.stdout.trim();
    if (versions.has(version)) continue; // dedupe by version (distinct-runtime semantics)
    versions.add(version);
    const sqliteProbe = runSync(bin,
      ["-e", 'import("node:sqlite").then(() => process.exit(0)).catch(() => process.exit(1))'],
      { timeout: 15_000 });
    runtimes.push({ bin, version, sqlite: sqliteProbe.status === 0 });
  }
  return runtimes;
}

const runtimes = discoverNodeRuntimes();
const currentReal = (() => { try { return fs.realpathSync(process.execPath); } catch { return process.execPath; } })();
const runtimeA = runtimes.find((r) => {
  let real;
  try { real = fs.realpathSync(r.bin); } catch { real = r.bin; }
  return real === currentReal;
}) ?? runtimes[0];
assert.ok(runtimeA, "runtime A (current node) must be discovered");
const runtimeB = runtimes.find((r) => r !== runtimeA && r.sqlite);
assert.ok(runtimeB,
  `W4.23 requires a SECOND distinct node runtime with node:sqlite (found: ${runtimes.map((r) => r.version).join(", ")}) — the host's node-runtimes-2 predicate should have gated this case NOT_RUN`);
assert.notEqual(runtimeB.version, runtimeA.version, "runtime B must be a distinct node version");

const baseDaemonEnv = {
  TAMANDUA_SCRIPTED_BEHAVIORS: behaviorsFile,
  TAMANDUA_SCRIPTED_STATE: counterDir,
};
const defaultPath = process.env.PATH ?? "";
// The caller-PATH leg of the contained launch PATH must keep the repo's bin
// dir reachable so the launch script's `tamandua` resolves (the harness
// daemon_control handoff uses the same PATH="$REPO_ROOT/bin:$PATH" shape);
// node resolution is owned by the env-script leg (see below).
const harnessPath = `${repoRoot}/bin:${defaultPath}`;

// ── daemon-control-sanctioned runtime switch (TT_DC_ENV_SCRIPTED) ─────
// daemon-control reconstructs the contained launch PATH itself
// (contained_path_for_kind, S24/US-006): var/adapters-bin first, the env
// script's PATH next, the caller PATH last — a caller-PATH prepend of
// runtime B's node dir is therefore DROPPED and the restarted daemon lands
// on the env script's node (runtime A). The sanctioned mechanism is the
// TT_DC_ENV_SCRIPTED env-script seam: write a CONTAINED env-script variant
// (under torture-test/var) that sources the bundled scripted env and pins
// TT_NODE_BIN/TT_NODE_BIN_DIR + the printed PATH to runtime B; daemon-control
// scripted start/status/stop for the runtime-B phase only run with
// TT_DC_ENV_SCRIPTED=<variant>. The variant is removed with the invocation
// dir (harness cleanup). The generation lives in
// scenarios/lib/runtime-switch-env.mjs so the regression self-test pins the
// same corridor.
const runtimeBEnvScript = writeRuntimeBEnvScript({
  invocationDir,
  repoRoot,
  runtimeBBin: runtimeB.bin,
});
const defaultDaemonEnv = { ...baseDaemonEnv, PATH: harnessPath };
const runtimeBDaemonEnv = {
  ...baseDaemonEnv,
  PATH: `${path.dirname(runtimeB.bin)}:${harnessPath}`,
  TT_DC_ENV_SCRIPTED: runtimeBEnvScript,
};

// ── phase 1: under runtime A (harness-started daemon) ────────────────

const statusA = daemonUp(defaultDaemonEnv);
assert.match(statusA, /STATUS: RUNNING/, "daemon must be RUNNING under runtime A before the switch");
const pidA = daemonPid();
const exeA = processExe(pidA);
assert.ok(exeA, `cannot resolve daemon node executable under A (pid ${pidA})`);

const run1Id = launchDoNow("W4.23 daemon cross-runtime probe run 1 (runtime A)");
const schemaBefore = schemaSnapshot();
const run1Before = runSnapshot(run1Id);

// ── phase 2: stop under A, start under B — same DB ───────────────────

runDaemonControl("stop", defaultDaemonEnv);
// No state-dir pidfile manipulation here: cmd_stop records the stopped
// provenance (identity-verified) and cmd_start clears a stale pidfile
// itself (T2.1 US-009); deleting the pidfile by hand could race the
// identity-verified provenance.
runDaemonControl("start", runtimeBDaemonEnv);
waitForRunning(runtimeBDaemonEnv, "phase 2 (runtime B)");
const pidB = daemonPid();
const exeB = processExe(pidB);
assert.ok(exeB, `cannot resolve daemon node executable under B (pid ${pidB})`);
const runtimeBReal = fs.realpathSync(runtimeB.bin);
assert.equal(exeB, runtimeBReal,
  `the restarted daemon must run under runtime B's node (${runtimeBReal}), got ${exeB}`);

// ── phase 3: zero behavioral drift (DC44) ────────────────────────────

assert.equal(schemaSnapshot(), schemaBefore,
  "the DB schema (sqlite_master) must be byte-identical across the runtime switch (zero drift)");
assert.equal(runSnapshot(run1Id), run1Before,
  "runtime A's run rows must survive the restart byte-identically (same DB, zero drift)");
const statusB = daemonUp(runtimeBDaemonEnv);
assert.match(statusB, /STATUS: RUNNING/, "the control plane must respond under runtime B");

const run2Id = launchDoNow("W4.23 daemon cross-runtime probe run 2 (runtime B)");
assert.equal(runBehavior(run2Id), runBehavior(run1Id),
  "a run under runtime B must complete with the SAME behavior as under runtime A (zero behavioral drift)");

// ── phase 4: restore under runtime A, scoped cleanup, zero tokens ────

runDaemonControl("stop", runtimeBDaemonEnv);
runDaemonControl("start", defaultDaemonEnv);
waitForRunning(defaultDaemonEnv, "phase 4 (restore runtime A)");

const runTokens = dbRead("SELECT COALESCE(SUM(tokens_spent), 0) AS total FROM runs")[0].total;
const systemTokens = dbRead("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1")[0].system_tokens_spent;
assert.equal(runTokens, 0, "W4.23 observed nonzero run tokens");
assert.equal(systemTokens, 0, "W4.23 system token tripwire moved");

deleteRun(run1Id);
deleteRun(run2Id);

process.stdout.write(`${JSON.stringify({
  scenario: scenarioId,
  result: "PASS",
  runtime_a: { version: runtimeA.version, bin: runtimeA.bin, daemon_exe: exeA },
  runtime_b: { version: runtimeB.version, bin: runtimeB.bin, daemon_exe: exeB },
  same_db: true,
  schema_identical: true,
  run_rows_preserved: true,
  run_behavior_identical: true,
  runs: { run1: run1Id, run2: run2Id },
  tokens_spent: runTokens,
  system_tokens_spent: systemTokens,
})}\n`);
