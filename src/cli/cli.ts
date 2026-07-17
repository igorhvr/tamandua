#!/usr/bin/env node

// Runtime check: node:sqlite requires Node.js >= 22
try {
  await import("node:sqlite");
} catch {
  console.error("Error: node:sqlite is not available.\n\nTamandua requires Node.js >= 22 with native SQLite support.");
  process.exit(1);
}

import { readVersionStatus } from "../lib/version-check.js";
import {
  hasHelpFlag,
  printHelp,
  shouldSkipUpdateWarning,
} from "./shared.js";
import {
  getNudgeHelp,
  getSkillPathHelp,
  getSourcePathHelp,
  getTamanduaHelp,
  getUpdateHelp,
  getVersionHelp,
  handleStandalone,
} from "./commands/standalone.js";
import {
  getGetReadyHelp,
  getUninstallHelp,
  handleGetReady,
} from "./commands/get-ready.js";
import {
  getDoctorHelp,
  getStatusHelp,
  handleStatus,
} from "./commands/status.js";
import {
  getMcpHelp,
  getMcpRestartHelp,
  getMcpStartHelp,
  getMcpStatusHelp,
  getMcpStopHelp,
  handleMcp,
} from "./commands/mcp.js";
import {
  getDashboardHelp,
  getDashboardRestartHelp,
  getDashboardStartHelp,
  getDashboardStatusHelp,
  getDashboardStopHelp,
  handleDashboard,
} from "./commands/dashboard.js";
import {
  getControlPlaneHelp,
  getControlPlaneRestartHelp,
  getControlPlaneStartHelp,
  getControlPlaneStatusHelp,
  getControlPlaneStopHelp,
  getDaemonHelp,
  getDaemonRestartHelp,
  getDaemonStartHelp,
  getDaemonStatusHelp,
  getDaemonStopHelp,
  handleDaemon,
} from "./commands/daemon.js";
import {
  getStepClaimHelp,
  getStepCompleteHelp,
  getStepFailHelp,
  getStepPeekHelp,
  getStepStoriesHelp,
  handleStep,
} from "./commands/step.js";
import {
  getLogsHelp,
  getLogsTailHelp,
  handleLogs,
} from "./commands/logs.js";
import {
  getWorktreeGroupHelp,
  getWorktreeListHelp,
  getWorktreePruneHelp,
  getWorktreeRemoveHelp,
  getWorktreeStatusHelp,
  handleWorktree,
} from "./commands/worktree.js";
import {
  getAutoresearchHelp,
  getAutoresearchInitHelp,
  getAutoresearchLogExperimentHelp,
  getAutoresearchLoopHelp,
  getAutoresearchNextHelp,
  getAutoresearchPruneHelp,
  getAutoresearchRunExperimentHelp,
  getAutoresearchRunLoopIterationHelp,
  getAutoresearchStatusHelp,
  getAutoresearchWizardHelp,
  handleAutoresearch,
} from "./commands/autoresearch.js";
import {
  getWorkflowAutoresearchHelp,
  getWorkflowDeleteHelp,
  getWorkflowGroupHelp,
  getWorkflowInstallHelp,
  getWorkflowListHelp,
  getWorkflowPauseAllHelp,
  getWorkflowPauseHelp,
  getWorkflowResumeAllHelp,
  getWorkflowResumeHelp,
  getWorkflowRunHelp,
  getWorkflowRunsHelp,
  getWorkflowStatusHelp,
  getWorkflowStopHelp,
  getWorkflowUninstallHelp,
  handleWorkflow,
} from "./commands/workflow.js";
import { getWaitHelp } from "./commands/wait.js";
import {
  getMergeBranchHelp,
  handleMergeBranch,
} from "./commands/merge-branch.js";

