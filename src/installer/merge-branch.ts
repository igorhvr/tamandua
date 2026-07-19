import { spawnSync } from "node:child_process";
import {
  emitEvent as emitTamanduaEvent,
  type CheckoutRefreshOutcome,
  type TamanduaEvent,
} from "./events.js";

export const MERGE_BRANCH_EXIT_CODES = {
  landed: 0,
  operationalError: 1,
  targetMoved: 2,
  conflicts: 3,
} as const;

export interface PlumbingMergeParams {
  origin: string;
  branch: string;
  into: string;
  expectTip: string;
  message: string;
  runId?: string;
}

export interface MergeBranchEvent extends TamanduaEvent {
  event: "merge.landed" | "merge.target_moved" | "merge.conflicts";
  origin: string;
  branch: string;
  target: string;
  expectedTip: string;
  actualTip?: string;
  mergedTree?: string;
  mergedCommit?: string;
  noop?: boolean;
}

export type PlumbingMergeResult =
  | {
      status: "landed";
      exitCode: typeof MERGE_BRANCH_EXIT_CODES.landed;
      mergedCommit: string;
      mergedTree: string;
      target: string;
      noop: boolean;
      checkoutRefresh: CheckoutRefreshOutcome;
    }
  | {
      status: "target_moved";
      exitCode: typeof MERGE_BRANCH_EXIT_CODES.targetMoved;
      expectedTip: string;
      actualTip?: string;
      mergedTree?: string;
      mergedCommit?: string;
      detail: string;
    }
  | {
      status: "conflicts";
      exitCode: typeof MERGE_BRANCH_EXIT_CODES.conflicts;
      conflicts: string;
      mergedTree?: string;
    }
  | {
      status: "operational_error";
      exitCode: typeof MERGE_BRANCH_EXIT_CODES.operationalError;
      detail: string;
    };

interface GitResult {
  stdout: string;
  stderr: string;
  status: number;
}

export interface PlumbingMergeDependencies {
  runGit?: (origin: string, args: string[]) => GitResult;
  emitEvent?: (event: MergeBranchEvent) => void;
}

function runGit(origin: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-C", origin, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status ?? -1,
  };
}

function commandError(args: string[], result: GitResult): string {
  const diagnostics = result.stderr || result.stdout;
  return `git ${args.join(" ")} failed (exit ${result.status})${diagnostics ? `: ${diagnostics}` : ""}`;
}

interface WorktreeMetadata {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
}

function parseWorktreeMetadata(output: string): WorktreeMetadata[] {
  const records: WorktreeMetadata[] = [];
  let fields = new Map<string, string>();

  const finishRecord = (): void => {
    if (fields.size === 0) return;
    const worktreePath = fields.get("worktree");
    const isBare = fields.has("bare");
    const isDetached = fields.has("detached");
    const head = fields.get("HEAD");
    const branch = fields.get("branch");
    if (!worktreePath) throw new Error("record has no worktree path");
    if (isBare) {
      if (head || branch || isDetached) throw new Error(`bare record for ${worktreePath} has checkout fields`);
    } else {
      if (!head || !/^[0-9a-f]{40,64}$/.test(head)) throw new Error(`record for ${worktreePath} has no valid HEAD`);
      if ((branch ? 1 : 0) + (isDetached ? 1 : 0) !== 1) {
        throw new Error(`record for ${worktreePath} has ambiguous HEAD attachment`);
      }
    }
    records.push({ path: worktreePath, head, branch, bare: isBare });
    fields = new Map<string, string>();
  };

  for (const field of output.split("\0")) {
    if (field === "") {
      finishRecord();
      continue;
    }
    const separator = field.indexOf(" ");
    const key = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? "" : field.slice(separator + 1);
    if (!["worktree", "HEAD", "branch", "bare", "detached", "locked", "prunable"].includes(key)) {
      throw new Error(`unsupported field ${key}`);
    }
    if (fields.has(key)) throw new Error(`duplicate field ${key}`);
    if (["worktree", "HEAD", "branch"].includes(key) && !value) throw new Error(`field ${key} has no value`);
    fields.set(key, value);
  }
  finishRecord();
  if (records.length === 0) throw new Error("no worktree records");
  return records;
}

