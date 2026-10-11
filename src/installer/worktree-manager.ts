import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { getDb } from "../db.js";
import { logger } from "../lib/logger.js";
import { sweepRunProcesses } from "./run-cleanup.js";
import { getDaemonInstanceToken } from "./sweep-ownership.js";
import { gitIdentityEnv, resolveRunGitIdentity } from "./git-identity.js";

// ── Types ──

export type WorkflowWorkspace = "direct" | "worktree";

export interface CreateRunWorktreeParams {
  runId: string;
  runNumber: number;
  workflowId: string;
  worktreeOriginRepository: string;
  worktreeOriginRef?: string;
  cleanupPolicy?: "keep" | "remove_on_success" | "remove_on_terminal";
}

export interface ManagedRunWorktree {
  runId: string;
  worktreeOriginRepository: string;
  worktreeOriginGitCommonDir: string;
  worktreePath: string;
  worktreeOriginRef: string;
  worktreeOriginSha: string;
  originalBranch?: string;
  status: "creating" | "ready" | "removing" | "removed" | "error" | "cleanup_failed";
  cleanupPolicy: "keep" | "remove_on_success" | "remove_on_terminal";
}

// ── Internal helpers ──

function runGit(
  args: string[],
  cwd?: string,
  extraEnv?: NodeJS.ProcessEnv,
): { stdout: string; stderr: string; status: number } {
  const fullArgs = cwd ? ["-C", cwd, ...args] : args;
  const result = spawnSync("git", fullArgs, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status ?? -1,
  };
}

function gitMustSucceed(
  args: string[],
  cwd?: string,
  errorPrefix?: string,
  extraEnv?: NodeJS.ProcessEnv,
): string {
  const result = runGit(args, cwd, extraEnv);
  if (result.status !== 0) {
    const prefix = errorPrefix ? `${errorPrefix}: ` : "";
    throw new Error(
      `${prefix}git ${args.join(" ")} failed (exit ${result.status})${result.stderr ? `: ${result.stderr}` : ""}`,
    );
  }
  return result.stdout;
}

function rowToManagedRunWorktree(
  row: Record<string, unknown>,
): ManagedRunWorktree {
  return {
    runId: row.run_id as string,
    worktreeOriginRepository: row.worktree_origin_repository as string,
    worktreeOriginGitCommonDir: row.worktree_origin_git_common_dir as string,
    worktreePath: row.worktree_path as string,
    worktreeOriginRef: (row.worktree_origin_ref as string) ?? "",
    worktreeOriginSha: (row.worktree_origin_sha as string) ?? "",
    originalBranch: (row.original_branch as string) ?? undefined,
    status: row.status as ManagedRunWorktree["status"],
    cleanupPolicy: row.cleanup_policy as ManagedRunWorktree["cleanupPolicy"],
  };
}

// ── Exported functions ──

export function resolveWorktreeRoot(): string {
  const env = process.env.TAMANDUA_WORKTREE_ROOT?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), ".tamandua", "worktrees");
}

/**
 * Origin-cleanliness gate (ORIJ product fix): refuses only TRACKED changes.
 *
 * Untracked (`??`) and ignored (`!!`) porcelain entries are skipped because
 * untracked scratch files in the origin repo cannot affect a worktree built
 * from committed objects, and real user repos routinely carry them.
 *
 * ── Sibling porcelain-check audit (US-003) ─────────────────────────────
 * Every other `git status --porcelain` call on an origin/source repository
 * reachable from run creation was audited for the same untracked-only
 * false-refusal. None needs alignment:
 *
 * - src/installer/merge-branch.ts `inspectOwnerSafety` (landing gate): runs
 *   `status --porcelain=v1 --untracked-files=no`, so it already ignores
 *   untracked/ignored files. Correct; out of scope.
 * - src/installer/ledger-gate.ts `buildRefusalDiagnostics`: reads
 *   `status --porcelain` only to emit the read-only WORKSPACE_STATE
 *   diagnostic line; it never produces a refusal. Out of scope.
 * - src/autoresearch/autoresearch.ts `hasDirtyNonAutoresearchFiles` /
 *   `revertExperimentChanges`: commit/revert bookkeeping for the
 *   autoresearch engine (protected-file filtering, restore/clean), not a
 *   worktree-creation refusal. Out of scope.
 * - src/suite/shim.ts `getTrackedDirtyPaths` (TSTX tree-dirty gate) and
 *   src/suite/tree-hash.ts (temporary-index hashing): test/shim gates, and
 *   the shim already passes `--untracked-files=no`. Out of scope.
 * - src/installer/worktree-manager.ts `removeRunWorktree` (line ~375): the
 *   dirty check guards removal of the AGENT worktree (not the origin repo)
 *   and is force-overridable; it is not an origin/source refusal at run
 *   creation. No alignment needed.
 *
 * No sibling code change was required by this audit.
 */
