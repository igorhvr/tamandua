/**
 * dashboard command group — manage the web dashboard daemon.
 *
 * Extracted from src/cli/cli.ts (SPLC story US-006).
 */

import { startDaemon, stopDaemon, restartDaemon, getDaemonStatus, isRunning } from "../../server/daemonctl.js";
import { MCP_ENDPOINT_PATH } from "../../server/mcp-server.js";

export function getDashboardHelp(): string {
  return `tamandua dashboard — Manage the web dashboard daemon

Usage: tamandua dashboard <start|stop|status>

The dashboard daemon runs the Tamandua web dashboard, a local HTTP server
for monitoring workflow runs, logs, and agent activity. It also shows the
status of the standalone MCP server.

Default port: 3334

Subcommands:
  start   [--port N]   Start the dashboard daemon on the given port
  stop                 Stop the dashboard daemon
  restart [--port N]   Restart the dashboard daemon
  status               Show dashboard status and MCP server status

Dashboard status output includes both dashboard and MCP server information
(PID, port, endpoint for each).

Start will refuse if the dashboard is already running.

Examples:
  tamandua dashboard start             # Start on default port 3334
  tamandua dashboard start --port 8080 # Start on port 8080
  tamandua dashboard stop              # Stop the dashboard
  tamandua dashboard restart           # Restart on current/default port
  tamandua dashboard status            # Check dashboard and MCP status`;
}

export function getDashboardStartHelp(): string {
  return `tamandua dashboard start — Start the web dashboard daemon

Usage: tamandua dashboard start [--port N]

Starts the dashboard daemon on the specified port (default: 3334). The
dashboard provides an HTTP interface at http://localhost:<port> for
monitoring workflow runs, logs, and agent activity.

The daemon also co-manages the standalone MCP server; the dashboard
status command will report both services.

If the dashboard is already running, the command prints the current
status instead of starting a duplicate.

Options:
  --port N    Port to listen on (default: 3334)

Examples:
  tamandua dashboard start             # Start on default port 3334
  tamandua dashboard start --port 8080 # Start on port 8080`;
}

export function getDashboardStopHelp(): string {
  return `tamandua dashboard stop — Stop the web dashboard daemon

Usage: tamandua dashboard stop

Stops the dashboard daemon if it is running. If the daemon is not running,
the command prints a message and exits successfully.

Examples:
  tamandua dashboard stop`;
}

export function getDashboardRestartHelp(): string {
  return `tamandua dashboard restart — Restart the web dashboard daemon

Usage: tamandua dashboard restart [--port N]

Restarts the dashboard daemon. If the daemon is currently running, it is
stopped first, then a new daemon is started on the given port (or the
previously configured port if no --port is specified). If the daemon is
not running, this command behaves like start.

Options:
  --port N    Port to restart on (default: currently configured port or 3334)

Examples:
  tamandua dashboard restart            # Restart on current/default port
  tamandua dashboard restart --port 8080 # Restart on port 8080`;
}

export function getDashboardStatusHelp(): string {
  return `tamandua dashboard status — Show dashboard and MCP server status

Usage: tamandua dashboard status

Reports whether the dashboard daemon is running (PID, port) and also
shows the status of the MCP server. When either service is running, it
prints PID, port, and endpoint URL. When not running, it prints the
default endpoint that would be used on start.

Examples:
  tamandua dashboard status`;
}

/**
 * Handle dashboard command group (start, stop, restart, status).
 * Returns true if the command was handled, false if not recognized.
 */
export async function handleDashboard(group: string, args: string[]): Promise<boolean> {
  if (group !== "dashboard") return false;

  const sub = args[1];

  if (sub === "stop") {
    console.log(stopDaemon() ? "Dashboard stopped." : "Dashboard is not running.");
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
      const result = await restartDaemon(port);
      console.log(`Dashboard restarted (PID ${result.pid})\n  http://localhost:${result.port}`);
    } catch (err) {
      process.stderr.write(`Failed to restart dashboard: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    return true;
  }

  if (sub === "status") {
    const st = getDaemonStatus();
    const { getMcpStatusAsync: mcpStatusAsync } = await import("../../server/daemonctl.js");
    const mcp = await mcpStatusAsync();

    if (!st.running) {
      console.log("Dashboard is not running.");
    } else {
      console.log(`Dashboard running (PID ${st.pid})`);
      console.log(`Dashboard endpoint: http://localhost:${st.port}`);
    }

    if (!mcp.running) {
      console.log("MCP server is not running.");
      console.log(`Default MCP endpoint: http://localhost:${mcp.port}${mcp.endpoint}`);
    } else {
      console.log(`MCP server running (PID ${mcp.pid})`);
      console.log(`MCP endpoint: http://localhost:${mcp.port}${mcp.endpoint}`);
    }
    return true;
  }

  // Default: start
  let port = 3334; const portIdx = args.indexOf("--port");
  if (portIdx !== -1 && args[portIdx + 1]) port = parseInt(args[portIdx + 1], 10) || 3334;
  else if (sub && sub !== "start" && !sub.startsWith("-")) { const p = parseInt(sub, 10); if (!Number.isNaN(p)) port = p; }
  if (isRunning().running) { const status = getDaemonStatus(); if (status.running) console.log(`Dashboard already running (PID ${status.pid})`); console.log(`  http://localhost:${port}`); return true; }
  const result = await startDaemon(port); console.log(`Dashboard started (PID ${result.pid})\n  http://localhost:${result.port}`); return true;
}
