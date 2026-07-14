/**
 * Standalone dashboard UI lifecycle commands.
 *
 * Extracted mechanically from src/cli/cli.ts (SPL2 story US-006).
 */

import {
  getDashboardStatus,
  isDashboardRunning,
  restartDashboardStandalone,
  startDashboardStandalone,
  stopDashboardStandalone,
} from "../../server/daemonctl.js";

export function getDashboardHelp(): string {
  return `tamandua dashboard — Manage the standalone web dashboard

Usage: tamandua dashboard <start|stop|restart|status>

The dashboard is a standalone UI process — an HTTP server for monitoring
workflow runs, logs, and agent activity. It runs independently of the daemon
(scheduling motor), so restarting the dashboard never affects in-flight runs.

Default port: 3334

Subcommands:
  start   [--port N]   Start the dashboard UI process on the given port
  stop                 Stop the dashboard (does not affect scheduling)
  restart [--port N]   Restart the dashboard safely (no motor impact)
  status               Show whether the dashboard and its port

Start will refuse if the dashboard is already running.

Examples:
  tamandua dashboard start             # Start on default port 3334
  tamandua dashboard start --port 8080 # Start on port 8080
  tamandua dashboard stop              # Stop the dashboard
  tamandua dashboard restart           # Restart on current/default port
  tamandua dashboard status            # Check dashboard status`;
}

export function getDashboardStartHelp(): string {
  return `tamandua dashboard start — Start the standalone dashboard UI process

Usage: tamandua dashboard start [--port N]

Starts the dashboard UI process on the specified port (default: 3334). The
dashboard provides an HTTP interface at http://localhost:<port> for
monitoring workflow runs, logs, and agent activity.

This only starts the dashboard — workflow scheduling is handled by the
daemon process (control-plane+motor). Use \`tamandua daemon start\` to
start the scheduling motor.

If the dashboard is already running, the command prints the current
status instead of starting a duplicate.

Options:
  --port N    Port to listen on (default: 3334)

Examples:
  tamandua dashboard start             # Start on default port 3334
  tamandua dashboard start --port 8080 # Start on port 8080`;
}

export function getDashboardStopHelp(): string {
  return `tamandua dashboard stop — Stop the standalone dashboard UI process

Usage: tamandua dashboard stop

Stops the dashboard UI process if it is running. If the dashboard is not
running, the command prints a message and exits successfully.

Stopping the dashboard does not affect workflow scheduling or in-flight
runs — the daemon (control-plane+motor) is a separate process.

Examples:
  tamandua dashboard stop`;
}

export function getDashboardRestartHelp(): string {
  return `tamandua dashboard restart — Restart the standalone dashboard UI process

Usage: tamandua dashboard restart [--port N]

Restarts the dashboard UI process. If the dashboard is currently running,
it is stopped first, then a new process is started on the given port (or the
previously configured port if no --port is specified). If the dashboard is
not running, this command behaves like start.

Restarting the dashboard has zero impact on the scheduling motor or in-flight
runs — the daemon (control-plane+motor) is a separate process.

Options:
  --port N    Port to restart on (default: currently configured port or 3334)

Examples:
  tamandua dashboard restart            # Restart on current/default port
  tamandua dashboard restart --port 8080 # Restart on port 8080`;
}

export function getDashboardStatusHelp(): string {
  return `tamandua dashboard status — Show standalone dashboard status

Usage: tamandua dashboard status

Reports whether the dashboard UI process is running. When running, it
prints the PID and port. When not running, it prints the default port
that would be used on start.

The dashboard status reports only the dashboard process — use
\`tamandua daemon status\` for the scheduling motor and
\`tamandua mcp status\` for the MCP server.

Examples:
  tamandua dashboard status`;
}

/**
 * Handle standalone dashboard lifecycle commands.
 * Returns true if the command was handled, false if not recognized.
 */
export async function handleDashboard(group: string, args: string[]): Promise<boolean> {
  if (group !== "dashboard") return false;

  const sub = args[1];
  if (sub === "stop") {
    console.log(stopDashboardStandalone() ? "Dashboard stopped." : "Dashboard is not running.");
    return true;
  }
  if (sub === "restart") {
    let port: number | undefined;
    const portIdx = args.indexOf("--port");
    if (portIdx !== -1 && args[portIdx + 1]) {
      port = parseInt(args[portIdx + 1], 10) || undefined;
    }
    // Support positional port: tamandua dashboard restart 5555
    const posIdx = args.indexOf("restart") + 1;
    const posArg = args[posIdx];
    if (posArg && !posArg.startsWith("-")) {
      const p = parseInt(posArg, 10);
      if (!Number.isNaN(p)) port = p;
    }
    try {
      const result = await restartDashboardStandalone(port);
      console.log(`Dashboard restarted (PID ${result.pid})\n  http://localhost:${result.port}`);
    } catch (err) {
      process.stderr.write(`Failed to restart dashboard: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    return true;
  }
  if (sub === "status") {
    const st = getDashboardStatus();
    if (!st.running) {
      console.log("Dashboard is not running.");
    } else {
      console.log(`Dashboard running (PID ${st.pid})`);
      console.log(`Dashboard endpoint: http://localhost:${st.port}`);
    }
    return true;
  }
  let port = 3334; const portIdx = args.indexOf("--port");
  if (portIdx !== -1 && args[portIdx + 1]) port = parseInt(args[portIdx + 1], 10) || 3334;
  else if (sub && sub !== "start" && !sub.startsWith("-")) { const p = parseInt(sub, 10); if (!Number.isNaN(p)) port = p; }
  if (isDashboardRunning().running) { const status = getDashboardStatus(); if (status.running) console.log(`Dashboard already running (PID ${status.pid})`); console.log(`  http://localhost:${port}`); return true; }
  const result = await startDashboardStandalone(port); console.log(`Dashboard started (PID ${result.pid})\n  http://localhost:${result.port}`); return true;
}
