/**
 * Daemon lifecycle commands and the control-plane alias.
 *
 * Extracted mechanically from src/cli/cli.ts (SPL2 story US-007).
 */

import {
  getDaemonStatusAsync,
  restartDaemon,
  startDaemon,
  stopDaemonAsync,
} from "../../server/daemonctl.js";
import type { ForeignDaemonHolder } from "../../server/daemonctl.js";

/**
 * Report a Tamandua daemon that holds the configured control port but belongs
 * to a different state dir. It is never signalled; the caller continues with
 * its own configured-state-dir behavior.
 */
function reportForeignHolder(holder: ForeignDaemonHolder | null | undefined): void {
  if (!holder) return;
  process.stderr.write(
    `another Tamandua daemon (pid ${holder.pid}, port ${holder.port}, state dir ${holder.stateDir})\n`,
  );
}

/**
 * Dependency-injection seams for the daemon command handler.
 *
 * Production calls pass nothing and use the real daemonctl lifecycle
 * functions; tests inject fakes to assert which path a subcommand takes
 * without spawning or signalling anything.
 */
export interface DaemonCommandDeps {
  getDaemonStatusAsync?: typeof getDaemonStatusAsync;
  stopDaemonAsync?: typeof stopDaemonAsync;
  restartDaemon?: typeof restartDaemon;
  startDaemon?: typeof startDaemon;
}

export function getDaemonHelp(): string {
  return `tamandua daemon — Manage the daemon (control plane + scheduling motor)

Usage: tamandua daemon <start|stop|restart|status>

The daemon hosts the control plane and scheduling motor. It manages run
admission, agent dispatch, and the reconciler loop. The daemon MUST be
running for workflows to progress.

Subcommands:
  start   [--port N]   Start the daemon on the given control plane port
  stop                 Stop the daemon
  restart [--port N]   Restart the daemon
  status               Show whether the daemon is running (PID)

Start will refuse if the daemon is already running.

Examples:
  tamandua daemon start            # Start the daemon
  tamandua daemon stop             # Stop the daemon
  tamandua daemon restart          # Restart the daemon
  tamandua daemon status           # Check daemon status`;
}

export function getDaemonStartHelp(): string {
  return `tamandua daemon start — Start the daemon (control plane + motor)

Usage: tamandua daemon start [--port N]

Starts the daemon which hosts the control plane and scheduling motor.
The daemon must be running for workflow runs to progress.

If the daemon is already running, the command prints the current
status instead of starting a duplicate.

Options:
  --port N    Control plane port (default: 3334)

Examples:
  tamandua daemon start            # Start the daemon on default port
  tamandua daemon start --port 4444 # Start on port 4444`;
}

export function getDaemonStopHelp(): string {
  return `tamandua daemon stop — Stop the daemon

Usage: tamandua daemon stop

Stops the daemon if it is running. If the daemon is not running, the
command prints a message and exits successfully.

Stop is takeover-aware: the live daemon is identified by its identity
socket (daemon.sock), then by the verified holder of the control port,
then by the pidfile hint. The exact resolved pid receives SIGTERM; if it
does not exit within the grace window (default 15 s, override with
TAMANDUA_TAKEOVER_GRACE_MS) it is SIGKILLed, and the command verifies the
control port is free before returning. A daemon whose pidfile was lost is
therefore still stopped and replaced.

Examples:
  tamandua daemon stop`;
}

export function getDaemonRestartHelp(): string {
  return `tamandua daemon restart — Restart the daemon

Usage: tamandua daemon restart [--port N]

Restarts the daemon. If the daemon is currently running, it is stopped
first (takeover: identity socket → verified control-port holder → pidfile
hint, SIGTERM → bounded grace → SIGKILL, then port-free verification), then
a new daemon is started on the given port (or the previously configured
port if no --port is specified). If the daemon is not running, this command
behaves like start.

Options:
  --port N    Port to restart on (default: currently configured port or 3334)

Examples:
  tamandua daemon restart            # Restart on current/default port
  tamandua daemon restart --port 4444 # Restart on port 4444`;
}

export function getDaemonStatusHelp(): string {
  return `tamandua daemon status — Show daemon status

Usage: tamandua daemon status

Reports whether the daemon is running. When running, it prints the live
PID, the control port, and how the daemon was resolved (source):
  socket       identity socket answered (authoritative)
  port-holder  verified Tamandua process holds the control port
  pidfile      pidfile hint only

A daemon that lost its pidfile is still reported running. When not
running, it indicates the daemon is down.

Examples:
  tamandua daemon status`;
}

export function getControlPlaneHelp(): string {
  return `tamandua control-plane — Alias for tamandua daemon commands

Usage: tamandua control-plane <start|stop|restart|status>

The control plane is not a standalone server — it is hosted by the daemon
process (the scheduling brain). All control-plane subcommands are aliases
for the corresponding \`tamandua daemon\` commands:

  control-plane start   → daemon start     (start the daemon)
  control-plane stop    → daemon stop      (stop the daemon)
  control-plane restart → daemon restart   (restart the daemon)
  control-plane status  → daemon status    (check daemon status)

Subcommands:
  start  [--port N]   Start the daemon (control-plane+motor)
  stop                Stop the daemon
  restart [--port N]  Restart the daemon
  status              Show whether the daemon is running

Examples:
  tamandua control-plane start               # Start the daemon (alias for daemon start)
  tamandua control-plane stop                # Stop the daemon
  tamandua control-plane status              # Check daemon status`;
}

