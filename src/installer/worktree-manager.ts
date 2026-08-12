import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { getDb } from "../db.js";
import { logger } from "../lib/logger.js";
import { sweepRunProcesses } from "./run-cleanup.js";

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
): { stdout: string; stderr: string; status: number } {
  const fullArgs = cwd ? ["-C", cwd, ...args] : args;
  const result = spawnSync("git", fullArgs, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
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
): string {
  const result = runGit(args, cwd);
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

  // Validate origin is a git repo
  gitMustSucceed(
    ["rev-parse", "--show-toplevel"],
    originRepo,
    "origin repository is not a git working tree",
  );

  const dirtyStatus = gitMustSucceed(
    ["status", "--porcelain"],
    originRepo,
    "cannot inspect origin repository status",
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
  );
  const gitCommonDir = path.isAbsolute(gitCommonDirRaw)
    ? gitCommonDirRaw
    : path.resolve(originRepo, gitCommonDirRaw);

  // Capture original branch
  const branchResult = runGit(["branch", "--show-current"], originRepo);
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
      sweepRunProcesses(params.runId, wt.worktreePath, { excludePgids });
    } catch (err) {
      logger.warn(
        `Process cleanup sweep failed for run ${params.runId}, proceeding with worktree removal`,
        { runId: params.runId, error: String(err) },
      );
    }

    // Check dirty state
    if (!params.force) {
      const statusResult = runGit(["status", "--porcelain"], wt.worktreePath);
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

    const result = runGit(removeArgs, wt.worktreeOriginRepository);
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