export function hasTrackedChanges(porcelainOutput: string): boolean {
  for (const rawLine of porcelainOutput.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    const xy = line.slice(0, 2);
    if (xy === "??" || xy === "!!") continue;
    return true;
  }
  return false;
}

export function buildWorktreePath(params: {
  worktreeOriginGitCommonDir: string;
  worktreeOriginRepository: string;
  runId: string;
  runNumber: number;
}): string {
  const repoSlug = path.basename(params.worktreeOriginRepository);
  const repoHash = createHash("sha256")
    .update(params.worktreeOriginGitCommonDir)
    .digest("hex")
    .substring(0, 8);
  const runIdShort = params.runId.substring(0, 8);

  return path.join(
    resolveWorktreeRoot(),
    `${repoSlug}-${repoHash}`,
    `${params.runNumber}-${runIdShort}`,
  );
}

export function createRunWorktree(
  params: CreateRunWorktreeParams,
): ManagedRunWorktree {
  const originRepoInput = path.resolve(params.worktreeOriginRepository);
  let originRepo: string;
  try {
    originRepo = fs.realpathSync(originRepoInput);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`origin repository does not exist: ${originRepoInput}`);
    }
    throw err;
  }

  // Resolve the run's ONE commit identity (GIDN US-004) from the origin
  // repository and apply it to every git invocation this function makes, so
  // no Tamandua git operation silently falls back to the host process
  // identity. Env only — git config is never written.
  const identityEnv = gitIdentityEnv(
    resolveRunGitIdentity(params.runId, originRepo, process.env),
  );

  // Validate origin is a git repo
  gitMustSucceed(
    ["rev-parse", "--show-toplevel"],
    originRepo,
    "origin repository is not a git working tree",
    identityEnv,
  );

  const dirtyStatus = gitMustSucceed(
    ["status", "--porcelain"],
    originRepo,
    "cannot inspect origin repository status",
    identityEnv,
  );
  if (hasTrackedChanges(dirtyStatus)) {
    throw new Error(
      `origin repository has uncommitted changes to tracked files: ${originRepo}`,
    );
  }

  // Resolve git common dir (normalize to absolute — git may return relative)
  const gitCommonDirRaw = gitMustSucceed(
    ["rev-parse", "--git-common-dir"],
    originRepo,
    undefined,
    identityEnv,
  );
  const gitCommonDir = path.isAbsolute(gitCommonDirRaw)
    ? gitCommonDirRaw
    : path.resolve(originRepo, gitCommonDirRaw);

  // Capture original branch
  const branchResult = runGit(["branch", "--show-current"], originRepo, identityEnv);
  const originalBranch =
    branchResult.status === 0 && branchResult.stdout
      ? branchResult.stdout
      : undefined;

  // Determine worktree origin ref
  const originRef = params.worktreeOriginRef ?? originalBranch;
  if (!originRef) {
    throw new Error(
      "origin repository is in detached HEAD state and no --worktree-origin-ref was provided",
    );
  }

  // Resolve SHA
  const originSha = gitMustSucceed(
    ["rev-parse", originRef],
    originRepo,
    `cannot resolve origin ref "${originRef}"`,
    identityEnv,
  );

  // Build worktree path
  const worktreePath = buildWorktreePath({
    worktreeOriginGitCommonDir: gitCommonDir,
    worktreeOriginRepository: originRepo,
    runId: params.runId,
    runNumber: params.runNumber,
  });

  const cleanupPolicy = params.cleanupPolicy ?? "keep";
  const now = new Date().toISOString();
  const db = getDb();

  // Insert DB row with status=creating
  db.prepare(
    `INSERT INTO run_worktrees (run_id, worktree_origin_repository, worktree_origin_git_common_dir,
      worktree_path, worktree_origin_ref, worktree_origin_sha, original_branch, status,
      cleanup_policy, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?)`,
  ).run(
    params.runId,
    originRepo,
    gitCommonDir,
    worktreePath,
    originRef,
    originSha,
    originalBranch ?? null,
    cleanupPolicy,
    now,
  );

  // Create detached worktree
  try {
    gitMustSucceed(
      ["worktree", "add", "--detach", worktreePath, originRef],
      originRepo,
      "failed to create managed worktree",
      identityEnv,
    );
  } catch (err) {
    const errorMsg = (err as Error).message;
    db.prepare(
      "UPDATE run_worktrees SET status = 'error', error = ? WHERE run_id = ?",
    ).run(errorMsg, params.runId);
    throw err;
  }

  // Update status to ready
  db.prepare("UPDATE run_worktrees SET status = 'ready' WHERE run_id = ?").run(
    params.runId,
  );

  return getRunWorktree(params.runId)!;
}

