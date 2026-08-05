#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [scenarioArg] = process.argv.slice(2);
if (!scenarioArg) throw new Error("usage: run-retry-cell.mjs <scenario-directory>");
const scenarioDir = fs.realpathSync(scenarioArg);
const metadata = JSON.parse(fs.readFileSync(path.join(scenarioDir, "scenario.json"), "utf8"));
const expected = metadata.expected_route;
const task = fs.readFileSync(path.join(scenarioDir, metadata.task), "utf8").trim();
const stateDir = process.env.TAMANDUA_STATE_DIR;
const invocationDir = process.env.TT_SCENARIO_STATE_DIR;
const workflowId = process.env.TT_SCENARIO_WORKFLOW_ID;
const repoRoot = process.env.TT_REPO_ROOT;
if (!stateDir || !invocationDir || !workflowId || !repoRoot) {
  throw new Error("scripted scenario environment is incomplete");
}
if (!workflowId.startsWith(`${metadata.workflow_id}-`)) {
  throw new Error(`runtime workflow identity does not derive from matrix cell: ${workflowId}`);
}

// One mechanically designated matrix cell also carries the RSTY fossil. Its
// scenario-unique workflow copy turns fix into a one-story verify_each loop
// and makes the verifier's honest retry an accepted expects variant.
if (expected.story_rows === 1) {
  const workflowFile = path.join(stateDir, "workflows", workflowId, "workflow.yml");
  let workflowText = fs.readFileSync(workflowFile, "utf8");
  workflowText = workflowText.replace(
    "  - id: fix\n    agent: fixer\n",
    "  - id: fix\n    agent: fixer\n    type: loop\n    loop:\n      over: stories\n      completion: all_done\n      fresh_session: true\n      verify_each: true\n      verify_step: verify\n",
  );
  workflowText = workflowText.replace(
    /(\n  - id: verify[\s\S]*?\n    expects: )[^\n]+/,
    "$1|\n      regex:^STATUS:\\s*(done|retry)\\s*$",
  );
  fs.writeFileSync(workflowFile, workflowText);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const fixture = path.join(invocationDir, "fixture");
fs.mkdirSync(fixture, { recursive: true });
run("git", ["init", "-b", "main"], { cwd: fixture });
run("git", ["config", "user.name", "Tamandua Scripted Scenario"], { cwd: fixture });
run("git", ["config", "user.email", "scripted@tetradactyla.org"], { cwd: fixture });
fs.writeFileSync(path.join(fixture, "value.txt"), "old\n");
fs.writeFileSync(path.join(fixture, ".gitignore"), ".env\nnode_modules/\n*.key\n*.pem\n");
run("git", ["add", "."], { cwd: fixture });
run("git", ["commit", "-m", "test: seed W4.35 retry matrix fixture"], { cwd: fixture });
const targetBefore = run("git", ["rev-parse", "refs/heads/main"], { cwd: fixture }).stdout.trim();

const cli = path.join(repoRoot, "bin", "tamandua");
const launch = run(cli, [
  "workflow", "run", workflowId, task,
  "--worktree-origin-repository", fixture,
  "--worktree-origin-ref", "main",
  "--wait", "--timeout", "10m", "--json",
], { cwd: fixture, allowFailure: true });
const launchText = `${launch.stdout}\n${launch.stderr}`;
const runMatch = launchText.match(/^Run:\s+run-([0-9a-f-]+)$/m);
if (!runMatch) throw new Error(`workflow launch did not publish a run id\n${launchText}`);
const runId = runMatch[1];

const db = new DatabaseSync(path.join(stateDir, "tamandua.db"), { readOnly: true });
const runRow = db.prepare("SELECT status, tokens_spent FROM runs WHERE id = ?").get(runId);
const finalize = db.prepare(`
  SELECT status, retry_count, reroute_count, terminal_reroute_count, ledger_concession_count, output
  FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'
`).get(runId);
const system = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get();
const suiteCount = db.prepare("SELECT COUNT(*) AS count FROM suite_results WHERE run_id = ?").get(runId).count;
const stories = db.prepare("SELECT COUNT(*) AS count, MAX(status) AS status, COALESCE(MAX(retry_count), 0) AS retry_count FROM stories WHERE run_id = ?").get(runId);
db.close();

const eventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
const events = fs.readFileSync(eventsPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const countEvent = (name) => events.filter((event) => event.event === name).length;
const stepInvocations = (stepId) => events.filter((event) => event.event === "step.running" && event.stepId === stepId).length;
const rerouteEvents = events.filter((event) => event.event === "step.rerouted" && event.stepId === "finalize_merge");
const finalizeDoneEvents = events.filter((event) => event.event === "step.done" && event.stepId === "finalize_merge");
const mergeAnnotations = events.filter((event) => [
  "merge.landed", "merge.landed_over_red_suite", "merge.landed_without_suite_evidence",
  "merge.gate_overridden", "merge.accepted_already_landed",
].includes(event.event));
const targetAfter = run("git", ["rev-parse", "refs/heads/main"], { cwd: fixture }).stdout.trim();
// Remove the managed worktree before assertions so a failed invariant cannot
// leak state into the next matrix cell. The harness owns fixture cleanup.
const worktreeRemove = run(cli, ["worktree", "remove", `run-${runId}`, "--force"], { allowFailure: true });
if (worktreeRemove.status !== 0 && !`${worktreeRemove.stdout}\n${worktreeRemove.stderr}`.includes("No managed worktree")) {
  throw new Error(`could not remove scenario worktree\n${worktreeRemove.stdout}\n${worktreeRemove.stderr}`);
}

assert.equal(runRow.status, expected.run_status, "terminal run status");
assert.equal(finalize.status, expected.finalize_status, "terminal finalize status");
assert.equal(finalize.retry_count, expected.retry_count, "finalize retry count");
assert.equal(finalize.reroute_count, expected.reroute_count, "RAMP reroute count");
assert.equal(finalize.terminal_reroute_count, expected.terminal_reroute_count, "terminal reroute count");
assert.equal(finalize.ledger_concession_count, expected.ledger_concession_count, "ledger concession count");
assert.equal(rerouteEvents.length, expected.reroute_events, "step.rerouted event count");
assert.equal(stepInvocations("finalize_merge"), expected.merger_invocations, "merger invocation count");
assert.equal(stepInvocations("verify"), expected.verifier_invocations, "producer must be reclaimed after each reroute");
assert.equal(stepInvocations("fix"), expected.fixer_invocations, "fix producer invocation count");
assert.equal(countEvent("step.retry"), expected.accepted_retry_events, "step-level retry events");
assert.equal(countEvent("story.retry"), expected.story_retry_events, "RSTY story reset event count");
assert.equal(stories.count, expected.story_rows, "RSTY story row count");
assert.equal(stories.retry_count, expected.story_retry_count, "RSTY story retry budget");
if (expected.story_rows > 0) assert.equal(stories.status, "done", "retried story must finish done");
assert.equal(countEvent("dispatch.keys.rejected"), expected.unresolved_placeholder_events,
  "retry routing must not dispatch unresolved downstream placeholders");
assert.equal(targetAfter, targetBefore, "STATUS retry must not move the target ref");
assert.deepEqual(finalizeDoneEvents, [], "STATUS retry must never complete finalize_merge");
assert.deepEqual(mergeAnnotations, [], "retry cells must not emit landing annotations");
assert.equal(
  rerouteEvents.filter((event) => event.detail.includes(expected.retry_feedback_contains)).length,
  expected.retry_feedback_reroutes,
  "verdict-driven reroutes must carry bounded diagnostic feedback",
);
assert.equal(runRow.tokens_spent, 0, "scripted run tokens");
assert.equal(system.system_tokens_spent, expected.system_tokens_spent, "system token tripwire");
assert.equal(suiteCount, expected.suite_rows, "suite evidence rows must match the cell replay policy");
assert.equal(countEvent("run.failed"), 1, "exact terminal run event");
assert.equal(countEvent("run.completed"), 0, "no phantom completion");

process.stdout.write(`${JSON.stringify({
  scenario_id: metadata.id,
  workflow_id: workflowId,
  run_id: `run-${runId}`,
  terminal_route: expected.terminal_route,
  run_status: runRow.status,
  ref_moved: false,
  suite_evidence: metadata.matrix.suite_evidence,
  reroute_events: rerouteEvents.length,
  merger_invocations: stepInvocations("finalize_merge"),
  verifier_invocations: stepInvocations("verify"),
  story_retry_events: countEvent("story.retry"),
  suite_rows: suiteCount,
  tokens_spent: runRow.tokens_spent,
  system_tokens_spent: system.system_tokens_spent,
  result: "PASS",
})}\n`);
