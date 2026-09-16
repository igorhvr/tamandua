import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { WorkflowSpec } from "./types.js";

const VALID_ON_FAIL_KEYS = new Set([
  "retry_step",
  "max_reroutes",
  "max_target_moved_reroutes",
  "retry_on",
]);

/**
 * Allowed values for a step's `type` field. Absent type defaults to
 * "single" (see run.ts step creation).
 */
const VALID_STEP_TYPES = new Set(["single", "loop", "conditional"]);

/**
 * Validates on_fail blocks on every step:
 * - Rejects unknown keys (only retry_step, max_reroutes,
 *   max_target_moved_reroutes, retry_on are valid).
 * - Enforces the M4 attestation rule: if a step has on_fail.retry_step, it must
 *   match the nearest upstream step whose input template contains TESTED_TREE
 *   (the attesting step).
 */
function validateOnFail(
  steps: Array<Record<string, unknown>>,
  workflowDir: string,
): void {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepId = String(step.id ?? `<unknown>`);

    if (!step.on_fail || typeof step.on_fail !== "object") continue;

    const onFail = step.on_fail as Record<string, unknown>;

    // Check for unknown keys
    for (const key of Object.keys(onFail)) {
      if (!VALID_ON_FAIL_KEYS.has(key)) {
        throw new Error(
          `workflow.yml step[${i}] ("${stepId}") on_fail in ${workflowDir} contains unknown key: "${key}". Valid keys are: retry_step, max_reroutes, max_target_moved_reroutes, retry_on.`,
        );
      }
    }

    // M4 attestation rule: if a step has on_fail.retry_step, it must match the
    // nearest upstream step whose input template contains TESTED_TREE.
    //
    // WAVE-A (US-006): conditional steps are exempt — they are read-only
    // review/audit steps whose on_fail.retry_step targets the producer of the
    // material under review (e.g. the TEST_CMD rewrite producer), which is
    // deliberately NOT the TESTED_TREE-attesting step. The M4 attestation
    // constraint only governs steps that reroute on TESTED_TREE attestation
    // failures.
    const retryStep = onFail.retry_step;
    if (typeof retryStep !== "string") continue;
    if (step.type === "conditional") continue;

    // Scan backwards to find the nearest upstream step declaring TESTED_TREE
    let attestingStepId: string | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const upstream = steps[j];
      const input = upstream.input;
      if (typeof input === "string" && input.includes("TESTED_TREE")) {
        attestingStepId = String(upstream.id ?? "");
        break;
      }
    }

    if (attestingStepId !== null && retryStep !== attestingStepId) {
      throw new Error(
        `workflow.yml step[${i}] ("${stepId}") on_fail.retry_step is "${retryStep}" but the attesting step that produces TESTED_TREE is "${attestingStepId}" in ${workflowDir}`,
      );
    }
  }
}

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

/**
 * REROUTE-BUDGET (NPF-3): `on_fail.max_target_moved_reroutes` caps how many
 * FAILURE_CLASS target_moved (stale-tip) reroutes a step may take on its own
 * budget. When present it must be a positive integer; omitting it is valid and
 * leaves the runtime default (16) in effect.
 */
function validateMaxTargetMovedReroutes(
  step: Record<string, unknown>,
  stepIndex: number,
  workflowDir: string,
): void {
  if (!step.on_fail || typeof step.on_fail !== "object") return;

  const value = (step.on_fail as Record<string, unknown>)
    .max_target_moved_reroutes;
  if (value === undefined) return;

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `workflow.yml step[${stepIndex}] ("${String(step.id)}") on_fail.max_target_moved_reroutes in ${workflowDir} must be a positive integer`,
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
    // Step type validation: single/loop/conditional, and the conditional
    // contract (a conditional step MUST declare a non-empty condition; a
    // non-conditional step MUST NOT declare a condition).
    if (
      step.type !== undefined &&
      (typeof step.type !== "string" || !VALID_STEP_TYPES.has(step.type))
    ) {
      throw new Error(
        `workflow.yml step[${i}] ("${step.id}") in ${workflowDir} has invalid type: "${String(step.type)}". Valid types are: single, loop, conditional.`,
      );
    }
    if (step.type === "conditional") {
      if (typeof step.condition !== "string" || step.condition.trim().length === 0) {
        throw new Error(
          `workflow.yml step[${i}] ("${step.id}") in ${workflowDir} is type conditional but is missing required field: condition (must be a non-empty string naming the run-context flag key)`,
        );
      }
    } else if (step.condition !== undefined) {
      throw new Error(
        `workflow.yml step[${i}] ("${step.id}") in ${workflowDir} declares condition but is not type conditional. Only type: conditional steps may declare a condition.`,
      );
    }
    validateRetryOn(step, i, workflowDir);
    validateMaxTargetMovedReroutes(step, i, workflowDir);
  }

  // Validate on_fail blocks after all steps are parsed (needed for M4 attestation rule)
  validateOnFail(spec.steps as Array<Record<string, unknown>>, workflowDir);

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
