#!/usr/bin/env node
// o6.mjs — O6 worktree bookkeeping (post-batch) evaluator.
//
// spec 03 "O6 — Worktree bookkeeping (post-batch)" + the STORM-HYGIENE
// read-only slice rules. This evaluator reconciles the INDEPENDENTLY admitted
// native run_worktrees snapshot (read-only database copy), the run statuses
// in the same snapshot, exact disk paths under the declared managed worktree
// root, the native `git worktree list` capture plus .git/worktrees metadata
// capture, and the retained branch inventory — in BOTH directions (rows ->
// disk/git and disk/git -> rows). All inputs travel in the post-batch hygiene
// sidecar (see POST-BATCH-CONTRACT.md); this checker never deletes, prunes,
// moves or rewrites anything.
//
// Corruption dimensions (failing findings):
//   * orphan row (run_worktrees row without a runs row)             O6_ORPHAN_ROW
//   * orphan directory (git/managed dir without a row)             O6_ORPHAN_DIRECTORY
//   * orphan .git/worktrees metadata (no row, no live worktree)    O6_ORPHAN_METADATA
//   * out-of-band deletion / reappearance                          O6_OUT_OF_BAND_*
//   * moved/corrupt path (ready row, dir present but not a git wt) O6_PATH_NOT_GIT_WORKTREE
//   * duplicate bindings (two rows / git entries on one path)      O6_DUPLICATE_BINDING
//   * wrong origin (row origin repo/common-dir disagrees)          O6_WRONG_ORIGIN
//   * invalid row content (unknown status/policy)                  O6_INVALID_ROW_DATA
//   * metadata mismatch (git lists the worktree, metadata absent)  O6_METADATA_MISMATCH
//
// (The 'ready row, path absent' shape is O6_OUT_OF_BAND_DELETION and the
// 'ready row, dir present but not a git worktree' shape is
// O6_PATH_NOT_GIT_WORKTREE — there is no separate O6_MISSING_WORKTREE id;
// consumers must not wait for one.)
//
// Policy/UX characterization (informational, non-failing — reported
// SEPARATELY from corruption): each row's OWN cleanup_policy is applied with
// CURRENT native semantics. Default `keep` (the createRunWorktree default)
// means retained-after-terminal is today's CONTRACT and is CORRECT — normal
// retained size and non-merged feature/fix branches are never turned into
// deletion-worthy defects here. remove_on_success / remove_on_terminal are
// not auto-enforced by native run-terminal code in this snapshot (only
// `worktree remove`, `workflow delete` and `worktree prune` remove worktrees),
// so a remove_on_* row that is still `ready` after a terminal run is a
// product policy/UX characterization, never a corruption finding.
//
// Branch inventory is characterization-only for the same reason: native
// lifecycle in this snapshot NEVER deletes refs — worktree removal removes the
// worktree and its .git/worktrees metadata but leaves the origin repository's
// refs/heads inventory untouched, and runs check out existing origin refs
// (original_branch records the origin's checked-out branch, generally a shared
// base), so a retained ref under an admitted branch root is origin inventory,
// never corruption. A retained branch whose owning run is remove_on_* is the
// SAME non-enforcement gap as the worktree-level O6_POLICY_CHARACTERIZATION
// and is reported as O6_BRANCH_RETENTION_CHARACTERIZATION accordingly.
//
// Prune/age semantics are an explicit SEPARATE behavioral leg: this run does
// NOT execute native prune/removal (removal is gated on independent
// coordinator review of the exact disposable root/DB/path set and code). The
// sidecar must declare prune.executed === false with a clone-only probe plan;
// the response then records the prune leg as NOT_RUN (informational) and the
// full O6 acceptance stays open. Exact counts are honored: totals are never
// derived from a capped (sampled) array, an absence in a capped/failed
// capture is never proof of absence, and unknown/invalid input never becomes
// PASS.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { FindingCollector } from './findings.mjs';
import { OracleRuntimeError, pathIsWithin } from './paths.mjs';
import { writeEvidenceJson } from './evidence.mjs';
import { HYGIENE_SIDECAR_SCHEMA_VERSION, CLEANUP_POLICIES, WORKTREE_STATUSES } from './hygiene-sidecar.mjs';