function preflightTargetWorktree(
  origin: string,
  target: string,
  expectedTip: string,
  git: (origin: string, args: string[]) => GitResult,
): { ownerPath?: string; detail?: string } {
  const listArgs = ["worktree", "list", "--porcelain", "-z"];
  const listResult = git(origin, listArgs);
  if (listResult.status !== 0) return { detail: commandError(listArgs, listResult) };

  let worktrees: WorktreeMetadata[];
  try {
    worktrees = parseWorktreeMetadata(listResult.stdout);
  } catch (error) {
    return { detail: `invalid Git worktree metadata: ${error instanceof Error ? error.message : String(error)}` };
  }

  const owners = worktrees.filter((worktree) => worktree.branch === target);
  if (owners.length > 1) {
    return { detail: `multiple worktrees own ${target}: ${owners.map((owner) => owner.path).join(", ")}` };
  }
  const owner = owners[0];
  if (!owner) return {};
  if (owner.head !== expectedTip) {
    return { detail: `target worktree ${owner.path} metadata is at ${owner.head ?? "unknown"}, expected ${expectedTip}` };
  }

  const symbolicArgs = ["symbolic-ref", "-q", "HEAD"];
  const symbolicResult = git(owner.path, symbolicArgs);
  if (symbolicResult.status !== 0) {
    return { detail: `target worktree ${owner.path} is not accessible on ${target}: ${commandError(symbolicArgs, symbolicResult)}` };
  }
  if (symbolicResult.stdout !== target) {
    return { detail: `target worktree ${owner.path} is on ${symbolicResult.stdout || "an unknown ref"}, expected ${target}` };
  }

  const headArgs = ["rev-parse", "--verify", "HEAD"];
  const headResult = git(owner.path, headArgs);
  if (headResult.status !== 0) {
    return { detail: `cannot verify target worktree ${owner.path} HEAD: ${commandError(headArgs, headResult)}` };
  }
  if (headResult.stdout !== expectedTip) {
    return { detail: `target worktree ${owner.path} is at ${headResult.stdout || "unknown"}, expected ${expectedTip}` };
  }

  const statusArgs = ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"];
  const statusResult = git(owner.path, statusArgs);
  if (statusResult.status !== 0) {
    return { detail: `cannot inspect target worktree ${owner.path}: ${commandError(statusArgs, statusResult)}` };
  }
  if (statusResult.stdout !== "") {
    const summary = statusResult.stdout.replace(/\s+/g, " ").slice(0, 256);
    return { detail: `target worktree ${owner.path} is not clean: ${summary}` };
  }
  return { ownerPath: owner.path };
}

