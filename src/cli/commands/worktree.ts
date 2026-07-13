/**
 * worktree command group — manage git worktrees for workflow runs.
 *
 * Extracted from src/cli/cli.ts (SPLC story US-010).
 */

import {
  listRunWorktrees,
  getRunWorktree,
  removeRunWorktree,
  type ManagedRunWorktree,
} from "../../installer/worktree-manager.js";
import { getWorkflowStatus as getWorkflowStatusFn } from "../../installer/status.js";
import { parseDuration } from "../shared.js";

export function formatWorktreeStatus(wt: ManagedRunWorktree): string {
  const idShort = wt.runId.substring(0, 8);
  const repoShort =
    wt.worktreeOriginRepository.split("/").slice(-2).join("/") ||
    wt.worktreeOriginRepository;
  return [
    `  [${wt.status.padEnd(9)}] ${idShort}  ${wt.cleanupPolicy.padEnd(20)} ${wt.worktreePath}`,
    `           origin: ${repoShort}${wt.worktreeOriginRef ? ` @ ${wt.worktreeOriginRef}` : ""}`,
  ].join("\n");
}

export function getWorktreeListHelp(): string {
  return `tamandua worktree list — List all managed worktrees

Usage: tamandua worktree list

Lists every managed git worktree created by Tamandua workflow runs.
Each entry shows the run ID, status, cleanup policy, and filesystem path.

Output columns:
  Status    Worktree status (ready, removed, etc.)
  Run ID    8-char run identifier prefix
  Cleanup   When the worktree will be cleaned up (e.g. on-completion)
  Path      Absolute filesystem path to the worktree
  Origin    Source repository and ref (below the main line)

Examples:
  tamandua worktree list`;
}

export function getWorktreeStatusHelp(): string {
  return `tamandua worktree status — Show detailed worktree info for a run

Usage: tamandua worktree status <run-id>

Shows detailed information about the managed git worktree associated with
a specific workflow run. Accepts a run-id prefix.

Output includes:
  Run          Run ID prefix
  Status       Worktree status (ready, removed, etc.)
  Origin repo  Source repository the worktree was cloned from
  Origin ref   Git ref used to create the worktree (branch, tag, SHA)
  Origin SHA   Full commit SHA the worktree is at
  Orig branch  Original branch the run was started from
  Worktree     Absolute filesystem path to the worktree
  Cleanup      When the worktree will be cleaned up

Examples:
  tamandua worktree status abc12345`;
}

export function getWorktreeRemoveHelp(): string {
  return `tamandua worktree remove — Remove a managed worktree

Usage: tamandua worktree remove <run-id> [--force]

Removes a managed git worktree and its associated tracking entry.
Accepts a run-id prefix to identify the worktree.

By default, removal is only allowed for worktrees with a non-ready status
(e.g. removed or after cleanup). To remove a worktree that is still active
or in ready status, use --force.

Options:
  --force    Allow removal of worktrees in any status (not just non-ready).

Examples:
  tamandua worktree remove abc12345
  tamandua worktree remove abc12345 --force`;
}

export function getWorktreePruneHelp(): string {
  return `tamandua worktree prune — Remove old completed worktrees

Usage: tamandua worktree prune --completed --older-than <duration>

Prunes (removes) managed git worktrees that are associated with completed
or canceled workflow runs and are older than the specified duration.
This is a cleanup command that helps reclaim disk space from old worktrees.

Options (both required):
  --completed        Only prune worktrees for completed or canceled runs.
  --older-than <d>   Only prune worktrees older than the given duration.

Duration format:
  Duration is specified as a number followed by a unit letter:
    d — days   (e.g. 7d  = 7 days)
    h — hours  (e.g. 24h = 24 hours)
    m — minutes(e.g. 30m = 30 minutes)

Examples:
  tamandua worktree prune --completed --older-than 7d
  tamandua worktree prune --completed --older-than 24h
  tamandua worktree prune --completed --older-than 30m`;
}

export function getWorktreeGroupHelp(): string {
  return `tamandua worktree — Manage git worktrees for workflow runs

Usage: tamandua worktree <list|status|remove|prune>

Commands for managing git worktrees that Tamandua creates for workflow
runs. Worktrees provide isolated working directories so concurrent runs
never interfere with each other.

Subcommands:
  list      List all managed worktrees with status, cleanup policy, and paths
  status    Show detailed info for a specific run's worktree
  remove    Remove a managed worktree (--force for non-ready statuses)
  prune     Remove old completed worktrees (requires --completed and --older-than)

Examples:
  tamandua worktree list
  tamandua worktree status abc12345
  tamandua worktree remove abc12345 --force
  tamandua worktree prune --completed --older-than 7d`;
}

/**
 * Handle worktree command group (list, status, remove, prune).
 * Returns true if the command was handled, false if not recognized.
 */
