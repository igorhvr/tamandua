#!/usr/bin/env node
// scenario-workflow-parity.mjs — roster + fix-step-expects parity guard
// between scripted scenario assets and the bundled workflows they drive
// (S58 US-007).
//
// A scripted scenario cell declares workflow_base in its scenario.json and
// canned agent behaviors in behaviors.json. Two invariants must hold or the
// scenario silently stops exercising the product's real corridor:
//
//   (a) roster parity — behaviors.json agent keys must EXACTLY equal the
//       `- id:` agent roster parsed from workflows/<workflow_base>/workflow.yml
//       (the same parse validate-scenario.mjs enforces). A stale roster (a
//       WAVE-A-class workflow change adds/removes an agent without touching
//       the scenarios) makes every scripted run of that workflow drift.
//
//   (b) fix-expects parity — when ANY step of the workflow declares an
//       `expects` containing the `(REPRO_EVIDENCE|CANNOT_REPRODUCE)` contract
//       (WAVE-A fix steps), EVERY output-bearing canned invocation of that
//       step's agent must satisfy `^(REPRO_EVIDENCE|CANNOT_REPRODUCE):\s*\S+`
//       (one line). Entries that never emit output (provider_error entries,
//       entries without an `output` string) are exempt — only output-bearing
//       invocations need the marker.
//
// The tier asset validators (bin/tt-tier0-assets, bin/tt-tier2-assets) run
// this check per manifest-referenced scenario dir at GATE time, so a
// roster/fix-expects drift flips the tier gate red with a named reason
// instead of surfacing only at scenario runtime. The self-test
// self-tests/tier0-scenario-workflow-parity.test.ts runs it across every cell
// referenced by cases/tier0.jsonl + cases/tier2.jsonl.
//
// Confined to torture-test/. Zero tokens (pure file/schema checks).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workflowAgents } from "./validate-scenario.mjs";

const FIX_EXPECTS_MARKER = "(REPRO_EVIDENCE|CANNOT_REPRODUCE)";
const REPRO_MARKER_LINE = /^(REPRO_EVIDENCE|CANNOT_REPRODUCE):\s*\S+/m;

