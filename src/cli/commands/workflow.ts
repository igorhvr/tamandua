/**
 * Workflow catalog, run lifecycle, and inspection commands.
 *
 * Kept as a single command group so the top-level CLI only routes workflow
 * arguments and all workflow-specific output contracts remain together.
 */

import { installWorkflow } from "../../installer/install.js";
import { uninstallAllWorkflows, uninstallWorkflow, checkActiveRuns } from "../../installer/uninstall.js";
import { getWorkflowStatus, listRuns, stopWorkflow, deleteWorkflow, forceFailRun } from "../../installer/status.js";
import { runWorkflow, resumeWorkflow } from "../../installer/run.js";
import { listBundledWorkflows } from "../../installer/workflow-fetch.js";
import { loadWorkflowSpec } from "../../installer/workflow-spec.js";
import { resolveBundledWorkflowDir } from "../../installer/paths.js";
import { readPort } from "../../server/daemonctl.js";
import os from "node:os";
import { pauseRunWithDaemon, resumeRunWithDaemon } from "../../server/control-client.js";
import { buildAbandonReasonAggregate } from "../../installer/step-ops.js";
import { checkCatalogStalenessWarning } from "../../installer/catalog-version.js";
import { parseWorkflowRunArgs } from "../workflow-run-args.js";
import { reportUnknownCommand } from "../shared.js";
import { logger } from "../../lib/logger.js";
import type { HarnessType } from "../../installer/types.js";
import { printWorkflowAutoresearch } from "./autoresearch.js";
import { handleWait, getWaitHelp } from "./wait.js";
import { detectWrongPrefix, stripIdPrefix, prefixRunId, prefixStepId } from "../../lib/id-prefix.js";
import { getInstantFailBackoffThreshold, getInstantFailWallThresholdMs } from "../../installer/instant-fail.js";

export function getWorkflowListHelp(): string {
  return `tamandua workflow list — List available bundled workflows with descriptions

Usage: tamandua workflow list [--json]

Lists all bundled workflows that are available for installation from the
source checkout, showing a one-line description for each. These are the
workflows defined in the workflows/ directory of the Tamandua source tree.

Each workflow line shows the workspace mode: [worktree] for worktree-mode
workflows, [direct] for direct-mode workflows.

Options:
  --json    Output a JSON array of {id, name, description, workspaceMode} for programmatic consumption

Examples:
  tamandua workflow list
  tamandua workflow list --json`;
}

export function getWorkflowRunsHelp(): string {
  return `tamandua workflow runs — List all workflow runs

Usage: tamandua workflow runs [--json]

Lists every workflow run in the database with status, workflow ID, token
usage, and a preview of the task description.

Output columns:
  Status    Run status (running, paused, done, failed, canceled)
  Run ID    8-character run identifier prefix
  Workflow  The workflow ID (e.g. feature-dev-merge)
  Tokens    Total tokens spent so far
  Task      Task description preview (truncated at 50 characters)

Options:
  --json    Output a JSON object with a runs array for machine consumption.
            Each run includes runId, runNumber, workflowId, status, tokensSpent,
            task (first 120 chars), createdAt, and updatedAt.

Examples:
  tamandua workflow runs
  tamandua workflow runs --json`;
}

export function getWorkflowInstallHelp(): string {
  return `tamandua workflow install — Install a specific workflow by name

Usage: tamandua workflow install <name>

Installs a single bundled workflow by its directory name. This fetches
the workflow YAML spec, provisions agent workspaces (AGENTS.md, IDENTITY.md,
SOUL.md, and any bundled skills), and registers agents in the agent config.

After installation, the workflow is ready to run with:
  tamandua workflow run <name> "task description"

Note: Installed bundled workflow files are refreshed on every install — local
edits are overwritten. Copy under a new workflow id to customize.

Examples:
  tamandua workflow install feature-dev-merge`;
}

export function getWorkflowUninstallHelp(): string {
  return `tamandua workflow uninstall — Uninstall one or all workflows

Usage: tamandua workflow uninstall <name> [--force]
       tamandua workflow uninstall --all [--force]

Uninstalls a workflow by name, or all workflows when --all is used.

By default, uninstall checks for active runs (running or paused) belonging
to the workflow and refuses if any exist. Use --force to skip this check.

Options:
  --all      Uninstall every installed workflow
  --force    Skip the active-runs check and uninstall anyway

Examples:
  tamandua workflow uninstall feature-dev-merge
  tamandua workflow uninstall feature-dev-merge --force
  tamandua workflow uninstall --all
  tamandua workflow uninstall --all --force`;
}

