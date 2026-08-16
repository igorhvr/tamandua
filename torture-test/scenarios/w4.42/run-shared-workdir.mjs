#!/usr/bin/env node
// W4.42 shared-workdir refusal — one scripted bfmw round in DIRECT mode at a
// shared working clone, then a second run pointed at the SAME workdir while
// the first is live. The daemon's admission gate
// (src/server/control-server.ts admitOrQueueRun) refuses the second run with
// the OWNING run named:
//
//   "Run <run2> harness workdir is already scheduled for run <run1>: <path>"
//   (realpath-compared against the daemon's in-memory job metadata; the
//   TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR escape hatch must NOT be set)
//
// Expected (pinned contract): deterministic refusal with the owning run
// named — NEVER two agent teams interleaving commits in one index (the S1).
//
// Zero tokens. Compact single-line JSON on stdout.

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

const [scenarioArg] = process.argv.slice(2);
if (!scenarioArg) throw new Error("usage: run-shared-workdir.mjs <scenario-directory>");
const scenarioDir = fs.realpathSync(scenarioArg);
const metadata = JSON.parse(fs.readFileSync(path.join(scenarioDir, "scenario.json"), "utf8"));

const repoRoot = requiredPath("TT_REPO_ROOT");
const invocationDir = requiredPath("TT_SCENARIO_STATE_DIR");
const scenarioId = requiredValue("TT_SCENARIO_ID");
const stateDir = requiredPath("TAMANDUA_STATE_DIR");
const workflowId = requiredValue("TT_SCENARIO_WORKFLOW_ID");
assert.equal(process.env.TT_SCENARIO_COMMAND_GROUP_PROVEN, "1",
  "scenario must run in the harness-proven process group");
assert.equal(scenarioId, metadata.id, "scenario id mismatch");

const cli = path.join(repoRoot, "bin", "tamandua");
const dbPath = path.join(stateDir, "tamandua.db");
const workdir = path.join(invocationDir, "work");
const preRunCount = dbReadCount();

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

function dbReadCount() {
  return Number(dbRead("SELECT COUNT(*) AS c FROM runs")[0].c);
}

function git(args, cwd) {
  const result = runSync("git", args, { cwd });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
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
}

// ── the shared working clone (both runs point here, DIRECT mode) ─────
fs.mkdirSync(workdir, { recursive: true });
git(["init", "-b", "main"], workdir);
git(["config", "user.email", "w4.42@tamandua.local"], workdir);
git(["config", "user.name", "W4.42 Shared Workdir"], workdir);
fs.writeFileSync(path.join(workdir, "package.json"),
  `${JSON.stringify({ name: "w4-42-fixture", version: "1.0.0", scripts: { test: "node -e 'process.exit(0)'" } })}\n`);
fs.writeFileSync(path.join(workdir, "value.txt"), "old\n");
fs.writeFileSync(path.join(workdir, ".gitignore"), ".env\nnode_modules/\n*.key\n*.pem\n");
git(["add", "."], workdir);
git(["commit", "-q", "-m", "baseline"], workdir);

const taskText = "W4.42: hold the shared working clone (direct mode) for the refusal window.";

// ── run-1: launch WITHOUT --wait so run-2 can be fired while it is live ──
const launch1 = spawn(cli, [
  "workflow", "run", workflowId, taskText,
  "--working-directory-for-harness", workdir,
  "--context", "test_cmd=npm test",
  "--json",
], { cwd: invocationDir, env: process.env });
let launch1Text = "";
launch1.stdout.on("data", (d) => { launch1Text += String(d); });
launch1.stderr.on("data", (d) => { launch1Text += String(d); });

const run1Match = await new Promise((resolve) => {
  const timer = setInterval(() => {
    const m = launch1Text.match(/^Run:\s+run-([0-9a-f-]+)$/m);
    if (m) { clearInterval(timer); resolve(m); }
  }, 100);
  setTimeout(() => { clearInterval(timer); resolve(null); }, 30_000);
});
assert.ok(run1Match, `run-1 launch did not publish a run id:\n${launch1Text}\nlaunch status: ${launch1.exitCode}`);
const run1Id = run1Match[1];

