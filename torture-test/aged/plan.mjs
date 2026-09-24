// plan.mjs — pure corpus plan builders for the tt-storm-aged generator.
//
// Kept importable with zero side effects so the self-test can exercise plan
// shape deterministically (phases.mjs hosts the phase dispatcher and must not
// run on import).  The plan is the *intent* list; each entry is driven through
// REAL product APIs by the seed phase, and the disposition taxonomy records
// entry intent — actual terminalization (including any force-fail fallback) is
// recorded per run in the seed receipts and reconciled into the manifest.

import { LINEAR_COMPLETABLE } from "./seedlib.mjs";

// Worktree-mode catalog ids and their non-worktree twins.  A worktree-mode
// workflow run creates a REAL managed worktree through runWorkflow at creation
// time (rows + directories + metadata, cleanup_policy 'keep') whatever its
// terminal disposition — observed in the pilot (canceled/paused/failed and
// completed worktree runs all own a retained worktree row+dir).  The twin map
// lets the full plan keep scaling the run total past the explicit
// worktreesTarget without unbounded worktree growth, while every catalog id
// (worktree and twin alike) stays represented in the corpus.
export const WORKTREE_WORKFLOWS = new Set([
  "bug-fix-merge-worktree",
  "bug-fix-worktree",
  "feature-dev-merge-worktree",
  "feature-dev-worktree",
  "quarantine-broken-tests-merge-worktree",
  "security-audit-merge-worktree",
  "security-audit-worktree",
]);

export const NON_WORKTREE_TWIN = Object.freeze({
  "bug-fix-merge-worktree": "bug-fix-merge",
  "bug-fix-worktree": "bug-fix",
  "feature-dev-merge-worktree": "feature-dev-merge",
  "feature-dev-worktree": "feature-dev",
  "quarantine-broken-tests-merge-worktree": "quarantine-broken-tests-merge",
  "security-audit-merge-worktree": "security-audit-merge",
  "security-audit-worktree": "security-audit",
});

export function buildPlan({ manifest }) {
  const kind = manifest.seed_kind;
  if (kind === "pilot") {
    const plan = pilotEntries();
    return { kind, entries: plan.entries, target: plan.target };
  }
  if (kind === "full") {
    const plan = fullEntries({ manifest });
    return { kind, entries: plan.entries, target: plan.target, stats: plan.stats };
  }
  throw new Error(`buildPlan: unknown seed_kind "${kind}"`);
}

export function pilotEntries() {
  // Disposition × workflow coverage with real worktree runs (exact API
  // receipts recorded per run).  completed only for linear-completable
  // families; everything else passes through REAL fail/stop/pause handlers.
  // NOTE: the pilot's 'failed-exhaust' entry exercises the REAL failStep
  // budget-exhaustion driver; whether a given run reached a clean exhaustion
  // or fell back to a genuine force-fail is recorded per-run in the seed
  // receipts and reconciled in disposition_counts (see evidence/
  // disposition-reconciliation.json on the retained root).
  const seq = (tag, i) => `aged-pilot:${tag}:${i}`;
  const E = [];
  const add = (id, workflowId, disposition) => E.push({ id, workflowId, disposition });
  let i = 0;
  // completed — direct + worktree
  add(seq("completed", ++i), "do-now", "completed");
  add(seq("completed", ++i), "do-review-do-verify", "completed");
  add(seq("completed", ++i), "bug-fix", "completed");
  add(seq("completed", ++i), "bug-fix-worktree", "completed"); // worktree
  // canceled (real stopWorkflow)
  add(seq("canceled", ++i), "do-now", "canceled");
  add(seq("canceled", ++i), "feature-dev-merge-worktree", "canceled"); // worktree
  add(seq("canceled", ++i), "do-review-do-verify", "canceled");
  // failed via real forceFailRun
  add(seq("failed-force", ++i), "do-review-do-verify", "failed-force");
  add(seq("failed-force", ++i), "security-audit-worktree", "failed-force"); // worktree
  add(seq("failed-force", ++i), "feature-dev", "failed-force");
  // failed via real step-exhaustion driver (genuine run.failed budget path;
  // see receipts for the per-run terminalization record)
  add(seq("failed-exhaust", ++i), "do-now", "failed-exhaust");
  // paused via real control-server handler (NONTERMINAL)
  add(seq("paused", ++i), "feature-dev", "paused");
  add(seq("paused", ++i), "feature-dev-worktree", "paused"); // worktree
  add(seq("paused", ++i), "quarantine-broken-tests-merge-worktree", "paused"); // worktree
  // resume-then-cancel (real resume handler then real stopWorkflow)
  add(seq("resumed-canceled", ++i), "do-now", "resumed-canceled");
  return { entries: E, target: { runs: E.length } };
}

