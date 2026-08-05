#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EXPECTED_OUTCOMES = new Set(["completed", "failed", "canceled", "not_run"]);
const BASE_METADATA_KEYS = new Set([
  "schema_version",
  "id",
  "workflow_base",
  "behaviors",
  "command",
  "expected_outcome",
  "oracles",
]);
const MATRIX_METADATA_KEYS = new Set([
  "workflow_id",
  "task",
  "matrix",
  "expected_route",
  "oracle_justification",
]);
const METADATA_KEYS = new Set([...BASE_METADATA_KEYS, ...MATRIX_METADATA_KEYS]);

function fail(message) {
  throw new Error(`scenario validation: ${message}`);
}

function readJson(file, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON (${file}): ${error.message}`);
  }
  return value;
}

function containedFile(scenarioDir, relative, label) {
  if (typeof relative !== "string" || relative.length === 0 || path.isAbsolute(relative)) {
    fail(`${label} must be a non-empty relative path`);
  }
  const resolved = path.resolve(scenarioDir, relative);
  if (resolved !== scenarioDir && !resolved.startsWith(`${scenarioDir}${path.sep}`)) {
    fail(`${label} escapes the scenario directory: ${relative}`);
  }
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
    fail(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

function workflowAgents(workflowFile) {
  const agents = [];
  let inAgents = false;
  for (const line of fs.readFileSync(workflowFile, "utf8").split(/\r?\n/)) {
    if (/^agents:\s*$/.test(line)) {
      inAgents = true;
      continue;
    }
    if (inAgents && /^[A-Za-z][A-Za-z0-9_-]*:/.test(line)) break;
    const match = inAgents ? line.match(/^\s+-\s+id:\s*([^\s#]+)\s*(?:#.*)?$/) : null;
    if (match) agents.push(match[1]);
  }
  if (agents.length === 0) fail(`declared workflow base has no agents: ${workflowFile}`);
  if (new Set(agents).size !== agents.length) fail(`declared workflow base has duplicate agent ids: ${workflowFile}`);
  return agents;
}

function validateBehaviorEntry(entry, label) {
  const entries = Array.isArray(entry) ? entry : [entry];
  if (entries.length === 0) fail(`${label} must not be an empty array`);
  for (const [index, item] of entries.entries()) {
    const itemLabel = `${label}[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      fail(`${itemLabel} must be a behavior object`);
    }
    if (Object.hasOwn(item, "tokens") && item.tokens !== 0) {
      fail(`${itemLabel}.tokens must be 0 for a Tier-0 scripted scenario`);
    }
  }
}

