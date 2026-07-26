import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { WorkflowSpec } from "./types.js";

function validateRetryOn(
  step: Record<string, unknown>,
  stepIndex: number,
  workflowDir: string,
): void {
  if (!step.on_fail || typeof step.on_fail !== "object") return;

  const retryOn = (step.on_fail as Record<string, unknown>).retry_on;
  if (retryOn === undefined) return;

  if (
    !Array.isArray(retryOn) ||
    retryOn.some((failureClass) =>
      typeof failureClass !== "string" || failureClass.trim().length === 0
    )
  ) {
    throw new Error(
      `workflow.yml step[${stepIndex}] ("${String(step.id)}") on_fail.retry_on in ${workflowDir} must be an array of non-empty strings`,
    );
  }
}

function parseAndValidateWorkflowSpec(
  raw: string,
  workflowDir: string,
): WorkflowSpec {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse workflow.yml in ${workflowDir}: ${(err as Error).message}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      `workflow.yml in ${workflowDir} did not parse to an object`,
    );
  }

  const spec = parsed as Record<string, unknown>;

  // Validate required fields
  if (typeof spec.id !== "string" || !spec.id) {
    throw new Error(`workflow.yml in ${workflowDir} is missing required field: id`);
  }
  if (!Array.isArray(spec.agents) || spec.agents.length === 0) {
    throw new Error(`workflow.yml in ${workflowDir} is missing required field: agents (must be a non-empty array)`);
  }
  if (!Array.isArray(spec.steps)) {
    throw new Error(`workflow.yml in ${workflowDir} is missing required field: steps (must be an array)`);
  }

  // Validate each agent has required fields
  for (let i = 0; i < spec.agents.length; i++) {
    const agent = spec.agents[i] as Record<string, unknown>;
    if (typeof agent.id !== "string" || !agent.id) {
      throw new Error(
        `workflow.yml agent[${i}] in ${workflowDir} is missing required field: id`,
      );
    }
    if (!agent.workspace || typeof agent.workspace !== "object") {
      throw new Error(
        `workflow.yml agent[${i}] ("${agent.id}") in ${workflowDir} is missing required field: workspace`,
      );
    }
    const ws = agent.workspace as Record<string, unknown>;
    if (typeof ws.baseDir !== "string") {
      throw new Error(
        `workflow.yml agent[${i}] ("${agent.id}") workspace in ${workflowDir} is missing required field: baseDir`,
      );
    }
  }

  // Validate each step has required fields
  for (let i = 0; i < spec.steps.length; i++) {
    const step = (spec.steps as Array<Record<string, unknown>>)[i];
    if (typeof step.id !== "string" || !step.id) {
      throw new Error(
        `workflow.yml step[${i}] in ${workflowDir} is missing required field: id`,
      );
    }
    if (typeof step.agent !== "string" || !step.agent) {
      throw new Error(
        `workflow.yml step[${i}] ("${step.id}") in ${workflowDir} is missing required field: agent`,
      );
    }
    validateRetryOn(step, i, workflowDir);
  }

  // Validate run.workspace if present
  if (spec.run && typeof spec.run === "object") {
    const runCfg = spec.run as Record<string, unknown>;
    if (runCfg.workspace !== undefined) {
      if (runCfg.workspace !== "direct" && runCfg.workspace !== "worktree") {
        throw new Error(
          `workflow.yml in ${workflowDir} has invalid run.workspace value: ` +
          `"${String(runCfg.workspace)}". Must be "direct" or "worktree".`,
        );
      }
    }
  }

  return spec as unknown as WorkflowSpec;
}

/**
 * Load and parse a workflow.yml file from a workflow directory.
 * Returns a validated WorkflowSpec.
 */
export async function loadWorkflowSpec(
  workflowDir: string,
): Promise<WorkflowSpec> {
  const ymlPath = path.join(workflowDir, "workflow.yml");
  let raw: string;
  try {
    raw = await fs.readFile(ymlPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new Error(
        `No workflow.yml found in ${workflowDir}. Expected a workflow specification file.`,
      );
    }
    throw err;
  }

  return parseAndValidateWorkflowSpec(raw, workflowDir);
}

/**
 * Synchronous variant of loadWorkflowSpec. Used in contexts where async is
 * not practical (e.g. completeStep expects-validation, orphan recovery).
 */
export function loadWorkflowSpecSync(workflowDir: string): WorkflowSpec {
  const ymlPath = path.join(workflowDir, "workflow.yml");
  let raw: string;
  try {
    raw = fsSync.readFileSync(ymlPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new Error(
        `No workflow.yml found in ${workflowDir}. Expected a workflow specification file.`,
      );
    }
    throw err;
  }

  return parseAndValidateWorkflowSpec(raw, workflowDir);
}
