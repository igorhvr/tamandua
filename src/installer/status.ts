import { getDb } from "../db.js";
import { scheduleRunCronTeardown, getWorkflowId, emitRunTerminalEvent, parseRunContext } from "./step-ops.js";
import { removeRunCrons } from "./agent-scheduler.js";
import { terminateRunWithDaemon } from "../server/control-client.js";
import { getRunWorktree, removeRunWorktree } from "./worktree-manager.js";
import { emitEvent, getRunEvents } from "./events.js";
import { logger } from "../lib/logger.js";
import { stripIdPrefix } from "../lib/id-prefix.js";
import { displayStepStatus } from "../lib/step-display.js";
import type { HarnessType } from "./types.js";

export interface RunInfo {
  id: string;
  runNumber?: number;
  workflowId: string;
  task: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  stepSummary?: string;
  tokensSpent: number;
  workerLostCount: number;
  /** Rounds the motor itself killed at the worker time ceiling (step.ceiling_expiry). */
  ceilingExpiryCount: number;
  redLedgerLanding?: RedLedgerLanding;
}

export interface RedLedgerLanding {
  ledgerRowId: number;
  exitCode: number;
  ledgerCreatedAt: string;
}

export interface RunDetail extends RunInfo {
  runNumber?: number;
  steps: StepInfo[];
  stories?: StoryInfo[];
  /** Harness selected for the run, resolved from context harness_type (default "pi"). */
  harnessType: HarnessType;
  workspace_mode?: string;
  worktree_path?: string;
  worktree_origin_repository?: string;
  worktree_origin_ref?: string;
  worktree_origin_sha?: string;
}

export interface StepInfo {
  stepId: string;
  agentId: string;
  status: string;
  displayStatus: string;
  type: string;
  currentStoryId?: string | null;
  retryCount: number;
  stepIndex: number;
  abandonedCount?: number;
  rerouteCount?: number;
  claimPid?: number | null;
  claimUpdatedAt?: string | null;
  updatedAt?: string | null;
  output?: string;
}

export interface StoryInfo {
  storyId: string;
  title: string;
  status: string;
  retryCount: number;
  abandonedCount?: number;
  updatedAt?: string;
}

/**
 * Find a run by id prefix or task substring match.
 * Returns the run detail if exactly one match is found.
 * Throws if zero or multiple matches.
 */
