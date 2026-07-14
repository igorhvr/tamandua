import { getDb } from "../db.js";
import { emitEvent } from "./events.js";
import { logger } from "../lib/logger.js";

/**
 * Launch setup normally creates steps and managed-worktree state within seconds.
 * Thirty minutes leaves ample room for slow disks and overloaded hosts while
 * allowing the daemon to recover legacy rows left by crashes or older versions.
 */
export const STALE_LAUNCH_PHANTOM_AGE_MS = 30 * 60 * 1000;

export const STALE_LAUNCH_PHANTOM_REASON =
  "Daemon recovery: stale launch phantom had no steps or managed-worktree state after 30 minutes";

export interface StaleLaunchPhantomSweepResult {
  recovered: number;
  runIds: string[];
}

interface PhantomCandidate {
  id: string;
  workflow_id: string;
  tokens_spent: number;
}

/**
 * Fail legacy launch phantoms without racing an in-flight launch.
 *
 * Each conditional update rechecks every invariant atomically, so a concurrent
 * launcher that creates a step or run_worktrees row protects its run even when
 * it was selected just before that setup completed. Only successful updates
 * emit events, which makes repeated and concurrent sweeps idempotent.
 */
export function recoverStaleLaunchPhantoms(
  nowMs: number = Date.now(),
): StaleLaunchPhantomSweepResult {
  const db = getDb();
  const cutoff = new Date(nowMs - STALE_LAUNCH_PHANTOM_AGE_MS).toISOString();
  const recoveredAt = new Date(nowMs).toISOString();
  const candidates = db.prepare(
    `SELECT r.id, r.workflow_id, r.tokens_spent
     FROM runs r
     WHERE r.status = 'running'
       AND datetime(r.created_at) < datetime(?)
       AND NOT EXISTS (SELECT 1 FROM steps s WHERE s.run_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM run_worktrees rw WHERE rw.run_id = r.id)
     ORDER BY r.created_at ASC, r.id ASC`,
  ).all(cutoff) as unknown as PhantomCandidate[];

  const runIds: string[] = [];
  const failCandidate = db.prepare(
    `UPDATE runs
     SET status = 'failed',
         scheduling_status = NULL,
         scheduling_error = ?,
         updated_at = ?
     WHERE id = ?
       AND status = 'running'
       AND datetime(created_at) < datetime(?)
       AND NOT EXISTS (SELECT 1 FROM steps s WHERE s.run_id = runs.id)
       AND NOT EXISTS (SELECT 1 FROM run_worktrees rw WHERE rw.run_id = runs.id)`,
  );

  for (const candidate of candidates) {
    const result = failCandidate.run(
      STALE_LAUNCH_PHANTOM_REASON,
      recoveredAt,
      candidate.id,
      cutoff,
    );
    if (Number(result.changes) !== 1) continue;

    runIds.push(candidate.id);
    try {
      emitEvent({
        ts: recoveredAt,
        event: "run.failed",
        runId: candidate.id,
        workflowId: candidate.workflow_id,
        reason: "stale_launch_phantom_recovery",
        detail: STALE_LAUNCH_PHANTOM_REASON,
        tokensSpent: candidate.tokens_spent,
      });
    } catch (err) {
      // The persisted scheduling_error remains machine-inspectable even if
      // the append-only event log is temporarily unavailable.
      logger.warn("run-recovery: failed to emit stale launch phantom event", {
        runId: candidate.id,
        error: String(err),
      });
    }
  }

  return { recovered: runIds.length, runIds };
}
