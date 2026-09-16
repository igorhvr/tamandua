/**
 * Diagnostic commands: status and doctor.
 *
 * Extracted mechanically from src/cli/cli.ts (SPL2 story US-004).
 */

import { runDoctorChecks, formatDoctorOutput, repairLiveness } from "../../doctor.js";
import {
  formatProcessList,
  formatRunsSummary,
  formatServiceStatusAsync,
  formatTamanduaInfo,
  collectServiceStatusAsync,
  collectTamanduaInfo,
  collectRunsSummary,
  collectProcessList,
  formatDaemonLifecycle,
  collectDaemonLifecycle,
} from "../status-format.js";
import { getVersion } from "./standalone.js";

export function getDoctorHelp(): string {
  return `tamandua doctor — Run one-shot diagnostics with per-check pass/fail and remedy commands

Usage: tamandua doctor [--repair]

Runs a comprehensive health check across six categories and prints a
pass/fail icon for each check. On failure, the exact remedy command is
shown alongside the failure.

Options:
  --repair   After the report, explicitly perform the daemon liveness
             takeover: adopt a live daemon found by its identity socket or
             the control-port holder into a fresh pidfile, remove a stale
             daemon.sock or a dead-pid tamandua.pid, and stop + restart a
             verified Tamandua daemon whose build differs from the installed
             build. A control port held by a non-Tamandua process is reported
             and left untouched — tamandua never signals an unverified pid.
             Plain 'tamandua doctor' only reports; it never repairs.

Check categories:
  ENVIRONMENT  Node.js >= 22 (probes node:sqlite for runtime compatibility),
               pi present on PATH, gh present on PATH,
               pi-token-saver and hermes-token-saver detection (informational — optional),
               TAMANDUA_HERMES_BINARY / hermes detection (informational — alpha),
               TAMANDUA_DSH_BINARY / dsh detection (informational — alpha)
  SERVICES     Daemon PID alive, control plane health reachable,
               dashboard HTTP up, MCP server status (if configured).
               On any failure, the relevant log tail is included for diagnostics.
  LIVENESS     Pidfile/socket/control-port-holder consistency and the running
               daemon's build version (from the daemon identity socket). Catches
               a live daemon that lost its pidfile, a stale daemon.sock, a
               control port held by a non-Tamandua process, and a build
               mismatch. Report-only — never stops or repairs anything; run
               'tamandua daemon restart' to replace a stale daemon. Pass
               --repair to perform the takeover explicitly.
  STALENESS    Compares the running daemon's build version (from control plane
               /control/health) against the locally installed dist/version.
               On mismatch, tells you to restart the daemon.
  STATE        Database opens, and medic-style run anomaly detection
               (zombie runs, long-stuck steps).
  LLM PROMPT   Per-step key-emission rates from workflow runs — measures
  ADHERENCE    how often agents deliver expected output keys declared in
               step Reply-with contracts. Reports rates per key, warns on
               keys below 50% over at least 5 samples.

Exit codes:
  0 — all checks passed (or only informational warnings)
  1 — at least one check failed (remedies printed)
  With --repair, the exit code reflects the repair outcome instead:
  0 — repair succeeded, 1 — a daemon liveness failure remains.

Examples:
  tamandua doctor             # Run all diagnostic checks
  tamandua doctor --repair    # Report, then repair daemon liveness
  tamandua doctor --help      # This help text`;
}

export function getStatusHelp(): string {
  return `tamandua status — Show detailed Tamandua system status

Usage: tamandua status [--json]

Displays a comprehensive status overview of the Tamandua system, including:

  Services — Dashboard, daemon (control-plane+motor), and MCP status (up/down, PID, port)
  Daemon Lifecycle — Most recent daemon death (clean or unclean), with an
                  [UNSEEN] marker on a fresh unclean death
  Tamandua Info — Source path, skill path, version, and source tree SHA256
  Workflow Runs — Summary of all runs (running, paused, done, failed), with
                  visible red-ledger landing annotations when present
  Running Processes — Active pi/hermes/dsh harness processes spawned by tamandua

Options:
  --json    Output a JSON object with services, daemonLifecycle, info, runs,
            and processes sections for machine consumption. No other stdout.

Examples:
  tamandua status             # Full system status overview
  tamandua status --json      # Machine-readable JSON output
  tamandua status --help      # This help text`;
}

/**
 * Handle diagnostic commands.
 * Returns true if the command was handled, false if not recognized.
 */
export async function handleStatus(group: string, args: string[]): Promise<boolean> {
  if (group === "doctor") {
    const rest = args.slice(1);
    const repair = rest.includes("--repair");
    const unknown = rest.filter((arg) => arg !== "--repair");
    if (unknown.length > 0) {
      process.stderr.write(`Unknown doctor option: ${unknown.join(" ")}\nUsage: tamandua doctor [--repair]\n`);
      process.exit(1);
    }
    const groups = await runDoctorChecks();
    const { output, hasFailures } = formatDoctorOutput(groups);
    console.log(output);

    if (!repair) {
      process.exit(hasFailures ? 1 : 0);
    }

    const { actions, ok } = await repairLiveness();
    console.log();
    console.log("─── REPAIR ───");
    if (actions.length === 0) {
      console.log("  No daemon liveness issues to repair.");
    } else {
      for (const action of actions) {
        console.log(`  ${action}`);
      }
    }
    process.exit(ok ? 0 : 1);
  }

  if (group === "status") {
    const jsonFlag = args.includes("--json");

    if (jsonFlag) {
      const [services, info, runs, processes, daemonLifecycle] = await Promise.all([
        collectServiceStatusAsync(),
        Promise.resolve(collectTamanduaInfo({ getVersion })),
        Promise.resolve(collectRunsSummary()),
        Promise.resolve(collectProcessList()),
        Promise.resolve(collectDaemonLifecycle()),
      ]);
      console.log(JSON.stringify({ services, info, runs, processes, daemonLifecycle }));
      return true;
    }

    console.log("Tamandua Status");
    console.log("===============");
    console.log();
    console.log(await formatServiceStatusAsync());
    console.log();
    console.log("---");
    console.log();
    console.log(formatDaemonLifecycle());
    console.log();
    console.log("---");
    console.log();
    console.log(formatTamanduaInfo({ getVersion }));
    console.log();
    console.log("---");
    console.log();
    console.log(formatRunsSummary());
    console.log();
    console.log("---");
    console.log();
    console.log(formatProcessList());
    return true;
  }

  return false;
}
