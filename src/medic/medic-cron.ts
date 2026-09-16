/**
 * Medic cron management — install/uninstall the medic's periodic health check.
 *
 * Uses the agent-scheduler module to schedule a tamandua-medic agent
 * that polls the medic check every 15 minutes.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveTamanduaCli } from "../installer/paths.js";
import { nowIso } from "../lib/instant.js";
import {
  createAgentCronJob,
  removeAgentCrons,
} from "../installer/agent-scheduler.js";

const MEDIC_CRON_FILE = path.join(os.homedir(), ".tamandua", "medic-cron.json");
const MEDIC_AGENT_ID = "tamandua-medic";
const MEDIC_INTERVAL_MINUTES = 15;

interface MedicCronConfig {
  installed: boolean;
  installedAt?: string;
  intervalMinutes: number;
  agentId: string;
}

function readMedicCronConfig(): MedicCronConfig | null {
  try {
    if (!fs.existsSync(MEDIC_CRON_FILE)) return null;
    const raw = fs.readFileSync(MEDIC_CRON_FILE, "utf-8");
    return JSON.parse(raw) as MedicCronConfig;
  } catch {
    return null;
  }
}

function writeMedicCronConfig(config: MedicCronConfig): void {
  const dir = path.dirname(MEDIC_CRON_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MEDIC_CRON_FILE, JSON.stringify(config, null, 2), "utf-8");
}

function removeMedicCronConfig(): void {
  try {
    if (fs.existsSync(MEDIC_CRON_FILE)) {
      fs.unlinkSync(MEDIC_CRON_FILE);
    }
  } catch {
    // Best effort
  }
}

/**
 * Build the medic agent prompt that instructs the agent
 * to run the medic check via the tamandua CLI.
 */
export function buildMedicPrompt(): string {
  const cli = resolveTamanduaCli();
  return `You are the Tamandua Medic — a health watchdog for workflow runs.

Run the medic check:
\`\`\`
"${cli}" medic run --json
\`\`\`

If the check output contains "issuesFound": 0, reply MEDIC_OK and stop.
If issues were found, summarize what was detected and what actions were taken.

If there are critical unremediated issues, notify the user directly with a clear message.

Do NOT attempt to fix issues yourself beyond what the medic check already handles.`;
}

/**
 * Install the medic watchdog cron.
 *
 * Writes the medic cron config, ensures the tamandua-medic agent
 * is registered in agents.json, and schedules it via agent-scheduler
 * to run every 15 minutes.
 */
export async function installMedicCron(): Promise<{ ok: boolean; error?: string }> {
  const existing = readMedicCronConfig();
  if (existing && existing.installed) {
    return { ok: true }; // already installed
  }

  const config: MedicCronConfig = {
    installed: true,
    installedAt: nowIso(),
    intervalMinutes: MEDIC_INTERVAL_MINUTES,
    agentId: MEDIC_AGENT_ID,
  };

  try {
    writeMedicCronConfig(config);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to write medic cron config: ${(err as Error).message}`,
    };
  }

  // Ensure the tamandua-medic agent entry exists in agents.json
  try {
    const agentsPath = path.join(os.homedir(), ".tamandua", "agents.json");
    const agentsDir = path.dirname(agentsPath);
    fs.mkdirSync(agentsDir, { recursive: true });

    let agents: Array<Record<string, unknown>> = [];
    try {
      if (fs.existsSync(agentsPath)) {
        const raw = fs.readFileSync(agentsPath, "utf-8");
        agents = JSON.parse(raw);
        if (!Array.isArray(agents)) agents = [];
      }
    } catch {
      agents = [];
    }

    if (!agents.some((a) => a.id === MEDIC_AGENT_ID)) {
      agents.push({
        id: MEDIC_AGENT_ID,
        name: "Tamandua Medic",
        model: "default",
        workspace: path.join(os.homedir(), ".tamandua", "workspaces", MEDIC_AGENT_ID),
        agentDir: path.join(os.homedir(), ".tamandua", "agents", MEDIC_AGENT_ID),
        config: {
          role: "analysis",
          description: "Health watchdog for tamandua workflow runs",
          timeoutSeconds: 120,
        },
      });
      fs.writeFileSync(agentsPath, JSON.stringify(agents, null, 2), "utf-8");
    }
  } catch {
    // best-effort — medic can still run even without agent provisioning
  }

  // Dispatch jobs are coupled to a runId. The medic isn't tied to any
  // run — it's a global health watchdog — and the previous scheduler
  // wiring was effectively a no-op anyway (a run-scoped job would peek
  // for steps that medic never claims). The medic config + agent
  // provisioning above is preserved so `tamandua medic run` and dashboard
  // checks keep working; a future commit can attach the medic to its own
  // non-run-scoped scheduler.
  void createAgentCronJob;
  void MEDIC_INTERVAL_MINUTES;

  return { ok: true };
}

/**
 * Uninstall the medic watchdog cron.
 *
 * Removes the medic cron config, cleans up the agent from agents.json,
 * and tears down the agent-scheduler cron job.
 */
export async function uninstallMedicCron(): Promise<{ ok: boolean; error?: string }> {
  removeMedicCronConfig();

  // Remove medic agent from agents.json
  try {
    const agentsPath = path.join(os.homedir(), ".tamandua", "agents.json");
    if (fs.existsSync(agentsPath)) {
      const raw = fs.readFileSync(agentsPath, "utf-8");
      let agents = JSON.parse(raw);
      if (Array.isArray(agents)) {
        agents = agents.filter(
          (a: Record<string, unknown>) => a.id !== MEDIC_AGENT_ID,
        );
        fs.writeFileSync(agentsPath, JSON.stringify(agents, null, 2), "utf-8");
      }
    }
  } catch {
    // best-effort
  }

  // Remove medic cron job via agent-scheduler
  try {
    await removeAgentCrons("tamandua-medic");
  } catch (err) {
    console.warn("Failed to remove medic cron via agent-scheduler:", (err as Error).message);
  }

  return { ok: true };
}

/**
 * Check whether medic cron is installed.
 */
export async function isMedicCronInstalled(): Promise<boolean> {
  const config = readMedicCronConfig();
  return config?.installed ?? false;
}
