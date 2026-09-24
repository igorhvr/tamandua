/**
 * Evidence prune executor (DIAG-PRUNE US-014).
 *
 * Executes an ALREADY-APPROVED plan produced by the US-013 dry-run planner
 * (`prune-plan.ts`). It is filesystem-only: there is not a single database
 * read or write here, so run/step/story rows, `suite_results`, the event
 * stream and the daemon log are structurally untouched.
 *
 * Contract:
 *
 *   - Only items with `action: 'remove'` are ever considered. Every `keep`
 *     item is ignored (it was never a candidate).
 *   - A path that no longer exists is `skipped` — re-running an executed plan
 *     is therefore idempotent and never throws.
 *   - A path that is not LEXICALLY inside `stateDir` is refused (`failed`,
 *     the item is left on disk). The lexical guard is also applied to the
 *     physical location: the deepest existing ancestor of the target (and,
 *     for a non-symlink target, the target itself) must resolve inside the
 *     real state dir, so an intermediate symlink can never make a recursive
 *     delete escape the state dir. A target that IS a symlink is removed
 *     (the link itself is unlinked, never followed).
 *   - A path is never touched twice: a duplicated remove item is `skipped`.
 *   - `fs.rmSync(path, { recursive: true, force: true })` performs the
 *     delete; any thrown error lands in `failed` with its message.
 *
 * The module imports only Node-core (`fs`/`path`), the pure US-001 path
 * helper and type-only shared shapes, so its unit test stays in the parallel
 * lane.
 */
import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "./paths.js";
import type { PruneExecutionResult, PruneItem, PrunePlan } from "./types.js";

export interface ExecutePrunePlanOptions {
  /** Effective tamandua state dir; every removable path must live inside it. */
  stateDir: string;
}

/** `child` is the same as, or strictly inside, `parent` (lexical). */
function isInsideOrEqual(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  return resolvedParent === resolvedChild || isPathInside(resolvedParent, resolvedChild);
}

/** `realpathSync` that degrades to null instead of throwing. */
function safeRealpath(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * Real path of the deepest existing ancestor of `target` (including `target`
 * itself when it exists). Used to prove that a recursive delete cannot escape
 * the state dir through a symlinked directory component.
 */
function deepestExistingRealpath(target: string): string | null {
  let current = path.resolve(target);
  for (;;) {
    const resolved = safeRealpath(current);
    if (resolved !== null) return resolved;
    const parent = path.dirname(current);
    if (parent === current) return null; // reached the filesystem root
    current = parent;
  }
}

interface ContainmentVerdict {
  ok: boolean;
  error?: string;
}

/**
 * Decides whether a remove target can be safely deleted without escaping
 * `stateDir`.
 */
function checkContainment(
  stateDir: string,
  target: string,
  targetIsSymlink: boolean,
): ContainmentVerdict {
  if (!isPathInside(stateDir, target)) {
    return {
      ok: false,
      error: `refused: path is not inside the state dir (${stateDir})`,
    };
  }

  const realState = safeRealpath(stateDir);
  if (realState === null) return { ok: true };

  const realAncestor = deepestExistingRealpath(path.dirname(target));
  if (realAncestor !== null && !isInsideOrEqual(realState, realAncestor)) {
    return {
      ok: false,
      error: `refused: parent resolves outside the state dir (${realAncestor} not inside ${realState})`,
    };
  }

  // A symlink target is unlinked, never followed, so its own real path is
  // irrelevant. Everything else must physically live inside the state dir.
  if (!targetIsSymlink) {
    const realTarget = safeRealpath(target);
    if (realTarget !== null && !isInsideOrEqual(realState, realTarget)) {
      return {
        ok: false,
        error: `refused: path resolves outside the state dir (${realTarget} not inside ${realState})`,
      };
    }
  }

  return { ok: true };
}

/** lstat that degrades to null instead of throwing (missing path). */
function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/**
 * Execute an approved prune plan.
 *
 * @returns `removed` (deleted items), `skipped` (remove items whose path no
 *          longer exists, or was already handled by an earlier duplicate) and
 *          `failed` (refused or errored items, which remain on disk). No
 *          database row, event stream line or daemon log line is touched.
 */
export function executePrunePlan(
  plan: PrunePlan,
  options: ExecutePrunePlanOptions,
): PruneExecutionResult {
  const result: PruneExecutionResult = { removed: [], skipped: [], failed: [] };
  const stateDir = typeof options?.stateDir === "string" ? options.stateDir : "";
  const stateDirUsable = stateDir.length > 0;

  const items = Array.isArray(plan?.items) ? plan.items : [];
  const seen = new Set<string>();

  for (const raw of items) {
    if (raw === null || typeof raw !== "object") continue;
    const candidate = raw as PruneItem;
    if (candidate.action !== "remove") continue;
    if (typeof candidate.path !== "string" || candidate.path.length === 0) {
      result.failed.push({ item: candidate, error: "remove item has no path" });
      continue;
    }

    const target = path.resolve(candidate.path);
    if (seen.has(target)) {
      // The same physical path was already handled; never touch it twice.
      result.skipped.push(candidate);
      continue;
    }
    seen.add(target);

    if (!stateDirUsable) {
      result.failed.push({ item: candidate, error: "refused: state dir is empty" });
      continue;
    }

    const stat = lstatOrNull(target);
    if (stat === null) {
      // Already gone: a re-run of an executed plan is a harmless no-op.
      result.skipped.push(candidate);
      continue;
    }

    const verdict = checkContainment(stateDir, target, stat.isSymbolicLink());
    if (!verdict.ok) {
      result.failed.push({ item: candidate, error: verdict.error ?? "refused" });
      continue;
    }

    try {
      fs.rmSync(target, { recursive: true, force: true });
      result.removed.push(candidate);
    } catch (error) {
      result.failed.push({
        item: candidate,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}