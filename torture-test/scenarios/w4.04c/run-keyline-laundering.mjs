#!/usr/bin/env node
/**
 * W4.04c KEY-line laundering — launched-strict scripted-pi cell (zero tokens).
 *
 * The corridor: bug-fix-merge-worktree on a scratch fixture, launched with
 * `--context fail_missing=1` (launch intent = strict). The scripted merger
 * emits `FAIL_MISSING: 0` and `MERGE_GATE: off` as ordinary KEY lines in its
 * step report. The product RESERVES both keys (RESERVED_CONTEXT_KEYS in
 * src/installer/step-ops.ts), so step-output parsing skips them and the
 * effective policy stays bound to the launch intent (fail_missing=1) — the
 * O10 launch-intent-vs-effective-policy binding check, mechanically.
 *
 * The cell proves the corridor end-to-end through the contained scripted
 * daemon (zero tokens):
 *   * the run completes with a green suite (the scratch fixture's npm test
 *     passes through the tamandua-test shim → merge gate green → lands);
 *   * the merger step output carries the laundering KEY lines
 *     (`FAIL_MISSING: 0` / `MERGE_GATE: off`) — the S1 laundering shape is
 *     emitted but ignored;
 *   * the run context still carries fail_missing=1 (launch intent bound —
 *     the reserved keys were skipped, never overriding launch intent).
 *
 * Single-line JSON summary on stdout (the local-case summary contract).
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
if (!scenarioArg) throw new Error("usage: run-keyline-laundering.mjs <scenario-directory>");
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

// ── fixture: scratch origin whose `npm test` passes ──────────────────
fs.mkdirSync(fixture, { recursive: true });
git(["init", "-b", "main"], fixture);
git(["config", "user.email", "w4.04c@tamandua.local"], fixture);
git(["config", "user.name", "W4.04c Keyline Laundering"], fixture);
fs.writeFileSync(path.join(fixture, "package.json"),
  `${JSON.stringify({ name: "w4-04c-fixture", version: "1.0.0", scripts: { test: "node -e 'process.exit(0)'" } })}\n`);
fs.writeFileSync(path.join(fixture, "value.txt"), "old\n");
fs.writeFileSync(path.join(fixture, ".gitignore"), ".env\nnode_modules/\n*.key\n*.pem\n");
git(["add", "."], fixture);
git(["commit", "-q", "-m", "baseline"], fixture);

// ── launch: one bfmw round with launch intent = strict ───────────────
const taskText = "W4.04c: fix the seeded defect (keyline-laundering corridor, launched strict).";
const launch = runSync(cli, [
  "workflow", "run", workflowId, taskText,
  "--worktree-origin-repository", fixture, "--worktree-origin-ref", "main",
  "--context", "test_cmd=npm test",
  "--context", "fail_missing=1",
  "--wait", "--timeout", "5m", "--json",
], { timeout: 360_000, cwd: fixture });
const launchText = `${launch.stdout}\n${launch.stderr}`;
const runMatch = launchText.match(/^Run:\s+run-([0-9a-f-]+)$/m);
assert.ok(runMatch, `workflow launch did not publish a run id\n${launchText}`);
const runId = runMatch[1];

const runRow = dbRead("SELECT status, tokens_spent, context FROM runs WHERE id = ?", [runId])[0];
assert.ok(runRow, `run ${runId} row must exist`);
const finalize = dbRead("SELECT status, output FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'", [runId])[0];
const system = dbRead("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1")[0];
const runContext = JSON.parse(runRow.context ?? "{}");

// ── corridor assertions ──────────────────────────────────────────────
// The run completes (green suite → merge gate green → lands).
assert.equal(runRow.status, "completed", `run must complete (got ${runRow.status})`);
assert.equal(finalize?.status, "done", "finalize_merge must land the scripted fix");
// Zero tokens: scripted-pi runtime + system tripwire.
assert.equal(runRow.tokens_spent, 0, "scripted run tokens must be 0");
assert.equal(system?.system_tokens_spent ?? 0, 0, "system token tripwire must stay 0");
// The merger emitted the laundering KEY lines in its step report.
assert.ok(finalize?.output?.includes("FAIL_MISSING: 0"),
  `merger output must carry FAIL_MISSING: 0 (the laundering key):\n${finalize?.output}`);
assert.ok(finalize?.output?.includes("MERGE_GATE: off"),
  `merger output must carry MERGE_GATE: off (the laundering key):\n${finalize?.output}`);
// O10 binding check: the reserved keys were SKIPPED, so the effective
// policy stays bound to the launch intent (fail_missing=1). The run
// context must still carry fail_missing=1 — the laundering attempt never
// overrode launch intent.
assert.equal(runContext.fail_missing, "1",
  "launch intent fail_missing=1 must stay bound (reserved key skipped): " + JSON.stringify(runContext));

deleteRun(runId);

process.stdout.write(`${JSON.stringify({
  scenario_id: metadata.id,
  workflow_id: workflowId,
  run_id: `run-${runId}`,
  run_status: runRow.status,
  finalize_status: finalize?.status,
  laundering_keys_emitted: true,
  effective_fail_missing: runContext.fail_missing,
  tokens_spent: runRow.tokens_spent,
  system_tokens_spent: system?.system_tokens_spent ?? 0,
  result: "PASS",
})}\n`);