export function getRunWorktree(runId: string): ManagedRunWorktree | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM run_worktrees WHERE run_id = ?")
    .get(runId) as Record<string, unknown> | undefined;

  if (!row) return null;

  return rowToManagedRunWorktree(row);
}

export function validateRunWorktree(
  runId: string,
  context: Record<string, unknown>,
): ManagedRunWorktree {
  const wt = getRunWorktree(runId);
  if (!wt) {
    throw new Error(`Run ${runId} has no managed worktree`);
  }

  if (wt.status !== "ready") {
    throw new Error(
      `Run ${runId} managed worktree status is "${wt.status}", expected "ready"`,
    );
  }

  // Check worktree path exists and is a directory
  let stats: fs.Stats;
  try {
    stats = fs.statSync(wt.worktreePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `Run ${runId} managed worktree path does not exist: ${wt.worktreePath}`,
      );
    }
    throw err;
  }

  if (!stats.isDirectory()) {
    throw new Error(
      `Run ${runId} managed worktree path is not a directory: ${wt.worktreePath}`,
    );
  }

  // Check it's a git working tree
  gitMustSucceed(
    ["rev-parse", "--show-toplevel"],
    wt.worktreePath,
    `Run ${runId} managed worktree is not a git working tree`,
  );

  // Check git-common-dir matches (normalize both — git may return relative or absolute)
  const actualGitCommonDirRaw = gitMustSucceed(
    ["rev-parse", "--git-common-dir"],
    wt.worktreePath,
  );
  const actualGitCommonDir = path.isAbsolute(actualGitCommonDirRaw)
    ? actualGitCommonDirRaw
    : path.resolve(wt.worktreePath, actualGitCommonDirRaw);
  if (actualGitCommonDir !== wt.worktreeOriginGitCommonDir) {
    throw new Error(
      `Run ${runId} managed worktree git-common-dir mismatch: ` +
        `expected "${wt.worktreeOriginGitCommonDir}", got "${actualGitCommonDir}"`,
    );
  }

  // Check context.repo matches worktree_path
  const contextRepo = context.repo;
  if (typeof contextRepo !== "string" || contextRepo !== wt.worktreePath) {
    throw new Error(
      `Run ${runId} context.repo "${String(contextRepo)}" does not match worktree_path "${wt.worktreePath}"`,
    );
  }

  const contextHarnessDir = context.working_directory_for_harness;
  if (
    typeof contextHarnessDir !== "string" ||
    contextHarnessDir !== wt.worktreePath
  ) {
    throw new Error(
      `Run ${runId} context.working_directory_for_harness "${String(contextHarnessDir)}" does not match worktree_path "${wt.worktreePath}"`,
    );
  }

  return wt;
}