export function getWorkflowRunHelp(): string {
  return `tamandua workflow run — Start a new workflow run

Usage: tamandua workflow run <name> <task> [options]

Starts a new run of the given workflow with the specified task description.
The task is passed to the workflow's agents as their objective.

On success, prints the run ID in prefixed format: run-<uuid>. Both prefixed
and bare UUID forms are accepted when passing the run ID to other commands.

Options:
  --no-hurry-please-save-tokens-mode
      Prefer a token-saver wrapper for this run's work: whenever a step
      spawns a harness (pi, hermes, or dsh), the matching <harness>-token-saver
      command is looked up on PATH first (per invocation, so installing it
      mid-run takes effect) and used if present; otherwise the plain
      harness binary runs as usual. Idle checking is free either way —
      the dispatch motor never spends tokens between steps.
  --context <key=value>
      Inject a key-value pair into the run's template context for step
      input resolution. Repeatable for multiple keys. The key and value
      are split on the first '=' character. Keys must be non-empty and
      must not be duplicated across --context flags.
      Example: --context branch=feature/my-branch
  --working-directory-for-harness <dir>
      Set the working directory for the agent harness during this run.
      Agents will operate within this directory.
  --worktree-origin-repository <dir>
      Repository to clone when creating a worktree for this run.
      Defaults to the current repository.
  --worktree-origin-ref <ref>
      Git ref (branch, tag, or SHA) to check out in the worktree.
      Defaults to the current branch.
  --pi-as-harness
      Use pi as the agent harness (this is the default).
      Mutually exclusive with --hermes-as-harness and --dsh-as-harness.
  --hermes-as-harness
      Use hermes as the agent harness instead of pi.
      Mutually exclusive with --pi-as-harness and --dsh-as-harness.
  --dsh-as-harness
      Use the DeepSeek Harness (dsh) as the agent harness instead of pi.
      Alpha support.
      Mutually exclusive with --pi-as-harness and --hermes-as-harness.
  --task-file <path>
      Read the task description from a file instead of passing it inline.
      The file path is dereferenced exactly once at CLI time — the path
      is never stored downstream. Mutually exclusive with inline task
      text; error if both are given.
  --no-relaunch-upon-rugpull
      Disable automatic replacement-run after a rugpull (base branch move)
      is detected on a failed merge/merge-worktree run.
  --wait
      Block until the run reaches a terminal status (completed, failed,
      or canceled). Heartbeat output is written to stderr; exit codes
      follow the same precedence as tamandua workflow wait.
  --timeout <duration>
      Max wait duration (e.g. 30s, 10m, 2h). Only meaningful with --wait.
      Units: s, m, h, d.
  --json
      When combined with --wait, print the wait result as a JSON object
      to stdout after the run completes.

Examples:
  tamandua workflow run feature-dev-merge "Add dark mode toggle"
  tamandua workflow run feature-dev-merge "Refactor DB layer" \\
      --no-hurry-please-save-tokens-mode
  tamandua workflow run feature-dev-merge "Build login page" \\
      --working-directory-for-harness /path/to/project
  tamandua workflow run feature-dev-merge "Fix bug #42" \\
      --worktree-origin-repository /repos/myapp --worktree-origin-ref develop
  tamandua workflow run quarantine-broken-tests-merge-worktree "Quarantine failing tests" \\
      --context branch=quarantine/broken-tests
  tamandua workflow run feature-dev-merge "Add dark mode" --wait
  tamandua workflow run feature-dev-merge "Add dark mode" --wait --timeout 5m
  tamandua workflow run feature-dev-merge "Add dark mode" --wait --json
  tamandua workflow run feature-dev-merge --task-file task.md --wait`;
}

export function getWorkflowStatusHelp(): string {
  return `tamandua workflow status — Show detailed run status with step listing

Usage: tamandua workflow status <query> [--json]

Shows detailed information about a workflow run, including status, token
usage, workspace mode (for worktree runs), and a list of every step with
its current status and assigned agent role.

The query accepts a run-id prefix for matching.

Output includes:
  Run          Run ID (8-char prefix)
  Workflow     Workflow ID
  Task         Full task description
  Status       Current run status
  Harness      Harness selected for the run (shown when not pi);
               dsh runs are labeled "dsh (alpha)"
  Tokens       Total tokens spent
  Workspace    Workspace mode (only shown for worktree runs)
  Steps        Per-step listing with step ID, status icon, and agent role
  Red-ledger landing
               Ledger row, non-zero exit code, and suite timestamp when a
               default-mode merge landed over known red suite evidence

Step status indicators:
  [done   ]    Step completed successfully
  [running]    Step currently being executed
  [failed ]    Step failed (may be retried)
  [pending]    Step waiting to be claimed
  [verify ]    Loop step parked between stories while per-story verification runs

Options:
  --json    Output a JSON object with full run details for machine consumption.
            Includes runId, runNumber, workflowId, status, harnessType, task (first 200 chars),
            tokensSpent, createdAt, updatedAt, workspaceMode (worktree runs),
            worktreePath, worktreeOriginRef, steps array (stepId, stepIndex,
            agentRole, status, displayStatus, retryCount, abandonedCount, rerouteCount, claimPid,
            claimUpdatedAt, updatedAt), stories array (storyId, title, status,
            abandonedCount), and optional redLedgerLanding evidence. Step outputs
            are NOT included.

Examples:
  tamandua workflow status run-abc12345
  tamandua workflow status run-abc12345 --json`;
}