// Wait until run-1 is ADMITTED and its first dispatch job exists (the
// workdir is in the daemon's job metadata — the refusal source for run-2).
let run1Admitted = false;
for (let i = 0; i < 200; i++) {
  const row = dbRead("SELECT scheduling_status FROM runs WHERE id = ?", [run1Id]);
  const claimed = dbRead(
    "SELECT COUNT(*) AS c FROM steps WHERE run_id = ? AND status IN ('running','done','failed')", [run1Id],
  );
  if (row.length > 0 && row[0].scheduling_status === "active" && claimed[0].c > 0) {
    run1Admitted = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
assert.ok(run1Admitted, `run-1 was not admitted with a live dispatch job:\n${launch1Text}`);

// ── run-2: same workdir, DIRECT mode, while run-1 is live ────────────
const launch2 = runSync(cli, [
  "workflow", "run", workflowId, taskText,
  "--working-directory-for-harness", workdir,
  "--context", "test_cmd=npm test",
  "--wait", "--timeout", "5m", "--json",
], { timeout: 180_000, cwd: invocationDir, allowFailure: true });
const launch2Text = `${launch2.stdout}\n${launch2.stderr}`;
// The refusal surfaces as a registration failure — the CLI throws
// "Failed to register run with daemon: Run <run2> harness workdir is already
// scheduled for run <run1>: <workdir>" and the run2 id is NOT printed as a
// "Run: run-..." line; resolve run-2 from the ledger (the newest run row that
// is not run-1) and assert the refusal text names the owner.
let run2Id = null;
const run2Candidates = dbRead("SELECT id FROM runs WHERE id != ? ORDER BY created_at DESC LIMIT 1", [run1Id]);
if (run2Candidates.length > 0) run2Id = run2Candidates[0].id;
assert.ok(run2Id, `run-2 must have created a run row (the refusal names the owner)\n${launch2Text}`);

// Wait for run-1 to reach terminal (the full scripted bfmw).
await new Promise((r) => setTimeout(r, 500));
for (let i = 0; i < 300; i++) {
  const row = dbRead("SELECT status FROM runs WHERE id = ?", [run1Id]);
  if (row.length > 0 && ["completed", "failed", "canceled"].includes(row[0].status)) break;
  await new Promise((r) => setTimeout(r, 500));
}
const run1 = dbRead("SELECT status, tokens_spent FROM runs WHERE id = ?", [run1Id])[0];
assert.ok(run1, "run-1 row must exist");
assert.equal(run1.tokens_spent, 0, "run-1 must be zero-token");
assert.equal(run1.status, "completed", `run-1 must complete cleanly (got ${run1.status})`);

// The refusal contract: run-2 is REFUSED with the owning run named.
const run2 = dbRead("SELECT status, scheduling_status, scheduling_error, context FROM runs WHERE id = ?", [run2Id])[0];
assert.ok(run2, "run-2 row must exist");
const refusalText = `${run2.scheduling_error ?? ""} ${launch2Text}`;
assert.match(refusalText, /harness workdir is already scheduled for run/,
  `run-2 must be refused with the shared-workdir diagnostic\n${launch2Text}`);
assert.match(refusalText, new RegExp(run1Id),
  `the refusal must name the OWNING run (${run1Id})\n${launch2Text}`);
assert.equal(run2.status, "failed", "run-2 must be terminal failed (deterministic refusal)");

// No interleaving: the shared clone's index was never touched by a second
// agent team (run-2 was refused before any dispatch). The workdir stays at
// the baseline commit with a clean status.
const logCount = Number(runSync("git", ["rev-list", "--count", "HEAD"], { cwd: workdir }).stdout.trim());
assert.equal(logCount, 1, "no second agent team may have committed in the shared clone");
const status = runSync("git", ["status", "--porcelain"], { cwd: workdir }).stdout.trim();
assert.equal(status, "", "the shared clone's working tree must be untouched (no interleaved edits)");

// ── cleanup: delete both runs (scoped ledger) ────────────────────────
for (const runId of [run1Id, run2Id]) {
  if (runId) deleteRun(runId);
}

process.stdout.write(`${JSON.stringify({
  scenario_id: metadata.id,
  workflow_id: workflowId,
  run1_id: `run-${run1Id}`,
  run2_id: `run-${run2Id}`,
  run1_status: run1.status,
  run2_status: run2.status,
  refusal_named_owner: true,
  runs_before: preRunCount,
  tokens_spent: run1.tokens_spent,
  result: "PASS",
})}\n`);