export function removeRunWorktree(params: {
  runId: string;
  force?: boolean;
}): void {
  const db = getDb();
  const wt = getRunWorktree(params.runId);

  if (!wt) {
    throw new Error(`Run ${params.runId} has no managed worktree`);
  }

  if (wt.status === "removed") {
    return; // already removed, idempotent
  }

  // Check if worktree path exists
  let pathExists = false;
  try {
    fs.statSync(wt.worktreePath);
    pathExists = true;
  } catch {
    // path doesn't exist, skip filesystem removal
  }

  if (pathExists) {
    // Resolve the run's identity from the origin repository and apply it to
    // the removal invocations too (GIDN US-004): even a non-committing git
    // operation runs under the run's identity, never the host's.
    const identityEnv = gitIdentityEnv(
      resolveRunGitIdentity(params.runId, wt.worktreeOriginRepository, process.env),
    );

    // Sweep for surviving processes tied to this worktree before removal.
    // Exclude the run's own harness process groups (steps.claim_pgid): the
    // final work round may still be flushing token usage inside the
    // teardown grace window — the scheduler's leak guard owns those. This
    // sweep targets everything ELSE an agent left behind (test daemons,
    // orphaned tools).
    try {
      const excludePgids = getDb()
        .prepare("SELECT DISTINCT claim_pgid FROM steps WHERE run_id = ? AND claim_pgid IS NOT NULL")
        .all(params.runId)
        .map((r) => (r as { claim_pgid: number }).claim_pgid);
      // SWEEP-SCOPE US-004: the pre-removal sweep must prove ownership by the
      // same exclusive evidence as the post-grace sweep — a recorded pgid or a
      // marker scoped to THIS daemon instance. Pass this process's token so the
      // marker channel stays usable; an unavailable token disables it.
      sweepRunProcesses(params.runId, wt.worktreePath, {
        excludePgids,
        daemonInstance: getDaemonInstanceToken(),
      });
    } catch (err) {
      logger.warn(
        `Process cleanup sweep failed for run ${params.runId}, proceeding with worktree removal`,
        { runId: params.runId, error: String(err) },
      );
    }

    // Check dirty state
    if (!params.force) {
      const statusResult = runGit(["status", "--porcelain"], wt.worktreePath, identityEnv);
      if (statusResult.status === 0 && statusResult.stdout.length > 0) {
        throw new Error(
          `Run ${params.runId} managed worktree is dirty. Use --force to remove anyway.`,
        );
      }
    }

    // Remove the worktree (must be run from origin repo, not the worktree itself).
    // Double --force is required to override a git worktree lock (e.g. the
    // 'initialising' lock left by a killed-mid-add git process).
    const removeArgs = params.force
      ? ["worktree", "remove", "--force", "--force", wt.worktreePath]
      : ["worktree", "remove", wt.worktreePath];

    const result = runGit(removeArgs, wt.worktreeOriginRepository, identityEnv);
    if (result.status !== 0) {
      throw new Error(
        `Failed to remove managed worktree for run ${params.runId}: ${result.stderr || result.stdout}`,
      );
    }
  }

  // Update DB
  db.prepare(
    "UPDATE run_worktrees SET status = 'removed', removed_at = ? WHERE run_id = ?",
  ).run(new Date().toISOString(), params.runId);
}

export function listRunWorktrees(): ManagedRunWorktree[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM run_worktrees ORDER BY created_at DESC")
    .all() as Array<Record<string, unknown>>;

  return rows.map(rowToManagedRunWorktree);
}

// ── tamandua-dlt: teardown detach (WORKTREE-OWN) ─────────────────────

/**
 * Run statuses in which a run's writers have stopped (its teardown passes
 * have run). Only these may have their OWN managed worktree detached from an
 * attached branch — a run that is (or was just) reactivated keeps its
 * attachment.
 */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "canceled",
]);

/** What {@link detachRunWorktreeBranch} did (or deliberately did not do). */
export type DetachRunWorktreeOutcome = "detached" | "already-detached" | "skipped" | "failed";

