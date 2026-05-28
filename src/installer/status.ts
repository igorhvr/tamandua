import { getDb } from "../db.js";
import { scheduleRunCronTeardown } from "./step-ops.js";
import { removeRunCrons } from "./agent-scheduler.js";
import { terminateRunWithDaemon } from "../server/control-client.js";
import { getRunWorktree, removeRunWorktree } from "./worktree-manager.js";
import { emitEvent } from "./events.js";

export interface RunInfo {
  id: string;
  workflowId: string;
  task: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  stepSummary?: string;
  tokensSpent: number;
}

export interface RunDetail extends RunInfo {
  steps: StepInfo[];
  stories?: StoryInfo[];
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
  type: string;
  retryCount: number;
  output?: string;
}

export interface StoryInfo {
  storyId: string;
  title: string;
  status: string;
  retryCount: number;
}

/**
 * Find a run by id prefix or task substring match.
 * Returns the run detail if exactly one match is found.
 * Throws if zero or multiple matches.
 */
export function getWorkflowStatus(query: string): RunDetail {
  const db = getDb();

  // Try exact id match first
  let row = db
    .prepare(
      "SELECT id, workflow_id, task, status, context, created_at, updated_at, tokens_spent FROM runs WHERE id = ?",
    )
    .get(query) as unknown as RunRow | undefined;

  // Try id prefix match
  if (!row) {
    const prefixRows = db
      .prepare(
        "SELECT id, workflow_id, task, status, context, created_at, updated_at, tokens_spent FROM runs WHERE id LIKE ?",
      )
      .all(`${query}%`) as unknown as RunRow[];
    if (prefixRows.length === 1) {
      row = prefixRows[0];
    } else if (prefixRows.length > 1) {
      throw new Error(
        `Multiple runs match prefix "${query}": ${prefixRows.map((r) => r.id.slice(0, 12)).join(", ")}. Use a longer prefix to disambiguate.`,
      );
    }
  }

  // Try task substring match
  if (!row) {
    const taskRows = db
      .prepare(
        "SELECT id, workflow_id, task, status, context, created_at, updated_at, tokens_spent FROM runs WHERE task LIKE ?",
      )
      .all(`%${query}%`) as unknown as RunRow[];
    if (taskRows.length === 1) {
      row = taskRows[0];
    } else if (taskRows.length > 1) {
      throw new Error(
        `Multiple runs match task "${query}": ${taskRows.map((r) => `${r.id.slice(0, 8)} (${r.task.slice(0, 30)})`).join(", ")}. Use a more specific query.`,
      );
    }
  }

  if (!row) {
    throw new Error(`No run found matching "${query}"`);
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
      "SELECT id, workflow_id, task, status, created_at, updated_at, tokens_spent FROM runs ORDER BY created_at DESC LIMIT ?",
    )
    .all(limit) as unknown as RunRow[];

  return rows.map((r) => {
    const stepSummary = getStepSummary(db, r.id);
    return {
      id: r.id,
      workflowId: r.workflow_id,
      task: r.task,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      stepSummary,
      tokensSpent: r.tokens_spent,
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
): Promise<{ ok: boolean; runId: string; status: string }> {
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
  if (wt && wt.status !== "removed") {
    try {
      removeRunWorktree({ runId, force: true });
    } catch {
      // Best-effort worktree removal — proceed with DB cleanup
    }
  }

  // Delete associated records in dependency order
  db.prepare("DELETE FROM stories WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM run_worktrees WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM runs WHERE id = ?").run(runId);

  // Emit deletion event to logs tail and recent events
  emitEvent({
    ts: new Date().toISOString(),
    event: "run.deleted",
    runId,
    detail: isActive ? "Force-deleted while active" : "Deleted by user",
  });

  return { ok: true, runId, status: "deleted" };
}

/**
 * Cancel a running workflow.
 * Sets the run status to 'canceled' and tears down cron jobs.
 */
export async function stopWorkflow(runId: string): Promise<{ ok: boolean; runId: string }> {
  const db = getDb();

  const run = db
    .prepare("SELECT id, status FROM runs WHERE id = ?")
    .get(runId) as { id: string; status: string } | undefined;

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

  return { ok: true, runId };
}

// ── Internal helpers ────────────────────────────────────────────────

interface RunRow {
  id: string;
  workflow_id: string;
  task: string;
  status: string;
  context: string;
  created_at: string;
  updated_at: string;
  tokens_spent: number;
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

function buildRunDetail(
  db: ReturnType<typeof getDb>,
  row: RunRow,
): RunDetail {
  const steps = db
    .prepare(
      "SELECT step_id, agent_id, status, type, retry_count, output FROM steps WHERE run_id = ? ORDER BY step_index ASC",
    )
    .all(row.id) as Array<{
      step_id: string;
      agent_id: string;
      status: string;
      type: string;
      retry_count: number;
      output: string | null;
    }>;

  const stepInfos: StepInfo[] = steps.map((s) => ({
    stepId: s.step_id,
    agentId: s.agent_id,
    status: s.status,
    type: s.type,
    retryCount: s.retry_count,
    output: s.output ?? undefined,
  }));

  const stories = db
    .prepare(
      "SELECT story_id, title, status, retry_count FROM stories WHERE run_id = ? ORDER BY story_index ASC",
    )
    .all(row.id) as Array<{
      story_id: string;
      title: string;
      status: string;
      retry_count: number;
    }>;

  const storyInfos: StoryInfo[] = stories.map((s) => ({
    storyId: s.story_id,
    title: s.title,
    status: s.status,
    retryCount: s.retry_count,
  }));

  const stepSummary = getStepSummary(db, row.id);

  // Enrich with worktree information when workspace_mode is 'worktree'
  let workspaceMode: string | undefined;
  let wtPath: string | undefined;
  let wtOriginRepo: string | undefined;
  let wtOriginRef: string | undefined;
  let wtOriginSha: string | undefined;
  try {
    const ctx = JSON.parse(row.context || "{}") as Record<string, string>;
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
  } catch {
    // context may be malformed; leave worktree fields unset
  }

  return {
    id: row.id,
    workflowId: row.workflow_id,
    task: row.task,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stepSummary,
    tokensSpent: row.tokens_spent,
    steps: stepInfos,
    stories: storyInfos.length > 0 ? storyInfos : undefined,
    workspace_mode: workspaceMode,
    worktree_path: wtPath,
    worktree_origin_repository: wtOriginRepo,
    worktree_origin_ref: wtOriginRef,
    worktree_origin_sha: wtOriginSha,
  };
}
