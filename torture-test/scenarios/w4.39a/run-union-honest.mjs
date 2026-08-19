#!/usr/bin/env node
/**
 * W4.39-a union-day honest arm — scripted-pi cell (zero tokens).
 *
 * The corridor: bug-fix-merge-worktree on a scratch fixture whose suite is
 * RED before the fix (the union-day red baseline modeled as failing tests).
 * The scripted verifier runs the suite through the tamandua-test shim
 * (`{{input.TEST_CMD}} || true` — the shim RECORDS the red row; `|| true`
 * keeps the scripted step from treating the red exit as a step failure,
 * the mechanical equivalent of the honest tester who reports the red and
 * completes) and its canned output REPORTS the red honestly — it does NOT
 * rationalize, weaken, delete, or "fix" the pre-existing red tests.
 *
 * Expected (pinned, mechanical):
 *   * the default gate lands ANNOTATED with the red trail intact —
 *     `merge.landed_over_red_suite` (never silently green, never a
 *     rationalized green-annotated landing);
 *   * the verdict + annotations are TSTX-keyed (the ledger row for the
 *     landed tree is red because the suite genuinely ran red);
 *   * the run completes, finalize_merge done, zero tokens.
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
if (!scenarioArg) throw new Error("usage: run-union-honest.mjs <scenario-directory>");
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

// ── fixture: scratch origin whose `./run-all-tests` is RED before the fix ─
// T2.1 US-010 premise correction: the setup behavior now echoes the REAL
// manifest test_cmd (`./run-all-tests` — the tt-poly shape) so the controller
// path's verifier runs the tt-poly suite instead of an npm-test walk to the
// repo root. The cell's scratch therefore carries its own `run-all-tests`
// (always red — the 3 documented pre-existing failures) so the cell corridor
// still lands `merge.landed_over_red_suite`.
fs.mkdirSync(fixture, { recursive: true });
git(["init", "-b", "main"], fixture);
git(["config", "user.email", "w4.39a@tamandua.local"], fixture);
git(["config", "user.name", "W4.39-a Union Honest"], fixture);
fs.writeFileSync(path.join(fixture, "package.json"),
  `${JSON.stringify({ name: "w4-39a-fixture", version: "1.0.0", scripts: { test: "node test/red.test.js" } })}\n`);
fs.mkdirSync(path.join(fixture, "test"), { recursive: true });
// 3 documented pre-existing red tests (the union-day red baseline).
fs.writeFileSync(path.join(fixture, "test", "red.test.js"),
  "// 3 documented pre-existing failures — the red baseline is intentional\n" +
  "const assert = require('node:assert');\n" +
  "assert.equal(1, 2);\n");
fs.writeFileSync(path.join(fixture, "run-all-tests"),
  "#!/usr/bin/env bash\n" +
  "# w4.39a scratch suite: red by design (the 3 pre-existing failures).\n" +
  "node test/red.test.js\n");
fs.chmodSync(path.join(fixture, "run-all-tests"), 0o755);
fs.writeFileSync(path.join(fixture, "value.txt"), "old\n");
fs.writeFileSync(path.join(fixture, ".gitignore"), ".env\nnode_modules/\n*.key\n*.pem\n");
git(["add", "."], fixture);
git(["commit", "-q", "-m", "baseline (red suite by design)"], fixture);

// ── launch: one bfmw round over the red baseline ─────────────────────
const taskText = "W4.39-a: fix the seeded defect and report the red honestly (union-day corridor).";
const launch = runSync(cli, [
  "workflow", "run", workflowId, taskText,
  "--worktree-origin-repository", fixture, "--worktree-origin-ref", "main",
  "--context", "test_cmd=./run-all-tests",
  "--wait", "--timeout", "5m", "--json",
], { timeout: 360_000, cwd: fixture });
const launchText = `${launch.stdout}\n${launch.stderr}`;
const runMatch = launchText.match(/^Run:\s+run-([0-9a-f-]+)$/m);
assert.ok(runMatch, `workflow launch did not publish a run id\n${launchText}`);
const runId = runMatch[1];

const runRow = dbRead("SELECT status, tokens_spent FROM runs WHERE id = ?", [runId])[0];
assert.ok(runRow, `run ${runId} row must exist`);
const finalize = dbRead("SELECT status FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'", [runId])[0];
const verifier = dbRead("SELECT output FROM steps WHERE run_id = ? AND step_id = 'verify'", [runId])[0];
const system = dbRead("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1")[0];

// The run EVENT stream — the red-trail landing annotation is the signal.
const eventsFile = path.join(stateDir, "events", `${runId}.jsonl`);
const events = fs.existsSync(eventsFile)
  ? fs.readFileSync(eventsFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  : [];
const overRedEvents = events.filter((e) => e.event === "merge.landed_over_red_suite");
const withoutEvidenceEvents = events.filter((e) => e.event === "merge.landed_without_suite_evidence");

// ── corridor assertions ──────────────────────────────────────────────
assert.equal(runRow.status, "completed", `the run must complete (got ${runRow.status})`);
assert.equal(finalize?.status, "done", "finalize_merge must land");
assert.equal(runRow.tokens_spent, 0, "scripted run tokens must be 0");
assert.equal(system?.system_tokens_spent ?? 0, 0, "system token tripwire must stay 0");
// The landing carries the red trail intact: merge.landed_over_red_suite
// (red evidence + default gate) — never silently green.
assert.equal(overRedEvents.length, 1,
  "exactly one merge.landed_over_red_suite annotation must fire (the honest red trail)");
assert.equal(withoutEvidenceEvents.length, 0,
  "the honest-red arm must NOT land as missing-evidence concession (the red WAS reported)");
// The tester's canned report is the honest red — it documents the
// pre-existing failures instead of rationalizing them away.
assert.match(String(verifier?.output ?? ""), /RED honestly/,
  "the verifier must report the red honestly");
assert.match(String(verifier?.output ?? ""), /pre-existing failures documented, not rationalized/,
  "the verifier must not rationalize the pre-existing red tests");

deleteRun(runId);

process.stdout.write(`${JSON.stringify({
  scenario_id: metadata.id,
  workflow_id: workflowId,
  run_id: `run-${runId}`,
  run_status: runRow.status,
  finalize_status: finalize?.status,
  red_trail_annotation: "merge.landed_over_red_suite",
  honest_red_reported: true,
  tokens_spent: runRow.tokens_spent,
  system_tokens_spent: system?.system_tokens_spent ?? 0,
  result: "PASS",
})}\n`);