export function getControlPlaneStartHelp(): string {
  return `tamandua control-plane start — Alias for tamandua daemon start

Usage: tamandua control-plane start [--port N]

Alias for \`tamandua daemon start\`. Starts the daemon (control-plane+motor)
on the specified port.

Options:
  --port N    Port to listen on (default: 3334)

Examples:
  tamandua control-plane start              # Alias for tamandua daemon start
  tamandua control-plane start --port 4444  # Start on port 4444`;
}

export function getControlPlaneStopHelp(): string {
  return `tamandua control-plane stop — Alias for tamandua daemon stop

Usage: tamandua control-plane stop

Alias for \`tamandua daemon stop\`. Stops the daemon (control-plane+motor)
if it is running.

Examples:
  tamandua control-plane stop`;
}

export function getControlPlaneRestartHelp(): string {
  return `tamandua control-plane restart — Alias for tamandua daemon restart

Usage: tamandua control-plane restart [--port N]

Alias for \`tamandua daemon restart\`. Restarts the daemon (control-plane+motor).

Options:
  --port N    Port to restart on (default: currently configured port or 3334)

Examples:
  tamandua control-plane restart            # Alias for tamandua daemon restart
  tamandua control-plane restart --port 4444 # Restart on port 4444`;
}

export function getControlPlaneStatusHelp(): string {
  return `tamandua control-plane status — Alias for tamandua daemon status

Usage: tamandua control-plane status

Alias for \`tamandua daemon status\`. Reports whether the daemon
(control-plane+motor) is running.

Examples:
  tamandua control-plane status`;
}

/**
 * Handle daemon lifecycle commands and their control-plane aliases.
 * Returns true if the command was handled, false if not recognized.
 */
export async function handleDaemon(
  group: string,
  args: string[],
  deps: DaemonCommandDeps = {},
): Promise<boolean> {
  if (group !== "daemon" && group !== "control-plane") return false;

  const controlPlaneAlias = group === "control-plane";
  const serviceName = controlPlaneAlias ? "Control plane" : "Daemon";
  const serviceNameLower = controlPlaneAlias ? "control plane" : "daemon";
  const sub = args[1];

  if (sub === "stop") {
    const stopAsync = deps.stopDaemonAsync ?? stopDaemonAsync;
    const result = await stopAsync();
    reportForeignHolder(result.foreignHolder);
    if (result.pid === undefined) {
      console.log(`${serviceName} is not running.`);
      return true;
    }
    if (!result.stopped) {
      const notes = result.portFree ? "port free" : "control port still in use";
      console.log(`${serviceName} did not stop (PID ${result.pid}; ${notes}).`);
      return true;
    }
    const notes: string[] = [];
    if (result.escalated) notes.push("escalated to SIGKILL");
    notes.push(result.portFree ? "port free" : "control port still in use");
    console.log(`${serviceName} stopped (PID ${result.pid}; ${notes.join(", ")}).`);
    return true;
  }
  if (sub === "restart") {
    let port: number | undefined;
    const portIdx = args.indexOf("--port");
    if (portIdx !== -1 && args[portIdx + 1]) {
      port = parseInt(args[portIdx + 1], 10) || undefined;
    }
    const posIdx = args.indexOf("restart") + 1;
    const posArg = args[posIdx];
    if (posArg && !posArg.startsWith("-")) {
      const p = parseInt(posArg, 10);
      if (!Number.isNaN(p)) port = p;
    }
    try {
      const result = await (deps.restartDaemon ?? restartDaemon)(port);
      console.log(`${serviceName} restarted (PID ${result.pid})`);
    } catch (err) {
      process.stderr.write(`Failed to restart ${serviceNameLower}: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    return true;
  }
  if (sub === "status") {
    const status = await (deps.getDaemonStatusAsync ?? getDaemonStatusAsync)();
    reportForeignHolder(status.foreignHolder);
    if (!status.running) {
      console.log(`${serviceName} is not running.`);
    } else {
      console.log(`${serviceName} running (PID ${status.pid}, source ${status.source ?? "unknown"})`);
    }
    return true;
  }

  const startFn = deps.startDaemon ?? startDaemon;
  const statusFn = deps.getDaemonStatusAsync ?? getDaemonStatusAsync;

  let port: number | undefined;
  const portIdx = args.indexOf("--port");
  if (portIdx !== -1 && args[portIdx + 1]) {
    port = parseInt(args[portIdx + 1], 10) || undefined;
  } else {
    // Positional form: `tamandua daemon start <port>` (a bare port sub, e.g.
    // `tamandua daemon <port>`, is also accepted for backward compatibility).
    const startIdx = args.indexOf("start");
    const posArg = startIdx !== -1 ? args[startIdx + 1] : sub;
    if (posArg && !posArg.startsWith("-")) {
      const p = parseInt(posArg, 10);
      if (!Number.isNaN(p)) port = p;
    }
  }
  // Resolve by takeover (socket identity → verified port holder → pidfile) so
  // an already-running daemon is recognized even when its pidfile is gone.
  // The requested port is threaded through so the freshness check inspects
  // exactly the port startDaemon() is about to bind (never the default).
  const existing = await statusFn(port === undefined ? undefined : { port });
  reportForeignHolder(existing.foreignHolder);
  if (existing.running) {
    console.log(`${serviceName} already running (PID ${existing.pid})`);
    return true;
  }

  if (!controlPlaneAlias) {
    const result = await startFn(port);
    console.log(`Daemon started (PID ${result.pid})`);
    return true;
  }

  try {
    const result = await startFn(port);
    console.log(`Control plane started (PID ${result.pid})`);
  } catch (err) {
    process.stderr.write(`Failed to start control plane: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  return true;
}