function getUsageText(): string {
  return [
    "Run tamandua <command> --help for detailed command help.",
    "",
    "tamandua get-ready                    Install bundled workflows and start daemon/dashboard/MCP",
    "tamandua uninstall [--force]          Full uninstall",
    "tamandua status                       Show detailed system status (services, paths, runs, processes)",
    "tamandua merge-branch --origin <repo> --branch <branch> --into <target> --expect-tip <sha> --message <message>",
    "                                      Atomically land a plumbing-based squash merge",
    "", "tamandua workflow list                List available workflows",
    "tamandua workflow install <name|--all>  Install a workflow (or all)",
    "tamandua workflow run <name> <task> [--no-hurry-please-save-tokens-mode]",
    "                                      [--context <key=value> ...]",
    "                                      [--working-directory-for-harness <dir>]",
    "                                      [--worktree-origin-repository <dir>]",
    "                                      [--worktree-origin-ref <ref>]",
    "                                      [--pi-as-harness | --hermes-as-harness]",
    "                                      [--no-relaunch-upon-rugpull]",
    "                                      [--wait] [--timeout <dur>] [--json]",
    "                                      Start a workflow run",
    "", "tamandua worktree list                List managed worktrees",
    "tamandua worktree status <run-id>     Show worktree details for a run",
    "tamandua worktree remove <run-id>     Remove managed worktree [--force]",
    "tamandua worktree prune --completed   Remove old completed worktrees",
    "           --older-than <duration>    (e.g. 7d, 24h, 30m)",
    "", "tamandua autoresearch init            Create durable experiment-loop state",
    "tamandua autoresearch run-experiment  Run the configured experiment command",
    "tamandua autoresearch log-experiment   Log keep/discard learning for the loop",
    "tamandua autoresearch loop            Run a bounded experiment loop with live progress",
    "tamandua autoresearch run-loop-iteration Run a single transactional experiment iteration",
    "tamandua autoresearch status          Summarize AutoResearch state",
    "tamandua autoresearch next            Print the next experiment prompt",
    "tamandua autoresearch prune           Remove stale AutoResearch registry rows",
    "           --older-than <duration>    (e.g. 30d, 7d, 24h)",
    "tamandua autoresearch wizard          Interactive AutoResearch setup wizard",
    "tamandua workflow autoresearch <run-id> Show run AutoResearch progress",
    "tamandua workflow status <query>      Check run status",
    "tamandua workflow runs                List all workflow runs",
    "tamandua workflow pause <run-id>      Pause a running workflow",
    "tamandua workflow pause-all [--drain]  Pause all running workflows",
    "tamandua workflow resume <run-id>     Resume a paused or failed run",
    "tamandua workflow resume-all           Resume all paused workflows",
    "tamandua workflow stop <run-id>       Stop/cancel a running workflow",
    "tamandua workflow delete <run-id>     Permanently delete a run [--force]",
    "tamandua workflow wait <selector...> [--all] [--timeout <dur>] [--json] [--quiet]",
    "                                      Block until runs reach terminal status",
    "tamandua mcp start [--port N]         Start MCP server (default: 3338)",
    "tamandua mcp stop                     Stop MCP server",
    "tamandua mcp restart [--port N]       Restart MCP server",
    "tamandua mcp status                   Check MCP server status",
    "tamandua control-plane start [--port N]      Start control plane (alias for daemon)",
    "tamandua control-plane stop                  Stop control plane (alias for daemon)",
    "tamandua control-plane restart [--port N]    Restart control plane (alias for daemon)",
    "tamandua control-plane status                Check control plane status (alias for daemon)",
    "", "tamandua daemon start [--port N]       Start daemon (control plane+motor)",
    "tamandua daemon stop                  Stop daemon",
    "tamandua daemon restart [--port N]    Restart daemon",
    "tamandua daemon status                Check daemon status",
    "", "tamandua dashboard [start] [--port N] Start dashboard (default: 3334)",
    "tamandua dashboard stop               Stop dashboard",
    "tamandua dashboard restart [--port N] Restart dashboard",
    "tamandua dashboard status             Check dashboard status",
    "", "tamandua step peek <agent-id> --run-id <run-id>     Check for pending work (HAS_WORK or NO_WORK)",
    "tamandua step claim <agent-id> --run-id <run-id>    Claim pending step (JSON output)",
    "tamandua step complete <step-id>      Complete step (reads output from stdin)",
    "tamandua step fail <step-id> <error>  Fail step with retry logic",
    "tamandua step stories <run-id>        List stories for a run",
    "", "tamandua logs [<lines>|<run-id>|#<run-number>] Show recent activity",
    "tamandua logs-tail [<lines>|<run-id>|#<run-number>] Follow recent activity",
    "", "tamandua version                      Show installed version",
    "tamandua skill-path                  Print path to the bundled tamandua-agents skill",
    "tamandua source-path                  Print source checkout path",
    "tamandua nudge                       Trigger an immediate dispatch round for running runs",
    "tamandua doctor                       Run one-shot diagnostic with per-check pass/fail and remedies",
    "tamandua update [--force]             Pull latest, rebuild, reinstall",
  ].join("\n") + "\n";
}