const ACTIVE_WORKTREE_STATUSES = new Set(['creating', 'ready', 'removing', 'error', 'cleanup_failed']);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'canceled']);
const REMOVAL_POLICIES = new Set(['remove_on_success', 'remove_on_terminal']);
const TRANSITIONAL_STATUSES = new Set(['creating', 'removing']);

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OracleRuntimeError(`${label} must be a JSON object`);
  }
  return value;
}

function loadRunWorktreeRows(databasePath) {
  const details = fs.statSync(databasePath);
  if ((details.mode & 0o222) !== 0) {
    throw new OracleRuntimeError('O6 database snapshot is writable; read-only mechanical evidence is required');
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const worktreeColumns = db.prepare('PRAGMA table_info(run_worktrees)').all().map((column) => column.name);
    const runsColumns = db.prepare('PRAGMA table_info(runs)').all().map((column) => column.name);
    for (const required of ['run_id', 'worktree_path', 'worktree_origin_repository', 'worktree_origin_git_common_dir', 'status', 'cleanup_policy', 'created_at']) {
      if (!worktreeColumns.includes(required)) return { available: false, reason: `run_worktrees is missing native column ${required}` };
    }
    if (!runsColumns.includes('id') || !runsColumns.includes('status')) {
      return { available: false, reason: 'runs table is missing native columns id/status' };
    }
    const worktrees = db.prepare('SELECT * FROM run_worktrees ORDER BY created_at').all();
    const runs = db.prepare('SELECT id, status, created_at, updated_at FROM runs').all();
    return { available: true, worktrees, runs: new Map(runs.map((row) => [row.id, row])) };
  } finally {
    db.close();
  }
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  try {
    return path.resolve(left) === path.resolve(right);
  } catch {
    return left === right;
  }
}

// A row's worktree path normalized against the origin's git common dir: a row
// whose git-common-dir matches an admitted origin is reconciled against THAT
// origin's git captures; otherwise its origin is foreign to the admitted set.
function findOriginForRow(row, sidecarO6) {
  return sidecarO6.roots.origins.find((origin, index) => {
    if (samePath(origin.git_common_dir, row.worktree_origin_git_common_dir)) return true;
    const gitOrigin = sidecarO6.git.origins.find((entry) => entry.origin_index === index);
    if (gitOrigin === undefined) return false;
    return gitOrigin.worktree_list.rows.some((gitRow) => samePath(gitRow.worktree_path, row.worktree_path));
  });
}

function gitCaptureFor(originIndex, sidecarO6) {
  return sidecarO6.git.origins.find((entry) => entry.origin_index === originIndex);
}

