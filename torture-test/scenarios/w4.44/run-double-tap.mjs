#!/usr/bin/env node
// W4.44(a) idempotency — operator double-tap: the SAME `workflow run` command
// fired twice within 1s.
//
// The product contract (pinned, per spec 08 §J W4.44): the double-tap yields
// TWO DISTINCT RUNS BY DESIGN in worktree mode (each run gets its OWN managed
// worktree — never both-runs-one-worktree, the S1). The direct-mode
// one-refusal contract of the double-tap is the SAME shared-workdir admission
// gate pinned by W4.42 (the cell references it; it is not re-pinned here).
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
if (!scenarioArg) throw new Error("usage: run-double-tap.mjs <scenario-directory>");
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
const fixture = path.join(invocationDir, "fixture");

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? invocationDir,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 180_000,
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

// ── fixture ───────────────────────────────────────────────────────────
fs.mkdirSync(fixture, { recursive: true });
git(["init", "-b", "main"], fixture);
git(["config", "user.email", "w4.44@tamandua.local"], fixture);
git(["config", "user.name", "W4.44 Double Tap"], fixture);
fs.writeFileSync(path.join(fixture, "package.json"),
  `${JSON.stringify({ name: "w4-44-fixture", version: "1.0.0", scripts: { test: "node -e 'process.exit(0)'" } })}\n`);
fs.writeFileSync(path.join(fixture, "value.txt"), "old\n");
fs.writeFileSync(path.join(fixture, ".gitignore"), ".env\nnode_modules/\n*.key\n*.pem\n");
git(["add", "."], fixture);
git(["commit", "-q", "-m", "baseline"], fixture);

const taskText = "W4.44: fix the seeded defect (operator double-tap corridor).";

// ── the worktree-mode double-tap → two DISTINCT runs, own worktrees ──
const launchA1 = spawn(cli, [
  "workflow", "run", workflowId, taskText,
  "--worktree-origin-repository", fixture, "--worktree-origin-ref", "main",
  "--wait", "--timeout", "5m", "--json",
], { cwd: invocationDir, env: process.env });
let a1Text = "";
launchA1.stdout.on("data", (d) => { a1Text += String(d); });
launchA1.stderr.on("data", (d) => { a1Text += String(d); });

// Second tap ~300ms later (well within the 1s double-tap window).
await new Promise((r) => setTimeout(r, 300));
const launchA2 = spawn(cli, [
  "workflow", "run", workflowId, taskText,
  "--worktree-origin-repository", fixture, "--worktree-origin-ref", "main",
  "--wait", "--timeout", "5m", "--json",
], { cwd: invocationDir, env: process.env });
let a2Text = "";
launchA2.stdout.on("data", (d) => { a2Text += String(d); });
launchA2.stderr.on("data", (d) => { a2Text += String(d); });

await Promise.all([new Promise((resolve) => launchA1.on("close", resolve)), new Promise((resolve) => launchA2.on("close", resolve))]);
const runIdOf = (text) => {
  const m = text.match(/^Run:\s+run-([0-9a-f-]+)$/m);
  return m ? m[1] : null;
};
const a1Id = runIdOf(a1Text);
const a2Id = runIdOf(a2Text);
assert.ok(a1Id, `tap-1 must publish a run id:\n${a1Text}`);
assert.ok(a2Id, `tap-2 must publish a run id:\n${a2Text}`);
assert.notEqual(a1Id, a2Id, "the double-tap must produce TWO DISTINCT runs (never one run for two taps)");
// The wait exit code reflects the run's terminal status; the authoritative
// assertion is the DB terminal state below (the w4.35 pattern).

for (const runId of [a1Id, a2Id]) {
  const row = dbRead("SELECT status, tokens_spent FROM runs WHERE id = ?", [runId])[0];
  assert.ok(row, `run ${runId} row must exist`);
  if (row.status !== "completed") {
    const steps = dbRead("SELECT step_id, status, retry_count, output FROM steps WHERE run_id = ?", [runId]);
    console.error(`RUN ${runId} status=${row.status} steps=${JSON.stringify(steps.map((s) => ({ id: s.step_id, status: s.status, retry: s.retry_count, out: String(s.output ?? "").slice(0, 200) })))}`);
  }
  assert.equal(row.status, "completed", `tap run ${runId} must complete (got ${row.status})`);
  assert.equal(row.tokens_spent, 0, `tap run ${runId} must be zero-token`);
}
// Both-runs-one-worktree is the S1: each run must own a DISTINCT worktree.
const worktrees = dbRead("SELECT run_id, worktree_path FROM run_worktrees WHERE run_id IN (?, ?)", [a1Id, a2Id]);
assert.equal(worktrees.length, 2, "each double-tap run must own its own managed worktree");
assert.notEqual(worktrees[0].worktree_path, worktrees[1].worktree_path,
  "the two runs must NEVER share one worktree (both-runs-one-worktree is the S1)");
const worktreesForA1 = dbRead("SELECT COUNT(*) AS c FROM run_worktrees WHERE run_id = ?", [a1Id])[0].c;
const worktreesForA2 = dbRead("SELECT COUNT(*) AS c FROM run_worktrees WHERE run_id = ?", [a2Id])[0].c;
assert.equal(worktreesForA1, 1, "tap-1 owns exactly one worktree");
assert.equal(worktreesForA2, 1, "tap-2 owns exactly one worktree");

for (const runId of [a1Id, a2Id]) deleteRun(runId);

process.stdout.write(`${JSON.stringify({
  scenario_id: metadata.id,
  workflow_id: workflowId,
  worktree_mode: { run1: `run-${a1Id}`, run2: `run-${a2Id}`, contract: "two-distinct-runs-own-worktrees" },
  direct_mode_refusal: "pinned by W4.42 (shared-workdir admission gate)",
  tokens_spent: 0,
  result: "PASS",
})}\n`);
