#!/usr/bin/env node
/**
 * W4.36 broken-work concession — scripted-pi cell (zero tokens).
 *
 * The corridor: bug-fix-merge-worktree on a scratch fixture where the
 * scripted FIXER deliberately breaks the suite (DELETES a test file and
 * INVERTS an assertion — the W4.36 injection encoded in behaviors.json),
 * and the evidence is MISSING at the finalize gate (the cell's verifier
 * reports done WITHOUT running the suite, the mechanical equivalent of the
 * campaign's drain-armed ledger-row deletion). merge_gate unset (default).
 *
 * Expected (pinned, mechanical):
 *   * the default gate sees MISSING evidence → reroutes once (to verify,
 *     per finalize_merge's retry_step) → then the concession valve lands it
 *     ANNOTATED: `merge.landed_without_suite_evidence` — never a silent
 *     green, never a refusal loop;
 *   * the run completes and finalize_merge is done;
 *   * zero tokens (scripted-pi runtime + system tripwire).
 *
 * O17 (test-inventory oracle) is deliberately NOT declared (the manifest
 * oracle list excludes it — the tier1-oracle-hygiene gate fails closed on
 * declared-but-missing oracles); the cell proves the concession corridor
 * that O17 will later gate.
 *
 * Single-line JSON summary on stdout.
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

const [scenarioArg] = process.argv.slice(2);
if (!scenarioArg) throw new Error("usage: run-broken-work.mjs <scenario-directory>");
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
    timeout: options.timeout ?? 360_000,
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

// ── fixture: scratch origin whose test file the fixer will DELETE ────
fs.mkdirSync(fixture, { recursive: true });
git(["init", "-b", "main"], fixture);
git(["config", "user.email", "w4.36@tamandua.local"], fixture);
git(["config", "user.name", "W4.36 Broken Work Concession"], fixture);
fs.writeFileSync(path.join(fixture, "package.json"),
  `${JSON.stringify({ name: "w4-36-fixture", version: "1.0.0", scripts: { test: "node -e 'process.exit(0)'" } })}\n`);
fs.writeFileSync(path.join(fixture, "value.txt"), "old\n");
fs.mkdirSync(path.join(fixture, "test"), { recursive: true });
fs.writeFileSync(path.join(fixture, "test", "regression.test.js"),
  "// the regression test the W4.36 fixer injection deletes\n");
fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
fs.writeFileSync(path.join(fixture, "src", "store.js"),
  "// assertion the W4.36 fixer injection inverts\nconst assert = require('node:assert');\nassert.equal(1, 1);\n");
fs.writeFileSync(path.join(fixture, ".gitignore"), ".env\nnode_modules/\n*.key\n*.pem\n");
git(["add", "."], fixture);
git(["commit", "-q", "-m", "baseline"], fixture);

// ── launch: one bfmw round with the broken-work injection ────────────
const taskText = "W4.36: fix the seeded defect (broken-work concession corridor).";
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
const finalize = dbRead("SELECT status FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'", [runId])[0];
const system = dbRead("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1")[0];

// The run EVENT stream — the concession annotation is the terminal signal.
const eventsFile = path.join(stateDir, "events", `${runId}.jsonl`);
const events = fs.existsSync(eventsFile)
  ? fs.readFileSync(eventsFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  : [];
const concessionEvents = events.filter((e) => e.event === "merge.landed_without_suite_evidence");
const overRedEvents = events.filter((e) => e.event === "merge.landed_over_red_suite");

// ── corridor assertions ──────────────────────────────────────────────
assert.equal(runRow.status, "completed", `the run must complete (got ${runRow.status})`);
assert.equal(finalize?.status, "done", "finalize_merge must land (concession valve)");
assert.equal(runRow.tokens_spent, 0, "scripted run tokens must be 0");
assert.equal(system?.system_tokens_spent ?? 0, 0, "system token tripwire must stay 0");
// Evidence MISSING + default gate → the concession valve lands it
// ANNOTATED with merge.landed_without_suite_evidence — never silently
// green, never a refusal loop.
assert.equal(concessionEvents.length, 1,
  "exactly one merge.landed_without_suite_evidence annotation must fire");
assert.equal(overRedEvents.length, 0,
  "the broken-work corridor must NOT land over red (evidence is missing, not red)");

deleteRun(runId);

process.stdout.write(`${JSON.stringify({
  scenario_id: metadata.id,
  workflow_id: workflowId,
  run_id: `run-${runId}`,
  run_status: runRow.status,
  finalize_status: finalize?.status,
  concession_annotation: "merge.landed_without_suite_evidence",
  tokens_spent: runRow.tokens_spent,
  system_tokens_spent: system?.system_tokens_spent ?? 0,
  result: "PASS",
})}\n`);