export interface DetachRunWorktreeResult {
  runId: string;
  /** Recorded worktree path, when the run has a managed-worktree row. */
  worktreePath: string | null;
  outcome: DetachRunWorktreeOutcome;
  /** Branch the worktree was attached to (outcome "detached" only). */
  branch?: string;
  /** Commit HEAD pointed at before the detach (outcome "detached" only). */
  head?: string;
  /** Human-readable cause for a "skipped"/"failed" outcome. */
  reason?: string;
}

/**
 * Bounded timeout for ONE detach git invocation. A local plumbing command on
 * a healthy repository completes in milliseconds; the bound exists so a
 * pathological repository can never wedge the daemon's event loop (these git
 * calls are synchronous) or hold the serializing transaction below open
 * indefinitely.
 */
const DETACH_GIT_TIMEOUT_MS = 5_000;

/**
 * Canonicalize a path, or null when the filesystem cannot resolve it.
 * Fail-closed by design: callers treat null as "cannot corroborate", never
 * as a lexical fallback — a claimed-canonical compare must not degrade into
 * a string compare.
 */
function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Run one git command for the detach with a REPLACEMENT environment (not a
 * merge on top of process.env): every repository-selection / config-injection
 * variable is removed at the subprocess boundary, so no caller environment
 * can redirect the operation away from the exact verified worktree path.
 * Checkout hooks are suppressed (core.hooksPath points at the null device,
 * where no hook files exist) and submodule recursion is disabled. Bounded by
 * {@link DETACH_GIT_TIMEOUT_MS}.
 */
function runGitDetach(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
  ]) {
    delete env[key];
  }
  const result = spawnSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      `core.hooksPath=${os.devNull}`,
      "-c",
      "submodule.recurse=false",
      ...args,
    ],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DETACH_GIT_TIMEOUT_MS,
      env,
    },
  );
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status ?? -1,
  };
}

/**
 * tamandua-dlt (WORKTREE-OWN, TEARDOWN-DETACH): when a run has reached a
 * terminal state, detach the run's OWN managed worktree from a branch it is
 * still attached to (`git checkout --detach` semantics at the current HEAD:
 * the directory, every ref and all working-tree content are kept). This is
 * the #117 failure-class fix: a completed run's worktree left attached to
 * the integration branch conflates branch ownership with the origin
 * checkout, so the NEXT run's `finalize_merge` refuses ("multiple worktrees
 * own refs/heads/X") (bead tamandua-dlt).
 *
 * STRICT SAFETY — the target is only ever the exactly-identified run-owned
 * allocation:
 *   - the EXACT run's own managed-worktree row is resolved (never a generic
 *     working-directory fallback); the target is never "whichever worktree
 *     holds a branch";
 *   - refusal set, compared on canonical (realpath-resolved) paths: the
 *     origin checkout; any path claimed by a DIFFERENT run's row (canonical
 *     aliases cannot defeat this); any path outside the canonical worktree
 *     root (a drifted root yields a safe skip, never a wrong-target detach);
 *     and any path whose git administrative metadata fails the corroboration
 *     (toplevel must resolve to the path itself, git-common-dir must match
 *     the recorded origin repository, and the linked worktree's registration
 *     backlink must point back at the path);
 *   - writer fence: the run must be TERMINAL (completed/failed/canceled) at a
 *     fresh read taken INSIDE a short `BEGIN IMMEDIATE` transaction that also
 *     serializes the detach against competing resume/state-write
 *     transactions, so a resume that commits first is guaranteed to be seen
 *     (skip). A resume that begins only after the transaction commits then
 *     operates on an already-detached worktree — the state the #117 recovery
 *     prescribes (directory + refs intact, re-attachable with one
 *     `git checkout`); no ref is ever moved. This helper does not itself
 *     re-prove process exit: callers (the post-grace teardown) establish
 *     writer quiescence with a bounded probe before invoking it;
 *   - idempotent: an intentionally detached HEAD is a success no-op; an
 *     UNREADABLE HEAD inspection is a failure (never conflated with
 *     idempotent success);
 *   - bounded: every git invocation is bounded ({@link DETACH_GIT_TIMEOUT_MS})
 *     and never touches anything but HEAD's attachment; on failure it reports
 *     `failed` with the cause (post-verify failures are reported, never
 *     "rolled back" via a destructive retry) and never throws, so the caller
 *     can surface it WITHOUT masking the run's own outcome.
 */
