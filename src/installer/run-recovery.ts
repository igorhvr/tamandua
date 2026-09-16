import { getDb } from "../db.js";
import { emitEvent } from "./events.js";
import { logger } from "../lib/logger.js";
import { isOlderThan } from "../lib/instant.js";

/**
 * Launch setup normally creates steps and managed-worktree state within seconds.
 * Thirty minutes leaves ample room for slow disks and overloaded hosts while
 * allowing the daemon to recover legacy rows left by crashes or older versions.
 */
export const STALE_LAUNCH_PHANTOM_AGE_MS = 30 * 60 * 1000;

/**
 * Tolerance (ms) for the stale-launch-phantom age comparison (TIME-CLOCKS rule
 * 2). `runs.created_at` and the injected `nowMs` share the host clock, so the
 * tolerance only absorbs sub-second storage/rounding granularity; it widens the
 * 30-minute window slightly so a run sitting right at the boundary is never
 * recovered prematurely.
 */
export const STALE_LAUNCH_PHANTOM_TOLERANCE_MS = 1_000;

export const STALE_LAUNCH_PHANTOM_REASON =
  "Daemon recovery: stale launch phantom had no steps and worktree state was absent or stuck in a launch-failure state after 30 minutes";

export interface StaleLaunchPhantomSweepResult {
  recovered: number;
  runIds: string[];
}

interface PhantomCandidate {
  id: string;
  workflow_id: string;
  tokens_spent: number;
  created_at: string;
}

/**
 * Fail legacy launch phantoms without racing an in-flight launch.
 *
 * Detects runs that have no steps AND either (a) no run_worktrees row at all
 * (pre-existing phantom shape) or (b) a run_worktrees row stuck in a
 * launch-failure state ('creating', 'error', 'cleanup_failed'). Runs whose
 * worktree row is 'ready'/'removing'/'removed' are intentionally left alone —
 * those are actively managed by other cleanup paths.
 *
 * Each conditional update rechecks every invariant atomically, so a concurrent
 * launcher that creates a step or flips a worktree row to 'ready' protects its
 * run even when it was selected just before that setup completed. Only
 * successful updates emit events, which makes repeated and concurrent sweeps
 * idempotent.
 */
export function recoverStaleLaunchPhantoms(
  nowMs: number = Date.now(),
): StaleLaunchPhantomSweepResult {
  const db = getDb();
  const recoveredAt = new Date(nowMs).toISOString();
  const candidates = db.prepare(
    `SELECT r.id, r.workflow_id, r.tokens_spent, r.created_at
     FROM runs r
     WHERE r.status = 'running'
       AND NOT EXISTS (SELECT 1 FROM steps s WHERE s.run_id = r.id)
       AND (NOT EXISTS (SELECT 1 FROM run_worktrees rw WHERE rw.run_id = r.id)
            OR EXISTS (SELECT 1 FROM run_worktrees rw
                       WHERE rw.run_id = r.id
                         AND rw.status IN ('creating', 'error', 'cleanup_failed')))
     ORDER BY r.created_at ASC, r.id ASC`,
  ).all() as unknown as PhantomCandidate[];

  // The age cutoff is a numeric durable-instant comparison (rule 2): each
  // run's stored created_at is aged against the injected nowMs via the shared
  // helper instead of a `datetime(created_at) < datetime(?)` SQL string bound.
  // An unparseable/missing instant is never stale (isOlderThan -> false), so an
  // unknown created_at is left alone rather than recovered on a fabricated age.
  const staleCandidates = candidates.filter((candidate) =>
    isOlderThan(
      candidate.created_at,
      STALE_LAUNCH_PHANTOM_AGE_MS,
      nowMs,
      STALE_LAUNCH_PHANTOM_TOLERANCE_MS,
    ),
  );

  const runIds: string[] = [];
  const failCandidate = db.prepare(
    `UPDATE runs
     SET status = 'failed',
         scheduling_status = NULL,
         scheduling_error = ?,
         updated_at = ?
     WHERE id = ?
       AND status = 'running'
       AND NOT EXISTS (SELECT 1 FROM steps s WHERE s.run_id = runs.id)
       AND (NOT EXISTS (SELECT 1 FROM run_worktrees rw WHERE rw.run_id = runs.id)
            OR EXISTS (SELECT 1 FROM run_worktrees rw
                       WHERE rw.run_id = runs.id
                         AND rw.status IN ('creating', 'error', 'cleanup_failed')))`,
  );

  for (const candidate of staleCandidates) {
    const result = failCandidate.run(
      STALE_LAUNCH_PHANTOM_REASON,
      recoveredAt,
      candidate.id,
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
