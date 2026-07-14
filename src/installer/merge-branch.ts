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

function skippedRefresh(reason: string, result?: GitResult): CheckoutRefreshOutcome {
  const diagnostics = result ? result.stderr || result.stdout : "";
  const detail = diagnostics.replace(/\s+/g, " ").trim();
  const suffix = detail ? `:${detail}` : "";
  return `skipped:${reason}${suffix}`.slice(0, 512) as CheckoutRefreshOutcome;
}

function refreshCheckedOutTarget(
  origin: string,
  target: string,
  expectedTip: string,
  mergedTree: string,
  git: (origin: string, args: string[]) => GitResult,
): CheckoutRefreshOutcome {
  const bareResult = git(origin, ["rev-parse", "--is-bare-repository"]);
  if (bareResult.status !== 0) {
    return skippedRefresh("bare-detection-failed", bareResult);
  }
  if (bareResult.stdout === "true") {
    return "not-applicable";
  }
  if (bareResult.stdout !== "false") {
    return skippedRefresh("bare-detection-invalid", bareResult);
  }

  const headResult = git(origin, ["symbolic-ref", "-q", "HEAD"]);
  if (headResult.status === 1) {
    return "not-applicable";
  }
  if (headResult.status !== 0) {
    return skippedRefresh("head-detection-failed", headResult);
  }
  if (headResult.stdout !== target) {
    return "not-applicable";
  }

  const oldTreeResult = git(origin, ["rev-parse", "--verify", `${expectedTip}^{tree}`]);
  if (oldTreeResult.status !== 0 || !oldTreeResult.stdout) {
    return skippedRefresh("old-tree-resolution-failed", oldTreeResult);
  }

  const refreshResult = git(origin, ["read-tree", "-m", "-u", oldTreeResult.stdout, mergedTree]);
  if (refreshResult.status !== 0) {
    return skippedRefresh("refresh-failed", refreshResult);
  }
  return "refreshed";
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

  const checkoutRefresh = refreshCheckedOutTarget(
    params.origin,
    target,
    params.expectTip,
    mergedTree,
    git,
  );

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
