/**
 * get-ready and uninstall top-level commands.
 *
 * Extracted from src/cli/cli.ts (SPLC story US-003).
 * Both commands share the install/uninstall domain.
 */

import { installWorkflow } from "../../installer/install.js";
import { uninstallAllWorkflows, checkActiveRuns } from "../../installer/uninstall.js";
import { listBundledWorkflows } from "../../installer/workflow-fetch.js";
import { ensureCliSymlink } from "../../installer/symlink.js";
import {
  startDaemon,
  stopDaemon,
  isRunning,
  stopMcp,
  isMcpRunning,
  startMcp,
  getMcpStatus,
  startControlPlane,
  getControlPlaneStatus,
} from "../../server/daemonctl.js";

export function getGetReadyHelp(): string {
  return `tamandua get-ready — Install all bundled workflows from the source checkout

Usage: tamandua get-ready

tamandua get-ready sets up Tamandua by installing every bundled workflow and
establishing the CLI symlink so tamandua is available on your PATH.

In order, it does this:

  1. Lists all bundled workflows available in the source checkout.
  2. Installs each workflow: fetches workflow files, loads the YAML spec,
     provisions agent workspaces (AGENTS.md, IDENTITY.md, SOUL.md), and
     registers agents in ~/.tamandua/agents.json.
  3. Creates the CLI symlink at ~/.local/bin/tamandua (or updates it if
     it already exists).
  4. Reports whether the dashboard daemon is already running.
  5. If the dashboard is not running, starts it on the default port
     (3334) so you can monitor workflow runs.
  6. If the MCP server is not running, starts it on the default port
     (3338).
  7. If the control plane is not running, starts it on the default
     port (3339).

Examples:
  tamandua get-ready            # Install all bundled workflows and start dashboard/MCP/control plane
  tamandua workflow install <name>  # Install a single workflow by name`;
}

export function getUninstallHelp(): string {
  return `tamandua uninstall — Fully remove Tamandua workflows, agents, and services

Usage: tamandua uninstall [--force]

tamandua uninstall stops all Tamandua services and removes every installed
workflow, including agent workspaces, agent registrations, and cron jobs.

In order, it does this:

  1. Checks for active runs with status running or paused.
  2. If active runs exist and --force is not set, lists them and exits
     with code 1.
  3. Stops the dashboard daemon if it is running.
  4. Stops the standalone MCP server if it is running.
  5. Uninstalls every workflow: removes workflow directories, agent
     workspaces, agent entries from ~/.tamandua/agents.json, and cron
     jobs. Stops and removes any managed git worktrees associated with
     completed runs.

Options:
  --force    Skip the active-runs check and uninstall anyway.

Examples:
  tamandua uninstall          # Full uninstall (refuses if active runs exist)
  tamandua uninstall --force  # Force uninstall despite active runs
  tamandua workflow uninstall <name>  # Uninstall a single workflow by name
  tamandua workflow uninstall --all   # Uninstall all workflows only (no service stops)`;
}

/**
 * Handle get-ready and uninstall commands.
 * Returns true if the command was handled, false if not recognized.
 */
export async function handleGetReady(group: string, args: string[]): Promise<boolean> {
  if (group === "uninstall" && (!args[1] || args[1] === "--force")) {
    const force = args.includes("--force");
    const activeRuns = await checkActiveRuns();
    if (activeRuns.length > 0 && !force) {
      process.stderr.write(`Cannot uninstall: ${activeRuns.length} active run(s):\n`);
      for (const run of activeRuns) process.stderr.write(`  - ${run.id}: ${run.task}\n`);
      process.stderr.write(`\nUse --force to uninstall anyway.\n`); process.exit(1);
    }
    if (isRunning().running) { stopDaemon(); console.log("Dashboard stopped."); }
    if (isMcpRunning().running) { stopMcp(); console.log("MCP server stopped."); }
    await uninstallAllWorkflows();
    console.log("Tamandua fully uninstalled."); return true;
  }

  if (group === "get-ready" && !args[1]) {
    const workflows = await listBundledWorkflows();
    if (workflows.length === 0) { console.log("No bundled workflows found."); return true; }
    console.log(`Installing ${workflows.length} workflow(s)...`);
    let failures = 0;
    for (const wf of workflows) { try { await installWorkflow({ workflowId: wf }); console.log(`  ✓ ${wf}`); } catch (err) { failures++; console.log(`  ✗ ${wf}: ${err instanceof Error ? err.message : String(err)}`); } }
    if (failures > 0) { console.log(`\n${failures} of ${workflows.length} workflows failed to install`); process.exitCode = 1; }
    ensureCliSymlink();
    console.log(`\nDone. Start with: tamandua workflow run <name> "your task"`);
    if (!isRunning().running) { try { const r = await startDaemon(3334); console.log(`\nDashboard started (PID ${r.pid}): http://localhost:${r.port}`); } catch (err) { console.log(`\nNote: dashboard not started: ${err instanceof Error ? err.message : String(err)} (recover: tamandua dashboard restart)`); } }
    else console.log("\nDashboard already running.");
    if (!getMcpStatus().running) { try { const r = await startMcp(); console.log(`\nMCP server started (PID ${r.pid}): http://localhost:${r.port}/mcp`); } catch (err) { console.log(`\nNote: MCP server not started: ${err instanceof Error ? err.message : String(err)} (recover: tamandua mcp start)`); } }
    else console.log("\nMCP server already running.");
    if (!getControlPlaneStatus().running) { try { const r = await startControlPlane(); console.log(`\nControl plane started (PID ${r.pid}): http://localhost:${r.port}/control/health`); } catch (err) { console.log(`\nNote: control plane not started: ${err instanceof Error ? err.message : String(err)} (recover: tamandua control-plane start)`); } }
    else console.log("\nControl plane already running.");
    return true;
  }

  return false;
}
