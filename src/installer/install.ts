import fs from "node:fs/promises";
import path from "node:path";
import { fetchWorkflow } from "./workflow-fetch.js";
import { loadWorkflowSpec } from "./workflow-spec.js";
import { provisionAgents } from "./agent-provision.js";
import { readPiConfig, type PiConfig } from "./pi-config.js";
import { resolvePiStateDir, resolveSourcePath } from "./paths.js";
import type { AgentRole, WorkflowInstallResult } from "./types.js";
import { writeCatalogStamp } from "./catalog-version.js";

// ── Agent list management (Tamandua stores agents at ~/.tamandua/agents.json) ──

function resolveAgentsPath(): string {
  return path.join(resolvePiStateDir(), "agents.json");
}

async function readAgentsList(): Promise<Array<Record<string, unknown>>> {
  const filePath = resolveAgentsPath();
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    throw err;
  }
}

async function writeAgentsList(list: Array<Record<string, unknown>>): Promise<void> {
  const filePath = resolveAgentsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = `${JSON.stringify(list, null, 2)}\n`;
  await fs.writeFile(filePath, content, "utf-8");
}

function ensureAgentList(agents: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return agents;
}

/**
 * Ensure the user's main agent is explicitly in the list with `default: true`.
 * On pi, the main agent is the default interactive session — we keep the structure
 * for compatibility but pi doesn't have agent routing the same way OpenClaw does.
 */
function ensureMainAgentInList(list: Array<Record<string, unknown>>): void {
  // If any entry already has default: true, routing is configured — don't touch it
  if (list.some((entry) => entry.default === true)) return;

  // If "main" agent already exists in the list, just mark it as default
  const existing = list.find((entry) => entry.id === "main");
  if (existing) {
    existing.default = true;
    return;
  }

  // Main agent isn't in the list — add a minimal entry so it stays the default.
  list.unshift({
    id: "main",
    name: "Main",
    default: true,
  });
}

// ── Role policies (kept for documentation and timeout configuration) ──
// Pi doesn't have tool profiles like OpenClaw, so these are simplified to
// role descriptions and timeout values only.

const TIMEOUT_60_MIN = 3600;
const TIMEOUT_90_MIN = 5400;

interface RolePolicy {
  description: string;
  timeoutSeconds: number;
}

const ROLE_POLICIES: Record<AgentRole, RolePolicy> = {
  // analysis: read-only code exploration (planner, prioritizer, reviewer, investigator, triager)
  analysis: {
    description: "Read-only code exploration and reasoning — no file modification, web, or browser access",
    timeoutSeconds: TIMEOUT_90_MIN,
  },

  // coding: full read/write/exec — the workhorses (developer, fixer, setup)
  coding: {
    description: "Full read/write/exec for implementation work — the primary workhorse role",
    timeoutSeconds: TIMEOUT_90_MIN,
  },

  // verification: read + exec but NO write — preserves independent verification integrity
  verification: {
    description: "Read + exec but NO write — independent verification and code review",
    timeoutSeconds: TIMEOUT_60_MIN,
  },

  // testing: read + exec + browser/web for E2E, NO write
  testing: {
    description: "Read + exec capability for running tests and E2E validation",
    timeoutSeconds: TIMEOUT_90_MIN,
  },

  // pr: just needs read + exec (for `gh pr create`)
  pr: {
    description: "Read + exec only — creates pull requests and manages version control",
    timeoutSeconds: TIMEOUT_60_MIN,
  },

  // scanning: read + exec + web (CVE lookups), NO write
  scanning: {
    description: "Read + exec for security scanning and vulnerability analysis",
    timeoutSeconds: TIMEOUT_60_MIN,
  },
};

/**
 * Return the highest configured role timeout (seconds).
 * Used by step-ops to derive the abandoned-step threshold.
 */
export function getMaxRoleTimeoutSeconds(): number {
  return Math.max(...Object.values(ROLE_POLICIES).map(r => r.timeoutSeconds));
}

/**
 * Return the per-role execution timeout (seconds) used for individual
 * work rounds. This is the wall-clock budget the harness has to
 * claim/execute/complete a step once the dispatch motor spawns it.
 */
export function getRoleTimeoutSeconds(role: AgentRole): number {
  return ROLE_POLICIES[role].timeoutSeconds;
}

/**
 * Infer an agent's role from its id when not explicitly set in workflow YAML.
 * Matches common agent id patterns across all bundled workflows.
 */