export function detachRunWorktreeBranch(runId: string): DetachRunWorktreeResult {
  const base: DetachRunWorktreeResult = { runId, worktreePath: null, outcome: "skipped" };
  try {
    const wt = getRunWorktree(runId);
    if (!wt) return { ...base, reason: "run has no managed worktree row" };
    base.worktreePath = wt.worktreePath;

    if (wt.status === "removed" || wt.status === "removing") {
      return { ...base, reason: `worktree row status is "${wt.status}"` };
    }

    const db = getDb();
    const wtReal = realpathOrNull(wt.worktreePath);
    if (wtReal === null) {
      return { ...base, outcome: "failed", reason: "cannot canonicalize the recorded worktree path" };
    }
    const originReal = realpathOrNull(wt.worktreeOriginRepository);
    // Every git invocation below targets the CANONICAL, verified path: the
    // validation and the mutation must address the same directory even when
    // the recorded spelling differs from the on-disk reality.
    const detachTarget = wtReal;

    // (1) Never the origin checkout, whatever the row says. If the origin
    // cannot be canonicalized the comparison cannot be PROVEN, so refuse
    // rather than guess.
    if (originReal === null) {
      return {
        ...base,
        outcome: "failed",
        reason: "cannot canonicalize the recorded origin repository; refusing to guess",
      };
    }
    if (wtReal === originReal) {
      return { ...base, reason: "refusing to operate on the origin checkout itself" };
    }

    // (2) Never another run's worktree — canonical compare over ALL other
    // rows (incl. removing/removed history: an allocation mid-removal must
    // not become available to this teardown), so aliased spellings of the
    // same directory cannot defeat the check.
    const otherRows = db
      .prepare("SELECT run_id, worktree_path FROM run_worktrees WHERE run_id != ?")
      .all(runId) as Array<{ run_id: string; worktree_path: string }>;
    for (const row of otherRows) {
      const rowReal = realpathOrNull(row.worktree_path);
      if (rowReal !== null && rowReal === wtReal) {
        return { ...base, reason: `worktree path is claimed by another run (${row.run_id})` };
      }
    }

    // (3) Corroborate the persisted allocation against the canonical root —
    // a drifted/unknown root can only cause a safe skip, never a
    // wrong-target detach.
    const rootReal = realpathOrNull(resolveWorktreeRoot());
    if (rootReal === null || !wtReal.startsWith(rootReal + path.sep)) {
      return {
        ...base,
        reason: `worktree path is outside the canonical worktree root (${rootReal ?? "<unresolvable>"})`,
      };
    }

    // (4) Git administrative metadata + registration corroboration.
    const toplevelRes = runGitDetach(["rev-parse", "--show-toplevel"], detachTarget);
    if (toplevelRes.status !== 0) {
      return {
        ...base,
        reason: `not a git working tree: ${toplevelRes.stderr || toplevelRes.stdout || `exit ${toplevelRes.status}`}`,
      };
    }
    if (realpathOrNull(toplevelRes.stdout) !== wtReal) {
      return { ...base, reason: "git toplevel does not resolve to the recorded worktree path" };
    }
    const commonRes = runGitDetach(["rev-parse", "--git-common-dir"], detachTarget);
    if (commonRes.status !== 0) {
      return {
        ...base,
        reason: `cannot resolve git-common-dir: ${commonRes.stderr || commonRes.stdout || `exit ${commonRes.status}`}`,
      };
    }
    const commonDir = path.isAbsolute(commonRes.stdout)
      ? commonRes.stdout
      : path.resolve(detachTarget, commonRes.stdout);
    const commonDirReal = realpathOrNull(commonDir);
    const recordedCommonDirReal = realpathOrNull(wt.worktreeOriginGitCommonDir);
    if (
      commonDirReal === null ||
      recordedCommonDirReal === null ||
      commonDirReal !== recordedCommonDirReal
    ) {
      return {
        ...base,
        reason: "git-common-dir could not be corroborated against the recorded origin repository",
      };
    }
    const absGitDirRes = runGitDetach(["rev-parse", "--absolute-git-dir"], detachTarget);
    if (absGitDirRes.status !== 0 || absGitDirRes.stdout === "") {
      return { ...base, reason: "cannot resolve the worktree's absolute git dir" };
    }
    const absGitDirReal = realpathOrNull(absGitDirRes.stdout);
    const worktreesRootReal = realpathOrNull(path.join(commonDir, "worktrees"));
    if (
      absGitDirReal === null ||
      worktreesRootReal === null ||
      !absGitDirReal.startsWith(worktreesRootReal + path.sep)
    ) {
      return { ...base, reason: "git dir is not a linked worktree registration under the origin" };
    }
    let backlink: string;
    try {
      backlink = fs.readFileSync(path.join(absGitDirRes.stdout, "gitdir"), "utf-8").trim();
    } catch (err) {
      return {
        ...base,
        reason: `cannot read the worktree registration backlink: ${(err as Error).message}`,
      };
    }
    const backlinkReal = realpathOrNull(backlink);
    const dotGitReal = realpathOrNull(path.join(detachTarget, ".git"));
    if (backlinkReal === null || dotGitReal === null || backlinkReal !== dotGitReal) {
      return { ...base, reason: "registration backlink does not point back at the recorded path" };
    }

    // (5) Attachment probe — strictly tri-state: exit 1 = deliberately
    // detached (valid idempotent no-op), exit 0 with a full refs/heads/*
    // symbolic ref = attached, anything else (including exit 0 with empty
    // or non-branch output) = failed inspection, never conflated with
    // success.
    const symRes = runGitDetach(["symbolic-ref", "--quiet", "HEAD"], detachTarget);
    if (symRes.status === 1) {
      return { ...base, outcome: "already-detached" };
    }
    if (symRes.status !== 0 || symRes.stdout === "" || !symRes.stdout.startsWith("refs/heads/")) {
      return {
        ...base,
        outcome: "failed",
        reason: `cannot inspect HEAD attachment (exit ${symRes.status}): ${symRes.stderr || symRes.stdout}`,
      };
    }
    const branchRef = symRes.stdout;
    const branch = branchRef.slice("refs/heads/".length);
    const branchBeforeRes = runGitDetach(["rev-parse", "--verify", `${branchRef}^{commit}`], detachTarget);
    const headBeforeRes = runGitDetach(["rev-parse", "HEAD"], detachTarget);
    if (
      branchBeforeRes.status !== 0 ||
      branchBeforeRes.stdout === "" ||
      headBeforeRes.status !== 0 ||
      headBeforeRes.stdout === ""
    ) {
      return { ...base, outcome: "failed", reason: "cannot read HEAD/branch state before detach" };
    }
    const branchBefore = branchBeforeRes.stdout;
    const headBefore = headBeforeRes.stdout;

    // (6) Serialized writer fence + detach. The IMMEDIATE transaction
    // RE-VALIDATES, at the freshest possible read: the run's terminal
    // status (a resume/state change that committed earlier is seen and
    // skipped), the worktree-allocation row (still this exact path, still
    // eligible), and the absence of a conflicting owner — the pre-checks
    // above ran outside the lock and can be stale. It then holds the DB
    // write lock across EXACTLY ONE bounded git mutation (the detach
    // itself), so a competing writer either commits BEFORE the
    // re-validation or waits until after the detach.
    db.exec("BEGIN IMMEDIATE");
    try {
      const runRow = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
        | { status: string }
        | undefined;
      if (!runRow) {
        db.exec("ROLLBACK");
        return { ...base, reason: "run row is gone" };
      }
      if (!TERMINAL_RUN_STATUSES.has(String(runRow.status))) {
        db.exec("ROLLBACK");
        return { ...base, reason: `run status "${runRow.status}" is not terminal` };
      }
      const alloc = db
        .prepare(
          "SELECT worktree_path, worktree_origin_repository, worktree_origin_git_common_dir, status FROM run_worktrees WHERE run_id = ?",
        )
        .get(runId) as
        | {
            worktree_path: string;
            worktree_origin_repository: string;
            worktree_origin_git_common_dir: string;
            status: string;
          }
        | undefined;
      const allocReal = alloc ? realpathOrNull(alloc.worktree_path) : null;
      const allocOriginReal = alloc ? realpathOrNull(alloc.worktree_origin_repository) : null;
      const allocCommonReal = alloc ? realpathOrNull(alloc.worktree_origin_git_common_dir) : null;
      if (
        !alloc ||
        allocReal === null ||
        allocReal !== wtReal ||
        allocOriginReal !== originReal ||
        allocCommonReal === null ||
        allocCommonReal !== recordedCommonDirReal ||
        alloc.status === "removed" ||
        alloc.status === "removing"
      ) {
        db.exec("ROLLBACK");
        return { ...base, reason: "worktree allocation changed before the detach" };
      }
      const conflictingRows = db
        .prepare("SELECT run_id, worktree_path FROM run_worktrees WHERE run_id != ?")
        .all(runId) as Array<{ run_id: string; worktree_path: string }>;
      for (const row of conflictingRows) {
        const rowReal = realpathOrNull(row.worktree_path);
        if (rowReal !== null && rowReal === wtReal) {
          db.exec("ROLLBACK");
          return { ...base, reason: `worktree path is claimed by another run (${row.run_id})` };
        }
      }

      // Git detach semantics: `checkout --detach` (deliberately NOT --force)
      // detaches at the current HEAD; the directory, every ref and all
      // working-tree content (staged, unstaged, untracked) are kept.
      const detachRes = runGitDetach(["checkout", "--detach"], detachTarget);
      if (detachRes.status !== 0) {
        db.exec("ROLLBACK");
        return {
          ...base,
          outcome: "failed",
          reason: `git checkout --detach failed (exit ${detachRes.status}): ${detachRes.stderr || detachRes.stdout}`,
        };
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Best-effort: the outer catch reports the outcome either way.
      }
      return { ...base, outcome: "failed", reason: `detach aborted: ${(err as Error).message}` };
    }

    // (7) Post-verify, outside the lock (the mutation already committed; a
    // post-mutation uncertainty can no longer be "rolled back", so it is
    // REPORTED). Strict reads: every verification must SUCCEED and match —
    // an unreadable or empty result is a reported failure, never a false
    // success.
    const afterRes = runGitDetach(["symbolic-ref", "--quiet", "HEAD"], detachTarget);
    if (afterRes.status !== 1) {
      return {
        ...base,
        outcome: "failed",
        reason:
          afterRes.status === 0
            ? `HEAD still attached to "${afterRes.stdout}" after detach`
            : `cannot verify detachment (inspection exit ${afterRes.status})`,
      };
    }
    const headAfterRes = runGitDetach(["rev-parse", "HEAD"], detachTarget);
    if (headAfterRes.status !== 0 || headAfterRes.stdout === "") {
      return { ...base, outcome: "failed", reason: "cannot verify HEAD after detach" };
    }
    if (headAfterRes.stdout !== headBefore) {
      return { ...base, outcome: "failed", reason: "HEAD moved during detach" };
    }
    const branchAfterRes = runGitDetach(["rev-parse", "--verify", `${branchRef}^{commit}`], detachTarget);
    if (branchAfterRes.status !== 0 || branchAfterRes.stdout === "") {
      return { ...base, outcome: "failed", reason: `cannot verify branch ref ${branchRef} after detach` };
    }
    if (branchAfterRes.stdout !== branchBefore) {
      return { ...base, outcome: "failed", reason: `branch ref ${branchRef} moved during detach` };
    }

    return { ...base, outcome: "detached", branch, head: headBefore };
  } catch (err) {
    return { ...base, outcome: "failed", reason: `detach threw: ${(err as Error).message}` };
  }
}