export function getWorkflowStatus(query: string): RunDetail {
  const db = getDb();

  // Strip run- prefix so callers can pass prefixed ids directly.
  // Try the original query first (handles run IDs that happen to start
  // with "run-"), then fall back to the stripped form.
  const stripped = stripIdPrefix(query);
  const useOriginal = query !== stripped;

  // Try exact id match first (original)
  let row = db
    .prepare(
      "SELECT id, run_number, workflow_id, task, status, context, created_at, updated_at, tokens_spent, worker_lost_count, ceiling_expiry_count FROM runs WHERE id = ?",
    )
    .get(query) as unknown as (RunRow & { run_number: number | null }) | undefined;

  // If stripped is different and no match, try stripped
  if (!row && useOriginal) {
    row = db
      .prepare(
        "SELECT id, run_number, workflow_id, task, status, context, created_at, updated_at, tokens_spent, worker_lost_count, ceiling_expiry_count FROM runs WHERE id = ?",
      )
      .get(stripped) as unknown as (RunRow & { run_number: number | null }) | undefined;
  }

  // Try id prefix match (original)
  if (!row) {
    let prefixRows = db
      .prepare(
        "SELECT id, run_number, workflow_id, task, status, context, created_at, updated_at, tokens_spent, worker_lost_count, ceiling_expiry_count FROM runs WHERE id LIKE ?",
      )
      .all(`${query}%`) as unknown as (RunRow & { run_number: number | null })[];

    // If stripped is different and no match, try stripped
    if (prefixRows.length === 0 && useOriginal) {
      prefixRows = db
        .prepare(
          "SELECT id, run_number, workflow_id, task, status, context, created_at, updated_at, tokens_spent, worker_lost_count, ceiling_expiry_count FROM runs WHERE id LIKE ?",
        )
        .all(`${stripped}%`) as unknown as (RunRow & { run_number: number | null })[];
    }

    if (prefixRows.length === 1) {
      row = prefixRows[0];
    } else if (prefixRows.length > 1) {
      throw new Error(
        `Multiple runs match prefix "${query}": ${prefixRows.map((r) => r.id.slice(0, 12)).join(", ")}. Use a longer prefix to disambiguate.`,
      );
    }
  }

  // Try run-number (#N) match
  if (!row) {
    const nMatch = query.match(/^#(\d+)$/);
    if (nMatch) {
      const num = Number(nMatch[1]);
      row = db
        .prepare(
          "SELECT id, run_number, workflow_id, task, status, context, created_at, updated_at, tokens_spent, worker_lost_count, ceiling_expiry_count FROM runs WHERE run_number = ?",
        )
        .get(num) as unknown as (RunRow & { run_number: number | null }) | undefined;
      if (!row) {
        throw new Error(`No run found matching "${query}"`);
      }
    }
  }

  // Try task substring match (original first, then stripped)
  if (!row) {
    let taskRows = db
      .prepare(
        "SELECT id, run_number, workflow_id, task, status, context, created_at, updated_at, tokens_spent, worker_lost_count, ceiling_expiry_count FROM runs WHERE task LIKE ?",
      )
      .all(`%${query}%`) as unknown as (RunRow & { run_number: number | null })[];

    if (taskRows.length === 0 && useOriginal) {
      taskRows = db
        .prepare(
          "SELECT id, run_number, workflow_id, task, status, context, created_at, updated_at, tokens_spent, worker_lost_count, ceiling_expiry_count FROM runs WHERE task LIKE ?",
        )
        .all(`%${stripped}%`) as unknown as (RunRow & { run_number: number | null })[];
    }

    if (taskRows.length === 1) {
      row = taskRows[0];
    } else if (taskRows.length > 1) {
      throw new Error(
        `Multiple runs match task "${query}": ${taskRows.map((r) => `${r.id.slice(0, 8)} (${r.task.slice(0, 30)})`).join(", ")}. Use a more specific query.`,
      );
    }
  }

  if (!row) {
    const hint = " — did you pass the right id? If this is a step id, run commands expect a run id.";
    throw new Error(`No run found matching "${query}"${hint}`);
  }

  return buildRunDetail(db, row);
}

/**
 * List all runs, most recent first.
 */
export function listRuns(limit = 50): RunInfo[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, run_number, workflow_id, task, status, created_at, updated_at, tokens_spent, worker_lost_count, ceiling_expiry_count FROM runs ORDER BY created_at DESC LIMIT ?",
    )
    .all(limit) as unknown as (RunRow & { run_number: number | null })[];

  return rows.map((r) => {
    const stepSummary = getStepSummary(db, r.id);
    const redLedgerLanding = r.workflow_id.includes("merge") ? getRedLedgerLanding(r.id) : undefined;
    return {
      id: r.id,
      runNumber: r.run_number ?? undefined,
      workflowId: r.workflow_id,
      task: r.task,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      stepSummary,
      tokensSpent: r.tokens_spent,
      workerLostCount: r.worker_lost_count,
      ceilingExpiryCount: r.ceiling_expiry_count,
      ...(redLedgerLanding ? { redLedgerLanding } : {}),
    };
  });
}

/**
 * Delete a workflow run and all associated data (steps, stories, worktree).
 * Running or paused runs are canceled first.
 * If --force is not provided and the run is running/paused, the deletion is refused.
 */
