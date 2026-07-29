/**
 * Content-addressed tree hashing utilities for TSTX.
 *
 * Computes git tree hashes using a temporary index so the real repository
 * index and working tree are never touched (R2). On any failure, returns
 * null so callers can fall back to passthrough (R3).
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Compute a git tree hash over the full working tree (HEAD + all tracked
 * and untracked-not-ignored files) using a temporary GIT_INDEX_FILE.
 *
 * R1: Uses `git read-tree HEAD`, `git add -A`, then `git write-tree`.
 * R2: MUST NOT touch the repository's real index or working tree.
 * R3: If git fails for ANY reason, returns `null`.
 *
 * @param repoDir - Path to the git repository (worktree or main).
 * @returns The tree hash (40 hex chars), or `null` on failure.
 */
export function computeTreeHash(repoDir: string): string | null {
  const tempIndex = join(tmpdir(), `tamandua-tstx-index-${randomUUID()}`);

  try {
    // R2: Use a temporary index file — never touch the real index.
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };

    // 1. Read HEAD into the temporary index.
    const readTree = spawnSync("git", ["read-tree", "HEAD"], {
      cwd: repoDir,
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    if (readTree.status !== 0) return null; // R3: passthrough fallback

    // 2. Add all files (respects .gitignore).
    const addAll = spawnSync("git", ["add", "-A"], {
      cwd: repoDir,
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    if (addAll.status !== 0) return null; // R3: passthrough fallback

    // 3. Write the tree.
    const writeTree = spawnSync("git", ["write-tree"], {
      cwd: repoDir,
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    if (writeTree.status !== 0) return null; // R3: passthrough fallback

    return writeTree.stdout.trim();
  } catch {
    return null; // R3: any unexpected error → passthrough
  } finally {
    // Clean up temp index regardless of outcome.
    try {
      unlinkSync(tempIndex);
    } catch {
      // Best-effort cleanup — temp file may not exist if git never
      // wrote to it.
    }
  }
}

/**
 * Compute the committed tree hash of HEAD.
 *
 * Runs `git rev-parse HEAD^{tree}` — a read-only operation that requires
 * no temporary index. Returns the trimmed tree hash, or `null` on any
 * git failure (non-git dir, empty repo with no commits, spawn failure).
 *
 * @param repoDir - Path to the git repository.
 * @returns The tree hash (40 hex chars), or `null` on failure.
 */
export function committedTreeHash(repoDir: string): string | null {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    if (result.status !== 0) return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Compute a git tree hash over tracked content only (HEAD + modifications
 * to already-tracked paths), using a temporary GIT_INDEX_FILE.
 *
 * Uses `git read-tree HEAD`, `git add -u` (NOT `-A` — updates only
 * already-tracked paths, ignores untracked files), then `git write-tree`.
 *
 * R2: MUST NOT touch the repository's real index or working tree.
 * R3: If git fails for ANY reason, returns `null`.
 *
 * @param repoDir - Path to the git repository (worktree or main).
 * @returns The tree hash (40 hex chars), or `null` on failure.
 */
export function trackedTreeHash(repoDir: string): string | null {
  const tempIndex = join(tmpdir(), `tamandua-tstx-index-${randomUUID()}`);

  try {
    // R2: Use a temporary index file — never touch the real index.
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };

    // 1. Read HEAD into the temporary index.
    const readTree = spawnSync("git", ["read-tree", "HEAD"], {
      cwd: repoDir,
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    if (readTree.status !== 0) return null; // R3: passthrough fallback

    // 2. Update only already-tracked paths (modifications + deletions).
    //    `-u` ignores untracked files — the key distinction from computeTreeHash.
    const addTracked = spawnSync("git", ["add", "-u"], {
      cwd: repoDir,
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    if (addTracked.status !== 0) return null; // R3: passthrough fallback

    // 3. Write the tree.
    const writeTree = spawnSync("git", ["write-tree"], {
      cwd: repoDir,
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    if (writeTree.status !== 0) return null; // R3: passthrough fallback

    return writeTree.stdout.trim();
  } catch {
    return null; // R3: any unexpected error → passthrough
  } finally {
    // Clean up temp index regardless of outcome.
    try {
      unlinkSync(tempIndex);
    } catch {
      // Best-effort cleanup — temp file may not exist if git never
      // wrote to it.
    }
  }
}

/**
 * Compute the SHA-256 hash of the exact test command string bytes,
 * with no normalization.
 *
 * @param cmd - The exact TEST_CMD string.
 * @returns The SHA-256 hex digest (64 hex chars).
 */
export function computeCmdHash(cmd: string): string {
  return createHash("sha256").update(cmd).digest("hex");
}

/**
 * Determine the origin repository for a worktree or main repository.
 *
 * For a managed worktree (`.git` is a file pointing into
 * `<origin>/.git/worktrees/...`), resolves to the realpath of the
 * origin repository. For a non-worktree repository, falls back to
 * the realpath of `repoDir` itself. On any failure, falls back to
 * `realpathSync(repoDir)`.
 *
 * @param repoDir - Path to check (worktree or main repo).
 * @returns The origin repository realpath.
 */
export function getOriginRepo(repoDir: string): string {
  try {
    // Attempt to find git common directory (origin's .git).
    const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });

    if (result.status !== 0 || !result.stdout) {
      // Fall back to repoDir's realpath.
      return realpathSync(repoDir);
    }

    const gitCommonDir = result.stdout.trim();

    // Check if we're in a worktree: the git-common-dir for a worktree
    // ends with "/.git" (the origin's .git). The origin repo is one
    // directory above git-common-dir.
    // For a non-worktree checkout, git-common-dir is ".git" (relative)
    // and is inside repoDir, so `repoDir` is the origin.
    //
    // If git-common-dir is an absolute path and different from
    // `<repoDir>/.git`, it's a worktree whose origin is the parent
    // of git-common-dir.
    const repoGitDir = join(repoDir, ".git");
    if (gitCommonDir !== repoGitDir && gitCommonDir !== ".git") {
      // Worktree case: the origin repo is the parent of git-common-dir.
      // e.g. /home/user/repo/.git → origin is /home/user/repo
      // e.g. /home/user/repo/.git (bare-ish) → origin is /home/user/repo
      const originRepo = gitCommonDir.endsWith("/.git")
        ? gitCommonDir.slice(0, -4) // strip "/.git"
        : gitCommonDir;
      return realpathSync(originRepo);
    }

    // Non-worktree: use repoDir itself.
    return realpathSync(repoDir);
  } catch {
    // On any failure, fall back to repoDir realpath.
    try {
      return realpathSync(repoDir);
    } catch {
      return repoDir;
    }
  }
}