// stepFixMarkerAgents(workflowFile) — walk the `steps:` section of a bundled
// workflow.yml and return the agent id of every step whose `expects` (single
// line or `|` block) contains the WAVE-A REPRO_EVIDENCE|CANNOT_REPRODUCE
// contract. Steps are the `- id:` list items under `steps:`; each carries an
// `agent:` field a few lines in. Returns [] when no step requires the marker.
export function stepFixMarkerAgents(workflowFile) {
  const agents = [];
  let current = null;
  let inSteps = false;
  const commit = () => {
    if (current !== null && current.marker && current.agent !== null
        && !agents.includes(current.agent)) {
      agents.push(current.agent);
    }
    current = null;
  };
  for (const line of fs.readFileSync(workflowFile, "utf8").split(/\r?\n/)) {
    if (/^steps:\s*$/.test(line)) {
      inSteps = true;
      commit();
      continue;
    }
    if (!inSteps) continue;
    if (/^[A-Za-z][A-Za-z0-9_-]*:/.test(line)) {
      commit(); // next top-level section
      break;
    }
    const stepStart = line.match(/^\s+-\s+id:\s*([^\s#]+)\s*(?:#.*)?$/);
    if (stepStart) {
      commit();
      current = { agent: null, marker: false };
      continue;
    }
    if (current === null) continue;
    const agentMatch = line.match(/^\s+agent:\s*([^\s#]+)\s*(?:#.*)?$/);
    if (agentMatch && current.agent === null) current.agent = agentMatch[1];
    if (line.includes(FIX_EXPECTS_MARKER)) current.marker = true;
  }
  commit();
  return agents;
}

// resolveWorkflowFile(repoRoot, workflowBase, workflowOverride) — the
// workflows/<base>/workflow.yml for a scenario cell, or a caller-supplied
// override (red-arm tests inject a doctored copy here).
function resolveWorkflowFile(repoRoot, workflowBase, workflowOverride) {
  if (workflowOverride !== undefined) return path.resolve(workflowOverride);
  return path.join(repoRoot, "workflows", workflowBase, "workflow.yml");
}

// checkScenarioWorkflowParity(scenarioDir, options) — returns an array of
// human-readable problem strings (empty = the cell tracks its workflow).
//
// options:
//   repoRoot            — repository root holding workflows/<base>/workflow.yml.
//                         Defaults to the checkout root derived from this
//                         module's own location (torture-test/scenarios/lib/..
//                         /.. => the repo root), mirroring validate-scenario.
//   workflowOverride    — absolute path of a workflow.yml to use instead of
//                         <repoRoot>/workflows/<base>/workflow.yml (red arm).
//   behaviorsOverride   — absolute path of a behaviors.json to use instead of
//                         <scenarioDir>/<scenario.json behaviors> (red arm).
export function checkScenarioWorkflowParity(scenarioDir, options = {}) {
  const problems = [];
  const dir = path.resolve(scenarioDir);
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const ttDir = path.resolve(moduleDir, "../..");
  const repoRoot = options.repoRoot ?? path.dirname(ttDir);

  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(path.join(dir, "scenario.json"), "utf8"));
  } catch (error) {
    return [`${dir}: scenario.json is not readable/valid JSON: ${error.message}`];
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [`${dir}: scenario.json must be an object`];
  }
  const workflowBase = metadata.workflow_base;
  const behaviorsRelative = metadata.behaviors;
  if (typeof workflowBase !== "string" || workflowBase.length === 0) {
    return [`${dir}: scenario.json must declare a non-empty workflow_base`];
  }
  if (typeof behaviorsRelative !== "string" || behaviorsRelative.length === 0) {
    return [`${dir}: scenario.json must declare a non-empty behaviors file`];
  }

  let behaviorsPath;
  if (options.behaviorsOverride !== undefined) {
    behaviorsPath = path.resolve(options.behaviorsOverride);
  } else {
    behaviorsPath = path.resolve(dir, behaviorsRelative);
    const contained = behaviorsPath === dir || behaviorsPath.startsWith(`${dir}${path.sep}`);
    if (!contained) {
      return [`${dir}: behaviors file escapes the scenario directory: ${behaviorsRelative}`];
    }
  }
  if (!fs.statSync(behaviorsPath, { throwIfNoEntry: false })?.isFile()) {
    return [`${dir}: behaviors file does not exist: ${behaviorsPath}`];
  }

  const workflowFile = resolveWorkflowFile(repoRoot, workflowBase, options.workflowOverride);
  if (!fs.statSync(workflowFile, { throwIfNoEntry: false })?.isFile()) {
    return [`${dir}: workflow base ${workflowBase} has no workflow.yml at ${workflowFile}`];
  }

  const roster = workflowAgents(workflowFile);
  const expectedRoster = [...roster].sort();

  let behaviors;
  try {
    behaviors = JSON.parse(fs.readFileSync(behaviorsPath, "utf8"));
  } catch (error) {
    return [`${dir}: behaviors file is not valid JSON (${behaviorsPath}): ${error.message}`];
  }
  if (!behaviors || typeof behaviors !== "object" || Array.isArray(behaviors)
      || !behaviors.agents || typeof behaviors.agents !== "object" || Array.isArray(behaviors.agents)) {
    return [`${dir}: behaviors file must be an object with an agents object`];
  }
  const behaviorAgents = Object.keys(behaviors.agents).sort();
  if (JSON.stringify(behaviorAgents) !== JSON.stringify(expectedRoster)) {
    problems.push(
      `${dir}: behaviors.json agent keys must exactly match the ${workflowBase} workflow roster; `
      + `expected ${expectedRoster.join(", ")}, got ${behaviorAgents.join(", ")}`,
    );
  }

  // (b) fix-expects parity: only steps whose expects carries the WAVE-A marker
  // impose a canned-output contract on their agent.
  const markerAgents = stepFixMarkerAgents(workflowFile);
  for (const agentId of markerAgents) {
    const behavior = behaviors.agents[agentId];
    if (behavior === undefined) continue; // missing agent already reported by (a)
    const entries = Array.isArray(behavior) ? behavior : [behavior];
    for (const [index, entry] of entries.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const output = entry.output;
      if (typeof output !== "string") continue; // no canned output => no contract
      if (!REPRO_MARKER_LINE.test(output)) {
        problems.push(
          `${dir}: ${agentId} canned output (invocation ${index}) does not satisfy the `
          + `${workflowBase} fix-step expects ^(REPRO_EVIDENCE|CANNOT_REPRODUCE):\\s*\\S+; `
          + `output: ${JSON.stringify(output.slice(-120))}`,
        );
      }
    }
  }

  return problems;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write(
      "Usage: scenario-workflow-parity.mjs <scenario-dir> [--repo-root <dir>] "
      + "[--workflow <workflow.yml>] [--behaviors <behaviors.json>]\n",
    );
    process.exit(2);
  }
  const dir = args[0];
  const options = {};
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--repo-root" && i + 1 < args.length) options.repoRoot = args[i + 1];
    else if (args[i] === "--workflow" && i + 1 < args.length) options.workflowOverride = args[i + 1];
    else if (args[i] === "--behaviors" && i + 1 < args.length) options.behaviorsOverride = args[i + 1];
  }
  try {
    const problems = checkScenarioWorkflowParity(dir, options);
    if (problems.length > 0) {
      for (const problem of problems) process.stderr.write(`${problem}\n`);
      process.exit(1);
    }
    process.stdout.write(`OK: ${path.resolve(dir)} tracks its workflow roster/fix-expects\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
