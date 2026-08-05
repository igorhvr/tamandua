#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { validateScenario } from "./validate-scenario.mjs";

function main() {
  const [scenarioDir, workflowId, outputPath] = process.argv.slice(2);
  if (!scenarioDir || !workflowId || !outputPath) {
    process.stderr.write("Usage: materialize-behaviors.mjs <scenario-directory> <workflow-id> <output-path>\n");
    process.exit(2);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workflowId)) {
    process.stderr.write("materialize behaviors: invalid workflow id\n");
    process.exit(1);
  }
  try {
    const scenario = validateScenario(scenarioDir);
    const template = JSON.parse(fs.readFileSync(scenario.behaviors_path, "utf8"));
    const agents = {};
    for (const agentId of scenario.agent_ids) agents[`${workflowId}_${agentId}`] = template.agents[agentId];
    const materialized = { ...template, agents };
    fs.writeFileSync(outputPath, `${JSON.stringify(materialized, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

main();
