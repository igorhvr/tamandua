/**
 * repository-scope.ts — MTLK-ADMIT.
 *
 * Real Git/FS resolution of the repository scope that a Matchlock work mount
 * must cover. The persisted policy records EXACT host spellings; this module
 * resolves what "the entire original repository" and "its Git metadata" mean
 * for a given directory using the ACTUAL git binary and filesystem — never by
 * trusting context strings as unvalidated metadata.
 *
 * Supported layouts:
 *   - a plain checkout (`.git` directory) or a cwd inside one;
 *   - a linked worktree (`.git` FILE carrying a `gitdir:` line) — the
 *     original/main checkout is recovered from `git worktree list --porcelain`
 *     (the entry whose gitdir equals the common dir), so worktree+original are
 *     both admitted;
 *   - a separate-git-dir checkout (`git init --separate-git-dir` / `.git` file
 *     pointing OUTSIDE the checkout) — the external Git/common directories are
 *     returned at their own absolute paths for admission at their exact path;
 *   - a bare repository used as a worktree origin — the repository root is the
 *     bare `.git` path itself.
 *
 * A NON-repository working directory resolves to an all-null scope: it stays
 * allowed and mounts itself only. Git resolution failures are reported as
 * "not a repository" (null scope) — no silent fabrication of metadata roots.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface RepositoryScopeOptions {
  /** Git binary to invoke (default "git"; tests may inject a fixture git). */
  gitBinary?: string;
}

/**
 * Resolved repository scope for one directory.
 * All paths are absolute (resolved, then realpath'd when the path exists).
 * Every field is null when `dir` is not inside a git working tree.
 */
export interface RepositoryScope {
  /** Top-level working tree containing `dir` (git rev-parse --show-toplevel). */
  topLevel: string | null;
  /** Absolute git dir of that working tree (following .git files). */
  gitDir: string | null;
  /** Absolute common dir (shared repository metadata). */
  commonDir: string | null;
  /**
   * The MAIN/original checkout path when this working tree is a linked
   * worktree of another checkout; equals the top level for the main checkout;
   * null when the repository is bare (no checkout) — the repository root is
   * then `commonDir` itself.
   */
  mainWorktree: string | null;
  /** True when the repository is bare (worktree list marks the entry bare). */
  bare: boolean;
}

const EMPTY_SCOPE: RepositoryScope = {
  topLevel: null,
  gitDir: null,
  commonDir: null,
  mainWorktree: null,
  bare: false,
};

function tryRealpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  }
}