function printUsage() {
  process.stdout.write(getUsageText());
}

async function main() {
  const args = process.argv.slice(2);
  const [group, action] = args;

  // Check for --help before anything else: display command-specific help
  // if recognized, otherwise show global usage.
  if (hasHelpFlag(args)) {
    if (group === "tamandua") {
      printHelp(getTamanduaHelp());
    }
    if (group === "version" || group === "--version" || group === "-v") {
      printHelp(getVersionHelp());
    }
    if (group === "skill-path") {
      printHelp(getSkillPathHelp());
    }
    if (group === "source-path") {
      printHelp(getSourcePathHelp());
    }
    if (group === "update") {
      printHelp(getUpdateHelp());
    }
    if (group === "get-ready") {
      printHelp(getGetReadyHelp());
    }
    if (group === "uninstall") {
      printHelp(getUninstallHelp());
    }
    if (group === "status") {
      printHelp(getStatusHelp());
    }
    if (group === "merge-branch") {
      printHelp(getMergeBranchHelp());
    }
    if (group === "mcp") {
      if (action === "start") { printHelp(getMcpStartHelp()); }
      if (action === "stop") { printHelp(getMcpStopHelp()); }
      if (action === "restart") { printHelp(getMcpRestartHelp()); }
      if (action === "status") { printHelp(getMcpStatusHelp()); }
      printHelp(getMcpHelp());
    }
    if (group === "dashboard") {
      if (action === "start") { printHelp(getDashboardStartHelp()); }
      if (action === "stop") { printHelp(getDashboardStopHelp()); }
      if (action === "restart") { printHelp(getDashboardRestartHelp()); }
      if (action === "status") { printHelp(getDashboardStatusHelp()); }
      printHelp(getDashboardHelp());
    }
    if (group === "daemon") {
      if (action === "start") { printHelp(getDaemonStartHelp()); }
      if (action === "stop") { printHelp(getDaemonStopHelp()); }
      if (action === "restart") { printHelp(getDaemonRestartHelp()); }
      if (action === "status") { printHelp(getDaemonStatusHelp()); }
      printHelp(getDaemonHelp());
    }
    if (group === "control-plane") {
      if (action === "start") { printHelp(getControlPlaneStartHelp()); }
      if (action === "stop") { printHelp(getControlPlaneStopHelp()); }
      if (action === "restart") { printHelp(getControlPlaneRestartHelp()); }
      if (action === "status") { printHelp(getControlPlaneStatusHelp()); }
      printHelp(getControlPlaneHelp());
    }
    if (group === "step") {
      if (action === "peek") { printHelp(getStepPeekHelp()); }
      if (action === "claim") { printHelp(getStepClaimHelp()); }
      if (action === "complete") { printHelp(getStepCompleteHelp()); }
      if (action === "fail") { printHelp(getStepFailHelp()); }
      if (action === "stories") { printHelp(getStepStoriesHelp()); }
    }
    if (group === "logs") {
      printHelp(getLogsHelp());
    }
    if (group === "logs-tail") {
      printHelp(getLogsTailHelp());
    }
    if (group === "workflow") {
      if (action === "list") { printHelp(getWorkflowListHelp()); }
      if (action === "runs") { printHelp(getWorkflowRunsHelp()); }
      if (action === "install") { printHelp(getWorkflowInstallHelp()); }
      if (action === "uninstall") { printHelp(getWorkflowUninstallHelp()); }
      if (action === "run") { printHelp(getWorkflowRunHelp()); }
      if (action === "status") { printHelp(getWorkflowStatusHelp()); }
      if (action === "autoresearch") { printHelp(getWorkflowAutoresearchHelp()); }
      if (action === "delete") { printHelp(getWorkflowDeleteHelp()); }
      if (action === "stop") { printHelp(getWorkflowStopHelp()); }
      if (action === "pause") { printHelp(getWorkflowPauseHelp()); }
      if (action === "resume") { printHelp(getWorkflowResumeHelp()); }
      if (action === "pause-all") { printHelp(getWorkflowPauseAllHelp()); }
      if (action === "resume-all") { printHelp(getWorkflowResumeAllHelp()); }
      if (action === "wait") { printHelp(getWaitHelp()); }
      printHelp(getWorkflowGroupHelp());
    }
    if (group === "worktree") {
      if (action === "list") { printHelp(getWorktreeListHelp()); }
      if (action === "status") { printHelp(getWorktreeStatusHelp()); }
      if (action === "remove") { printHelp(getWorktreeRemoveHelp()); }
      if (action === "prune") { printHelp(getWorktreePruneHelp()); }
      printHelp(getWorktreeGroupHelp());
    }
    if (group === "autoresearch") {
      if (action === "init") { printHelp(getAutoresearchInitHelp()); }
      if (action === "run-experiment") { printHelp(getAutoresearchRunExperimentHelp()); }
      if (action === "log-experiment") { printHelp(getAutoresearchLogExperimentHelp()); }
      if (action === "status") { printHelp(getAutoresearchStatusHelp()); }
      if (action === "next") { printHelp(getAutoresearchNextHelp()); }
      if (action === "loop") { printHelp(getAutoresearchLoopHelp()); }
      if (action === "run-loop-iteration") { printHelp(getAutoresearchRunLoopIterationHelp()); }
      if (action === "prune") { printHelp(getAutoresearchPruneHelp()); }
      if (action === "wizard") { printHelp(getAutoresearchWizardHelp()); }
      printHelp(getAutoresearchHelp());
    }
    if (group === "nudge") {
      printHelp(getNudgeHelp());
    }
    if (group === "doctor") {
      printHelp(getDoctorHelp());
    }
    printHelp(getUsageText());
  }

  // Display update warning before command output, but suppress for
  // update/version commands (user is already acting on versions) and
  // step peek/claim (would break polling agent output parsing).
  if (!shouldSkipUpdateWarning(group, action)) {
    const status = readVersionStatus();
    if (status.updateAvailable) {
      process.stderr.write("WARNING: A new version of tamandua is available! Run: tamandua update\n");
    }
  }

  if (await handleStandalone(group, args)) { return; }

  if (handleMergeBranch(group, args)) { return; }

  if (await handleGetReady(group, args)) { return; }

  if (await handleMcp(group, args)) { return; }

  if (await handleDashboard(group, args)) { return; }

  if (await handleDaemon(group, args)) { return; }

  if (await handleStatus(group, args)) { return; }

  if (await handleStep(group, args)) { return; }

  if (await handleLogs(group, args)) { return; }

  if (await handleWorktree(group, args)) { return; }

  if (await handleAutoresearch(group, args)) { return; }

  if (await handleWorkflow(group, args, printUsage)) { return; }

  printUsage(); process.exit(1);
}

main().then(
  () => {
    // Use process.exitCode if set (e.g. by workflow wait), else 0
    process.exit(process.exitCode ?? 0);
  },
).catch((err: Error) => { console.error("Error:", err.message); process.exit(1); });
