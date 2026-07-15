import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { validateRunWorktree } from "./worktree-manager.js";
import type { HarnessType } from "./types.js";
import { getDb } from "../db.js";
import { resolveHermesBinary } from "./hermes-resolver.js";
import { parseRunContext as safeParseRunContext } from "./step-ops.js";

export const RUN_CONTEXT_WORKING_DIRECTORY_FOR_HARNESS_KEY = "working_directory_for_harness";

export interface HarnessValidationResult {
  workingDirectoryForHarness: string;
  expectedBranch?: string;
}

function parseRunContext(runId: string, contextRaw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contextRaw);
  } catch {
    // Emit event via safeParseRunContext, then throw
    safeParseRunContext(runId, contextRaw);
    throw new Error("run context is not valid JSON");
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new Error("run context is not valid JSON");
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readCurrentGitBranch(workdir: string): string {
  const result = spawnSync("git", ["-C", workdir, "branch", "--show-current"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(
      `cannot read git branch at harness workdir ${workdir}${stderr ? `: ${stderr}` : ""}`,
    );
  }

  return result.stdout.trim();
}

export async function validateRunHarnessForScheduling(
  runId: string,
  contextRaw: string,
): Promise<HarnessValidationResult> {
  const context = parseRunContext(runId, contextRaw);
  const workspaceMode = readNonEmptyString(context, "workspace_mode") ?? "direct";

  // Resolve and validate the harness working directory (common to both modes).
  const rawWorkdir = readNonEmptyString(context, RUN_CONTEXT_WORKING_DIRECTORY_FOR_HARNESS_KEY);
  if (!rawWorkdir) {
    throw new Error(
      `Run ${runId} is missing ${RUN_CONTEXT_WORKING_DIRECTORY_FOR_HARNESS_KEY}; refusing to schedule without an explicit harness workdir`,
    );
  }
  if (!path.isAbsolute(rawWorkdir)) {
    throw new Error(
      `Run ${runId} has a relative harness workdir (${rawWorkdir}); refusing to schedule because resume must not depend on daemon cwd`,
    );
  }
  const workingDirectoryForHarness = path.resolve(rawWorkdir);

  // Mode-specific validation.
  if (workspaceMode === "worktree") {
    // Delegate worktree validation to the worktree manager, which checks
    // path existence, git-common-dir, context.repo, and more.
    validateRunWorktree(runId, context);
  } else {
    // Direct mode: validate harness workdir exists and is a directory.
    let stats: fs.Stats;
    try {
      stats = fs.statSync(workingDirectoryForHarness);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error(
          `Run ${runId} harness workdir does not exist: ${workingDirectoryForHarness}`,
        );
      }
      throw err;
    }

    if (!stats.isDirectory()) {
      throw new Error(
        `Run ${runId} harness workdir is not a directory: ${workingDirectoryForHarness}`,
      );
    }
  }

  // Validate hermes binary is available when harness_type is "hermes".
  // This runs for BOTH direct and worktree runs — a worktree run must
  // not bypass harness-type validation.
  const harnessType = readNonEmptyString(context, "harness_type");
  if (harnessType === "hermes") {
    try {
      await resolveHermesBinary();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Run ${runId} requests hermes harness but hermes is not available: ${message}`,
      );
    }
  }

  // Branch-mismatch check — direct mode only (worktree intentionally skips).
  let expectedBranch: string | undefined;
  if (workspaceMode !== "worktree") {
    expectedBranch = readNonEmptyString(context, "branch");
    if (expectedBranch) {
      const actualBranch = readCurrentGitBranch(workingDirectoryForHarness);
      if (actualBranch !== expectedBranch) {
        throw new Error(
          `Run ${runId} harness branch mismatch at ${workingDirectoryForHarness}: expected ${expectedBranch}, got ${actualBranch || "<detached>"}`,
        );
      }
    }
  }

  return { workingDirectoryForHarness, expectedBranch };
}

/**
 * Read the harness_type from a run's context. Defaults to "pi" if the run
 * is not found or the context does not specify harness_type.
 */
export function getRunHarnessType(runId: string): HarnessType {
  const db = getDb();
  const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
  if (!row) return "pi";
  const ctx = safeParseRunContext(runId, row.context);
  if (ctx.harness_type === "hermes") return "hermes";
  return "pi";
}
