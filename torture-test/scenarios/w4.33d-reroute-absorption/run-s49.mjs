#!/usr/bin/env node
/**
 * w4.33d-reroute-absorption - S49 split-cell scenario command (roster row W4.33d-reroute-absorption, zero tokens).
 *
 * This scenario cell is a SCRIPTED tier-2 cell: the CONTROLLER campaign
 * executes the corridor (launches the bfmw run with these materialized
 * behaviors on the contained scripted daemon, fires the manifest probe
 * sequence and the typed chaos block, and judges the outcome with the
 * roster oracles). This command is the scenario-dir contract smoke for that
 * corridor (the asset every validator checks is executable):
 *
 *   * validates this cell's own assets - scenario.json/behaviors.json shape,
 *     the bfmw agent roster parity, and the zero-token contract;
 *   * reroute ABSORPTION: the retry behavior absorbs the injected move (merge.target_moved + one reroute) and the done behavior lands.
 *   * re-checks the roster manifest row W4.33d-reroute-absorption
 *     (the typed move-branch chaos on seed/BUG-T4) so a roster/cell drift flips this command red at
 *     asset time.
 *
 * The executable corridor proof lives in the tier2 campaign (bare --tier2)
 * and in self-tests/tier2-s29-premise-redesign-corridor.test.ts (S49 arm) -
 * never duplicated here.
 *
 * Single-line JSON summary on stdout, result "PASS".
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [scenarioArg] = process.argv.slice(2);
if (!scenarioArg) throw new Error("usage: run-s49.mjs <scenario-directory>");
const scenarioDir = fs.realpathSync(scenarioArg);
const repoRoot = path.resolve(scenarioDir, "..", "..", "..");
const ttRoot = path.join(repoRoot, "torture-test");
const metadata = JSON.parse(fs.readFileSync(path.join(scenarioDir, "scenario.json"), "utf8"));
const behaviors = JSON.parse(fs.readFileSync(path.join(scenarioDir, metadata.behaviors), "utf8"));
assert.equal(metadata.id, "w4.33d-reroute-absorption", "scenario id mismatch");
assert.equal(metadata.workflow_base, "bug-fix-merge-worktree");
assert.ok(metadata.oracles.includes("O3z"), "scripted scenario must include O3z");
assert.equal(behaviors.heartbeatTokens, 0, "zero-token contract: heartbeatTokens must be 0");
assert.equal(behaviors.defaultTokens, 0, "zero-token contract: defaultTokens must be 0");
for (const entry of Object.values(behaviors.agents)) {
  for (const item of (Array.isArray(entry) ? entry : [entry])) {
    assert.equal(item.tokens ?? 0, 0, "zero-token contract: agent tokens must be 0");
  }
}
// bfmw agent roster parity (the WAVE-A 8-agent set), parsed from the
// workflow.yml `- id:` agent roster exactly like scenarios/lib/validate-scenario.mjs.
const workflowFile = path.join(repoRoot, "workflows", metadata.workflow_base, "workflow.yml");
const workflowText = fs.readFileSync(workflowFile, "utf8");
const workflowAgents = [];
let inAgents = false;
for (const line of workflowText.split(/\r?\n/)) {
  if (/^agents:\s*$/.test(line)) { inAgents = true; continue; }
  if (inAgents && /^[A-Za-z][A-Za-z0-9_-]*:/.test(line)) break;
  const m = inAgents ? line.match(/^\s+-\s+id:\s*([^\s#]+)\s*(?:#.*)?$/) : null;
  if (m) workflowAgents.push(m[1]);
}
assert.ok(workflowAgents.length > 0, "bfmw workflow must declare agents");
assert.deepEqual(Object.keys(behaviors.agents).sort(), [...workflowAgents].sort(),
  "behaviors agent keys must match the bfmw roster");
// Merger must be a behavior ARRAY with at least two honest landing entries
// (the absorption / resume / during-hold corridors dispatch the merger more
// than once).
const merger = behaviors.agents.merger;
assert.ok(Array.isArray(merger) && merger.length >= 2,
  "merger must be a behavior array (>= 2 entries)");
// Roster manifest row exists and matches this cell.
const manifestPath = path.join(ttRoot, "cases", "tier2.jsonl");
const rows = fs.readFileSync(manifestPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const row = rows.find((r) => r.id === "W4.33d-reroute-absorption");
assert.ok(row, "roster manifest must carry the W4.33d-reroute-absorption row");
assert.equal(row.context.scenario_id, metadata.id, "context.scenario_id must match the cell");
assert.equal(row.context.scenario_path, "scenarios/w4.33d-reroute-absorption", "context.scenario_path must match the cell");
assert.equal(row.harness, "scripted-pi", "the split cell must be a scripted-pi cell");
assert.equal(row.caps.tokens, 0, "the split cell must be zero-token");
assert.ok(row.chaos && row.chaos.type === "move-branch" && row.chaos.ref === "refs/heads/seed/BUG-T4",
  "W4.33d-reroute-absorption must carry the typed move-branch chaos on seed/BUG-T4");
assert.equal(row.probe_sequence, null, "absorption cell declares no probe sequence");

process.stdout.write(JSON.stringify({
  scenario_id: metadata.id,
  roster_row: "W4.33d-reroute-absorption",
  workflow_id: metadata.workflow_base,
  execution_mode: row.context.execution_mode,
  token_caps: row.caps.tokens,
  merger_entries: merger.length,
  result: "PASS",
}) + "\n");
