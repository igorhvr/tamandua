/**
 * tamandua restart — Restart all tamandua services with a real stop→ready barrier.
 *
 * Flow:
 *  1. Refuse when active workflow runs exist (unless --force).
 *  2. Stop services in order: dashboard → MCP → daemon.
 *     After each stop, poll until the service is gone (pidfile cleared/stale
 *     AND port no longer accepts connections), with a per-service ~10s timeout.
 *  3. Start services in order: daemon → dashboard → MCP.
 *     Each start includes built-in health waits (pidfile + port/health endpoint).
 *  4. Does NOT: git pull, rebuild, reinstall workflows, or touch ~/.tamandua/workflows.
 *  5. Output: one line per service per phase, final "All services restarted."
 *  6. Reuses primitives from daemonctl — no duplicated process-management logic.
 *  7. Respects the self-stop guard (underlying stop functions check TAMANDUA_WORKER_PID).
 */

import { checkActiveRuns, type ActiveRunInfo } from "../../installer/uninstall.js";
import {
  isDashboardRunning,
  isMcpRunning,
  isRunning,
  readMcpPort,
  readPort,
  startDaemon,
  startDashboardStandalone,
  startMcp,
  stopDaemon,
  stopDashboardStandalone,
  stopMcp,
  waitForDaemonStop,
  waitForDashboardStop,
  waitForMcpStop,
} from "../../server/daemonctl.js";

function formatActiveRuns(activeRuns: ActiveRunInfo[]): string {
  return activeRuns
    .map((run) => `  - ${run.id}: [${run.status}] ${run.task}`)
    .join("\n");
}

export function getRestartHelp(): string {
  return `tamandua restart — Restart all tamandua services with a stop→ready barrier

Usage: tamandua restart [--force]

Restarts all tamandua services (daemon, dashboard, MCP) from the currently
installed build. Waits for each service to actually stop before starting the
next — no sleep guessing.

This command is the sanctioned "pick up a locally rebuilt tree" step:
  1. ./build-and-install
  2. tamandua restart

It does NOT git pull, rebuild, reinstall workflows, or touch
~/.tamandua/workflows. It only restarts services from whatever is currently
installed.

Options:
  --force    Proceed despite active (running/paused) workflow runs.
             Without --force, restart refuses when active runs exist.

Examples:
  tamandua restart           # Restart all services (refuses if runs active)
  tamandua restart --force   # Restart despite active runs`;
}

/**
 * Handle tamandua restart command.
 * Returns true if the command was handled, false if not recognized.
 */
export async function handleRestart(group: string, args: string[]): Promise<boolean> {
  if (group !== "restart") return false;

  const force = args.includes("--force");

  // 1. Check for active runs
  const activeRuns = await checkActiveRuns();
  if (activeRuns.length > 0 && !force) {
    process.stderr.write(
      `Active Tamandua runs detected (${activeRuns.length}). Refusing to restart.\n` +
      `${formatActiveRuns(activeRuns)}\n\n` +
      "Run `tamandua restart --force` to restart despite active runs.\n",
    );
    process.exit(1);
  }

  if (activeRuns.length > 0) {
    process.stderr.write(
      `Active runs detected (${activeRuns.length}) but --force given; proceeding anyway.\n`,
    );
  }

  // 2. Save configured ports before stopping — stop functions clean up port
  //    files, so we must capture them now to avoid falling back to defaults.
  const dashPort = readPort();
  const mcpPort = readMcpPort();

  // 3. Stop services in order: dashboard → MCP → daemon
  //    Each stop + barrier wait, with clear error on timeout.
  try {
    // Stop dashboard
    const dashRunning = isDashboardRunning();
    if (dashRunning.running) {
      stopDashboardStandalone();
      await waitForDashboardStop();
      console.log("dashboard: stopped");
    } else {
      console.log("dashboard: not running");
    }
  } catch (err) {
    process.stderr.write(
      `dashboard failed to stop: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  try {
    // Stop MCP
    const mcpRunning = isMcpRunning();
    if (mcpRunning.running) {
      stopMcp();
      await waitForMcpStop();
      console.log("mcp: stopped");
    } else {
      console.log("mcp: not running");
    }
  } catch (err) {
    process.stderr.write(
      `mcp failed to stop: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  try {
    // Stop daemon
    const daemonRunning = isRunning();
    if (daemonRunning.running) {
      stopDaemon();
      await waitForDaemonStop();
      console.log("daemon: stopped");
    } else {
      console.log("daemon: not running");
    }
  } catch (err) {
    process.stderr.write(
      `daemon failed to stop: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  // 4. Start services in order: daemon → dashboard → MCP
  //    Each start includes built-in health waits (pidfile + health endpoint).
  try {
    const daemonResult = await startDaemon();
    console.log(`daemon: started (pid ${daemonResult.pid}, port ${daemonResult.port})`);
  } catch (err) {
    process.stderr.write(
      `daemon failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  try {
    const dashResult = await startDashboardStandalone(dashPort);
    console.log(`dashboard: started (pid ${dashResult.pid}, port ${dashResult.port})`);
  } catch (err) {
    process.stderr.write(
      `dashboard failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  try {
    const mcpResult = await startMcp(mcpPort);
    console.log(`mcp: started (pid ${mcpResult.pid}, port ${mcpResult.port})`);
  } catch (err) {
    process.stderr.write(
      `mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  console.log("All services restarted.");
  return true;
}
