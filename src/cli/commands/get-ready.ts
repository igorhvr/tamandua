/**
 * Installation lifecycle commands: get-ready and full uninstall.
 *
 * Extracted mechanically from src/cli/cli.ts (SPL2 story US-003).
 */

import { installWorkflow } from "../../installer/install.js";
import { checkActiveRuns, uninstallAllWorkflows } from "../../installer/uninstall.js";
import { listBundledWorkflows } from "../../installer/workflow-fetch.js";
import { ensureCliSymlink } from "../../installer/symlink.js";
import {
  getMcpStatus,
  isDashboardRunning,
  isMcpRunning,
  isRunning,
  startDaemon,
  startDashboardStandalone,
  startMcp,
  stopDaemon,
  stopMcp,
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
  4. If the daemon (control-plane+motor) is not running, starts it so
     workflow runs can be scheduled.
  5. If the dashboard standalone UI process is not running, starts it on
     the default port (3334) so you can monitor workflow runs.
  6. If the MCP server is not running, starts it on the default port
     (3338).

All three processes are started independently — if one fails, the others
still start. Each has its own PID file and log.

Examples:
  tamandua get-ready            # Install all bundled workflows and start daemon/dashboard/MCP
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
  3. Stops the daemon if it is running.
  4. Stops the standalone dashboard UI process if it is running.
  5. Stops the standalone MCP server if it is running.
  6. Uninstalls every workflow: removes workflow directories, agent
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
 * Handle installation lifecycle commands.
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
    // Start daemon (control-plane+motor) first
    if (!isRunning().running) { try { const r = await startDaemon(); console.log(`\nDaemon started (PID ${r.pid})`); } catch (err) { console.log(`\nNote: daemon not started: ${err instanceof Error ? err.message : String(err)} (recover: tamandua daemon start)`); } }
    else console.log("\nDaemon already running.");
    // Start dashboard standalone independently
    if (!isDashboardRunning().running) { try { const r = await startDashboardStandalone(3334); console.log(`Dashboard started (PID ${r.pid}): http://localhost:${r.port}`); } catch (err) { console.log(`Note: dashboard not started: ${err instanceof Error ? err.message : String(err)} (recover: tamandua dashboard start)`); } }
    else console.log("Dashboard already running.");
    // Start MCP independently
    if (!getMcpStatus().running) { try { const r = await startMcp(); console.log(`MCP server started (PID ${r.pid}): http://localhost:${r.port}/mcp`); } catch (err) { console.log(`Note: MCP server not started: ${err instanceof Error ? err.message : String(err)} (recover: tamandua mcp start)`); } }
    else console.log("MCP server already running.");
    return true;
  }

  return false;
}