export function getWorkflowDeleteHelp(): string {
  return `tamandua workflow delete — Permanently delete a workflow run

Usage: tamandua workflow delete <run-id> [--force]

Permanently deletes a workflow run and all associated data, including steps,
stories, and managed worktrees. The run-id accepts prefix matching.

By default, active runs (running or paused) cannot be deleted — they must
be canceled first. Use --force to cancel and delete an active run in one step.

Options:
  --force    Cancel and delete even if the run is currently running or paused.

Examples:
  tamandua workflow delete run-abc12345
  tamandua workflow delete run-abc12345 --force`;
}

export function getWorkflowStopHelp(): string {
  return `tamandua workflow stop — Cancel a running workflow

Usage: tamandua workflow stop <run-id>

Cancels a running workflow by setting its status to canceled. The run-id
accepts prefix matching.

Active agents associated with the run will see the cancellation on their
next polling cycle.

Examples:
  tamandua workflow stop run-abc12345`;
}

export function getWorkflowPauseHelp(): string {
  return `tamandua workflow pause — Pause a running workflow

Usage: tamandua workflow pause <run-id> [--drain]

Pauses a running workflow via the daemon. Only runs with status
"running" can be paused. The daemon must be running for this command to work
(start it with \`tamandua daemon start\`).

When paused, agents stop polling and active work sessions are interrupted.
Paused runs can be resumed later with \`tamandua workflow resume\`.

Options:
  --drain    Let in-flight agent sessions complete before pausing, rather
             than interrupting them immediately.

Examples:
  tamandua workflow pause run-abc12345
  tamandua workflow pause run-abc12345 --drain`;
}

export function getWorkflowResumeHelp(): string {
  return `tamandua workflow resume — Resume a paused or failed workflow run

Usage: tamandua workflow resume <run-id>

Resumes a workflow run that is paused or has failed. The run-id accepts
prefix matching.

Behavior by status:
  paused    Connects to the daemon and resumes agent polling.
            The daemon must be running for this to work.
  failed    Restarts the run from the failed step, creating a new run
            entry. The daemon is notified of the new run automatically.
  Other     Terminal runs (completed, canceled) cannot be resumed.
            Runs with status "running" are already active and do not
            need to be resumed.

Examples:
  tamandua workflow resume run-abc12345   # Resume a paused run
  tamandua workflow resume run-abc12345   # Re-start a failed run`;
}

export function getWorkflowPauseAllHelp(): string {
  return `tamandua workflow pause-all — Pause all running workflows

Usage: tamandua workflow pause-all [--drain]

Pauses every workflow run currently in "running" status. Uses the dashboard
daemon to pause each run. If the daemon is unreachable for a specific run,
a warning is printed and that run is skipped.

Options:
  --drain    Let in-flight agent sessions complete before pausing, rather
             than interrupting them immediately. Applies to all runs.

Examples:
  tamandua workflow pause-all
  tamandua workflow pause-all --drain`;
}

export function getWorkflowResumeAllHelp(): string {
  return `tamandua workflow resume-all — Resume all paused workflows

Usage: tamandua workflow resume-all

Resumes every workflow run currently in "paused" status. Uses the dashboard
daemon to resume agent polling for each run. If the daemon is unreachable
for a specific run, a warning is printed and that run is skipped.

Only paused runs are resumed; failed runs are not resumed by this command
(use \`tamandua workflow resume <run-id>\` for individual failed runs).

Examples:
  tamandua workflow resume-all`;
}

export function getWorkflowFailHelp(): string {
  return `tamandua workflow fail — Force a running or paused run to failed status

Usage: tamandua workflow fail <run-id> --reason <text> [--force]

Forces a running or paused workflow run to terminal failed status. The run-id
accepts prefix matching and #N (run number).

The --reason argument is required and is recorded in the run.force_failed
event for auditability.

By default, this command checks whether any worker for the run is still alive
(step with running status and live claim_pid). If a live worker is found, the
command refuses and lists the alive workers with their step IDs and PIDs. Use
--force to override this guard and force-fail the run anyway (the worker is
NOT terminated — only the run status is changed).

Options:
  --reason <text>    Reason for force-failing the run (required)
  --force            Force-fail even if a worker is still alive

Examples:
  tamandua workflow fail run-abc12345 --reason "Run stuck after repo migration"
  tamandua workflow fail run-abc12345 --reason "Run abandoned" --force
  tamandua workflow fail #42 --reason "Manual intervention"`;
}

export function getWorkflowGroupHelp(): string {
  return `tamandua workflow — Manage workflows and runs

Usage: tamandua workflow <list|runs|install|uninstall|run|status|autoresearch|stop|delete|wait|pause|resume|pause-all|resume-all|fail>

Commands for managing Tamandua workflows and their runs.

Subcommands:
  list        List available bundled workflows
  runs        List all workflow runs with status, tokens, task preview
  install     Install a specific workflow by name
  uninstall   Uninstall a workflow (--all for all workflows, --force to skip
              active-runs check)
  run         Start a new workflow run with the given task
  status      Show detailed run status with step listing
  autoresearch
              Show AutoResearch progress for a run
  stop        Cancel a running workflow
  delete      Permanently delete a run and all its data (--force for active runs)
  wait        Block until workflow runs reach terminal status
  pause       Pause a running workflow via the daemon
  resume      Resume a paused or failed workflow run
  pause-all   Pause all running workflows
  resume-all  Resume all paused workflows
  fail        Force a running or paused run to failed status

Examples:
  tamandua workflow list
  tamandua workflow runs
  tamandua workflow install feature-dev-merge
  tamandua workflow run feature-dev-merge "Add a new feature"
  tamandua workflow status run-abc12345
  tamandua workflow autoresearch run-abc12345
  tamandua workflow wait run-abc12345
  tamandua workflow pause run-abc12345 --drain
  tamandua workflow fail run-abc12345 --reason "Stuck run"`;
}


