/**
 * MTLK guest suite: local git/tree helpers for the portable guest shim.
 *
 * Self-contained Node-core copy of the native suite hashing semantics
 * (src/suite/tree-hash.ts, src/suite/dirty-list.ts and the shim's tracked
 * status check). Kept under src/installer/matchlock so the portable RO guest
 * pack closure stays inside dist/installer/matchlock and never imports host
 * DB/CLI/control-client code. Behavior is byte-identical to the native
 * helpers:
 *
 *   - tree hashes use a temporary GIT_INDEX_FILE so the real repository index
 *     and working tree are never touched; any git failure returns null
 *   - trackedTreeHash ignores untracked files (git add -u)
 *   - cmd hash is the SHA-256 of the exact raw command string (no env data)
 *   - the tracked-dirty status check mirrors `git status --porcelain
 *     --untracked-files=no`
 *
 * All git calls are bounded (30s) and run guest-side. Node-core only.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT_TIMEOUT_MS = 30_000;

/** True when running git produced a clean zero-exit result. */
function gitOk(result: { status: number | null }): boolean {
  return result.status === 0;
}

/**
 * Committed tree hash of HEAD (git rev-parse HEAD^{tree}); null on failure.
 * Read-only — no temporary index.
 */
export function committedTreeHash(repoDir: string): string | null {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    });
    if (!gitOk(result)) return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Tree hash over HEAD + modifications to ALREADY-TRACKED paths only
 * (git read-tree HEAD, git add -u, git write-tree on a temp index).
 * Untracked files never enter this hash. Returns null on any git failure.
 */
export function trackedTreeHash(repoDir: string): string | null {
  const tempIndex = join(tmpdir(), `tamandua-guest-suite-index-${randomUUID()}`);
  try {
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
    const readTree = spawnSync("git", ["read-tree", "HEAD"], {
      cwd: repoDir,
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    });
    if (!gitOk(readTree)) return null;
    const addTracked = spawnSync("git", ["add", "-u"], {
      cwd: repoDir,
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    });
    if (!gitOk(addTracked)) return null;
    const writeTree = spawnSync("git", ["write-tree"], {
      cwd: repoDir,
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    });
    if (!gitOk(writeTree)) return null;
    return writeTree.stdout.trim();
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(tempIndex);
    } catch {
      // Best-effort cleanup.
    }
  }
}

/** SHA-256 of the exact command string bytes, with no normalization. */
export function computeCmdHash(cmd: string): string {
  return createHash("sha256").update(cmd).digest("hex");
}

/**
 * Resolve the origin repository for a worktree or main repository, matching
 * native getOriginRepo semantics. Falls back to the realpath of repoDir.
 */
export function getOriginRepo(repoDir: string): string {
  try {
    const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    if (!gitOk(result) || !result.stdout) {
      return realpathSync(repoDir);
    }
    const gitCommonDir = result.stdout.trim();
    const repoGitDir = join(repoDir, ".git");
    if (gitCommonDir !== repoGitDir && gitCommonDir !== ".git") {
      const originRepo = gitCommonDir.endsWith("/.git")
        ? gitCommonDir.slice(0, -4)
        : gitCommonDir;
      return realpathSync(originRepo);
    }
    return realpathSync(repoDir);
  } catch {
    try {
      return realpathSync(repoDir);
    } catch {
      return repoDir;
    }
  }
}

/**
 * Porcelain tracked-dirty lines (untracked ignored) or null on git failure.
 * Mirrors the native shim's pre/post checks exactly.
 */
export function getTrackedDirtyPaths(repoDir: string): string[] | null {
  try {
    const result = spawnSync(
      "git",
      ["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"],
      {
        cwd: repoDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: GIT_TIMEOUT_MS,
      },
    );
    if (!gitOk(result)) return null;
    return result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  } catch {
    return null;
  }
}

/**
 * Bounded dirty-list body (native formatTrackedDirtyList): at most `cap`
 * verbatim porcelain lines, each prefixed with one space, plus a summary
 * line when the list is longer. Pure — no git calls.
 */
export function formatTrackedDirtyList(paths: string[], cap: number = 32): string {
  const lines: string[] = [];
  const limit = Math.min(paths.length, cap);
  for (let i = 0; i < limit; i++) {
    lines.push(` ${paths[i]}`);
  }
  if (paths.length > cap) {
    const n = paths.length - cap;
    const t = paths.length;
    lines.push(`… and ${n} more tracked files not listed here (${t} total).`);
  }
  return lines.join("\n");
}