export function validateScenario(inputDir, options = {}) {
  const scenarioDir = path.resolve(inputDir);
  if (!fs.statSync(scenarioDir, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`scenario directory does not exist: ${scenarioDir}`);
  }
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const ttDir = path.resolve(moduleDir, "../..");
  const repoRoot = options.repoRoot ?? path.dirname(ttDir);
  const metadataPath = path.join(scenarioDir, "scenario.json");
  const metadata = readJson(metadataPath, "metadata");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) fail("metadata must be an object");
  for (const key of Object.keys(metadata)) {
    if (!METADATA_KEYS.has(key)) fail(`metadata has unknown field: ${key}`);
  }
  for (const key of BASE_METADATA_KEYS) {
    if (!Object.hasOwn(metadata, key)) fail(`metadata is missing required field: ${key}`);
  }
  if (metadata.schema_version !== 1) fail("metadata schema_version must be 1");
  if (typeof metadata.id !== "string" || metadata.id.length > 64 || !ID_PATTERN.test(metadata.id)) {
    fail("metadata id must match ^[A-Za-z0-9][A-Za-z0-9._-]*$ and be at most 64 bytes");
  }
  if (typeof metadata.workflow_base !== "string" || metadata.workflow_base.length > 64 || !ID_PATTERN.test(metadata.workflow_base)) {
    fail("workflow_base must be a safe workflow id");
  }
  if (!EXPECTED_OUTCOMES.has(metadata.expected_outcome)) {
    fail(`expected_outcome must be one of: ${[...EXPECTED_OUTCOMES].join(", ")}`);
  }
  if (!Array.isArray(metadata.oracles) || metadata.oracles.length === 0 || new Set(metadata.oracles).size !== metadata.oracles.length) {
    fail("oracle list must be a non-empty unique array");
  }
  if (!metadata.oracles.includes("O3z")) fail("oracle list for a scripted scenario must include O3z");
  for (const oracle of metadata.oracles) {
    if (typeof oracle !== "string" || !ID_PATTERN.test(oracle)) fail(`invalid oracle id: ${oracle}`);
    const executable = path.join(ttDir, "oracles", oracle);
    try {
      fs.accessSync(executable, fs.constants.X_OK);
    } catch {
      fail(`oracle is not an executable CONTRACT oracle: ${oracle}`);
    }
  }

  const workflowFile = path.join(repoRoot, "workflows", metadata.workflow_base, "workflow.yml");
  if (!fs.statSync(workflowFile, { throwIfNoEntry: false })?.isFile()) {
    fail(`declared workflow base does not exist: ${metadata.workflow_base}`);
  }
  const agentIds = workflowAgents(workflowFile);
  const behaviorPath = containedFile(scenarioDir, metadata.behaviors, "behaviors file");
  const commandPath = containedFile(scenarioDir, metadata.command, "scenario command");

  const matrixKeysPresent = [...MATRIX_METADATA_KEYS].filter((key) => Object.hasOwn(metadata, key));
  if (matrixKeysPresent.length > 0 && matrixKeysPresent.length !== MATRIX_METADATA_KEYS.size) {
    const missing = [...MATRIX_METADATA_KEYS].filter((key) => !Object.hasOwn(metadata, key));
    fail(`matrix metadata is incomplete; missing: ${missing.join(", ")}`);
  }
  let taskPath;
  if (matrixKeysPresent.length > 0) {
    const expectedWorkflowId = `${metadata.workflow_base}-${metadata.id}`;
    if (metadata.workflow_id !== expectedWorkflowId) {
      fail(`workflow_id must mechanically equal ${expectedWorkflowId}`);
    }
    taskPath = containedFile(scenarioDir, metadata.task, "task file");
    if (!metadata.matrix || typeof metadata.matrix !== "object" || Array.isArray(metadata.matrix)) {
      fail("matrix must be an object");
    }
    const matrix = metadata.matrix;
    if (!["done", "retry", "failed", "missing-status"].includes(matrix.verdict) || !["true", "absent"].includes(matrix.rebased)
      || !["green", "red", "missing"].includes(matrix.suite_evidence)) {
      fail("matrix must declare verdict=done|retry|failed|missing-status, rebased=true|absent, and suite_evidence=green|red|missing");
    }
    if (!metadata.expected_route || typeof metadata.expected_route !== "object" || Array.isArray(metadata.expected_route)) {
      fail("expected_route must be an object");
    }
    if (typeof metadata.oracle_justification !== "string" || metadata.oracle_justification.length === 0) {
      fail("oracle_justification must be a non-empty string");
    }
  }
  try {
    fs.accessSync(commandPath, fs.constants.X_OK);
  } catch {
    fail(`scenario command is not executable: ${commandPath}`);
  }
  const behavior = readJson(behaviorPath, "behaviors file");
  if (!behavior || typeof behavior !== "object" || Array.isArray(behavior)) fail("behaviors file must be an object");
  if (!behavior.agents || typeof behavior.agents !== "object" || Array.isArray(behavior.agents)) {
    fail("behaviors file agents must be an object");
  }
  const behaviorAgents = Object.keys(behavior.agents).sort();
  const expectedAgents = [...agentIds].sort();
  if (JSON.stringify(behaviorAgents) !== JSON.stringify(expectedAgents)) {
    fail(`behavior agent keys must exactly match workflow agents; expected ${expectedAgents.join(", ")}, got ${behaviorAgents.join(", ")}`);
  }
  for (const agentId of behaviorAgents) validateBehaviorEntry(behavior.agents[agentId], `behavior agent ${agentId}`);
  for (const tokenField of ["heartbeatTokens", "defaultTokens"]) {
    if (behavior[tokenField] !== 0) fail(`behaviors file ${tokenField} must be 0 for a Tier-0 scripted scenario`);
  }

  return {
    scenario_dir: scenarioDir,
    metadata_path: metadataPath,
    id: metadata.id,
    workflow_base: metadata.workflow_base,
    behaviors_path: behaviorPath,
    command_path: commandPath,
    task_path: taskPath,
    expected_outcome: metadata.expected_outcome,
    oracles: metadata.oracles,
    agent_ids: agentIds,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    process.stderr.write("Usage: validate-scenario.mjs <scenario-directory>\n");
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(validateScenario(args[0]))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
