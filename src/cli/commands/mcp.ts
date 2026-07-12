/**
 * mcp command group — manage the standalone MCP HTTP server.
 *
 * Extracted from src/cli/cli.ts (SPLC story US-005).
 */

import { startMcp, stopMcp, restartMcp, getMcpStatus } from "../../server/daemonctl.js";
import { DEFAULT_MCP_PORT, MCP_ENDPOINT_PATH } from "../../server/mcp-server.js";

export function getMcpHelp(): string {
  return `tamandua mcp — Manage the standalone MCP HTTP server

Usage: tamandua mcp <start|stop|restart|status>

The MCP (Model Context Protocol) server provides a remote MCP endpoint for
agent tool access. It runs as a standalone HTTP server, independent of the
dashboard daemon.

Default port: 3338
Default endpoint: http://localhost:3338/mcp

Subcommands:
  start   [--port N]   Start the MCP server on the given port
  stop                 Stop the MCP server
  restart [--port N]   Restart the MCP server
  status               Show whether the MCP server is running (PID, port, endpoint)

Start will refuse if the MCP server is already running, printing its current
status instead.

Examples:
  tamandua mcp start                   # Start on default port 3338
  tamandua mcp start --port 5555       # Start on a custom port
  tamandua mcp stop                    # Stop the MCP server
  tamandua mcp restart                 # Restart on current/default port
  tamandua mcp restart --port 5555     # Restart on port 5555
  tamandua mcp status                  # Check if the MCP server is running`;
}

export function getMcpStartHelp(): string {
  return `tamandua mcp start — Start the standalone MCP HTTP server

Usage: tamandua mcp start [--port N]

Starts the MCP server on the specified port (default: 3338). The server
provides a remote MCP endpoint at http://localhost:<port>/mcp.

If the MCP server is already running, the command prints the current
PID, port, and endpoint instead of starting a duplicate.

Options:
  --port N    Port to listen on (default: 3338)

Examples:
  tamandua mcp start                   # Start on default port 3338
  tamandua mcp start --port 5555       # Start on port 5555`;
}

export function getMcpStopHelp(): string {
  return `tamandua mcp stop — Stop the standalone MCP HTTP server

Usage: tamandua mcp stop

Stops the MCP server if it is running. If the server is not running, the
command prints a message and exits successfully — it is safe to run even
when no MCP server is active.

Examples:
  tamandua mcp stop`;
}

export function getMcpRestartHelp(): string {
  return `tamandua mcp restart — Restart the MCP HTTP server

Usage: tamandua mcp restart [--port N]

Restarts the MCP server. If the server is currently running, it is
stopped first, then a new server is started on the given port (or the
previously configured port if no --port is specified). If the server is
not running, this command behaves like start.

Options:
  --port N    Port to restart on (default: currently configured port or 3338)

Examples:
  tamandua mcp restart            # Restart on current/default port
  tamandua mcp restart --port 5555 # Restart on port 5555`;
}

export function getMcpStatusHelp(): string {
  return `tamandua mcp status — Show MCP server status

Usage: tamandua mcp status

Reports whether the MCP server is running. When running, it prints the
PID, port, and full endpoint URL. When not running, it prints the default
endpoint that would be used on start.

Examples:
  tamandua mcp status`;
}

/**
 * Handle mcp command group (start, stop, restart, status).
 * Returns true if the command was handled, false if not recognized.
 */
export async function handleMcp(group: string, args: string[]): Promise<boolean> {
  if (group !== "mcp") return false;

  const sub = args[1];

  if (sub === "stop") {
    console.log(stopMcp() ? "MCP server stopped." : "MCP server is not running.");
    return true;
  }

  if (sub === "restart") {
    let restartPort: number | undefined;
    const restartPortIdx = args.indexOf("--port");
    if (restartPortIdx !== -1 && args[restartPortIdx + 1]) {
      restartPort = parseInt(args[restartPortIdx + 1], 10) || undefined;
    }
    // Support positional port: tamandua mcp restart 5555
    const restartPosIdx = args.indexOf("restart") + 1;
    const restartPosArg = args[restartPosIdx];
    if (restartPosArg && !restartPosArg.startsWith("-")) {
      const p = parseInt(restartPosArg, 10);
      if (!Number.isNaN(p)) restartPort = p;
    }
    try {
      const restartResult = await restartMcp(restartPort);
      console.log(`MCP server restarted (PID ${restartResult.pid})`);
      console.log(`Endpoint: http://localhost:${restartResult.port}${MCP_ENDPOINT_PATH}`);
    } catch (err) {
      process.stderr.write(`Failed to restart MCP: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    return true;
  }

  if (sub === "status") {
    const { getMcpStatusAsync: mcpStatusAsync } = await import("../../server/daemonctl.js");
    const st = await mcpStatusAsync();
    if (!st.running) {
      console.log("MCP server is not running.");
      console.log(`Default endpoint: http://localhost:${st.port}${st.endpoint}`);
      return true;
    }
    console.log(`MCP server running (PID ${st.pid})`);
    console.log(`Port: ${st.port}`);
    console.log(`Endpoint: http://localhost:${st.port}${st.endpoint}`);
    return true;
  }

  // Default: start
  let port = DEFAULT_MCP_PORT;
  const portIdx = args.indexOf("--port");
  if (portIdx !== -1 && args[portIdx + 1]) {
    port = parseInt(args[portIdx + 1], 10) || DEFAULT_MCP_PORT;
  }
  // Support positional port as well: tamandua mcp start 5555
  if (sub && sub !== "start" && !sub.startsWith("-")) {
    const p = parseInt(sub, 10);
    if (!Number.isNaN(p)) port = p;
  }
  const running = getMcpStatus();
  if (running.running) {
    console.log(`MCP server already running (PID ${running.pid})`);
    console.log(`Port: ${running.port}`);
    console.log(`Endpoint: http://localhost:${running.port}${running.endpoint}`);
    return true;
  }
  try {
    const result = await startMcp(port);
    console.log(`MCP server started (PID ${result.pid})`);
    console.log(`Endpoint: http://localhost:${result.port}${MCP_ENDPOINT_PATH}`);
  } catch (err) {
    process.stderr.write(`Failed to start MCP: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  return true;
}