export function inferRole(agentId: string): AgentRole {
  const id = agentId.toLowerCase();
  if (id.includes("planner") || id.includes("prioritizer") || id.includes("reviewer")
      || id.includes("investigator") || id.includes("triager")) return "analysis";
  if (id.includes("verifier")) return "verification";
  if (id.includes("tester")) return "testing";
  if (id.includes("scanner")) return "scanning";
  if (id === "pr" || id.includes("/pr")) return "pr";
  // developer, fixer, setup → coding
  return "coding";
}

/**
 * Build a tools/role config entry for an agent.
 * On pi, this is a role description rather than tool profiles
 * since pi doesn't have the same tool/profile system as OpenClaw.
 */
function buildToolsConfig(role: AgentRole): Record<string, unknown> {
  const policy = ROLE_POLICIES[role];
  return {
    role,
    description: policy.description,
    timeoutSeconds: policy.timeoutSeconds,
  };
}

// ── Pi config helpers (simplified — pi doesn't need the same cron/session config) ──

function ensureCronSessionRetention(_config: PiConfig): void {
  // Pi doesn't have cron-based session management — no-op for compatibility
}

function ensureSessionMaintenance(_config: PiConfig): void {
  // Pi doesn't have session maintenance config — no-op for compatibility
}

// ── Agent upsert ──

function upsertAgent(
  list: Array<Record<string, unknown>>,
  agent: {
    id: string;
    name?: string;
    model?: string;
    timeoutSeconds?: number;
    workspaceDir: string;
    agentDir: string;
    role: AgentRole;
  },
): void {
  const existing = list.find((entry) => entry.id === agent.id);
  // Never overwrite the user's default (main) agent — it was configured outside tamandua.
  if (existing?.default === true) return;
  const payload: Record<string, unknown> = {
    id: agent.id,
    name: agent.name ?? agent.id,
    workspace: agent.workspaceDir,
    agentDir: agent.agentDir,
    config: buildToolsConfig(agent.role),
  };
  if (agent.model) payload.model = agent.model;
  if (agent.timeoutSeconds !== undefined) payload.timeoutSeconds = agent.timeoutSeconds;
  if (existing) Object.assign(existing, payload);
  else list.push(payload);
}

// ── Workflow metadata ──

async function writeWorkflowMetadata(params: {
  workflowDir: string;
  workflowId: string;
  source: string;
}): Promise<void> {
  const content = {
    workflowId: params.workflowId,
    source: params.source,
    installedAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(params.workflowDir, "metadata.json"),
    `${JSON.stringify(content, null, 2)}\n`,
    "utf-8",
  );
}

// ── Main installer ──

/**
 * Install a workflow: fetch, load spec, provision agent workspaces, and register agents.
 */
export async function installWorkflow(params: {
  workflowId: string;
}): Promise<WorkflowInstallResult> {
  const { workflowDir, bundledSourceDir } = await fetchWorkflow(params.workflowId);
  const workflow = await loadWorkflowSpec(workflowDir);
  // overwriteFiles: true so reinstalling picks up updated bundled persona /
  // workspace.files content. Without this, edits to AGENTS.md / SOUL.md /
  // IDENTITY.md silently never reach the agent workspace.
  const provisioned = await provisionAgents({ workflow, workflowDir, bundledSourceDir, overwriteFiles: true });

  // Build a role lookup: workflow agent id → role (explicit or inferred)
  const roleMap = new Map<string, AgentRole>();
  for (const agent of workflow.agents) {
    roleMap.set(agent.id, agent.role ?? inferRole(agent.id));
  }

  // Read pi config for reference (we don't modify pi's config, just read it)
  await readPiConfig();

  // Load and update the tamandua agents list
  const list = await readAgentsList();
  ensureMainAgentInList(list);

  // Check for agent ID collisions
  for (const agent of provisioned) {
    const existing = list.find((entry) => entry.id === agent.id);
    if (existing && !agent.id.startsWith(workflow.id + "_")) {
      throw new Error(
        `Agent ID collision: "${agent.id}" already exists from a different source`,
      );
    }
  }

  // Upsert each provisioned agent into the tamandua agents list
  for (const agent of provisioned) {
    // Extract the local agent id (strip the workflow prefix + separator)
    const prefix = workflow.id + "_";
    const localId = agent.id.startsWith(prefix)
      ? agent.id.slice(prefix.length)
      : agent.id;
    const role = roleMap.get(localId) ?? inferRole(localId);
    upsertAgent(list, { ...agent, role });
  }

  // Persist the updated agents list
  await writeAgentsList(list);

  // Write workflow metadata
  await writeWorkflowMetadata({
    workflowDir,
    workflowId: workflow.id,
    source: `bundled:${params.workflowId}`,
  });

  // Record catalog stamp so staleness checks can detect outdated installed prompts
  writeCatalogStamp(resolveSourcePath());

  return { workflowId: workflow.id, workflowDir };
}