function revParseGitEnv(): NodeJS.ProcessEnv {
  // Strip ambient GIT_DIR/GIT_WORK_TREE so discovery is driven solely by the
  // directory's own .git layout (matches how run.ts drives plain `git`).
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

/**
 * Resolve the repository scope of `dir` with the real git binary. Returns the
 * all-null scope when `dir` is not inside a git working tree OR when git
 * cannot resolve it (no fabricated metadata).
 */
export function resolveRepositoryScope(
  dir: string,
  opts: RepositoryScopeOptions = {},
): RepositoryScope {
  const gitBinary = opts.gitBinary ?? "git";
  const run = (args: string[]): string => {
    const out = execFileSync(gitBinary, ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: revParseGitEnv(),
      timeout: 15_000,
    });
    return out.trim();
  };

  // 1. Top level — the single probe that decides "inside a git work tree".
  let topLevel: string;
  try {
    topLevel = run(["rev-parse", "--show-toplevel"]);
  } catch {
    return { ...EMPTY_SCOPE };
  }
  if (topLevel === "") return { ...EMPTY_SCOPE };

  // 2. Absolute git dir (follows `.git` files / separate-git-dir).
  let gitDirRaw: string;
  try {
    gitDirRaw = run(["rev-parse", "--absolute-git-dir"]);
  } catch {
    return { ...EMPTY_SCOPE };
  }
  const gitDir = tryRealpath(path.resolve(dir, gitDirRaw));

  // 3. Common dir (linked-worktree metadata lives here). Printed relative to
  //    the invocation dir on git < 2.31 — resolve against `dir`.
  let commonDirRaw: string;
  try {
    commonDirRaw = run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  } catch {
    try {
      commonDirRaw = run(["rev-parse", "--git-common-dir"]);
      commonDirRaw = path.resolve(dir, commonDirRaw);
    } catch {
      return { topLevel: tryRealpath(topLevel), gitDir, commonDir: null, mainWorktree: null, bare: false };
    }
  }
  const commonDir = tryRealpath(path.resolve(dir, commonDirRaw));

  // 4. Main/original checkout via `git worktree list --porcelain`. The entry
  //    whose gitdir equals the common dir is the main worktree; a `bare` entry
  //    has no checkout (repository root == common dir). This works for plain
  //    checkouts, linked worktrees AND separate-git-dir layouts.
  let mainWorktree: string | null = null;
  let bare = false;
  try {
    const porcelain = run(["worktree", "list", "--porcelain"]);
    const entries = porcelain.split(/\n\s*\n/);
    for (const entry of entries) {
      const wt = entry.match(/^worktree (.+)$/m)?.[1]?.trim();
      const gd = entry.match(/^gitdir (.+)$/m)?.[1]?.trim();
      if (entry.split("\n").some((l) => l.trim() === "bare")) bare = true;
      if (gd) {
        const gdReal = tryRealpath(path.resolve(dir, gd));
        if (gdReal === commonDir) {
          // The MAIN worktree entry: gitdir == commondir.
          if (wt && !entry.split("\n").some((l) => l.trim() === "bare")) {
            mainWorktree = tryRealpath(path.resolve(dir, wt));
          } else {
            mainWorktree = null; // bare — no checkout
          }
          break;
        }
      }
    }
  } catch {
    // git worktree list unsupported/failed — fall through to heuristic below.
  }

  if (!mainWorktree) {
    // Fallback heuristic: when the common dir is named `<root>/.git` and the
    // directory above it exists, that directory is the original checkout.
    if (path.basename(commonDir) === ".git") {
      const parent = path.dirname(commonDir);
      try {
        const st = fs.statSync(parent);
        if (st.isDirectory()) mainWorktree = parent;
      } catch {
        mainWorktree = null;
      }
    }
    if (!mainWorktree && !bare) {
      // Plain single-checkout repo whose common dir is the checkout's own
      // .git: the top level IS the main worktree.
      mainWorktree = topLevel;
    }
  }

  return { topLevel: tryRealpath(topLevel), gitDir, commonDir, mainWorktree, bare };
}

/**
 * True when `candidate` equals `root` or sits strictly inside it (path-wise).
 * Used to decide whether a resolved Git metadata root is already covered by a
 * planned mount of `root` (nested ⇒ redundant, the planner drops it).
 */
export function isWithinPath(candidate: string, root: string): boolean {
  const c = path.resolve(candidate);
  const r = path.resolve(root);
  return c === r || c.startsWith(r + path.sep);
}

/**
 * Absolute canonical real path of `p` when it exists, else `p` resolved
 * (matching run.ts's mount-capture behaviour: existing paths are canonical,
 * absent paths keep their literal spelling for confinement checks).
 */
export function canonicalRealPath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Realpath-identity membership test for admitted repository/work roots.
 *
 * DESIGN INTENT: the persisted policy and the guest's cwd preserve the EXACT
 * host spelling, while the canonical target of a path is recorded separately
 * (`hostRealPath`, `canonicalRealPath`). A work path may therefore be spelled
 * through a symlink on one side and canonically on the other, so admission
 * MUST compare by realpath identity — never by string equality alone.
 *
 * Returns true when `requestRoot` string-equals an admitted root (fast path,
 * covers absent paths and exact-spelling intent) OR when its canonical real
 * path equals the canonical real path of some admitted root. Returns false for
 * every root outside the admitted set and NEVER throws (a non-existent
 * requested path simply keeps its resolved spelling).
 */
export function admittedRootMatches(requestRoot: string, admittedRoots: readonly string[]): boolean {
  if (admittedRoots.includes(requestRoot)) return true;
  const requestCanonical = canonicalRealPath(requestRoot);
  for (const admitted of admittedRoots) {
    if (canonicalRealPath(admitted) === requestCanonical) return true;
  }
  return false;
}