export async function deleteWorkflow(
  runId: string,
  opts: { force?: boolean } = {},
): Promise<{ ok: boolean; runId: string; status: string; warning?: string }> {
  const db = getDb();

  const run = db
    .prepare("SELECT id, status FROM runs WHERE id = ?")
    .get(runId) as { id: string; status: string } | undefined;

  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  const isActive = run.status === "running" || run.status === "paused";
  if (isActive && !opts.force) {
    throw new Error(
      `Run ${runId.slice(0, 8)} is ${run.status}. Use --force to delete an active run (it will be canceled first).`,
    );
  }

  // Cancel any active run first
  if (isActive) {
    // Cancel pending/running steps
    db.prepare(
      "UPDATE steps SET status = 'canceled', updated_at = datetime('now') WHERE run_id = ? AND status IN ('waiting', 'pending', 'running')",
    ).run(runId);

    // Mark run as canceled and clear scheduling
    db.prepare(
      "UPDATE runs SET status = 'canceled', scheduling_status = NULL, updated_at = datetime('now') WHERE id = ?",
    ).run(runId);

    // Tear down cron jobs and notify daemon
    await Promise.allSettled([
      removeRunCrons(runId),
      terminateRunWithDaemon(runId),
    ]);
    scheduleRunCronTeardown(runId);
  }

  // Remove managed worktree if present
  const wt = getRunWorktree(runId);
  let worktreeWarning: string | undefined;
  if (wt && wt.status !== "removed") {
    try {
      removeRunWorktree({ runId, force: true });
    } catch (err) {
      // Track the failure instead of silently swallowing it
      const errMsg = err instanceof Error ? err.message : String(err);
      db.prepare(
        "UPDATE run_worktrees SET status = 'cleanup_failed', error = ? WHERE run_id = ?",
      ).run(errMsg, runId);
      worktreeWarning = `Worktree removal failed for run ${runId.slice(0, 8)}: ${errMsg}. Use 'tamandua worktree prune' or manually remove the path.`;
    }
  }

  // Delete associated records in dependency order
  db.prepare("DELETE FROM stories WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
  // Only delete the run_worktrees row if worktree removal succeeded
  if (!worktreeWarning) {
    db.prepare("DELETE FROM run_worktrees WHERE run_id = ?").run(runId);
  }
  db.prepare("DELETE FROM runs WHERE id = ?").run(runId);

  // Emit deletion event to logs tail and recent events
  emitEvent({
    ts: new Date().toISOString(),
    event: "run.deleted",
    runId,
    detail: isActive ? "Force-deleted while active" : "Deleted by user",
  });

  return { ok: true, runId, status: "deleted", ...(worktreeWarning ? { warning: worktreeWarning } : {}) };
}

/**
 * Cancel a running workflow.
 * Sets the run status to 'canceled' and tears down cron jobs.
 * Emits a terminal run.canceled event AFTER all cancel bookkeeping so it is
 * the last event of the run in the common path.
 *
 * @param opts.source — identifies what initiated the stop (defaults to
 *   'cli-stop'); carried as the event's `reason` field.
 */
export async function stopWorkflow(
  runId: string,
  opts: { source?: string } = {},
): Promise<{ ok: boolean; runId: string }> {
  const db = getDb();

  const run = db
    .prepare("SELECT id, status, workflow_id FROM runs WHERE id = ?")
    .get(runId) as { id: string; status: string; workflow_id: string } | undefined;

  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  if (run.status !== "running" && run.status !== "paused") {
    throw new Error(
      `Run ${runId} is already ${run.status} — cannot cancel`,
    );
  }

  // Cancel any pending/running steps
  db.prepare(
    "UPDATE steps SET status = 'canceled', updated_at = datetime('now') WHERE run_id = ? AND status IN ('waiting', 'pending', 'running')",
  ).run(runId);

  // Mark the run as canceled and clear scheduling status (terminal runs
  // never carry a scheduling_status).
  db.prepare(
    "UPDATE runs SET status = 'canceled', scheduling_status = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(runId);

  // Tear down run-scoped cron jobs in this process (best-effort), and
  // notify the daemon so it tears down its own timers too. The daemon
  // reconciler will catch any drift on the next tick if either fails.
  await Promise.allSettled([
    removeRunCrons(runId),
    terminateRunWithDaemon(runId),
  ]);

  // Workflow-wide idle teardown for back-compat (legacy callers).
  scheduleRunCronTeardown(runId);

  // Terminal event LAST, after all cancel bookkeeping, so the event stream
  // ends on a terminal record rather than just stopping. A straggling async
  // run.tokens.updated from an in-flight work round can still trail this in
  // the TATR race (out of scope for CNEV; see tests/MOTOR-CONTRACT.md).
  emitRunTerminalEvent({
    event: "run.canceled",
    runId,
    workflowId: run.workflow_id,
    reason: opts.source ?? "cli-stop",
  });

  return { ok: true, runId };
}

/**
 * Result of force-failing a run.
 */
export interface ForceFailResult {
  ok: boolean;
  runId: string;
  status: string;
  reason: string;
  /** If ok=false, list of alive workers */
  aliveWorkers?: Array<{ stepId: string; agentId: string; pid: number }>;
}

/**
 * Force a running/paused run to terminal failed status.
 * Records the reason and emits a run.force_failed event.
 *
 * GUARD: refuses if any worker for the run is still alive (step with running
 * status and live claim_pid), unless --force.
 */
export async function forceFailRun(
  runId: string,
  reason: string,
  force?: boolean,
): Promise<ForceFailResult> {
  const db = getDb();

  const run = db
    .prepare("SELECT id, status, workflow_id FROM runs WHERE id = ?")
    .get(runId) as { id: string; status: string; workflow_id: string } | undefined;

  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  if (run.status !== "running" && run.status !== "paused") {
    throw new Error(
      `Run ${runId.slice(0, 8)} is already ${run.status} — cannot force-fail`,
    );
  }

  // Check for alive workers — steps with running status and live claim_pid
  const runningSteps = db
    .prepare(
      "SELECT id, step_id, agent_id, claim_pid FROM steps WHERE run_id = ? AND status = 'running' AND claim_pid IS NOT NULL",
    )
    .all(runId) as { id: string; step_id: string; agent_id: string; claim_pid: number }[];

  const aliveWorkers: Array<{ stepId: string; agentId: string; pid: number }> = [];
  for (const step of runningSteps) {
    if (step.claim_pid > 0) {
      try {
        process.kill(step.claim_pid, 0);
        // PID is alive
        aliveWorkers.push({
          stepId: step.id,
          agentId: step.agent_id,
          pid: step.claim_pid,
        });
      } catch (err) {
        // ESRCH = dead, proceed
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
          // EPERM or other — treat as alive
          aliveWorkers.push({
            stepId: step.id,
            agentId: step.agent_id,
            pid: step.claim_pid,
          });
        }
      }
    }
  }

  if (aliveWorkers.length > 0 && !force) {
    return {
      ok: false,
      runId,
      status: run.status,
      reason: `Run ${runId.slice(0, 8)} has ${aliveWorkers.length} alive worker(s). Use --force to force-fail anyway.`,
      aliveWorkers,
    };
  }

  // Cancel pending/waiting/running steps
  db.prepare(
    "UPDATE steps SET status = 'canceled', updated_at = datetime('now') WHERE run_id = ? AND status IN ('waiting', 'pending', 'running')",
  ).run(runId);

  // Set run to failed and clear scheduling status
  db.prepare(
    "UPDATE runs SET status = 'failed', scheduling_status = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(runId);

  // Emit run.force_failed event with reason (reason field per the
  // terminal-event payload contract, CNEV US-004; detail kept for
  // logs-tail display compat).
  emitEvent({
    ts: new Date().toISOString(),
    event: "run.force_failed",
    runId,
    workflowId: run.workflow_id,
    detail: reason,
    reason,
  });

  logger.info(`Run ${runId.slice(0, 8)} force-failed: ${reason}`, {
    runId,
    reason,
    forced: !!force,
    aliveWorkerCount: aliveWorkers.length,
  });

  // Tear down crons and notify daemon
  await Promise.allSettled([
    removeRunCrons(runId),
    terminateRunWithDaemon(runId),
  ]);
  scheduleRunCronTeardown(runId);

  return { ok: true, runId, status: "failed", reason };
}

// ── Internal helpers ────────────────────────────────────────────────

interface RunRow {
  id: string;
  run_number: number | null;
  workflow_id: string;
  task: string;
  status: string;
  context: string;
  created_at: string;
  updated_at: string;
  tokens_spent: number;
  worker_lost_count: number;
  ceiling_expiry_count: number;
}

function getStepSummary(db: ReturnType<typeof getDb>, runId: string): string {
  const steps = db
    .prepare(
      "SELECT status, COUNT(*) as cnt FROM steps WHERE run_id = ? GROUP BY status",
    )
    .all(runId) as Array<{ status: string; cnt: number }>;

  if (steps.length === 0) return "no steps";
  const parts = steps.map((s) => `${s.status}:${s.cnt}`);
  return parts.join(" ");
}

function getRedLedgerLanding(runId: string): RedLedgerLanding | undefined {
  const events = getRunEvents(runId, 50);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (
      event.event === "merge.landed_over_red_suite"
      && typeof event.ledgerRowId === "number"
      && typeof event.exitCode === "number"
      && typeof event.ledgerCreatedAt === "string"
    ) {
      return {
        ledgerRowId: event.ledgerRowId,
        exitCode: event.exitCode,
        ledgerCreatedAt: event.ledgerCreatedAt,
      };
    }
  }
  return undefined;
}

function buildRunDetail(
  db: ReturnType<typeof getDb>,
  row: RunRow,
): RunDetail {
  const steps = db
    .prepare(
      "SELECT step_id, agent_id, status, type, current_story_id, retry_count, step_index, abandoned_count, reroute_count, claim_pid, claim_updated_at, updated_at, output FROM steps WHERE run_id = ? ORDER BY step_index ASC",
    )
    .all(row.id) as Array<{
      step_id: string;
      agent_id: string;
      status: string;
      type: string;
      current_story_id: string | null;
      retry_count: number;
      step_index: number;
      abandoned_count: number;
      reroute_count: number;
      claim_pid: number | null;
      claim_updated_at: string | null;
      updated_at: string | null;
      output: string | null;
    }>;

  const stepInfos: StepInfo[] = steps.map((s) => {
    const currentStoryId = s.current_story_id ?? null;
    return {
      stepId: s.step_id,
      agentId: s.agent_id,
      status: s.status,
      displayStatus: displayStepStatus({ type: s.type, status: s.status, currentStoryId }),
      type: s.type,
      currentStoryId,
      retryCount: s.retry_count,
      stepIndex: s.step_index,
      abandonedCount: s.abandoned_count > 0 ? s.abandoned_count : undefined,
      rerouteCount: s.reroute_count > 0 ? s.reroute_count : undefined,
      claimPid: s.claim_pid ?? undefined,
      claimUpdatedAt: s.claim_updated_at ?? undefined,
      updatedAt: s.updated_at ?? undefined,
      output: s.output ?? undefined,
    };
  });

  const stories = db
    .prepare(
      "SELECT story_id, title, status, retry_count, abandoned_count, updated_at FROM stories WHERE run_id = ? ORDER BY story_index ASC",
    )
    .all(row.id) as Array<{
      story_id: string;
      title: string;
      status: string;
      retry_count: number;
      abandoned_count: number;
      updated_at: string | null;
    }>;

  const storyInfos: StoryInfo[] = stories.map((s) => ({
    storyId: s.story_id,
    title: s.title,
    status: s.status,
    retryCount: s.retry_count,
    abandonedCount: s.abandoned_count > 0 ? s.abandoned_count : undefined,
    updatedAt: s.updated_at ?? undefined,
  }));

  const stepSummary = getStepSummary(db, row.id);
  const redLedgerLanding = row.workflow_id.includes("merge") ? getRedLedgerLanding(row.id) : undefined;

  // Enrich with worktree information when workspace_mode is 'worktree'
  let workspaceMode: string | undefined;
  let wtPath: string | undefined;
  let wtOriginRepo: string | undefined;
  let wtOriginRef: string | undefined;
  let wtOriginSha: string | undefined;
  const ctx = parseRunContext(row.id, row.context || "{}");
  const harnessType: HarnessType =
    ctx.harness_type === "hermes" || ctx.harness_type === "dsh"
      ? ctx.harness_type
      : "pi";
  if (ctx.workspace_mode === "worktree") {
    workspaceMode = ctx.workspace_mode;
    const wtRow = db
      .prepare(
        "SELECT worktree_path, worktree_origin_repository, worktree_origin_ref, worktree_origin_sha FROM run_worktrees WHERE run_id = ?",
      )
      .get(row.id) as
      | {
          worktree_path: string;
          worktree_origin_repository: string;
          worktree_origin_ref: string | null;
          worktree_origin_sha: string | null;
        }
      | undefined;
    if (wtRow) {
      wtPath = wtRow.worktree_path;
      wtOriginRepo = wtRow.worktree_origin_repository;
      wtOriginRef = wtRow.worktree_origin_ref ?? undefined;
      wtOriginSha = wtRow.worktree_origin_sha ?? undefined;
    }
  }

  return {
    id: row.id,
    runNumber: (row as any).run_number ?? undefined,
    workflowId: row.workflow_id,
    task: row.task,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stepSummary,
    tokensSpent: row.tokens_spent,
    workerLostCount: row.worker_lost_count,
    ceilingExpiryCount: row.ceiling_expiry_count,
    ...(redLedgerLanding ? { redLedgerLanding } : {}),
    steps: stepInfos,
    stories: storyInfos.length > 0 ? storyInfos : undefined,
    harnessType,
    workspace_mode: workspaceMode,
    worktree_path: wtPath,
    worktree_origin_repository: wtOriginRepo,
    worktree_origin_ref: wtOriginRef,
    worktree_origin_sha: wtOriginSha,
  };
}