export function getWorkflowWaitHelp(): string {
  return getWaitHelp();
}

export function getWorkflowAutoresearchHelp(): string {
  return `tamandua workflow autoresearch — Show AutoResearch progress for a workflow run

Usage: tamandua workflow autoresearch <run-id>

Resolves the run's harness working directory, reads its project-local
autoresearch.config.json and autoresearch.jsonl files, then prints the
current metric summary and recent experiment timeline.

Examples:
  tamandua workflow autoresearch run-abc12345`;
}

/**
 * Print non-done step states for a run.
 * One line per step: [status] stepIdPrefix (role) retry N
 */
function printNonDoneStepStates(runId: string): void {
  try {
    const detail = getWorkflowStatus(runId);
    const nonDone = detail.steps.filter((s) => s.status !== "done");
    for (const step of nonDone) {
      const role = step.agentId.split("_").slice(-1)[0];
      const prefix = step.stepId.slice(0, 8);
      console.log(`  [${step.status}] step-${prefix} (${role}) retry ${step.retryCount}`);
    }
  } catch {
    // If step query fails (e.g. DB error), don't break the resume flow.
  }
}

export async function handleWorkflow(
  group: string | undefined,
  args: string[],
  printUsage: () => void,
): Promise<boolean> {
  if (group !== "workflow") return false;
  const [, action, target] = args;
  if (args.length < 2) { printUsage(); process.exit(1); }
  if (group !== "workflow") { printUsage(); process.exit(1); }

  // Build CLI requester identity for pause/resume attribution (US-004).
  const cliIdentity = `${os.userInfo().username}@${os.hostname()}:${process.pid} (cli)`;

  if (action === "runs") {
    const jsonFlag = args.includes("--json");
    const runs = listRuns();
    if (jsonFlag) {
      const jsonRuns = runs.map((r) => ({
        runId: prefixRunId(r.id),
        runNumber: r.runNumber,
        workflowId: r.workflowId,
        status: r.status,
        tokensSpent: r.tokensSpent,
        task: r.task.slice(0, 120),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
      console.log(JSON.stringify({ runs: jsonRuns }));
      return true;
    }
    if (runs.length === 0) { console.log("No workflow runs found."); return true; }
    console.log("Workflow runs:");
    for (const r of runs) {
      const wl = r.workerLostCount > 0 ? ` wl:${r.workerLostCount}`.padEnd(6) : "      ";
      const ce = r.ceilingExpiryCount > 0 ? ` ce:${r.ceilingExpiryCount}`.padEnd(6) : "";
      // Instant-fail loop surfacing (DDTH): once a run has K+ consecutive
      // instant-fail rounds it is backing off toward escalation — show the
      // pathology before it is fatal.
      const ifMarker = r.instantFailCount >= getInstantFailBackoffThreshold()
        ? ` if:${r.instantFailCount}`.padEnd(6)
        : "";
      console.log(`  [${r.status.padEnd(9)}] run-${r.id.slice(0, 8).padEnd(10)} ${r.workflowId.padEnd(14)}${wl}${ce}${ifMarker}${r.tokensSpent.toLocaleString().padStart(8)} tokens  ${r.task.slice(0, 50)}${r.task.length > 50 ? "..." : ""}`);
    }
    return true;
  }

  if (action === "list") {
    const jsonFlag = args.includes("--json");
    const workflows = await listBundledWorkflows();
    if (workflows.length === 0) {
      if (jsonFlag) console.log("[]");
      else console.log("No workflows available.");
      return true;
    }
    // Load specs for all workflows — needed for workspaceMode in both text and JSON paths
    const specs = await Promise.all(
      workflows.map(async (wid) => {
        try {
          const dir = resolveBundledWorkflowDir(wid);
          const spec = await loadWorkflowSpec(dir);
          return { id: spec.id, name: spec.name || spec.id, description: spec.description || "", workspaceMode: spec.run?.workspace || "direct" };
        } catch {
          return { id: wid, name: wid, description: "", workspaceMode: "direct" };
        }
      }),
    );
    if (jsonFlag) {
      console.log(JSON.stringify(specs));
      return true;
    }
    console.log("Available workflows:");
    for (let i = 0; i < workflows.length; i++) { console.log(`  ${specs[i].id} - ${specs[i].description} [${specs[i].workspaceMode}]`); }
    return true;
  }

  if (action === "stop" || action === "cancel") {
    if (!target) { process.stderr.write("Missing run-id.\n"); process.exit(1); }
    const wrongPrefix = detectWrongPrefix(target, "run");
    if (wrongPrefix) { process.stderr.write(`${wrongPrefix}\n`); process.exit(1); }
    try { const fullId = getWorkflowStatus(target).id; const r = await stopWorkflow(fullId, { source: "cli-stop" }); console.log(`Cancelled run run-${r.runId.slice(0, 8)}.`); } catch (err) { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); }
    return true;
  }

  if (action === "pause") {
    if (!target) { process.stderr.write("Missing run-id.\n"); process.exit(1); }
    const wrongPrefix = detectWrongPrefix(target, "run");
    if (wrongPrefix) { process.stderr.write(`${wrongPrefix}\n`); process.exit(1); }
    const drain = args.includes("--drain");
    let fullId: string;
    let runStatus: string;
    try {
      const detail = getWorkflowStatus(target);
      fullId = detail.id;
      runStatus = detail.status;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    if (runStatus !== "running") {
      process.stderr.write(`Cannot pause run run-${fullId.slice(0, 8)}: status is "${runStatus}" (only running runs can be paused).\n`);
      process.exit(1);
    }
    const response = await pauseRunWithDaemon(fullId, drain, cliIdentity);
    if (response === null) {
      process.stderr.write("Daemon is unreachable. Is the daemon running? Try: tamandua daemon start\n");
      process.exit(1);
    }
    if (response.status !== 200) {
      const errMsg = typeof response.body.error === "string" ? response.body.error : "Unknown error";
      process.stderr.write(`Failed to pause run: ${errMsg}\n`);
      process.exit(1);
    }
    console.log(`Paused run run-${fullId.slice(0, 8)}.`);
    return true;
  }

  if (action === "resume") {
    if (!target) { process.stderr.write("Missing run-id.\n"); process.exit(1); }
    const wrongPrefix = detectWrongPrefix(target, "run");
    if (wrongPrefix) { process.stderr.write(`${wrongPrefix}\n`); process.exit(1); }
    let fullId: string;
    let runStatus: string;
    try {
      const detail = getWorkflowStatus(target);
      fullId = detail.id;
      runStatus = detail.status;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    if (runStatus === "paused") {
      const response = await resumeRunWithDaemon(fullId, cliIdentity);
      if (response === null) {
        process.stderr.write("Daemon is unreachable. Is the daemon running? Try: tamandua daemon start\n");
        process.exit(1);
      }
      if (response.status !== 200 && response.status !== 202) {
        const errMsg = typeof response.body.error === "string" ? response.body.error : "Unknown error";
        process.stderr.write(`Failed to resume run: ${errMsg}\n`);
        process.exit(1);
      }
      console.log(`Resumed run run-${fullId.slice(0, 8)}.`);
      printNonDoneStepStates(fullId);
      return true;
    }
    if (runStatus === "failed") {
      const result = await resumeWorkflow(fullId);
      if (result.status === "not_found") { console.log(`No failed run found matching "${target}".`); return true; }
      console.log(`Resumed run run-${result.runId!.slice(0, 8)} (${result.workflowId}), restarting from step: ${result.stepId}`);
      printNonDoneStepStates(result.runId!);
      return true;
    }
    if (runStatus === "completed" || runStatus === "canceled") {
      process.stderr.write(`Cannot resume run run-${fullId.slice(0, 8)}: status is "${runStatus}" (terminal runs cannot be resumed).\n`);
      process.exit(1);
    }
    process.stderr.write(`Cannot resume run run-${fullId.slice(0, 8)}: status is "${runStatus}" (only paused or failed runs can be resumed).\n`);
    process.exit(1);
  }

  if (action === "pause-all") {
    const drain = args.includes("--drain");
    const runs = listRuns(1000).filter(r => r.status === "running");
    if (runs.length === 0) {
      console.log("No runs to pause.");
      return true;
    }
    let paused = 0;
    for (const r of runs) {
      const response = await pauseRunWithDaemon(r.id, drain, cliIdentity);
      if (response === null) {
        console.warn(`Warning: daemon unreachable for run run-${r.id.slice(0, 8)} — skipped`);
        continue;
      }
      if (response.status !== 200) {
        console.warn(`Warning: failed to pause run run-${r.id.slice(0, 8)} — skipped`);
        continue;
      }
      paused++;
    }
    console.log(`Paused ${paused} run(s).`);
    return true;
  }

  if (action === "resume-all") {
    const runs = listRuns(1000).filter(r => r.status === "paused");
    if (runs.length === 0) {
      console.log("No runs to resume.");
      return true;
    }
    let resumed = 0;
    for (const r of runs) {
      const response = await resumeRunWithDaemon(r.id, cliIdentity);
      if (response === null) {
        console.warn(`Warning: daemon unreachable for run run-${r.id.slice(0, 8)} — skipped`);
        continue;
      }
      if (response.status !== 200 && response.status !== 202) {
        console.warn(`Warning: failed to resume run run-${r.id.slice(0, 8)} — skipped`);
        continue;
      }
      resumed++;
      console.log(`  Resumed run run-${r.id.slice(0, 8)}.`);
      printNonDoneStepStates(r.id);
      console.log();
    }
    console.log(`Resumed ${resumed} run(s).`);
    return true;
  }

  const WORKFLOW_ACTIONS = [
    "runs", "list", "stop", "cancel", "pause", "resume", "pause-all", "resume-all",
    "install", "uninstall", "run", "status", "autoresearch", "wait", "delete", "fail", "ensure-crons",
  ];
  if (!WORKFLOW_ACTIONS.includes(action)) {
    reportUnknownCommand(action, WORKFLOW_ACTIONS, "workflow");
  }

  if (!target) { printUsage(); process.exit(1); }

  if (action === "install") {
    const isAll = target === "--all" || target === "all";
    if (isAll) {
      const workflows = await listBundledWorkflows();
      if (workflows.length === 0) { console.log("No bundled workflows found."); return true; }
      console.log(`Installing ${workflows.length} workflow(s)...`);
      let failures = 0;
      for (const wf of workflows) { try { await installWorkflow({ workflowId: wf }); console.log(`  ✓ ${wf}`); } catch (err) { console.log(`  ✗ ${wf}: ${err instanceof Error ? err.message : String(err)}`); failures++; } }
      if (failures > 0) {
        console.log(`${failures} of ${workflows.length} workflows failed to install`);
        process.exitCode = 1;
      }
      console.log(`\nDone. Start with: tamandua workflow run <name> "your task"`);
      return true;
    }
    const result = await installWorkflow({ workflowId: target });
    console.log(`Installed workflow: ${result.workflowId}\nAgent crons will start when a run begins.\n\nStart with: tamandua workflow run ${result.workflowId} "your task"`);
    return true;
  }

  if (action === "uninstall") {
    const force = args.includes("--force"); const isAll = target === "--all" || target === "all";
    const activeRuns = await checkActiveRuns(isAll ? undefined : target);
    if (activeRuns.length > 0 && !force) { process.stderr.write(`Cannot uninstall: ${activeRuns.length} active run(s):\n`); activeRuns.forEach(r => process.stderr.write(`  - ${r.id}: ${r.task}\n`)); process.exit(1); }
    if (isAll) { await uninstallAllWorkflows(); console.log("All workflows uninstalled."); } else { await uninstallWorkflow(target); console.log(`Uninstalled: ${target}`); }
    return true;
  }

  if (action === "run") {
    const workflowName = args[2];
    if (!workflowName) { process.stderr.write("Missing workflow name.\n"); process.exit(1); }

    let runArgs: ReturnType<typeof parseWorkflowRunArgs>;
    try {
      runArgs = parseWorkflowRunArgs(args.slice(3));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }

    if (!runArgs.taskTitle) { process.stderr.write("Missing task description.\n"); process.exit(1); }
    let harnessType: HarnessType | undefined;
    if (runArgs.harnessAs !== undefined) {
      harnessType = runArgs.harnessAs as HarnessType;
    }

    // TATR US-009: when this CLI is invoked inside a worker round, the
    // scheduler sets TAMANDUA_RUN_ID to the run that spawned the round.
    // Derive the parent linkage from it so child runs record which run
    // created them (persisted as runs.parent_run_id and carried on
    // run.started). Manual launches outside a run have no such env var
    // and stay parentless (parent_run_id NULL).
    const parentRunId = process.env.TAMANDUA_RUN_ID?.trim() || undefined;

    const result = await runWorkflow({
      workflowId: workflowName,
      taskTitle: runArgs.taskTitle,
      workingDirectoryForHarness: runArgs.workingDirectoryForHarness,
      worktreeOriginRepository: runArgs.worktreeOriginRepository,
      worktreeOriginRef: runArgs.worktreeOriginRef,
      noHurrySaveTokensMode: runArgs.noHurrySaveTokensMode,
      noRelaunchUponRugpull: runArgs.noRelaunchUponRugpull,
      harnessType,
      context: runArgs.context,
      parentRunId,
    });
    const stalenessWarning = checkCatalogStalenessWarning();
    if (stalenessWarning) {
      process.stderr.write(stalenessWarning + "\n");
    }
    if (result.captureWarnings) {
      for (const warning of result.captureWarnings) {
        process.stderr.write(warning + "\n");
      }
    }
    // Build wait args for post-run blocking, if --wait is set
    let waitArgs: string[] | null = null;
    if (runArgs.wait) {
      waitArgs = [result.runId];
      if (runArgs.jsonFlag) waitArgs.push("--json");
      if (runArgs.timeout) waitArgs.push("--timeout", runArgs.timeout);
    }

    if (result.daemonWarning) {
      let dashboardLine = "";
      try {
        const port = readPort();
        dashboardLine = `\nDashboard: http://localhost:${port}/`;

      } catch {
        // can't read dashboard port
      }
      console.log(`Run: ${prefixRunId(result.runId)}\nWorkflow: ${result.workflowId}\nTask: ${result.taskTitle}\nRun created (pending admission); the reconciler will admit it when the control plane responds.`);
      console.log(`Check: tamandua workflow status run-${result.runId.slice(0, 8)}${dashboardLine}`);
    } else {
      console.log(`Run: ${prefixRunId(result.runId)}\nWorkflow: ${result.workflowId}\nTask: ${result.taskTitle}\nStatus: ${result.status}\nHarness CWD: ${result.workingDirectoryForHarness}`);
    }

    // If --wait, enter the wait loop for the newly created run
    if (waitArgs) {
      const exitCode = await handleWait(waitArgs);
      process.exitCode = exitCode;
    }

    return true;
  }

  if (action === "status") {
    if (!target) { process.stderr.write("Missing query.\n"); process.exit(1); }
    const wrongPrefix = detectWrongPrefix(target, "run");
    if (wrongPrefix) { process.stderr.write(`${wrongPrefix}\n`); process.exit(1); }
    const jsonFlag = args.includes("--json");
    try {
      const result = getWorkflowStatus(target);
      if (jsonFlag) {
        const jsonSteps = result.steps.map((s) => {
          const entry: Record<string, unknown> = {
            stepId: prefixStepId(s.stepId),
            stepIndex: s.stepIndex,
            agentRole: s.agentId.split("_").slice(-1)[0],
            status: s.status,
            displayStatus: s.displayStatus,
            retryCount: s.retryCount,
          };
          if (s.abandonedCount !== undefined) entry.abandonedCount = s.abandonedCount;
          if (s.rerouteCount !== undefined) entry.rerouteCount = s.rerouteCount;
          if (s.claimPid !== undefined) entry.claimPid = s.claimPid;
          if (s.claimUpdatedAt !== undefined) entry.claimUpdatedAt = s.claimUpdatedAt;
          if (s.updatedAt !== undefined) entry.updatedAt = s.updatedAt;
          return entry;
        });
        const jsonStories = result.stories ? result.stories.map((s) => {
          const entry: Record<string, unknown> = {
            storyId: s.storyId,
            title: s.title,
            status: s.status,
          };
          if (s.abandonedCount !== undefined) entry.abandonedCount = s.abandonedCount;
          if (s.updatedAt !== undefined) entry.updatedAt = s.updatedAt;
          return entry;
        }) : undefined;
        const jsonOutput: Record<string, unknown> = {
          runId: prefixRunId(result.id),
          runNumber: result.runNumber,
          workflowId: result.workflowId,
          status: result.status,
          harnessType: result.harnessType,
          task: result.task.slice(0, 200),
          tokensSpent: result.tokensSpent,
          createdAt: result.createdAt,
          updatedAt: result.updatedAt,
          steps: jsonSteps,
        };
        if (jsonStories) jsonOutput.stories = jsonStories;
        if (result.redLedgerLanding) jsonOutput.redLedgerLanding = result.redLedgerLanding;
        if (result.workspace_mode === "worktree") {
          jsonOutput.workspaceMode = result.workspace_mode;
          if (result.worktree_path) jsonOutput.worktreePath = result.worktree_path;
          if (result.worktree_origin_ref) jsonOutput.worktreeOriginRef = result.worktree_origin_ref;
        }
        console.log(JSON.stringify(jsonOutput));
        return true;
      }
      console.log(`Run: ${prefixRunId(result.id)}\nWorkflow: ${result.workflowId}\nTask: ${result.task}\nStatus: ${result.status}`);
      if (result.harnessType !== "pi") {
        const harnessLabel = result.harnessType === "dsh" ? "dsh (alpha)" : result.harnessType;
        console.log(`Harness: ${harnessLabel}`);
      }
      console.log(`Tokens: ${result.tokensSpent.toLocaleString()}`);
      if (result.redLedgerLanding) {
        console.log(`Red-ledger landing: row ${result.redLedgerLanding.ledgerRowId}, exit ${result.redLedgerLanding.exitCode}, suite recorded ${result.redLedgerLanding.ledgerCreatedAt}`);
      }
      if (result.ceilingExpiryCount > 0) console.log(`Rounds expired at ceiling: ${result.ceilingExpiryCount}`);
      if (result.workerLostCount > 0) console.log(`Worker lost: ${result.workerLostCount}`);
      // Instant-fail loop surfacing (DDTH): make the pathology visible
      // before it is fatal — K+ consecutive sub-threshold zero-output
      // nonzero-exit rounds mean the motor is backing off and heading for
      // force-fail escalation.
      if (result.instantFailCount >= getInstantFailBackoffThreshold()) {
        console.log(`Worker instant-fail loop: ${result.instantFailCount} consecutive sub-${Math.round(getInstantFailWallThresholdMs() / 1000)}s exit-1 rounds`);
      }
      if (result.workspace_mode === "worktree") {
        console.log(`Workspace: ${result.workspace_mode}`);
        if (result.worktree_path) console.log(`Worktree: ${result.worktree_path}`);
        if (result.worktree_origin_ref) console.log(`Origin ref: ${result.worktree_origin_ref}`);
      }
      // Surface abandon reasons for failed runs
      if (result.status === "failed") {
        const aggregate = buildAbandonReasonAggregate(result.id);
        const hasRecords = !aggregate.includes("no per-story abandonment records found");
        if (hasRecords) {
          console.log(`Abandon reasons: ${aggregate}`);
        }
      }
      console.log(`Steps:`);
      for (const step of result.steps) {
        const ds = step.displayStatus;
        const icon = ds === "done" ? "  [done   ]" : ds === "running" ? "  [running]" : ds === "failed" ? "  [failed ]" : ds === "pending" ? "  [pending]" : ds === "verifying" ? "  [verify ]" : `  [${ds.padEnd(7)}]`;
        console.log(`${icon} ${prefixStepId(step.stepId)} (${step.agentId.split("_").slice(-1)[0]})`);
        if (step.status === "failed" && step.output) {
          console.log(`         ${step.output}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : `No run found matching "${target}".`;
      console.log(message.startsWith("No run found matching") ? `No run found matching "${target}".` : message);
    }
    return true;
  }

  if (action === "autoresearch") {
    if (!target) {
      process.stderr.write("Missing run-id.\nUsage: tamandua workflow autoresearch <run-id>\n");
      process.exit(1);
    }
    const wrongPrefix = detectWrongPrefix(target, "run");
    if (wrongPrefix) { process.stderr.write(`${wrongPrefix}\n`); process.exit(1); }
    printWorkflowAutoresearch(target);
    return true;
  }

  if (action === "wait") {
    // Shift args to remove the group+action prefix, keeping remaining args.
    // handleWait returns the exit code. Set it as the process exit code.
    const exitCode = await handleWait(args.slice(2));
    process.exitCode = exitCode;
    return true;
  }

  if (action === "delete") {
    if (!target) { process.stderr.write("Missing run-id.\nUsage: tamandua workflow delete <run-id> [--force]\n"); process.exit(1); }
    const wrongPrefix = detectWrongPrefix(target, "run");
    if (wrongPrefix) { process.stderr.write(`${wrongPrefix}\n`); process.exit(1); }
    const force = args.includes("--force");
    try {
      let fullId: string;
      try {
        fullId = getWorkflowStatus(target).id;
      } catch (err) {
        const message = err instanceof Error ? err.message : `No run found matching "${target}".`;
        process.stderr.write(message.startsWith("No run found matching") ? `No run found matching "${target}".\n` : `${message}\n`);
        process.exit(1);
      }
      const result = await deleteWorkflow(fullId, { force });
      console.log(`Deleted run run-${result.runId.slice(0, 8)}.`);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    return true;
  }



  if (action === "fail") {
    if (!target) { process.stderr.write("Missing run-id.\nUsage: tamandua workflow fail <run-id> --reason <text> [--force]\n"); process.exit(1); }

    const wrongPrefix = detectWrongPrefix(target, "run");
    if (wrongPrefix) { process.stderr.write(`${wrongPrefix}\n`); process.exit(1); }

    // Parse --reason and --force from args (skip group and action indices)
    const failArgs = args.slice(2);
    const reasonIdx = failArgs.indexOf("--reason");
    let failReason: string | undefined;
    if (reasonIdx !== -1 && reasonIdx + 1 < failArgs.length) {
      failReason = failArgs[reasonIdx + 1];
    }
    if (!failReason) {
      process.stderr.write("Missing --reason. Usage: tamandua workflow fail <run-id> --reason <text> [--force]\n");
      process.exit(1);
    }
    const forceFlag = failArgs.includes("--force");

    let fullId: string;
    let runStatus: string;
    try {
      const detail = getWorkflowStatus(target);
      fullId = detail.id;
      runStatus = detail.status;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }

    if (runStatus !== "running" && runStatus !== "paused") {
      process.stderr.write(`Cannot force-fail run run-${fullId.slice(0, 8)}: status is "${runStatus}" (only running or paused runs can be force-failed).\n`);
      process.exit(1);
    }

    try {
      const result = await forceFailRun(fullId, failReason, forceFlag);
      if (!result.ok) {
        // Refused due to alive workers
        process.stderr.write(`${result.reason}\n`);
        if (result.aliveWorkers) {
          for (const w of result.aliveWorkers) {
            process.stderr.write(`  Step step-${w.stepId.slice(0, 8)} (${w.agentId}) PID ${w.pid}\n`);
          }
        }
        logger.warn(`forceFailRun refused: ${result.reason}`, { runId: fullId, aliveWorkers: result.aliveWorkers });
        process.exit(1);
      }
      console.log(`Force-failed run run-${fullId.slice(0, 8)}: ${failReason}`);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    return true;
  }

  if (action === "ensure-crons") {
    // Polling jobs are now tied to (runId, agentId) and admitted via the
    // daemon control plane. There is no longer a workflow-wide
    // "ensure-crons" notion — use `tamandua workflow run` instead
    // (which registers the new run with the daemon).
    process.stderr.write(
      "`workflow ensure-crons` is removed. Run-scoped scheduling makes it obsolete \u2014 " +
      "start a run with `tamandua workflow run <id> '<task>'`.\n",
    );
    process.exit(1);
  }

  // Unreachable — all known actions exit or return above. The unknown-action
  // guard before the target check ensures we never reach this point.
  return true;
}