export function evaluateO6(invocation) {
  const { sidecar, sidecarRoot, evidenceDir } = invocation;
  const sidecarO6 = sidecar.o6;
  const findings = new FindingCollector();
  const failures = [];

  const addFailure = (id, summary, details = {}) => {
    findings.add(id, summary, details);
    failures.push(id);
  };

  // ── database leg ───────────────────────────────────────────────────────
  const databasePath = path.resolve(sidecarRoot, sidecarO6.database.path);
  let dbLeg;
  try {
    // integrity: the snapshot sha256 declared by the sidecar must match the
    // file actually read (a mutated snapshot is invalid input, never PASS).
    const actual = createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex');
    if (actual !== sidecarO6.database.sha256) {
      dbLeg = { available: false, reason: `database snapshot sha256 mismatch (declared ${sidecarO6.database.sha256}, actual ${actual})` };
    } else {
      dbLeg = loadRunWorktreeRows(databasePath);
    }
  } catch (error) {
    dbLeg = { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!dbLeg.available) {
    // Nothing else can certify bookkeeping: invalid/unusable DB input is never
    // PASS. Concrete findings from OTHER legs are still reported (below).
    dbLeg = { ...dbLeg, noted_unavailable: true };
  }

  const rows = dbLeg.available ? dbLeg.worktrees : [];
  const runsById = dbLeg.available ? dbLeg.runs : new Map();

  // Exact-count helpers: an inventory's total is NEVER derived from a capped
  // (sampled) array. inlineCount is the number of rows actually inspected.
  const diskExact = sidecarO6.disk.exact_count;
  const diskCapped = sidecarO6.disk.capped === true;
  const diskToolOk = sidecarO6.disk.tool.exit_code === 0;
  const diskLegAvailable = diskToolOk;
  const diskEntries = sidecarO6.disk.entries;

  const orphanRowSubjects = [];
  // Per-row policy/UX characterizations are collected during analysis and their
  // informational findings are emitted ONLY in the PASS post-pass below: a
  // NOT_EVALUABLE result may not carry findings (output contract), and these
  // rows must never escalate a clean-but-unresolved analysis to ERROR.
  const retainedKeepRows = []; // terminal run + ready + cleanup_policy keep
  const policyCharacterizations = []; // terminal run + ready + remove_on_* policy
  const gitReconcileUnresolved = []; // ready rows git reconciliation is incomplete

  // A git worktree-list inventory is USABLE for absence certification only
  // when its tool ran (exit 0) and it is not capped (sampled). Absence from a
  // failed or capped capture is never proof that git lost the worktree.
  const gitListUsable = (gitOrigin) => gitOrigin !== undefined
    && gitOrigin.worktree_list.tool.exit_code === 0
    && gitOrigin.worktree_list.capped !== true;
  // A disk inventory is complete (absence is a capture-time fact) only when
  // the tool ran and the inventory is not capped.
  const diskLegUncappedComplete = diskLegAvailable && !diskCapped;

  // ── per-row reconciliation (rows -> run status, disk, git) ─────────────
  const pathToRows = new Map();
  const seenRowPaths = new Map();
  for (const [index, row] of rows.entries()) {
    object(row, `run_worktrees row ${index}`);
    const rowKey = `row:${row.run_id}`;
    if (!WORKTREE_STATUSES.includes(row.status)) {
      addFailure('O6_INVALID_ROW_DATA', `run_worktrees row ${row.run_id} carries unknown status ${row.status}`, { run_id: row.run_id });
    }
    if (!CLEANUP_POLICIES.includes(row.cleanup_policy)) {
      addFailure('O6_INVALID_ROW_DATA', `run_worktrees row ${row.run_id} carries unknown cleanup_policy ${row.cleanup_policy}`, { run_id: row.run_id });
      continue;
    }
    if (!pathToRows.has(row.worktree_path)) pathToRows.set(row.worktree_path, []);
    pathToRows.get(row.worktree_path).push(row);
    if (seenRowPaths.has(row.worktree_path)) {
      addFailure('O6_DUPLICATE_BINDING', `run_worktrees rows ${seenRowPaths.get(row.worktree_path)} and ${row.run_id} bind the same worktree_path ${row.worktree_path}`, {
        worktree_path: row.worktree_path,
        run_ids: [seenRowPaths.get(row.worktree_path), row.run_id],
      });
    } else {
      seenRowPaths.set(row.worktree_path, row.run_id);
    }

    const run = runsById.get(row.run_id);
    const runStatus = run?.status ?? null;
    if (runStatus === null) {
      orphanRowSubjects.push(row.run_id);
      addFailure('O6_ORPHAN_ROW', `run_worktrees row ${row.run_id} has no matching runs row (orphan row)`, {
        run_id: row.run_id,
        status: row.status,
        worktree_path: row.worktree_path,
      });
      continue; // no run status to reconcile policy against
    }
    const runTerminal = TERMINAL_RUN_STATUSES.has(runStatus);

    // cleanup_policy semantics (informational; never deletion-worthy here).
    if (runTerminal && row.status === 'ready') {
      if (row.cleanup_policy === 'keep') {
        retainedKeepRows.push(row.run_id);
      } else if (REMOVAL_POLICIES.has(row.cleanup_policy)) {
        policyCharacterizations.push({ run_id: row.run_id, cleanup_policy: row.cleanup_policy, run_status: runStatus });
      }
    }
    if (runTerminal && TRANSITIONAL_STATUSES.has(row.status)) {
      addFailure('O6_INCONSISTENT_STATE', `run ${row.run_id} is terminal (${runStatus}) but its worktree row is still ${row.status}`, {
        run_id: row.run_id,
        status: row.status,
      });
    }

    // Disk + git reconciliation for the row's worktree path. The evaluator is
    // read-only over the CAPTURED snapshots: disk presence comes from the
    // captured inventory only (never a live re-stat at evaluation time, which
    // would drift from the capture and break reproducibility).
    const diskDir = diskEntries.find((entry) => samePath(entry.path, row.worktree_path));
    let pathExistsOnDisk = null; // unknown until the inventory proves one way
    if (diskDir !== undefined) {
      pathExistsOnDisk = diskDir.kind === 'dir' || diskDir.kind === 'symlink-dir';
    } else if (diskLegUncappedComplete) {
      // Uncapped complete inventory: absence of the row path IS a capture-time
      // fact (the path was not under the managed root at capture).
      pathExistsOnDisk = false;
    }
    // When the disk inventory is capped (sampled), absence from the sample is
    // NOT proof of deletion — pathExistsOnDisk stays null and the ready-row
    // rules below refuse to guess. Same when the tool failed.

    const origin = findOriginForRow(row, sidecarO6);
    const gitOrigin = origin === undefined ? undefined : gitCaptureFor(sidecarO6.roots.origins.indexOf(origin), sidecarO6);
    const gitListHealthy = gitListUsable(gitOrigin);
    const gitListed = gitListHealthy
      && gitOrigin.worktree_list.rows.some((gitRow) => samePath(gitRow.worktree_path, row.worktree_path));
    const gitMetadataMatches = gitOrigin !== undefined
      && gitOrigin.worktrees_metadata.rows.some((meta) => samePath(meta.worktree_path, row.worktree_path));

    if (row.status === 'ready') {
      if (origin === undefined) {
        addFailure('O6_WRONG_ORIGIN', `run ${row.run_id} worktree origin (${row.worktree_origin_repository}; common dir ${row.worktree_origin_git_common_dir}) matches no admitted origin root`, {
          run_id: row.run_id,
          worktree_path: row.worktree_path,
        });
      } else if (!gitListHealthy) {
        // The row's own origin git worktree-list capture is capped or failed:
        // git-side absence is NOT a fact. Only an uncapped complete disk census
        // may certify path facts. A dir on disk that the DISK census itself
        // marks as not-a-git-worktree is a disk-level fact; anything else stays
        // unresolved (a reconciliation gap is NOT_EVALUABLE, never PASS).
        if (diskLegUncappedComplete && pathExistsOnDisk === false) {
          addFailure('O6_OUT_OF_BAND_DELETION', `run ${row.run_id} worktree row is ready but the path is absent from the complete disk census (deleted out-of-band); the origin git worktree-list capture is capped/failed so the git side is not asserted`, {
            run_id: row.run_id,
            worktree_path: row.worktree_path,
          });
        } else if (diskLegUncappedComplete && pathExistsOnDisk === true && diskDir !== undefined && diskDir.git_worktree === false) {
          addFailure('O6_PATH_NOT_GIT_WORKTREE', `run ${row.run_id} worktree path exists on disk but the disk census records it is not a git worktree of its recorded origin (moved/corrupt)`, {
            run_id: row.run_id,
            worktree_path: row.worktree_path,
          });
        } else {
          // git list capped/failed AND disk leg capped/failed or dir present
          // without a disk-level not-a-worktree proof: the row<->git/disk
          // reconciliation is incomplete.
          gitReconcileUnresolved.push(row.run_id);
        }
      } else if (!gitListed) {
        // Row says ready but an UNCAPPED, healthy git list does not list it.
        if (diskLegUncappedComplete && pathExistsOnDisk === false) {
          addFailure('O6_OUT_OF_BAND_DELETION', `run ${row.run_id} worktree row is ready but the path was deleted out-of-band (absent on disk and absent from the git worktree list)`, {
            run_id: row.run_id,
            worktree_path: row.worktree_path,
          });
        } else if (diskLegUncappedComplete && pathExistsOnDisk === true) {
          addFailure('O6_PATH_NOT_GIT_WORKTREE', `run ${row.run_id} worktree path exists on disk but is not a git worktree of its recorded origin (moved/corrupt)`, {
            run_id: row.run_id,
            worktree_path: row.worktree_path,
          });
        } else {
          // Healthy git says gone but the disk leg is capped/failed: cannot
          // distinguish deletion from a capture gap — unresolved, never PASS.
          gitReconcileUnresolved.push(row.run_id);
        }
      } else if (diskLegUncappedComplete && pathExistsOnDisk === false) {
        // git still lists the worktree but the captured disk inventory has no
        // such directory: the git entry is stale (deleted out-of-band).
        addFailure('O6_OUT_OF_BAND_DELETION', `run ${row.run_id} worktree is listed by git but absent from the captured disk inventory (stale git entry; deleted out-of-band)`, {
          run_id: row.run_id,
          worktree_path: row.worktree_path,
        });
      } else if (gitListed && !gitMetadataMatches) {
        addFailure('O6_METADATA_MISMATCH', `run ${row.run_id} worktree is listed by git but has no matching .git/worktrees metadata entry`, {
          run_id: row.run_id,
          worktree_path: row.worktree_path,
        });
      }
    } else if (row.status === 'removed') {
      const present = (diskLegUncappedComplete && pathExistsOnDisk === true)
        || (gitListHealthy && gitOrigin.worktree_list.rows.some((gitRow) => samePath(gitRow.worktree_path, row.worktree_path)));
      if (present) {
        addFailure('O6_REMOVED_BUT_PRESENT', `run ${row.run_id} worktree row is removed but the path/worktree is still present`, {
          run_id: row.run_id,
          worktree_path: row.worktree_path,
        });
      }
    }
    // error / cleanup_failed rows are characterization (native retries them on
    // prune); no automatic corruption finding here.
  }

  // ── orphan directories (disk/git -> rows) ─────────────────────────────
  const orphanDirs = [];
  const gitListPaths = new Set();
  for (const gitOrigin of sidecarO6.git.origins) {
    for (const gitRow of gitOrigin.worktree_list.rows) gitListPaths.add(gitRow.worktree_path);
  }
  const rowPaths = new Set(pathToRows.keys());
  for (const entry of diskEntries) {
    if (entry.kind !== 'dir') continue;
    const gitListed = [...gitListPaths].some((gitPath) => samePath(gitPath, entry.path));
    const referenced = [...rowPaths].some((rowPath) => samePath(rowPath, entry.path));
    if (gitListed && !referenced) {
      orphanDirs.push(entry.path);
      addFailure('O6_ORPHAN_DIRECTORY', `directory ${entry.path} is a git worktree (or managed under the worktree root) but no run_worktrees row references it`, {
        worktree_path: entry.path,
      });
    } else if (!gitListed && !referenced && entry.git_worktree === true) {
      orphanDirs.push(entry.path);
      addFailure('O6_ORPHAN_DIRECTORY', `directory ${entry.path} is marked a git worktree but no row and no git-list entry reference it`, {
        worktree_path: entry.path,
      });
    }
  }

  // ── orphan .git/worktrees metadata ─────────────────────────────────────
  for (const gitOrigin of sidecarO6.git.origins) {
    for (const meta of gitOrigin.worktrees_metadata.rows) {
      const gitListed = gitOrigin.worktree_list.rows.some((gitRow) => samePath(gitRow.worktree_path, meta.worktree_path));
      const referenced = [...rowPaths].some((rowPath) => samePath(rowPath, meta.worktree_path));
      if (!referenced && (!gitListed || meta.gitdir_target === null)) {
        addFailure('O6_ORPHAN_METADATA', `.git/worktrees metadata entry ${meta.name} (${meta.gitdir_path}) has no owning run_worktrees row${gitListed ? '' : ' and its worktree is not listed by git'}`, {
          metadata_name: meta.name,
          gitdir_path: meta.gitdir_path,
        });
      }
    }
  }

  // ── branch reconciliation (retained refs/heads inventory vs runs) ───────
  // Retained branches are CHARACTERIZATION ONLY, never corruption: native
  // lifecycle in this snapshot never deletes refs — worktree removal removes
  // the worktree and its .git/worktrees metadata but leaves the origin repo's
  // refs/heads untouched, and run worktrees are created detached at an
  // EXISTING origin ref (original_branch records the origin's checked-out
  // branch, generally a shared base). A retained feature/fix ref under an
  // admitted branch root is therefore origin-repository inventory. Its owning
  // row's cleanup_policy describes WORKTREE lifecycle, so a retained branch
  // whose owning run is remove_on_* is the same native auto-enforcement gap as
  // the worktree-level O6_POLICY_CHARACTERIZATION — informational, never a
  // deletion-worthy defect.
  const branchCharacterizations = [];
  for (const [originIndex, origin] of sidecarO6.roots.origins.entries()) {
    const gitOrigin = gitCaptureFor(originIndex, sidecarO6);
    if (gitOrigin === undefined) continue;
    for (const branchRow of gitOrigin.branches.rows) {
      const admittedRoot = origin.admitted_branch_roots.find((root) => branchRow.full_ref === root || branchRow.full_ref.startsWith(`${root}/`)
        || branchRow.full_ref.startsWith(`${root.replace(/\/$/, '')}/`));
      if (admittedRoot === undefined) continue; // only explicitly admitted branch roots are judged
      if (branchRow.full_ref === 'refs/heads/main' || branchRow.full_ref.endsWith('/main')) continue;
      const shortName = branchRow.full_ref.replace(/^refs\/heads\//, '');
      const owningRows = rows.filter((row) => row.original_branch === shortName || row.worktree_origin_ref === shortName);
      const context = owningRows.map((row) => {
        const run = runsById.get(row.run_id);
        return `${row.run_id}(status=${row.status},policy=${row.cleanup_policy},run=${run?.status ?? 'missing'})`;
      });
      branchCharacterizations.push({
        full_ref: branchRow.full_ref,
        owning_rows: owningRows.length,
        owning_context: context,
      });
    }
  }

  // ── input availability / result resolution ─────────────────────────────
  const dbAvailable = dbLeg.available;
  const gitAnyAvailable = sidecarO6.git.origins.some((gitOrigin) => gitOrigin.worktree_list.tool.exit_code === 0);
  // Every run_worktrees row must live under the declared managed worktree root
  // or under an admitted origin's tree; a row pointing anywhere else is a
  // wrong-root binding (explicit shared original repo roots only).
  for (const row of rows) {
    if (ACTIVE_WORKTREE_STATUSES.has(row.status) || row.status === 'removed') {
      const insideManagedRoot = samePath(row.worktree_path, sidecarO6.roots.worktree_root)
        || row.worktree_path.startsWith(`${sidecarO6.roots.worktree_root.replace(/\/$/, '')}/`);
      const insideOrigin = sidecarO6.roots.origins.some((origin) => samePath(row.worktree_path, origin.repository)
        || row.worktree_path.startsWith(`${origin.repository.replace(/\/$/, '')}/`));
      if (!insideManagedRoot && !insideOrigin) {
        addFailure('O6_WRONG_ROOT', `run ${row.run_id} worktree path ${row.worktree_path} falls outside the declared managed worktree root and every admitted origin`, {
          run_id: row.run_id,
          worktree_path: row.worktree_path,
        });
      }
    }
  }

  let result;
  let classification;
  if (failures.length > 0) {
    result = 'FAIL';
  } else if (!dbAvailable || !diskLegAvailable || !gitAnyAvailable || gitReconcileUnresolved.length > 0) {
    // Unusable input legs AND rows whose disk/git reconciliation is genuinely
    // incomplete (capped/failed git or disk captures) are NOT_EVALUABLE — an
    // unknown is never PASS.
    result = 'NOT_EVALUABLE';
    classification = { ambiguous: { category: gitReconcileUnresolved.length > 0 ? 'reconciliation-incomplete' : 'input-incomplete' } };
  } else {
    result = 'PASS';
  }

  // Informational findings ride PASS only (NOT_EVALUABLE may not carry findings
  // — output contract), so every addInfo emission is gated on the final result
  // computed above. Per-row policy characterizations collected during analysis
  // are emitted here, in the PASS post-pass.
  if (result === 'PASS') {
    // The prune/age behavioral leg is NOT executed in this read-only run; it is
    // recorded as a NOT_RUN sub-leg with its clone-only probe plan. Full O6
    // acceptance (including prune characterization) stays open.
    findings.addInfo(
      'O6_PRUNE_LEG_NOT_RUN',
      `native prune/removal characterization is NOT_RUN in this read-only slice: removal is gated on independent coordinator review of the exact disposable root/DB/path set and code; clone-only probe plan recorded in evidence (${sidecarO6.prune.plan.clone_root})`,
      { executed: sidecarO6.prune.executed },
    );
    for (const runId of retainedKeepRows) {
      findings.addInfo(
        'O6_RETAINED_BY_POLICY',
        `run ${runId} is terminal with cleanup_policy keep and status ready: retained-after-terminal is the current native contract (default keep)`,
        { run_id: runId },
      );
    }
    for (const characterization of policyCharacterizations) {
      findings.addInfo(
        'O6_POLICY_CHARACTERIZATION',
        `run ${characterization.run_id} is terminal (${characterization.run_status}) with cleanup_policy ${characterization.cleanup_policy} but the worktree is still ready: native run-terminal code does not auto-enforce remove_on_* policies in this snapshot (only remove/prune/delete do) — product policy/UX characterization, reported separately from corruption`,
        { run_id: characterization.run_id, cleanup_policy: characterization.cleanup_policy },
      );
    }
    if (policyCharacterizations.length > 0) {
      findings.addInfo(
        'O6_POLICY_CHARACTERIZATION_SUMMARY',
        `${policyCharacterizations.length} remove_on_* row(s) still ready after terminal runs — native auto-enforcement gap, see per-row O6_POLICY_CHARACTERIZATION findings`,
      );
    }
    for (const characterization of branchCharacterizations) {
      findings.addInfo(
        'O6_BRANCH_RETENTION_CHARACTERIZATION',
        `retained branch ${characterization.full_ref} under an admitted branch root${characterization.owning_rows === 0 ? ' is not referenced by any run_worktrees original_branch/worktree_origin_ref — origin repo ref inventory' : ` is referenced by ${characterization.owning_rows} run_worktrees row(s) (${characterization.owning_context.join(', ')})`}: native never deletes refs on worktree removal in this snapshot, so retained refs are origin inventory — characterization, never corruption`,
        { full_ref: characterization.full_ref },
      );
    }
  }

  // ── evidence: verdict summary + prune probe plan (exclusive creates) ──
  const summary = {
    schema_version: HYGIENE_SIDECAR_SCHEMA_VERSION,
    oracle_id: 'O6',
    produced_at: new Date().toISOString(),
    campaign_id: sidecar.campaign.id,
    result,
    database_leg: dbLeg.available ? { available: true, row_count: rows.length, run_count: runsById.size } : { available: false, reason: dbLeg.reason },
    disk_leg: {
      available: diskLegAvailable,
      exact_count: diskExact,
      inline_entries: diskEntries.length,
      capped: diskCapped,
      tool_exit: sidecarO6.disk.tool.exit_code,
      observed_orphan_dirs: orphanDirs.length,
    },
    git_legs: sidecarO6.git.origins.map((gitOrigin) => ({
      origin_index: gitOrigin.origin_index,
      worktree_list_tool_exit: gitOrigin.worktree_list.tool.exit_code,
      worktree_list_exact_count: gitOrigin.worktree_list.exact_count,
      worktree_list_inline_rows: gitOrigin.worktree_list.rows.length,
      worktree_list_capped: gitOrigin.worktree_list.capped === true,
      metadata_rows: gitOrigin.worktrees_metadata.rows.length,
      branch_rows: gitOrigin.branches.rows.length,
      branch_exact_count: gitOrigin.branches.exact_count,
      branch_capped: gitOrigin.branches.capped === true,
    })),
    orphan_rows: orphanRowSubjects,
    retained_by_policy_rows: retainedKeepRows,
    policy_characterizations: policyCharacterizations.map((entry) => entry.run_id),
    branch_characterizations: branchCharacterizations,
    reconciliation_unresolved_rows: gitReconcileUnresolved,
    prune_leg: { executed: sidecarO6.prune.executed, refusal: sidecarO6.prune.refusal },
  };
  const evidence = [];
  if (typeof evidenceDir === 'string' && evidenceDir.length > 0) {
    evidence.push(writeEvidenceJson(invocation, 'o6-summary.json', summary, 'o6-worktree-bookkeeping-summary'));
    evidence.push(writeEvidenceJson(invocation, 'o6-prune-probe-plan.json', {
      schema_version: HYGIENE_SIDECAR_SCHEMA_VERSION,
      oracle_id: 'O6',
      produced_at: new Date().toISOString(),
      executed: false,
      plan: sidecarO6.prune.plan,
      refusal: sidecarO6.prune.refusal,
      note: 'Clone-only probe plan for the SEPARATE prune/age behavioral leg; never executed against original data. A cloned DB that still points at original worktrees is NOT isolation — the clone must remap the disposable root and worktree paths.',
    }, 'o6-prune-probe-plan'));

    // Cite sidecar-declared raw capture artifacts as response evidence. The
    // response contract resolves every evidence path beneath the EVIDENCE
    // directory (TT_ORACLE_EVIDENCE_DIR when set, else the sidecar dir), so a
    // raw capture is cited with its path RELATIVE TO THE EVIDENCE DIR when it
    // is reachable from there (e.g. the recommended layout where the evidence
    // dir is a parent of the sidecar package); a capture outside the evidence
    // dir is not cited — it stays declared + hash-verified in the sidecar's
    // own evidence_files list.
    const byPath = new Map(sidecar.evidence_files.map((file) => [file.path, file]));
    const rawCaptureCandidates = sidecarO6.git.origins.flatMap((gitOrigin) => {
      const prefix = `o6-captures/origin-${gitOrigin.origin_index}`;
      return ['worktree-list.txt', 'worktrees-metadata.txt', 'branches.txt']
        .filter((name) => byPath.has(`${prefix}/${name}`))
        .map((name) => ({ path: `${prefix}/${name}`, kind: 'raw-git-capture' }));
    });
    const rawCaptureReferences = [];
    for (const candidate of rawCaptureCandidates) {
      const absolute = path.resolve(sidecarRoot, candidate.path);
      let inside;
      try {
        inside = pathIsWithin(evidenceDir, absolute);
      } catch {
        inside = false;
      }
      if (!inside) continue;
      const relative = path.relative(evidenceDir, absolute);
      // portable relative path: no leading ../, no empty/dot segments
      if (relative === '' || relative.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) continue;
      rawCaptureReferences.push({ path: relative, kind: candidate.kind });
    }
    for (const entry of rawCaptureReferences) evidence.push(entry);
  }

  return {
    result,
    findings: findings.toJSON(),
    evidence,
    ...(classification !== undefined ? { classification } : {}),
  };
}
