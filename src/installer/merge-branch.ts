import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
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
  parkedBranch?: string;
  parkedReason?: string;
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
      parkedBranch?: string;
      parkedReason?: string;
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
  /** @deprecated Checkout safety uses only the injected runGit dependency. */
  runGitWithIndex?: (origin: string, args: string[], indexPath: string) => GitResult;
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function gitFailureDiagnostic(result: GitResult, maxLength: number): string {
  const diagnostics = result.stderr || result.stdout;
  return boundedDiagnostic(
    `exit ${result.status}${diagnostics ? `: ${diagnostics}` : ""}`,
    maxLength,
  );
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

interface TargetWorktreeDiscovery {
  owner?: WorktreeMetadata;
  detail?: string;
}

function discoverTargetWorktree(
  origin: string,
  target: string,
  git: (origin: string, args: string[]) => GitResult,
): TargetWorktreeDiscovery {
  const listArgs = ["worktree", "list", "--porcelain", "-z"];
  const listResult = git(origin, listArgs);
  if (listResult.status !== 0) return { detail: boundedDiagnostic(commandError(listArgs, listResult)) };

  let worktrees: WorktreeMetadata[];
  try {
    worktrees = parseWorktreeMetadata(listResult.stdout);
  } catch (error) {
    return {
      detail: boundedDiagnostic(
        `invalid Git worktree metadata: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }

  const owners = worktrees.filter((worktree) => worktree.branch === target);
  if (owners.length > 1) {
    return {
      detail: boundedDiagnostic(
        `multiple worktrees own ${target}: ${owners.map((owner) => owner.path).join(", ")}`,
      ),
    };
  }
  const owner = owners[0];
  if (!owner) return {};
  return { owner };
}

const OWNER_OPERATION_SENTINELS = [
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
] as const;

interface OwnerSafety {
  clean: boolean;
}

function inspectOwnerSafety(
  owner: WorktreeMetadata,
  target: string,
  expectedTip: string,
  git: (origin: string, args: string[]) => GitResult,
): OwnerSafety | { detail: string } {
  if (owner.head !== expectedTip) {
    return {
      detail: boundedDiagnostic(
        `cannot land ${target}: owner ${owner.path} metadata HEAD ${owner.head ?? "missing"} disagrees with expected target tip ${expectedTip}`,
      ),
    };
  }

  for (const [sentinel, operation] of OWNER_OPERATION_SENTINELS) {
    const pathArgs = ["rev-parse", "--git-path", sentinel];
    const pathResult = git(owner.path, pathArgs);
    if (pathResult.status !== 0 || !pathResult.stdout) {
      return { detail: boundedDiagnostic(commandError(pathArgs, pathResult)) };
    }
    const sentinelPath = path.isAbsolute(pathResult.stdout)
      ? pathResult.stdout
      : path.resolve(owner.path, pathResult.stdout);
    if (existsSync(sentinelPath)) {
      return {
        detail: boundedDiagnostic(
          `cannot land ${target}: owner ${owner.path} has ${operation} operation in progress (${sentinel})`,
        ),
      };
    }
  }

  const headArgs = ["rev-parse", "--verify", "HEAD^{commit}"];
  const headResult = git(owner.path, headArgs);
  if (headResult.status !== 0 || !headResult.stdout) {
    return { detail: boundedDiagnostic(commandError(headArgs, headResult)) };
  }
  if (headResult.stdout !== expectedTip) {
    return {
      detail: boundedDiagnostic(
        `cannot land ${target}: owner ${owner.path} HEAD ${headResult.stdout} disagrees with expected target tip ${expectedTip}`,
      ),
    };
  }

  const statusArgs = ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=no"];
  const statusResult = git(owner.path, statusArgs);
  if (statusResult.status !== 0) {
    return { detail: boundedDiagnostic(commandError(statusArgs, statusResult)) };
  }
  return { clean: statusResult.stdout.length === 0 };
}

function boundedDiagnostic(detail: string, maxLength = 512): string {
  const normalized = detail.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function readTreeRefusalDiagnostic(result: GitResult): string {
  const raw = result.stderr || result.stdout || "Git refused checkout refresh";
  const paths = new Set<string>();
  for (const match of raw.matchAll(/['`]([^'`\r\n]+)['`]/g)) paths.add(match[1]!);

  const lines = raw.split(/\r?\n/);
  let collectingPathList = false;
  for (const line of lines) {
    if (/following .*files? would be (?:overwritten|removed)/i.test(line)) {
      collectingPathList = true;
      continue;
    }
    if (!collectingPathList) continue;
    if (/^\s+\S/.test(line)) paths.add(line.trim());
    else if (line.trim()) collectingPathList = false;
  }

  const pathSummary = paths.size > 0 ? `offending paths: ${[...paths].join(", ")}; ` : "";
  return boundedDiagnostic(`advance-refused: ${pathSummary}${raw}`);
}

function retryOnce(
  origin: string,
  args: string[],
  git: (origin: string, args: string[]) => GitResult,
): GitResult {
  const first = git(origin, args);
  return first.status === 0 ? first : git(origin, args);
}

function generateBackupName(targetBranch: string, runId: string): string {
  const timestamp = new Date().toISOString().replace(/[:-]/g, "").replace(/\..+/, "Z");
  const suffix = runId ? runId.slice(0, 8) : `manual-${randomBytes(3).toString("hex")}`;
  return `${targetBranch}-tamandua-parked-${timestamp}-${suffix}`;
}

/**
 * Structured reflog message for the target-advancing update-ref so parsers can
 * attribute a landing without special-casing (TATR facet 2). Run-scoped landings
 * carry the run id; genuinely runless manual merges carry the "(manual)" marker.
 */
function targetAdvanceReflogMessage(runId: string, mergedTree: string): string {
  return runId
    ? `tamandua: merge.landed run=${runId} tree=${mergedTree}`
    : `tamandua: merge.landed (manual) tree=${mergedTree}`;
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

  const targetArgs = ["rev-parse", "--verify", target];
  const targetResult = git(params.origin, targetArgs);
  if (targetResult.status !== 0) {
    return {
      status: "operational_error",
      exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
      detail: commandError(targetArgs, targetResult),
    };
  }
  const actualTip = targetResult.stdout;
  if (actualTip !== params.expectTip) {
    emit({ ...eventBase, event: "merge.target_moved", actualTip });
    return {
      status: "target_moved",
      exitCode: MERGE_BRANCH_EXIT_CODES.targetMoved,
      expectedTip: params.expectTip,
      actualTip,
      detail: `target ${target} moved: expected ${params.expectTip}, found ${actualTip}`,
    };
  }

  const targetWorktree = discoverTargetWorktree(params.origin, target, git);

  const branchArgs = ["rev-parse", "--verify", `${branchRef}^{commit}`];
  const branchResult = git(params.origin, branchArgs);
  if (branchResult.status !== 0) {
    return {
      status: "operational_error",
      exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
      detail: commandError(branchArgs, branchResult),
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
    let checkoutRefresh: CheckoutRefreshOutcome = "not-applicable";
    if (targetWorktree.owner?.head === actualTip) {
      const ownerHead = git(targetWorktree.owner.path, ["rev-parse", "--verify", "HEAD^{commit}"]);
      if (ownerHead.status === 0 && ownerHead.stdout === actualTip) {
        checkoutRefresh = "already-coherent";
      }
    }
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
  if (ancestorResult.status === 0) return noOpLanding();
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
    emit({ ...eventBase, event: "merge.conflicts", mergedTree });
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
  if (mergedTree === targetTree) return noOpLanding();

  if (targetWorktree.detail) {
    return {
      status: "operational_error",
      exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
      detail: targetWorktree.detail,
    };
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

  if (targetWorktree.owner) {
    const owner = targetWorktree.owner;
    const safety = inspectOwnerSafety(owner, target, params.expectTip, git);
    if ("detail" in safety) {
      return {
        status: "operational_error",
        exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
        detail: safety.detail,
      };
    }

    const backupName = generateBackupName(params.into, runId);
    const backupRef = `refs/heads/${backupName}`;
    const backupCreateArgs = ["update-ref", backupRef, params.expectTip, "0".repeat(40)];
    const backupCreateResult = git(params.origin, backupCreateArgs);
    if (backupCreateResult.status !== 0) {
      return {
        status: "operational_error",
        exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
        detail: boundedDiagnostic(
          `cannot park ${target}: cannot create backup ${backupRef}: ${commandError(backupCreateArgs, backupCreateResult)}`,
        ),
      };
    }

    const parkArgs = ["symbolic-ref", "HEAD", backupRef];
    const parkResult = git(owner.path, parkArgs);
    if (parkResult.status !== 0) {
      retryOnce(params.origin, ["update-ref", "-d", backupRef, params.expectTip], git);
      return {
        status: "operational_error",
        exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
        detail: boundedDiagnostic(`cannot park ${target}: ${commandError(parkArgs, parkResult)}`),
      };
    }

    const updateArgs = ["update-ref", "-m", targetAdvanceReflogMessage(runId, mergedTree), target, mergedCommit, params.expectTip];
    const updateResult = git(params.origin, updateArgs);
    if (updateResult.status !== 0) {
      let cleanupDetail: string | undefined;
      const unparkResult = retryOnce(owner.path, ["symbolic-ref", "HEAD", target], git);
      if (unparkResult.status === 0) {
        const cleanupArgs = ["update-ref", "-d", backupRef, params.expectTip];
        const cleanupResult = retryOnce(
          params.origin,
          cleanupArgs,
          git,
        );
        if (cleanupResult.status !== 0) {
          cleanupDetail = boundedDiagnostic(
            `stray backup ${backupRef} left after cleanup failed: ${commandError(cleanupArgs, cleanupResult)}`,
            256,
          );
        }
      } else {
        const recoveryCommand = `git -C ${shellQuote(owner.path)} symbolic-ref HEAD ${shellQuote(target)}`;
        cleanupDetail = boundedDiagnostic(
          `checkout remains parked on ${backupRef}; recover with: ${recoveryCommand}`,
          256,
        );
      }
      const updateError = commandError(updateArgs, updateResult);
      const updateDetail = cleanupDetail
        ? `${boundedDiagnostic(updateError, 253)}; ${cleanupDetail}`
        : updateError;
      const currentResult = git(params.origin, ["rev-parse", "--verify", target]);
      const movedTip = currentResult.status === 0 ? currentResult.stdout : undefined;
      if (movedTip === params.expectTip) {
        return {
          status: "operational_error",
          exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
          detail: updateDetail,
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
        detail: updateDetail,
      };
    }

    let checkoutRefresh: CheckoutRefreshOutcome;
    let parkedBranch: string | undefined;
    let parkedReason: string | undefined;
    if (safety.clean) {
      const refreshArgs = ["read-tree", "-m", "-u", targetTree, mergedTree];
      const refreshResult = git(owner.path, refreshArgs);
      if (refreshResult.status === 0) {
        const reattachResult = retryOnce(owner.path, ["symbolic-ref", "HEAD", target], git);
        if (reattachResult.status === 0) {
          const cleanupArgs = ["update-ref", "-d", backupRef, params.expectTip];
          const cleanupResult = retryOnce(params.origin, cleanupArgs, git);
          if (cleanupResult.status === 0) {
            checkoutRefresh = "refreshed";
          } else {
            const reparkResult = retryOnce(owner.path, ["symbolic-ref", "HEAD", backupRef], git);
            const rollbackRefreshResult = reparkResult.status === 0
              ? retryOnce(owner.path, ["read-tree", "-m", "-u", mergedTree, targetTree], git)
              : reparkResult;
            if (reparkResult.status === 0 && rollbackRefreshResult.status === 0) {
              parkedBranch = backupName;
              parkedReason = boundedDiagnostic(
                `advance-refused: backup cleanup failed: ${commandError(cleanupArgs, cleanupResult)}`,
              );
              checkoutRefresh = `parked:${backupName}`;
            } else {
              const recoveryAttachArgs = ["symbolic-ref", "HEAD", target];
              const recoveryAttachResult = retryOnce(owner.path, recoveryAttachArgs, git);
              const recoveryRefreshArgs = ["read-tree", "-m", "-u", targetTree, mergedTree];
              const recoveryRefreshResult = retryOnce(owner.path, recoveryRefreshArgs, git);
              if (recoveryAttachResult.status === 0 && recoveryRefreshResult.status === 0) {
                checkoutRefresh = "refreshed";
              } else {
                const rollbackFailure = reparkResult.status !== 0
                  ? `repark failed: ${gitFailureDiagnostic(reparkResult, 80)}`
                  : `content rollback failed: ${gitFailureDiagnostic(rollbackRefreshResult, 80)}`;
                const recoveryFailures = [
                  recoveryAttachResult.status !== 0
                    ? `target reattach failed: ${gitFailureDiagnostic(recoveryAttachResult, 80)}`
                    : undefined,
                  recoveryRefreshResult.status !== 0
                    ? `forward refresh failed: ${gitFailureDiagnostic(recoveryRefreshResult, 80)}`
                    : undefined,
                ].filter((detail): detail is string => detail !== undefined).join("; ");
                parkedBranch = backupName;
                parkedReason = boundedDiagnostic(
                  `parked-inconsistent: backup cleanup failed: ${gitFailureDiagnostic(cleanupResult, 80)}; ${rollbackFailure}; final recovery failed: ${recoveryFailures}`,
                );
                checkoutRefresh = `parked:${backupName}`;
              }
            }
          }
        } else {
          const rollbackRefreshArgs = ["read-tree", "-m", "-u", mergedTree, targetTree];
          const rollbackRefreshResult = retryOnce(owner.path, rollbackRefreshArgs, git);
          parkedBranch = backupName;
          parkedReason = rollbackRefreshResult.status === 0
            ? boundedDiagnostic(
              `advance-refused: ${commandError(["symbolic-ref", "HEAD", target], reattachResult)}`,
            )
            : boundedDiagnostic(
              `parked-inconsistent: reattach failed: ${gitFailureDiagnostic(reattachResult, 160)}; content rollback failed: ${gitFailureDiagnostic(rollbackRefreshResult, 160)}`,
            );
          checkoutRefresh = `parked:${backupName}`;
        }
      } else {
        parkedBranch = backupName;
        parkedReason = readTreeRefusalDiagnostic(refreshResult);
        checkoutRefresh = `parked:${backupName}`;
      }
    } else {
      parkedBranch = backupName;
      parkedReason = "local-changes";
      checkoutRefresh = `parked:${backupName}`;
    }

    const result: PlumbingMergeResult = {
      status: "landed",
      exitCode: MERGE_BRANCH_EXIT_CODES.landed,
      mergedCommit,
      mergedTree,
      target,
      noop: false,
      checkoutRefresh,
      ...(parkedBranch && parkedReason ? { parkedBranch, parkedReason } : {}),
    };
    emit({
      ...eventBase,
      event: "merge.landed",
      mergedTree,
      mergedCommit,
      noop: false,
      checkoutRefresh,
      ...(parkedBranch && parkedReason ? { parkedBranch, parkedReason } : {}),
    });
    return result;
  }

  const updateArgs = ["update-ref", "-m", targetAdvanceReflogMessage(runId, mergedTree), target, mergedCommit, params.expectTip];
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

  const result: PlumbingMergeResult = {
    status: "landed",
    exitCode: MERGE_BRANCH_EXIT_CODES.landed,
    mergedCommit,
    mergedTree,
    target,
    noop: false,
    checkoutRefresh: "not-applicable",
  };
  emit({
    ...eventBase,
    event: "merge.landed",
    mergedTree,
    mergedCommit,
    noop: false,
    checkoutRefresh: result.checkoutRefresh,
  });
  return result;
}