export async function handleWorktree(group: string, args: string[]): Promise<boolean> {
  if (group !== "worktree") return false;

  const action = args[1];
  const target = args[2];

  if (action === "list") {
    const worktrees = listRunWorktrees();
    if (worktrees.length === 0) {
      console.log("No managed worktrees found.");
      return true;
    }
    console.log("Managed worktrees:");
    for (const wt of worktrees) {
      console.log(formatWorktreeStatus(wt));
    }
    return true;
  }

  if (action === "status") {
    if (!target) {
      process.stderr.write("Missing run-id.\nUsage: tamandua worktree status <run-id>\n");
      process.exit(1);
    }
    // Resolve the run ID prefix to a full run ID via getWorkflowStatus
    let fullRunId: string;
    try {
      fullRunId = getWorkflowStatusFn(target).id;
    } catch (err) {
      const message = err instanceof Error ? err.message : `No run found matching "${target}".`;
      process.stderr.write(
        message.startsWith("No run found matching") ? `No run found matching "${target}".\n` : `${message}\n`,
      );
      process.exit(1);
    }

    const wt = getRunWorktree(fullRunId);
    if (!wt) {
      console.log(`No managed worktree for run ${fullRunId.slice(0, 8)}.`);
      return true;
    }

    console.log(`Run:          ${wt.runId.slice(0, 8)}`);
    console.log(`Status:       ${wt.status}`);
    console.log(`Origin repo:  ${wt.worktreeOriginRepository}`);
    console.log(`Origin ref:   ${wt.worktreeOriginRef || "(none)"}`);
    console.log(`Origin SHA:   ${wt.worktreeOriginSha || "(none)"}`);
    console.log(`Orig branch:  ${wt.originalBranch || "(none)"}`);
    console.log(`Worktree:     ${wt.worktreePath}`);
    console.log(`Cleanup:      ${wt.cleanupPolicy}`);
    return true;
  }

  if (action === "remove") {
    if (!target) {
      process.stderr.write("Missing run-id.\nUsage: tamandua worktree remove <run-id> [--force]\n");
      process.exit(1);
    }
    const force = args.includes("--force");
    let fullRunId: string;
    try {
      fullRunId = getWorkflowStatusFn(target).id;
    } catch (err) {
      const message = err instanceof Error ? err.message : `No run found matching "${target}".`;
      process.stderr.write(
        message.startsWith("No run found matching") ? `No run found matching "${target}".\n` : `${message}\n`,
      );
      process.exit(1);
    }

    try {
      removeRunWorktree({ runId: fullRunId, force });
      console.log(`Removed managed worktree for run ${fullRunId.slice(0, 8)}.`);
    } catch (err) {
      process.stderr.write(
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
    return true;
  }

  if (action === "prune") {
    const completedFlagIdx = args.indexOf("--completed");
    if (completedFlagIdx === -1) {
      process.stderr.write(
        "Missing --completed flag.\nUsage: tamandua worktree prune --completed --older-than <duration>\n",
      );
      process.exit(1);
    }

    const olderThanIdx = args.indexOf("--older-than");
    if (olderThanIdx === -1 || !args[olderThanIdx + 1]) {
      process.stderr.write(
        "Missing --older-than <duration>.\nUsage: tamandua worktree prune --completed --older-than <duration>\n",
      );
      process.exit(1);
    }

    let thresholdMs: number;
    try {
      thresholdMs = parseDuration(args[olderThanIdx + 1]);
    } catch (err) {
      process.stderr.write(
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }

    const cutoff = Date.now() - thresholdMs;
    const worktrees = listRunWorktrees();
    let pruned = 0;

    for (const wt of worktrees) {
      if (wt.status === "removed") continue;

      // Handle cleanup_failed worktrees: retry removal regardless of run existence
      if (wt.status === "cleanup_failed") {
        try {
          removeRunWorktree({ runId: wt.runId, force: true });
          pruned++;
          console.log(`Pruned cleanup_failed worktree for run ${wt.runId.slice(0, 8)}.`);
        } catch (err) {
          console.warn(
            `Warning: failed to prune cleanup_failed worktree for run ${wt.runId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        continue;
      }

      // Check if the associated run is completed/canceled
      let runStatus: string;
      try {
        runStatus = getWorkflowStatusFn(wt.runId).status;
      } catch {
        // Run not found, skip
        continue;
      }

      if (runStatus !== "completed" && runStatus !== "canceled") continue;

      // Check age: we need the worktree created_at from DB
      // getRunWorktree() doesn't expose created_at, so query DB directly
      const { getDb } = await import("../../db.js");
      const db = getDb();
      const row = db
        .prepare(
          "SELECT created_at FROM run_worktrees WHERE run_id = ?",
        )
        .get(wt.runId) as { created_at: string } | undefined;

      if (!row) continue;

      const createdAt = new Date(row.created_at).getTime();
      if (createdAt >= cutoff) continue;

      // Remove (force for non-ready status, since it's terminal pruning)
      try {
        removeRunWorktree({ runId: wt.runId, force: true });
        pruned++;
        console.log(
          `Pruned worktree for run ${wt.runId.slice(0, 8)} (${runStatus}).`,
        );
      } catch (err) {
        console.warn(
          `Warning: failed to prune run ${wt.runId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (pruned === 0) {
      console.log("No worktrees to prune.");
    } else {
      console.log(`Pruned ${pruned} worktree(s).`);
    }
    return true;
  }

  process.stderr.write(
    `Unknown worktree action: ${action}\nUsage: tamandua worktree <list|status|remove|prune>\n`,
  );
  process.exit(1);
}
