/**
 * Diagnostic commands: status and doctor.
 *
 * Extracted mechanically from src/cli/cli.ts (SPL2 story US-004).
 */

import { runDoctorChecks, formatDoctorOutput } from "../../doctor.js";
import {
  formatProcessList,
  formatRunsSummary,
  formatServiceStatusAsync,
  formatTamanduaInfo,
  collectServiceStatusAsync,
  collectTamanduaInfo,
  collectRunsSummary,
  collectProcessList,
} from "../status-format.js";
import { getVersion } from "./standalone.js";

export function getDoctorHelp(): string {
  return `tamandua doctor — Run one-shot diagnostics with per-check pass/fail and remedy commands

Usage: tamandua doctor

Runs a comprehensive health check across four categories and prints a
pass/fail icon for each check. On failure, the exact remedy command is
shown alongside the failure.

Check categories:
  ENVIRONMENT  Node.js >= 22 (probes node:sqlite for runtime compatibility),
               pi present on PATH, gh present on PATH,
               pi-token-saver and hermes-token-saver detection (informational — optional),
               TAMANDUA_HERMES_BINARY / hermes detection (informational — alpha)
  SERVICES     Daemon PID alive, control plane health reachable,
               dashboard HTTP up, MCP server status (if configured).
               On any failure, the relevant log tail is included for diagnostics.
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

Examples:
  tamandua doctor             # Run all diagnostic checks
  tamandua doctor --help      # This help text`;
}

export function getStatusHelp(): string {
  return `tamandua status — Show detailed Tamandua system status

Usage: tamandua status [--json]

Displays a comprehensive status overview of the Tamandua system, including:

  Services — Dashboard, daemon (control-plane+motor), and MCP status (up/down, PID, port)
  Tamandua Info — Source path, skill path, version, and source tree SHA256
  Workflow Runs — Summary of all runs (running, paused, done, failed), with
                  visible red-ledger landing annotations when present
  Running Processes — Active pi/hermes harness processes spawned by tamandua

Options:
  --json    Output a JSON object with services, info, runs, and processes
            sections for machine consumption. No other stdout.

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
    if (args.length > 1) {
      process.stderr.write(`Unknown doctor option: ${args.slice(1).join(" ")}\nUsage: tamandua doctor\n`);
      process.exit(1);
    }
    const groups = await runDoctorChecks();
    const { output, hasFailures } = formatDoctorOutput(groups);
    console.log(output);
    process.exit(hasFailures ? 1 : 0);
  }

  if (group === "status") {
    const jsonFlag = args.includes("--json");

    if (jsonFlag) {
      const [services, info, runs, processes] = await Promise.all([
        collectServiceStatusAsync(),
        Promise.resolve(collectTamanduaInfo({ getVersion })),
        Promise.resolve(collectRunsSummary()),
        Promise.resolve(collectProcessList()),
      ]);
      console.log(JSON.stringify({ services, info, runs, processes }));
      return true;
    }

    console.log("Tamandua Status");
    console.log("===============");
    console.log();
    console.log(await formatServiceStatusAsync());
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
