#!/usr/bin/env node
// W4.43 register-run refusal storm — 10 rapid-fire INVALID launches in <10s
// against the loaded contained scripted daemon, while a live scripted do-now
// run is mid-flight. The refusal path is REAL load (production sees ~2,255
// launch attempts/day).
//
// Expected (pinned contract):
//   * all 10 refuse cleanly with DISTINCT diagnostics (each stderr differs);
//   * ZERO run rows created for the refusals (they fail at arg-parse or
//     workflow-load — before the run INSERT);
//   * zero daemon impact on the concurrent live run (dispatch latency
//     unchanged — measured: the live run's claim→complete interval stays
//     bounded and the run completes);
//   * no refusal leaves a lock/claim behind (a follow-up valid launch works).
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
if (!scenarioArg) throw new Error("usage: run-refusal-storm.mjs <scenario-directory>");
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

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? invocationDir,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 60_000,
    maxBuffer: 16 * 1024 * 1024,
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

function runCount() {
  return Number(dbRead("SELECT COUNT(*) AS c FROM runs")[0].c);
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

// The 10 invalid launches — every one fails at arg-parse or workflow-load,
// BEFORE the run INSERT (zero run rows for refusals).
const INVALID_LAUNCHES = [
  ["unknown-workflow", ["workflow", "run", "nonexistent-workflow", "task"]],
  ["malformed-context", ["workflow", "run", "do-now", "task", "--context", "malformed"]],
  ["missing-task-file", ["workflow", "run", "do-now", "--task-file", "/no/such/file.md"]],
  ["inline-plus-file", ["workflow", "run", "do-now", "task", "--task-file", "/tmp/tamandua-absent.md"]],
  ["conflicting-harness", ["workflow", "run", "do-now", "task", "--pi-as-harness", "--hermes-as-harness"]],
  ["unknown-flag", ["workflow", "run", "do-now", "task", "--no-such-flag"]],
  ["no-task", ["workflow", "run", "do-now"]],
  ["no-args", ["workflow", "run"]],
  ["missing-timeout-value", ["workflow", "run", "do-now", "task", "--wait", "--timeout"]],
  ["empty-context-key", ["workflow", "run", "do-now", "task", "--context", "=x"]],
];

// ── the concurrent live run (scripted do-now, mid-flight during the storm) ──
const liveTask = "W4.43: live run observing the refusal storm (no-op task).";
const launchLive = spawn(cli, ["workflow", "run", workflowId, liveTask, "--json"], {
  cwd: invocationDir, env: process.env,
});
let liveText = "";
launchLive.stdout.on("data", (d) => { liveText += String(d); });
launchLive.stderr.on("data", (d) => { liveText += String(d); });
const liveMatch = await new Promise((resolve) => {
  const timer = setInterval(() => {
    const m = liveText.match(/^Run:\s+run-([0-9a-f-]+)$/m);
    if (m) { clearInterval(timer); resolve(m); }
  }, 100);
  setTimeout(() => { clearInterval(timer); resolve(null); }, 30_000);
});
assert.ok(liveMatch, `live run did not publish a run id:\n${liveText}`);
const liveRunId = liveMatch[1];

// Wait for the live run's step to be claimed (mid-flight).
// T2.1 US-010 re-proof round 3: the wait budget is 45s (450 x 100ms), not
// 20s. The product's deterministic dispatch tick is 15s (dispatchIntervalMs),
// so a run registered just after a tick can take up to ~15s to get its first
// round dispatched; under the full campaign's sequential load the claim can
// land even later (the re-proof's campaign-20260817T232952964Z W4.43 flake:
// the live run's step was claimed 15s after dispatch — inside a 20s window
// only by luck). The ASSERTION is unchanged (the step MUST be claimed
// mid-flight); only the observation budget grows so a loaded daemon is not
// mistaken for a missing claim.
let liveClaimedAt = null;
for (let i = 0; i < 450; i++) {
  const row = dbRead("SELECT status FROM steps WHERE run_id = ? LIMIT 1", [liveRunId]);
  if (row.length > 0 && row[0].status === "running") {
    liveClaimedAt = Date.now();
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
assert.ok(liveClaimedAt !== null, "live run step must be claimed (mid-flight) before the storm");

const runsBefore = runCount();
const stormStart = Date.now();

// ── the storm: 10 rapid-fire invalid launches ────────────────────────
const diagnostics = [];
for (const [label, args] of INVALID_LAUNCHES) {
  const res = runSync(cli, args, { timeout: 30_000 });
  const stderr = (res.stderr + res.stdout).trim();
  diagnostics.push({ label, status: res.status, stderr });
  assert.notEqual(res.status, 0, `${label} must refuse with a non-zero exit`);
}
const stormWallMs = Date.now() - stormStart;
assert.ok(stormWallMs < 10_000, `the 10 refusals must land in <10s (got ${stormWallMs}ms)`);

// Distinct diagnostics: every refusal names its own failure mode.
const firstLines = diagnostics.map((d) => d.stderr.split("\n")[0]);
assert.equal(new Set(firstLines).size, firstLines.length,
  `all 10 refusal diagnostics must be DISTINCT:\n${firstLines.join("\n")}`);

// ZERO run rows created for the refusals.
assert.equal(runCount(), runsBefore,
  `the 10 invalid launches must create ZERO run rows (before=${runsBefore} after=${runCount()})`);

// ── zero daemon impact on the concurrent live run ────────────────────
let liveCompleteAt = null;
for (let i = 0; i < 300; i++) {
  const row = dbRead("SELECT status FROM runs WHERE id = ?", [liveRunId]);
  if (row.length > 0 && ["completed", "failed", "canceled"].includes(row[0].status)) {
    liveCompleteAt = Date.now();
    break;
  }
  await new Promise((r) => setTimeout(r, 200));
}
assert.ok(liveCompleteAt !== null, "live run must complete despite the refusal storm");
const liveRow = dbRead("SELECT status, tokens_spent FROM runs WHERE id = ?", [liveRunId])[0];
assert.equal(liveRow.status, "completed", "live run must complete (zero daemon impact)");
assert.equal(liveRow.tokens_spent, 0, "live run must be zero-token");
const claimToCompleteMs = liveCompleteAt - liveClaimedAt;
assert.ok(claimToCompleteMs < 60_000,
  `live run dispatch must stay responsive during the storm (claim→complete ${claimToCompleteMs}ms)`);

// ── no refusal leaves a lock/claim behind: a follow-up valid launch works ──
// The follow-up must use a DISTINCT harness workdir (a do-now run defaults
// its workdir to the launch cwd, which the concurrent live run already
// owns — that refusal is W4.42's machinery, not a leftover lock).
const followUpWorkdir = path.join(invocationDir, "follow-up-workdir");
fs.mkdirSync(followUpWorkdir, { recursive: true });
const followUp = runSync(cli, [
  "workflow", "run", workflowId, "W4.43 follow-up valid launch.",
  "--working-directory-for-harness", followUpWorkdir, "--json",
], { timeout: 30_000 });
assert.equal(followUp.status, 0, `a follow-up valid launch must succeed after the storm:\n${followUp.stdout}\n${followUp.stderr}`);
const followUpMatch = followUp.stdout.match(/^Run:\s+run-([0-9a-f-]+)$/m);
assert.ok(followUpMatch, "follow-up launch must publish a run id");
const followUpId = followUpMatch[1];

// ── cleanup (scoped ledger) ──────────────────────────────────────────
deleteRun(liveRunId);
deleteRun(followUpId);

process.stdout.write(`${JSON.stringify({
  scenario_id: metadata.id,
  workflow_id: workflowId,
  live_run_id: `run-${liveRunId}`,
  refusals: diagnostics.length,
  distinct_diagnostics: firstLines.length,
  storm_wall_ms: stormWallMs,
  runs_before: runsBefore,
  runs_after: runCount(),
  live_run_status: liveRow.status,
  live_claim_to_complete_ms: claimToCompleteMs,
  tokens_spent: liveRow.tokens_spent,
  result: "PASS",
})}\n`);
