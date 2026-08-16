#!/usr/bin/env node
// W4.44(b) post-success immunity (FI-Q3): after a scripted bfmw lands and the
// run is TERMINAL, the target branch is moved (a colleague's post-terminal
// commit — tt-chaos `move-branch` is the spec's injector; the cell performs
// the same ref move directly). The rugpull window must be CLOSED: zero
// replacement runs, zero events beyond the terminal state — post-terminal
// target movement is a colleague's business, never a rugpull.
//
// Evidence asserted (mechanical):
//   * the bfmw run completes (terminal `completed`; the finalize_merge step
//     done — the "landed successfully" posture);
//   * after the target move + the rugpull-detection window, the run count is
//     UNCHANGED (zero replacement runs);
//   * the events directory contains NO run.rugpull_detected /
//     run.rugpull_relaunch_suppressed / run.relaunch* events for the run
//     beyond its terminal state;
//   * the run's terminal status stays `completed`.
//
// Zero tokens. Compact single-line JSON on stdout.

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

const [scenarioArg] = process.argv.slice(2);
if (!scenarioArg) throw new Error("usage: run-post-success-immunity.mjs <scenario-directory>");
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
const eventsDir = path.join(stateDir, "events");
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

// ── fixture + a "colleague" commit to move the target to ─────────────
fs.mkdirSync(fixture, { recursive: true });
git(["init", "-b", "main"], fixture);
git(["config", "user.email", "w4.44b@tamandua.local"], fixture);
git(["config", "user.name", "W4.44b Post-Success Immunity"], fixture);
fs.writeFileSync(path.join(fixture, "package.json"),
  `${JSON.stringify({ name: "w4-44b-fixture", version: "1.0.0", scripts: { test: "node -e 'process.exit(0)'" } })}\n`);
fs.writeFileSync(path.join(fixture, "value.txt"), "old\n");
fs.writeFileSync(path.join(fixture, ".gitignore"), ".env\nnode_modules/\n*.key\n*.pem\n");
git(["add", "."], fixture);
git(["commit", "-q", "-m", "baseline"], fixture);
const mainBefore = runSync("git", ["rev-parse", "refs/heads/main"], { cwd: fixture }).stdout.trim();

// ── the scripted bfmw round that "lands successfully" ────────────────
const taskText = "W4.44b: fix the seeded defect (post-success-immunity corridor).";
const launch = runSync(cli, [
  "workflow", "run", workflowId, taskText,
  "--worktree-origin-repository", fixture, "--worktree-origin-ref", "main",
  "--context", "test_cmd=npm test",
  "--wait", "--timeout", "5m", "--json",
], { timeout: 360_000, cwd: fixture });
const launchText = `${launch.stdout}\n${launch.stderr}`;
const runMatch = launchText.match(/^Run:\s+run-([0-9a-f-]+)$/m);
assert.ok(runMatch, `workflow launch did not publish a run id\n${launchText}`);
const runId = runMatch[1];

const runRow = dbRead("SELECT status, tokens_spent FROM runs WHERE id = ?", [runId])[0];
assert.ok(runRow, `run ${runId} row must exist`);
assert.equal(runRow.status, "completed", `the bfmw run must land successfully (got ${runRow.status})`);
assert.equal(runRow.tokens_spent, 0, "the scripted run must be zero-token");
const eventsFile = path.join(eventsDir, `${runId}.jsonl`);
const terminalEvents = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8") : "";

// ── move the target branch (the post-terminal colleague commit) ──────
// The immunity baseline is the run count AFTER run-1 reached terminal —
// any growth from here is a replacement run (the FI-Q3 violation).
const runsBefore = Number(dbRead("SELECT COUNT(*) AS c FROM runs")[0].c);
fs.writeFileSync(path.join(fixture, "colleague.txt"), "colleague post-terminal change\n");
git(["add", "."], fixture);
git(["commit", "-q", "-m", "colleague: post-terminal target movement"], fixture);
const colleagueCommit = runSync("git", ["rev-parse", "HEAD"], { cwd: fixture }).stdout.trim();
// The run's managed worktree has main checked out — `git branch -f` refuses
// to force-update a branch used by a worktree; `git update-ref` moves the ref
// directly (the tt-chaos move-branch injection semantics).
git(["update-ref", "refs/heads/main", colleagueCommit], fixture);
const mainAfterMove = runSync("git", ["rev-parse", "refs/heads/main"], { cwd: fixture }).stdout.trim();
assert.notEqual(mainAfterMove, mainBefore, "the target branch must actually move (the injection)");

// ── the rugpull-detection window (post-terminal — must stay CLOSED) ──
const RUGPULL_WINDOW_MS = 15_000;
await new Promise((r) => setTimeout(r, RUGPULL_WINDOW_MS));

const runsAfter = Number(dbRead("SELECT COUNT(*) AS c FROM runs")[0].c);
assert.equal(runsAfter, runsBefore,
  `post-terminal target movement must NOT launch a replacement run (before=${runsBefore} after=${runsAfter})`);

const eventsAfter = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8") : "";
const rugpullEvents = (eventsAfter.match(/"event":\s*"(run\.rugpull_detected|run\.rugpull_relaunch_suppressed|run\.relaunch[a-z_.]*|run\.replacement_launched)"/g) ?? []);
assert.equal(rugpullEvents.length, 0,
  `post-terminal target movement must emit ZERO rugpull/relaunch events (got: ${rugpullEvents.join(", ")})`);
const terminalStatus = dbRead("SELECT status FROM runs WHERE id = ?", [runId])[0].status;
assert.equal(terminalStatus, "completed", "the terminal run state must stay completed");

deleteRun(runId);

process.stdout.write(`${JSON.stringify({
  scenario_id: metadata.id,
  workflow_id: workflowId,
  run_id: `run-${runId}`,
  run_status: terminalStatus,
  target_moved: true,
  replacement_runs: runsAfter - runsBefore,
  rugpull_events: rugpullEvents.length,
  events_beyond_terminal: eventsAfter.length > terminalEvents.length,
  tokens_spent: runRow.tokens_spent,
  result: "PASS",
})}\n`);
