/**
 * control-plane command group — manage the control plane server.
 *
 * Extracted from src/cli/cli.ts (SPLC story US-007).
 */

import { startControlPlane, stopControlPlane, restartControlPlane, getControlPlaneStatus } from "../../server/daemonctl.js";
import { DEFAULT_CONTROL_PORT } from "../../server/control-server.js";

export function getControlPlaneHelp(): string {
  return `tamandua control-plane — Manage the control plane server

Usage: tamandua control-plane <start|stop|status>

The control plane server provides a scheduling API for run-scoped agent
polling. The dashboard daemon communicates with the control plane to manage
which agents are actively polling and to dispatch work sessions.

Default port: 3339

Subcommands:
  start  [--port N]   Start the control plane server on the given port
  stop                Stop the control plane server
  restart [--port N]  Restart the control plane server
  status              Show whether the control plane is running (PID, port, endpoint)

Start will refuse if the control plane is already running, printing its
current status instead.

Examples:
  tamandua control-plane start               # Start on default port 3339
  tamandua control-plane start --port 4444   # Start on port 4444
  tamandua control-plane stop                # Stop the control plane
  tamandua control-plane restart             # Restart on current/default port
  tamandua control-plane status              # Check control plane status`;
}

export function getControlPlaneStartHelp(): string {
  return `tamandua control-plane start — Start the control plane server

Usage: tamandua control-plane start [--port N]

Starts the control plane server on the specified port (default: 3339).
The control plane provides run-scoped scheduling endpoints that the
dashboard daemon uses to manage agent polling and work dispatch.

If the control plane is already running, the command prints the current
PID, port, and endpoint instead of starting a duplicate.

Options:
  --port N    Port to listen on (default: 3339)

Examples:
  tamandua control-plane start              # Start on default port 3339
  tamandua control-plane start --port 4444  # Start on port 4444`;
}

export function getControlPlaneStopHelp(): string {
  return `tamandua control-plane stop — Stop the control plane server

Usage: tamandua control-plane stop

Stops the control plane server if it is running. If the server is not
running, the command prints a message and exits successfully.

Examples:
  tamandua control-plane stop`;
}

export function getControlPlaneRestartHelp(): string {
  return `tamandua control-plane restart — Restart the control plane server

Usage: tamandua control-plane restart [--port N]

Restarts the control plane server. If the server is currently running, it is
stopped first, then a new server is started on the given port (or the
previously configured port if no --port is specified). If the server is
not running, this command behaves like start.

Options:
  --port N    Port to restart on (default: currently configured port or 3339)

Examples:
  tamandua control-plane restart            # Restart on current/default port
  tamandua control-plane restart --port 4444 # Restart on port 4444`;
}

export function getControlPlaneStatusHelp(): string {
  return `tamandua control-plane status — Show control plane server status

Usage: tamandua control-plane status

Reports whether the control plane server is running. When running, it
prints the PID, port, and full endpoint URL. When not running, it prints
the default endpoint that would be used on start.

Examples:
  tamandua control-plane status`;
}

/**
 * Handle control-plane command group (start, stop, restart, status).
 * Returns true if the command was handled, false if not recognized.
 */
export async function handleControlPlane(group: string, args: string[]): Promise<boolean> {
  if (group !== "control-plane") return false;

  const sub = args[1];

  if (sub === "stop") {
    console.log(stopControlPlane() ? "Control plane stopped." : "Control plane is not running.");
    return true;
  }

  if (sub === "restart") {
    let restartPort: number | undefined;
    const restartPortIdx = args.indexOf("--port");
    if (restartPortIdx !== -1 && args[restartPortIdx + 1]) {
      restartPort = parseInt(args[restartPortIdx + 1], 10) || undefined;
    }
    // Support positional port: tamandua control-plane restart 4444
    const restartPosIdx = args.indexOf("restart") + 1;
    const restartPosArg = args[restartPosIdx];
    if (restartPosArg && !restartPosArg.startsWith("-")) {
      const p = parseInt(restartPosArg, 10);
      if (!Number.isNaN(p)) restartPort = p;
    }
    try {
      const restartResult = await restartControlPlane(restartPort);
      const label = restartResult.alreadyRunning ? "already running" : "restarted";
      console.log(`Control plane ${label}${restartResult.pid > 0 ? ` (PID ${restartResult.pid})` : ""}`);
      console.log(`Endpoint: http://localhost:${restartResult.port}${getControlPlaneStatus().endpoint}`);
    } catch (err) {
      process.stderr.write(`Failed to restart control plane: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    return true;
  }

  if (sub === "status") {
    const { getControlPlaneStatusAsync: cpStatusAsync } = await import("../../server/daemonctl.js");
    const st = await cpStatusAsync();
    if (!st.running) {
      console.log("Control plane is not running.");
      console.log(`Default endpoint: http://localhost:${st.port}${st.endpoint}`);
      return true;
    }
    console.log(`Control plane running (PID ${st.pid})`);
    console.log(`Port: ${st.port}`);
    console.log(`Endpoint: http://localhost:${st.port}${st.endpoint}`);
    return true;
  }

  // Default: start
  let port = DEFAULT_CONTROL_PORT;
  const portIdx = args.indexOf("--port");
  if (portIdx !== -1 && args[portIdx + 1]) {
    port = parseInt(args[portIdx + 1], 10) || DEFAULT_CONTROL_PORT;
  }
  // Support positional port as well: tamandua control-plane start 4444
  // Also support positional port in target position: tamandua control-plane 4444
  const targetArg = args[2];
  if (sub && sub !== "start" && !sub.startsWith("-")) {
    const p = parseInt(sub, 10);
    if (!Number.isNaN(p)) port = p;
  } else if (targetArg && !targetArg.startsWith("-")) {
    const p = parseInt(targetArg, 10);
    if (!Number.isNaN(p)) port = p;
  }
  const running = getControlPlaneStatus();
  if (running.running) {
    console.log(`Control plane already running (PID ${running.pid})`);
    console.log(`Port: ${running.port}`);
    console.log(`Endpoint: http://localhost:${running.port}${running.endpoint}`);
    return true;
  }
  try {
    const result = await startControlPlane(port);
    const label = result.alreadyRunning ? "already running" : "started";
    console.log(`Control plane ${label}${result.pid > 0 ? ` (PID ${result.pid})` : ""}`);
    console.log(`Endpoint: http://localhost:${result.port}${getControlPlaneStatus().endpoint}`);
  } catch (err) {
    process.stderr.write(`Failed to start control plane: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  return true;
}