function boundedDiagnostic(detail: string, maxLength = 512): string {
  const normalized = detail.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

type CheckoutRefreshResult =
  | { outcome: CheckoutRefreshOutcome }
  | { detail: string };

function refreshCheckedOutTarget(
  ownerPath: string | undefined,
  expectedTip: string,
  mergedTree: string,
  git: (origin: string, args: string[]) => GitResult,
): CheckoutRefreshResult {
  if (!ownerPath) return { outcome: "not-applicable" };

  const oldTreeResult = git(ownerPath, ["rev-parse", "--verify", `${expectedTip}^{tree}`]);
  if (oldTreeResult.status !== 0 || !oldTreeResult.stdout) {
    return {
      detail: boundedDiagnostic(`old tree resolution failed: ${commandError(["rev-parse", "--verify", `${expectedTip}^{tree}`], oldTreeResult)}`),
    };
  }

  const refreshArgs = ["read-tree", "-m", "-u", oldTreeResult.stdout, mergedTree];
  const refreshResult = git(ownerPath, refreshArgs);
  if (refreshResult.status !== 0) {
    return { detail: boundedDiagnostic(commandError(refreshArgs, refreshResult)) };
  }
  return { outcome: "refreshed" };
}

function checkoutMatchesExpectedState(
  ownerPath: string,
  target: string,
  expectedTip: string,
  expectedTree: string,
  git: (origin: string, args: string[]) => GitResult,
): { matches: boolean; detail: string } {
  const checks: Array<{ label: string; args: string[]; expected: string }> = [
    { label: "branch", args: ["symbolic-ref", "-q", "HEAD"], expected: target },
    { label: "HEAD", args: ["rev-parse", "--verify", "HEAD"], expected: expectedTip },
    { label: "index", args: ["write-tree"], expected: expectedTree },
    { label: "status", args: ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"], expected: "" },
  ];
  for (const check of checks) {
    const result = git(ownerPath, check.args);
    if (result.status !== 0) {
      return { matches: false, detail: `${check.label} check failed: ${commandError(check.args, result)}` };
    }
    if (result.stdout !== check.expected) {
      const actual = result.stdout || "<empty>";
      return { matches: false, detail: `${check.label} is ${actual}, expected ${check.expected || "<empty>"}` };
    }
  }
  return { matches: true, detail: "verified" };
}

function rollbackFailedRefresh(
  origin: string,
  ownerPath: string,
  target: string,
  expectedTip: string,
  targetTree: string,
  mergedCommit: string,
  mergedTree: string,
  refreshDetail: string,
  git: (origin: string, args: string[]) => GitResult,
): string {
  const rollbackArgs = ["update-ref", target, expectedTip, mergedCommit];
  const rollbackResult = git(origin, rollbackArgs);
  if (rollbackResult.status !== 0) {
    const currentResult = git(origin, ["rev-parse", "--verify", target]);
    const current = currentResult.status === 0 ? currentResult.stdout : "unavailable";
    return boundedDiagnostic(
      `checkout refresh: failed: ${refreshDetail}; ` +
      `ref rollback: failed: ${commandError(rollbackArgs, rollbackResult)}; current target: ${current}; ` +
      "checkout restoration: not attempted because guarded ref rollback did not restore the expected tip",
      1536,
    );
  }

  const beforeRestore = checkoutMatchesExpectedState(ownerPath, target, expectedTip, targetTree, git);
  if (beforeRestore.matches) {
    return boundedDiagnostic(
      `checkout refresh: failed: ${refreshDetail}; ref rollback: restored; checkout restoration: restored (checkout already matched the old tree)`,
      1536,
    );
  }

  const restoreArgs = ["read-tree", "-m", "-u", mergedTree, targetTree];
  const restoreResult = git(ownerPath, restoreArgs);
  if (restoreResult.status !== 0) {
    return boundedDiagnostic(
      `checkout refresh: failed: ${refreshDetail}; ref rollback: restored; ` +
      `checkout restoration: failed: ${commandError(restoreArgs, restoreResult)}; pre-restore state: ${beforeRestore.detail}`,
      1536,
    );
  }

  const afterRestore = checkoutMatchesExpectedState(ownerPath, target, expectedTip, targetTree, git);
  if (!afterRestore.matches) {
    return boundedDiagnostic(
      `checkout refresh: failed: ${refreshDetail}; ref rollback: restored; ` +
      `checkout restoration: failed verification: ${afterRestore.detail}`,
      1536,
    );
  }
  return boundedDiagnostic(
    `checkout refresh: failed: ${refreshDetail}; ref rollback: restored; checkout restoration: restored and verified`,
    1536,
  );
}

export function runPlumbingMerge(
  params: PlumbingMergeParams,
  dependencies: PlumbingMergeDependencies = {},
): PlumbingMergeResult {
  const git = dependencies.runGit ?? runGit;
  const emit = dependencies.emitEvent ?? emitTamanduaEvent;
  const target = `refs/heads/${params.into}`;
  const branchRef = `refs/heads/${params.branch}`;
  const runId = params.runId ?? process.env.TAMANDUA_RUN_ID ?? "";
  const eventBase = {
    ts: new Date().toISOString(),
    runId,
    origin: params.origin,
    branch: params.branch,
    target,
    expectedTip: params.expectTip,
  };

  const targetResult = git(params.origin, ["rev-parse", "--verify", target]);
  if (targetResult.status !== 0) {
    return {
      status: "operational_error",
      exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
      detail: commandError(["rev-parse", "--verify", target], targetResult),
    };
  }
  const actualTip = targetResult.stdout;
  if (actualTip !== params.expectTip) {
    emit({
      ...eventBase,
      event: "merge.target_moved",
      actualTip,
    });
    return {
      status: "target_moved",
      exitCode: MERGE_BRANCH_EXIT_CODES.targetMoved,
      expectedTip: params.expectTip,
      actualTip,
      detail: `target ${target} moved: expected ${params.expectTip}, found ${actualTip}`,
    };
  }

  const targetWorktree = preflightTargetWorktree(params.origin, target, params.expectTip, git);
  if (targetWorktree.detail) {
    return {
      status: "operational_error",
      exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
      detail: targetWorktree.detail,
    };
  }

  const branchResult = git(params.origin, ["rev-parse", "--verify", `${branchRef}^{commit}`]);
  if (branchResult.status !== 0) {
    return {
      status: "operational_error",
      exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
      detail: commandError(["rev-parse", "--verify", `${branchRef}^{commit}`], branchResult),
    };
  }

  const targetTreeArgs = ["rev-parse", "--verify", `${target}^{tree}`];
  const targetTreeResult = git(params.origin, targetTreeArgs);
  if (targetTreeResult.status !== 0 || !targetTreeResult.stdout) {
    return {
      status: "operational_error",
      exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
      detail: commandError(targetTreeArgs, targetTreeResult),
    };
  }
  const targetTree = targetTreeResult.stdout;

  const noOpLanding = (): PlumbingMergeResult => {
    const checkoutRefresh = "not-applicable";
    emit({
      ...eventBase,
      event: "merge.landed",
      mergedTree: targetTree,
      mergedCommit: actualTip,
      noop: true,
      checkoutRefresh,
    });
    return {
      status: "landed",
      exitCode: MERGE_BRANCH_EXIT_CODES.landed,
      mergedCommit: actualTip,
      mergedTree: targetTree,
      target,
      noop: true,
      checkoutRefresh,
    };
  };

  const ancestorArgs = ["merge-base", "--is-ancestor", branchResult.stdout, actualTip];
  const ancestorResult = git(params.origin, ancestorArgs);
  if (ancestorResult.status === 0) {
    return noOpLanding();
  }
  if (ancestorResult.status !== 1) {
    return {
      status: "operational_error",
      exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
      detail: commandError(ancestorArgs, ancestorResult),
    };
  }

  const mergeArgs = ["merge-tree", "--write-tree", params.expectTip, branchRef];
  const mergeResult = git(params.origin, mergeArgs);
  const mergedTree = mergeResult.stdout.split(/\r?\n/, 1)[0]?.trim() || undefined;
  if (mergeResult.status === 1) {
    const conflicts = [mergeResult.stdout, mergeResult.stderr].filter(Boolean).join("\n");
    emit({
      ...eventBase,
      event: "merge.conflicts",
      mergedTree,
    });
    return {
      status: "conflicts",
      exitCode: MERGE_BRANCH_EXIT_CODES.conflicts,
      conflicts,
      mergedTree,
    };
  }
  if (mergeResult.status !== 0 || !mergedTree) {
    return {
      status: "operational_error",
      exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
      detail: commandError(mergeArgs, mergeResult),
    };
  }

  if (mergedTree === targetTree) {
    return noOpLanding();
  }

  const commitArgs = ["commit-tree", mergedTree, "-p", params.expectTip, "-m", params.message];
  const commitResult = git(params.origin, commitArgs);
  const mergedCommit = commitResult.stdout.split(/\r?\n/, 1)[0]?.trim();
  if (commitResult.status !== 0 || !mergedCommit) {
    return {
      status: "operational_error",
      exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
      detail: commandError(commitArgs, commitResult),
    };
  }

  const updateArgs = ["update-ref", target, mergedCommit, params.expectTip];
  const updateResult = git(params.origin, updateArgs);
  if (updateResult.status !== 0) {
    const currentResult = git(params.origin, ["rev-parse", "--verify", target]);
    const movedTip = currentResult.status === 0 ? currentResult.stdout : undefined;
    if (movedTip === params.expectTip) {
      return {
        status: "operational_error",
        exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
        detail: commandError(updateArgs, updateResult),
      };
    }
    emit({
      ...eventBase,
      event: "merge.target_moved",
      actualTip: movedTip,
      mergedTree,
      mergedCommit,
    });
    return {
      status: "target_moved",
      exitCode: MERGE_BRANCH_EXIT_CODES.targetMoved,
      expectedTip: params.expectTip,
      actualTip: movedTip,
      mergedTree,
      mergedCommit,
      detail: commandError(updateArgs, updateResult),
    };
  }

  const checkoutRefreshResult = refreshCheckedOutTarget(
    targetWorktree.ownerPath,
    params.expectTip,
    mergedTree,
    git,
  );
  if ("detail" in checkoutRefreshResult) {
    if (!targetWorktree.ownerPath) {
      return {
        status: "operational_error",
        exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
        detail: `checkout refresh failed without a target worktree: ${checkoutRefreshResult.detail}`,
      };
    }
    return {
      status: "operational_error",
      exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
      detail: rollbackFailedRefresh(
        params.origin,
        targetWorktree.ownerPath,
        target,
        params.expectTip,
        targetTree,
        mergedCommit,
        mergedTree,
        checkoutRefreshResult.detail,
        git,
      ),
    };
  }
  const checkoutRefresh = checkoutRefreshResult.outcome;

  emit({
    ...eventBase,
    event: "merge.landed",
    mergedTree,
    mergedCommit,
    noop: false,
    checkoutRefresh,
  });
  return {
    status: "landed",
    exitCode: MERGE_BRANCH_EXIT_CODES.landed,
    mergedCommit,
    mergedTree,
    target,
    noop: false,
    checkoutRefresh,
  };
}