export function fullEntries({ manifest }) {
  // Full-scale corpus (kind 'full'): deterministic round-robin across every
  // pinned catalog workflow id so each definition is represented; disposition
  // mix weights; worktree-mode selections drive REAL managed worktrees up to
  // the explicit worktreesTarget and then substitute the family's non-worktree
  // twin; the volume phase later reaches >=500000 logical events.
  const recipe = manifest.recipe ?? {};
  const total = recipe.runs_total ?? 5000;
  const worktreesTarget = recipe.worktrees_target ?? 200;
  const catalogIds = manifest.catalog?.ids ?? [];
  if (catalogIds.length === 0) throw new Error("full plan requires catalog installed (run catalog phase first)");
  const entries = [];
  const weights = { completed: 0.34, "failed-force": 0.22, canceled: 0.2, paused: 0.16, "failed-exhaust": 0.08 };
  const seq = (i) => `aged-full:${String(i).padStart(5, "0")}`;
  let worktreesPlanned = 0; // worktree-mode entries that WILL create a managed worktree
  let worktreeSubstitutions = 0;
  const idsSeen = new Set();
  for (let i = 1; i <= total; i += 1) {
    const rawId = catalogIds[(i - 1) % catalogIds.length];
    const isWorktreeWf = WORKTREE_WORKFLOWS.has(rawId);
    // Past the worktreesTarget, switch worktree-mode selections to their
    // non-worktree twin so only the explicit target worktree runs are driven.
    let workflowId = rawId;
    let substituted = false;
    if (isWorktreeWf && worktreesPlanned >= worktreesTarget) {
      const twin = NON_WORKTREE_TWIN[rawId];
      if (!twin) throw new Error(`full plan: no non-worktree twin mapped for ${rawId}`);
      workflowId = twin;
      substituted = true;
      worktreeSubstitutions += 1;
    }
    if (isWorktreeWf && !substituted) worktreesPlanned += 1;
    idsSeen.add(workflowId);

    // Deterministic pseudo-random disposition mix (stable across runs).
    const r = (i * 7919) % 1000 / 1000;
    let disposition = "completed";
    let acc = 0;
    for (const [d, w] of Object.entries(weights)) {
      acc += w;
      if (r < acc) { disposition = d; break; }
    }
    // Merge-family and story-loop families cannot be forced 'completed'
    // through the linear driver; reroute those weights to genuine
    // fail/cancel/pause dispositions (completed shapes come only from
    // LINEAR_COMPLETABLE families and are driven genuinely).
    if (disposition === "completed" && !LINEAR_COMPLETABLE.has(workflowId)) {
      disposition = dispositionFallback(workflowId);
    }
    entries.push({ id: seq(i), workflowId, disposition, worktree: isWorktreeWf && !substituted });
  }
  return {
    entries,
    target: { runs: total, worktreesTarget },
    stats: {
      worktreesPlanned,
      worktreeSubstitutions,
      catalogIdsTotal: catalogIds.length,
      distinctWorkflowIdsPlanned: idsSeen.size,
      worktreesTargetReached: worktreesPlanned >= worktreesTarget,
    },
  };
}

function dispositionFallback(workflowId) {
  if (workflowId.includes("merge")) return "canceled";
  if (workflowId.includes("security") || workflowId.includes("feature")) return "paused";
  return "failed-force";
}
