import { execFileSync } from "node:child_process";
import { getDb } from "../db.js";
import { emitEvent } from "./events.js";
import { parseRunContext } from "./step-ops.js";
import type { HarnessType } from "./types.js";

/**
 * Result of rugpull detection for a failed run.
 */
export interface RugpullResult {
  /** Whether this failure qualifies as a rugpull (merge workflow + moved base branch). */
  isRugpull: boolean;
  /** Human-readable explanation of the detection result. */
  reason?: string;
}

/**
 * Determine whether a failed run qualifies as a "rugpull":
 * the run belongs to a merge or merge-worktree workflow, it failed at
 * the finalize_merge step, and the base branch tip has moved since
 * the run started.
 *
 * May emit rugpull.self_merge_detected events when tree comparison reveals
 * an own-merge-already-landed scenario. Callers are responsible for all other
 * event emission.
 */
export function detectRugpull(runId: string): RugpullResult {
  const db = getDb();

  // 1. Look up the run
  const run = db
    .prepare("SELECT workflow_id, context, status FROM runs WHERE id = ?")
    .get(runId) as
    | { workflow_id: string; context: string; status: string }
    | undefined;

  if (!run) {
    return { isRugpull: false, reason: "Run not found" };
  }

  // 2. Only merge and merge-worktree workflows can rugpull
  if (
    !run.workflow_id.endsWith("-merge") &&
    !run.workflow_id.endsWith("-merge-worktree")
  ) {
    return {
      isRugpull: false,
      reason: `Workflow "${run.workflow_id}" is not a merge workflow`,
    };
  }

  // 3. Must have a failed finalize_merge step
  const failedMerge = db
    .prepare(
      "SELECT id FROM steps WHERE run_id = ? AND step_id = 'finalize_merge' AND status = 'failed' LIMIT 1",
    )
    .get(runId) as { id: string } | undefined;

  if (!failedMerge) {
    return {
      isRugpull: false,
      reason: "No failed finalize_merge step found",
    };
  }

  // 4. Get the base_branch_sha captured at run creation time
  const context: Record<string, string> = parseRunContext(runId, run.context);
  const baseBranchSha = context.base_branch_sha;

  if (!baseBranchSha) {
    return {
      isRugpull: false,
      reason: "Missing base_branch_sha in run context",
    };
  }

  // 5. Get the current tip of the base branch
  const workspaceMode = context.workspace_mode;
  let currentSha: string;

  if (workspaceMode === "worktree") {
    // Worktree mode: resolve against the origin repository
    const wt = db
      .prepare(
        "SELECT worktree_origin_repository FROM run_worktrees WHERE run_id = ? LIMIT 1",
      )
      .get(runId) as
      | { worktree_origin_repository: string }
      | undefined;

    if (!wt) {
      return { isRugpull: false, reason: "Worktree record not found" };
    }

    // Resolve the current tip of the recorded origin ref, not HEAD.
    // HEAD in the origin repository may point to a different branch
    // (e.g. main) while the run used --worktree-origin-ref develop.
    const originRef = context.worktree_origin_ref || "HEAD";
    try {
      currentSha = execFileSync("git", ["rev-parse", originRef], {
        cwd: wt.worktree_origin_repository,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      return {
        isRugpull: false,
        reason: `Failed to resolve ref "${originRef}" in origin repository`,
      };
    }
  } else {
    // Direct mode: resolve against the working directory
    const repo =
      context.repo || context.working_directory_for_harness;

    if (!repo) {
      return {
        isRugpull: false,
        reason: "No repository path available in run context",
      };
    }

    // Resolve the current tip of the recorded base branch, not HEAD.
    // HEAD may point to a feature branch after a final-merge failure
    // or rebase state, which would falsely flag a rugpull when the
    // base branch is unchanged.
    const baseRef = context.original_branch || "HEAD";
    try {
      currentSha = execFileSync("git", ["rev-parse", baseRef], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      return {
        isRugpull: false,
        reason: `Failed to resolve ref "${baseRef}" in working directory`,
      };
    }
  }

  // 6. Compare: equal = no rugpull, different = rugpull
  if (baseBranchSha === currentSha) {
    return {
      isRugpull: false,
      reason: "Base branch SHA has not changed since run started",
    };
  }

  // 7. Self-merge detection: when tested_tree is available and the base
  //    branch has moved, compare the current tip's tree with the tree
  //    captured at run creation. If they match, the run's own merge
  //    already landed — suppress the rugpull.
  const testedTree = context.tested_tree;
  if (testedTree && testedTree.length > 0) {
    let currentTree: string;
    try {
      if (workspaceMode === "worktree") {
        // Re-query for cwd (validated in step 5)
        const wt = db
          .prepare(
            "SELECT worktree_origin_repository FROM run_worktrees WHERE run_id = ? LIMIT 1",
          )
          .get(runId) as
          | { worktree_origin_repository: string }
          | undefined;
        if (!wt) throw new Error("Worktree record not found");
        currentTree = execFileSync(
          "git",
          ["rev-parse", `${currentSha}^{tree}`],
          {
            cwd: wt.worktree_origin_repository,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        ).trim();
      } else {
        const repo =
          context.repo || context.working_directory_for_harness;
        if (!repo) throw new Error("No repository path available in run context");
        currentTree = execFileSync(
          "git",
          ["rev-parse", `${currentSha}^{tree}`],
          {
            cwd: repo,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        ).trim();
      }
    } catch {
      // Tree resolution failed — fall back to existing rugpull behavior
      return {
        isRugpull: true,
        reason: `Base branch moved from ${baseBranchSha.slice(0, 7)} to ${currentSha.slice(0, 7)}`,
      };
    }

    if (currentTree === testedTree) {
      emitEvent({
        ts: new Date().toISOString(),
        event: "rugpull.self_merge_detected",
        runId,
        workflowId: run.workflow_id,
        detail: `Own merge already landed — tested_tree matches current tip tree (base_branch_sha: ${baseBranchSha}, currentSha: ${currentSha})`,
      });
      return {
        isRugpull: false,
        reason: "own merge already landed",
      };
    }
  }

  return {
    isRugpull: true,
    reason: `Base branch moved from ${baseBranchSha.slice(0, 7)} to ${currentSha.slice(0, 7)}`,
  };
}

/**
 * Extract user-provided context keys from a run context record,
 * stripping all internally-managed keys that Tamandua seeds during
 * run creation. Returns only the keys originally provided by the
 * caller via --context.
 *
 * Internally-managed keys are removed by exact match against a
 * fixed denylist, plus a catch-all for any key starting with
 * "worktree_" for defense in depth.
 */
export function extractUserContext(
  parsedContext: Record<string, string>,
): Record<string, string> {
  const denylist = new Set([
    "task",
    "workspace_mode",
    "base_branch_sha",
    "working_directory_for_harness",
    "harness_type",
    "no_hurry_save_tokens_mode",
    "no_relaunch_upon_rugpull",
    "repo",
    "original_branch",
    "worktree_path",
    "worktree_origin_repository",
    "worktree_origin_ref",
    "worktree_origin_sha",
    "target_working_directory_for_harness",
  ]);

  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(parsedContext)) {
    if (!denylist.has(key) && !key.startsWith("worktree_")) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Result of a rugpull relaunch attempt.
 */
export interface RelaunchResult {
  /** Whether a replacement run was successfully launched. */
  relaunched: boolean;
  /** The ID of the newly launched replacement run (only set when relaunched=true). */
  newRunId?: string;
}

/**
 * Launch a replacement run with the same parameters as the original failed run.
 *
 * Reads the original run's workflow_id, task, and context from the DB.
 * If `no_relaunch_upon_rugpull` is "true" in the original run's context,
 * the relaunch is suppressed (an event is still emitted indicating suppression).
 *
 * For worktree workflows: passes worktree_origin_repository and
 * worktree_origin_ref so a fresh worktree is created. The failed run's
 * worktree is left untouched.
 *
 * For direct workflows: passes working_directory_for_harness.
 *
 * Uses a dynamic import of runWorkflow to avoid circular dependencies
 * when step-ops.ts imports rugpull.ts.
 */
export async function relaunchRunAfterRugpull(
  failedRunId: string,
): Promise<RelaunchResult> {
  const db = getDb();

  // Read the failed run's parameters
  const run = db
    .prepare(
      "SELECT workflow_id, task, context, notify_url FROM runs WHERE id = ?",
    )
    .get(failedRunId) as
    | {
        workflow_id: string;
        task: string;
        context: string;
        notify_url: string | null;
      }
    | undefined;

  if (!run) {
    return { relaunched: false };
  }

  const context: Record<string, string> = parseRunContext(failedRunId, run.context);

  // Check no_relaunch_upon_rugpull suppression flag
  if (context.no_relaunch_upon_rugpull === "true") {
    emitEvent({
      ts: new Date().toISOString(),
      event: "run.rugpull_relaunch_suppressed",
      runId: failedRunId,
      workflowId: run.workflow_id,
      detail: "Relaunch suppressed by --no-relaunch-upon-rugpull flag",
    });
    return { relaunched: false };
  }

  // Extract user-provided context keys (strip internal keys that runWorkflow regenerates).
  // This ensures template references like {{branch}} resolve correctly in the replacement run.
  const userContext = extractUserContext(context);

  // Reconstruct original parameters from context
  const harnessType = (context.harness_type as HarnessType) || "pi";
  const noHurry = context.no_hurry_save_tokens_mode === "true";
  const workspaceMode = context.workspace_mode;

  // Dynamic import to avoid circular dependency: step-ops.ts → rugpull.ts → run.ts
  const { runWorkflow } = await import("./run.js");

  let result: Awaited<ReturnType<typeof runWorkflow>>;

  try {
    if (workspaceMode === "worktree") {
      const worktreeOriginRepo = context.worktree_origin_repository;
      const worktreeOriginRef = context.worktree_origin_ref || undefined;

      if (!worktreeOriginRepo) {
        emitEvent({
          ts: new Date().toISOString(),
          event: "run.rugpull_relaunch_failed",
          runId: failedRunId,
          workflowId: run.workflow_id,
          detail:
            "Rugpull relaunch not attempted: worktree_origin_repository is missing from run context",
        });
        return { relaunched: false };
      }

      result = await runWorkflow({
        workflowId: run.workflow_id,
        taskTitle: run.task,
        notifyUrl: run.notify_url ?? undefined,
        harnessType,
        noHurrySaveTokensMode: noHurry,
        worktreeOriginRepository: worktreeOriginRepo,
        worktreeOriginRef,
        context: userContext,
      });
    } else {
      const workingDir =
        context.working_directory_for_harness || context.repo;

      if (!workingDir) {
        emitEvent({
          ts: new Date().toISOString(),
          event: "run.rugpull_relaunch_failed",
          runId: failedRunId,
          workflowId: run.workflow_id,
          detail:
            "Rugpull relaunch not attempted: working_directory_for_harness is missing from run context",
        });
        return { relaunched: false };
      }

      result = await runWorkflow({
        workflowId: run.workflow_id,
        taskTitle: run.task,
        notifyUrl: run.notify_url ?? undefined,
        harnessType,
        noHurrySaveTokensMode: noHurry,
        workingDirectoryForHarness: workingDir,
        context: userContext,
      });
    }
  } catch (err) {
    // If runWorkflow fails (e.g. daemon unreachable), treat as non-relaunched.
    // Callers should fire-and-forget this function so errors here don't cascade.
    emitEvent({
      ts: new Date().toISOString(),
      event: "run.rugpull_relaunch_failed",
      runId: failedRunId,
      workflowId: run.workflow_id,
      detail: `Rugpull relaunch failed: ${String(err)}`,
    });
    return { relaunched: false };
  }

  // Emit relaunch event with both run IDs
  emitEvent({
    ts: new Date().toISOString(),
    event: "run.rugpull_relaunched",
    runId: failedRunId,
    workflowId: run.workflow_id,
    detail: `Rugpull replacement run launched: ${result.runId}`,
  });

  return { relaunched: true, newRunId: result.runId };
}
