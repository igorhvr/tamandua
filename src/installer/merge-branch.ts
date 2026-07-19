import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
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
  runGitWithIndex?: (origin: string, args: string[], indexPath: string) => GitResult;
  emitEvent?: (event: MergeBranchEvent) => void;
}

function runGitWithIndex(origin: string, args: string[], indexPath: string): GitResult {
  const result = spawnSync("git", ["-C", origin, ...args], {
    encoding: "utf-8",
    env: { ...process.env, GIT_INDEX_FILE: indexPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status ?? -1,
  };
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

interface CheckoutSerialization {
  fd: number;
  indexPath: string;
  lockPath: string;
  device: number;
  inode: number;
}

type CheckoutSerializationResult =
  | { serialization: CheckoutSerialization }
  | { detail: string };

function acquireCheckoutSerialization(
  ownerPath: string,
  git: (origin: string, args: string[]) => GitResult,
): CheckoutSerializationResult {
  const indexArgs = ["rev-parse", "--path-format=absolute", "--git-path", "index"];
  const indexResult = git(ownerPath, indexArgs);
  if (indexResult.status !== 0 || !indexResult.stdout) {
    return { detail: `cannot resolve target worktree index: ${commandError(indexArgs, indexResult)}` };
  }

  const lockPath = `${indexResult.stdout}.lock`;
  let fd: number;
  try {
    const indexMode = fs.statSync(indexResult.stdout).mode & 0o777;
    fd = fs.openSync(lockPath, "wx", indexMode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return { detail: `cannot acquire target worktree index lock: ${lockPath} already exists` };
    }
    return {
      detail: `cannot acquire target worktree index lock ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let lockIdentity: { device: number; inode: number } | undefined;
  try {
    const stat = fs.fstatSync(fd);
    lockIdentity = { device: stat.dev, inode: stat.ino };
    fs.writeFileSync(fd, fs.readFileSync(indexResult.stdout));
    fs.fsyncSync(fd);
    return {
      serialization: {
        fd,
        indexPath: indexResult.stdout,
        lockPath,
        device: stat.dev,
        inode: stat.ino,
      },
    };
  } catch (error) {
    if (lockIdentity) {
      releaseCheckoutSerialization({
        fd,
        indexPath: indexResult.stdout,
        lockPath,
        ...lockIdentity,
      });
    } else {
      try {
        fs.closeSync(fd);
      } catch {
        // The acquisition error remains the actionable failure; without an
        // inode identity, leaving the path is safer than deleting a replacement.
      }
    }
    return {
      detail: `cannot identify target worktree index lock ownership: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function releaseCheckoutSerialization(serialization: CheckoutSerialization): string | undefined {
  const quarantinePath = `${serialization.lockPath}.tamandua-release-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(serialization.lockPath, quarantinePath);
    const stat = fs.lstatSync(quarantinePath);
    if (stat.dev !== serialization.device || stat.ino !== serialization.inode) {
      return `target worktree index lock ownership changed after atomic release; refusing to remove ${quarantinePath}`;
    }
    fs.unlinkSync(quarantinePath);
    return undefined;
  } catch (error) {
    return `cannot remove owned target worktree index lock ${serialization.lockPath}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    try {
      fs.closeSync(serialization.fd);
    } catch {
      // The path cleanup result above determines whether the lock was released.
    }
  }
}

function withTemporaryIndex(
  serialization: CheckoutSerialization,
  action: (temporaryIndexPath: string) => GitResult,
): GitResult {
  const temporaryIndexPath = `${serialization.indexPath}.tamandua-${process.pid}-${randomUUID()}`;
  try {
    fs.copyFileSync(serialization.indexPath, temporaryIndexPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporaryIndexPath, fs.statSync(serialization.indexPath).mode & 0o777);
    return action(temporaryIndexPath);
  } finally {
    for (const ownedPath of [temporaryIndexPath, `${temporaryIndexPath}.lock`]) {
      try {
        fs.unlinkSync(ownedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

interface ExactOwnerSnapshot {
  ownerPath?: string;
  ownerMetadataHead?: string;
  ownerRef?: string;
  targetTip?: string;
  head?: string;
  indexTree?: string;
  trackedFilesystemDifference?: string;
  ordinaryUntracked?: string;
  detail?: string;
}

interface ExactOwnerExpectation {
  label: "pre-CAS" | "post-CAS/pre-refresh" | "landed" | "already-restored" | "safely-reversible";
  ownerPath: string;
  target: string;
  tip: string;
  indexTree: string;
}

function inspectExactOwnerState(
  origin: string,
  target: string,
  expectedOwnerPath: string,
  git: (origin: string, args: string[]) => GitResult,
  serialization: CheckoutSerialization,
  indexedGit: (origin: string, args: string[], indexPath: string) => GitResult,
): ExactOwnerSnapshot {
  const snapshot: ExactOwnerSnapshot = {};
  const details: string[] = [];
  const recordFailure = (label: string, args: string[], result: GitResult): void => {
    details.push(boundedDiagnostic(`${label}: ${commandError(args, result)}`, 256));
  };

  const listArgs = ["worktree", "list", "--porcelain", "-z"];
  const listResult = git(origin, listArgs);
  if (listResult.status !== 0) {
    recordFailure("owner discovery failed", listArgs, listResult);
  } else {
    try {
      const owners = parseWorktreeMetadata(listResult.stdout).filter((worktree) => worktree.branch === target);
      if (owners.length === 1) {
        snapshot.ownerPath = owners[0]?.path;
        snapshot.ownerMetadataHead = owners[0]?.head;
      } else if (owners.length === 0) {
        details.push(`owner discovery found no worktree for ${target}`);
      } else {
        details.push(boundedDiagnostic(
          `owner discovery found multiple worktrees for ${target}: ${owners.map((owner) => owner.path).join(", ")}`,
          256,
        ));
      }
    } catch (error) {
      details.push(boundedDiagnostic(
        `owner discovery returned invalid metadata: ${error instanceof Error ? error.message : String(error)}`,
        256,
      ));
    }
  }

  const targetArgs = ["rev-parse", "--verify", target];
  const targetResult = git(origin, targetArgs);
  if (targetResult.status === 0 && targetResult.stdout) snapshot.targetTip = targetResult.stdout;
  else recordFailure("target tip inspection failed", targetArgs, targetResult);

  if (snapshot.ownerPath !== expectedOwnerPath) {
    details.push(`owner path is ${snapshot.ownerPath ?? "unowned"}, expected ${expectedOwnerPath}`);
  } else {
    const ownerChecks: Array<{
      field: "ownerRef" | "head";
      label: string;
      args: string[];
    }> = [
      { field: "ownerRef", label: "owner ref inspection failed", args: ["symbolic-ref", "-q", "HEAD"] },
      { field: "head", label: "owner HEAD inspection failed", args: ["rev-parse", "--verify", "HEAD"] },
    ];
    for (const check of ownerChecks) {
      const result = git(snapshot.ownerPath, check.args);
      if (result.status === 0 && result.stdout) snapshot[check.field] = result.stdout;
      else recordFailure(check.label, check.args, result);
    }

    const indexChecks: Array<{
      field: "indexTree" | "trackedFilesystemDifference" | "ordinaryUntracked";
      label: string;
      args: string[];
    }> = [
      { field: "indexTree", label: "index tree inspection failed", args: ["write-tree"] },
      {
        field: "trackedFilesystemDifference",
        label: "tracked filesystem inspection failed",
        args: ["diff-files", "--name-status", "--"],
      },
      {
        field: "ordinaryUntracked",
        label: "ordinary untracked inspection failed",
        args: ["ls-files", "--others", "--exclude-standard", "--"],
      },
    ];
    for (const check of indexChecks) {
      const result = withTemporaryIndex(
        serialization,
        (temporaryIndexPath) => indexedGit(snapshot.ownerPath!, check.args, temporaryIndexPath),
      );
      if (result.status === 0) snapshot[check.field] = boundedDiagnostic(result.stdout, 256);
      else recordFailure(check.label, check.args, result);
    }
  }

  if (details.length > 0) snapshot.detail = details.map((detail) => boundedDiagnostic(detail, 256)).join("; ");
  return snapshot;
}

function matchesExactOwnerState(
  snapshot: ExactOwnerSnapshot,
  expectation: ExactOwnerExpectation,
): { matches: boolean; detail: string } {
  const mismatches: string[] = [];
  if (snapshot.detail) mismatches.push(snapshot.detail);
  const expectedValues: Array<[string, string | undefined, string]> = [
    ["owner path", snapshot.ownerPath, expectation.ownerPath],
    ["owner metadata HEAD", snapshot.ownerMetadataHead, expectation.tip],
    ["owner ref", snapshot.ownerRef, expectation.target],
    ["target tip", snapshot.targetTip, expectation.tip],
    ["HEAD", snapshot.head, expectation.tip],
    ["index tree", snapshot.indexTree, expectation.indexTree],
    ["tracked filesystem difference", snapshot.trackedFilesystemDifference, ""],
    ["ordinary untracked paths", snapshot.ordinaryUntracked, ""],
  ];
  for (const [label, actual, expected] of expectedValues) {
    if (actual !== expected) {
      mismatches.push(`${label} is ${actual === undefined ? "unknown" : actual || "<empty>"}, expected ${expected || "<empty>"}`);
    }
  }
  return mismatches.length === 0
    ? { matches: true, detail: `${expectation.label} state verified` }
    : { matches: false, detail: boundedDiagnostic(`${expectation.label} state drifted: ${mismatches.join("; ")}`, 1024) };
}

function matchesPreCasOwnerState(snapshot: ExactOwnerSnapshot, expectation: Omit<ExactOwnerExpectation, "label">) {
  return matchesExactOwnerState(snapshot, { ...expectation, label: "pre-CAS" });
}

function matchesPostCasOwnerState(snapshot: ExactOwnerSnapshot, expectation: Omit<ExactOwnerExpectation, "label">) {
  return matchesExactOwnerState(snapshot, { ...expectation, label: "post-CAS/pre-refresh" });
}

function matchesLandedOwnerState(snapshot: ExactOwnerSnapshot, expectation: Omit<ExactOwnerExpectation, "label">) {
  return matchesExactOwnerState(snapshot, { ...expectation, label: "landed" });
}

function matchesAlreadyRestoredOwnerState(snapshot: ExactOwnerSnapshot, expectation: Omit<ExactOwnerExpectation, "label">) {
  return matchesExactOwnerState(snapshot, { ...expectation, label: "already-restored" });
}

function matchesSafelyReversibleOwnerState(snapshot: ExactOwnerSnapshot, expectation: Omit<ExactOwnerExpectation, "label">) {
  return matchesExactOwnerState(snapshot, { ...expectation, label: "safely-reversible" });
}

function serializedReadTree(
  ownerPath: string,
  oldTree: string,
  newTree: string,
  serialization: CheckoutSerialization,
  indexedGit: (origin: string, args: string[], indexPath: string) => GitResult,
): GitResult {
  return withTemporaryIndex(serialization, (temporaryIndexPath) => {
    const result = indexedGit(ownerPath, ["read-tree", "-m", "-u", oldTree, newTree], temporaryIndexPath);
    // A failed read-tree may have partially changed the filesystem. Do not
    // broadly reset it here: the guarded rollback path must first classify the
    // exact owner/index/filesystem state, and unknown drift may be operator
    // bytes that Tamandua is not entitled to rewrite.
    if (result.status !== 0) return result;
    fs.renameSync(temporaryIndexPath, serialization.indexPath);
    return result;
  });
}

type CheckoutRefreshResult =
  | { outcome: CheckoutRefreshOutcome }
  | { detail: string };

function refreshCheckedOutTarget(
  ownerPath: string | undefined,
  oldTree: string,
  mergedTree: string,
  serialization: CheckoutSerialization | undefined,
  indexedGit: (origin: string, args: string[], indexPath: string) => GitResult,
): CheckoutRefreshResult {
  if (!ownerPath) return { outcome: "not-applicable" };
  if (!serialization) return { detail: "target worktree checkout serialization is unavailable" };

  // The caller attested this exact old tree in the serialized transitional
  // snapshot. Re-resolving it after that final check would add an unnecessary
  // command boundary and weaken the connection between proof and mutation.
  const refreshArgs = ["read-tree", "-m", "-u", oldTree, mergedTree];
  const refreshResult = serializedReadTree(ownerPath, oldTree, mergedTree, serialization, indexedGit);
  if (refreshResult.status !== 0) {
    return { detail: boundedDiagnostic(commandError(refreshArgs, refreshResult)) };
  }
  return { outcome: "refreshed" };
}

const POST_CAS_DIAGNOSTIC_COMPONENT_LIMIT = 512;

function composePostCasFailure(
  refreshOrAttestation: string,
  refRollback: string,
  checkoutRestoration: string,
): string {
  // Bound each component before composition. A pathological Git diagnostic in
  // one phase must never hide the rollback/restoration outcome labels that an
  // operator needs to determine which state was preserved.
  const refreshDetail = boundedDiagnostic(refreshOrAttestation, POST_CAS_DIAGNOSTIC_COMPONENT_LIMIT);
  const rollbackDetail = boundedDiagnostic(refRollback, POST_CAS_DIAGNOSTIC_COMPONENT_LIMIT);
  const restorationDetail = boundedDiagnostic(checkoutRestoration, POST_CAS_DIAGNOSTIC_COMPONENT_LIMIT);
  return `checkout refresh: failed: ${refreshDetail}; ` +
    `ref rollback: ${rollbackDetail}; checkout restoration: ${restorationDetail}`;
}

function handlePostCasFailure(
  origin: string,
  ownerPath: string,
  target: string,
  expectedTip: string,
  targetTree: string,
  mergedCommit: string,
  mergedTree: string,
  refreshDetail: string,
  git: (origin: string, args: string[]) => GitResult,
  serialization: CheckoutSerialization,
  indexedGit: (origin: string, args: string[], indexPath: string) => GitResult,
): string {
  const rollbackArgs = ["update-ref", target, expectedTip, mergedCommit];
  const rollbackResult = git(origin, rollbackArgs);
  if (rollbackResult.status !== 0) {
    const currentResult = git(origin, ["rev-parse", "--verify", target]);
    const current = currentResult.status === 0 ? currentResult.stdout : "unavailable";
    return composePostCasFailure(
      refreshDetail,
      `failed: ${commandError(rollbackArgs, rollbackResult)}; current target: ${current}`,
      "not attempted because guarded ref rollback did not restore the expected tip",
    );
  }

  const recoverySnapshot = inspectExactOwnerState(origin, target, ownerPath, git, serialization, indexedGit);
  const recoveryExpectation = { ownerPath, target, tip: expectedTip, indexTree: targetTree };
  const alreadyRestored = matchesAlreadyRestoredOwnerState(recoverySnapshot, recoveryExpectation);
  if (alreadyRestored.matches) {
    return composePostCasFailure(
      refreshDetail,
      "restored",
      "restored (checkout already matched the old tree)",
    );
  }

  const safelyReversible = matchesSafelyReversibleOwnerState(
    recoverySnapshot,
    { ownerPath, target, tip: expectedTip, indexTree: mergedTree },
  );
  if (!safelyReversible.matches) {
    return composePostCasFailure(
      refreshDetail,
      "restored",
      `not attempted because state drifted: ${safelyReversible.detail}; ` +
        `already-restored check: ${alreadyRestored.detail}`,
    );
  }

  // Classification authorizes a possible restoration, but it is not the final
  // mutation guard. Re-discover and re-attest the same exact owner state at the
  // reverse boundary while the original Git index lock remains continuously
  // held. The lock prevents normal Git index/checkout commands from crossing
  // the remaining validation-to-read-tree command boundary.
  const finalSafelyReversible = matchesSafelyReversibleOwnerState(
    inspectExactOwnerState(origin, target, ownerPath, git, serialization, indexedGit),
    { ownerPath, target, tip: expectedTip, indexTree: mergedTree },
  );
  if (!finalSafelyReversible.matches) {
    return composePostCasFailure(
      refreshDetail,
      "restored",
      `not attempted because state drifted before reverse mutation: ${finalSafelyReversible.detail}`,
    );
  }

  const restoreArgs = ["read-tree", "-m", "-u", mergedTree, targetTree];
  const restoreResult = serializedReadTree(ownerPath, mergedTree, targetTree, serialization, indexedGit);
  if (restoreResult.status !== 0) {
    return composePostCasFailure(
      refreshDetail,
      "restored",
      `failed: ${commandError(restoreArgs, restoreResult)}; pre-restore state: ${finalSafelyReversible.detail}`,
    );
  }

  const afterRestore = matchesAlreadyRestoredOwnerState(
    inspectExactOwnerState(origin, target, ownerPath, git, serialization, indexedGit),
    recoveryExpectation,
  );
  if (!afterRestore.matches) {
    return composePostCasFailure(
      refreshDetail,
      "restored",
      `failed verification: ${afterRestore.detail}`,
    );
  }
  return composePostCasFailure(refreshDetail, "restored", "restored and verified");
}

export function runPlumbingMerge(
  params: PlumbingMergeParams,
  dependencies: PlumbingMergeDependencies = {},
): PlumbingMergeResult {
  const git = dependencies.runGit ?? runGit;
  const indexedGit = dependencies.runGitWithIndex ?? runGitWithIndex;
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
    let checkoutRefresh: CheckoutRefreshOutcome = "not-applicable";
    if (targetWorktree.ownerPath) {
      const acquisition = acquireCheckoutSerialization(targetWorktree.ownerPath, git);
      if ("detail" in acquisition) {
        return {
          status: "operational_error",
          exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
          detail: boundedDiagnostic(acquisition.detail),
        };
      }

      let ownerState: { matches: boolean; detail: string };
      try {
        ownerState = matchesPreCasOwnerState(
          inspectExactOwnerState(
            params.origin,
            target,
            targetWorktree.ownerPath,
            git,
            acquisition.serialization,
            indexedGit,
          ),
          { ownerPath: targetWorktree.ownerPath, target, tip: actualTip, indexTree: targetTree },
        );
      } catch (error) {
        releaseCheckoutSerialization(acquisition.serialization);
        throw error;
      }
      const releaseDetail = releaseCheckoutSerialization(acquisition.serialization);
      if (!ownerState.matches || releaseDetail) {
        return {
          status: "operational_error",
          exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
          detail: boundedDiagnostic([ownerState.matches ? undefined : ownerState.detail, releaseDetail].filter(Boolean).join("; ")),
        };
      }
      checkoutRefresh = "already-coherent";
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

  let serialization: CheckoutSerialization | undefined;
  if (targetWorktree.ownerPath) {
    const acquisition = acquireCheckoutSerialization(targetWorktree.ownerPath, git);
    if ("detail" in acquisition) {
      return {
        status: "operational_error",
        exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
        detail: boundedDiagnostic(acquisition.detail),
      };
    }
    serialization = acquisition.serialization;

    let lockedOwnerState: { matches: boolean; detail: string };
    try {
      const lockedOwnerSnapshot = inspectExactOwnerState(
        params.origin,
        target,
        targetWorktree.ownerPath,
        git,
        serialization,
        indexedGit,
      );
      lockedOwnerState = matchesPreCasOwnerState(
        lockedOwnerSnapshot,
        { ownerPath: targetWorktree.ownerPath, target, tip: params.expectTip, indexTree: targetTree },
      );
    } catch (error) {
      releaseCheckoutSerialization(serialization);
      throw error;
    }
    if (!lockedOwnerState.matches) {
      const releaseDetail = releaseCheckoutSerialization(serialization);
      return {
        status: "operational_error",
        exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
        detail: boundedDiagnostic(
          [lockedOwnerState.detail, releaseDetail].filter(Boolean).join("; "),
        ),
      };
    }
  }

  let mergedCommit = "";
  let lockedFailure: PlumbingMergeResult | undefined;
  let releaseFailure: string | undefined;
  let commitPhaseCompleted = false;
  try {
    const commitArgs = ["commit-tree", mergedTree, "-p", params.expectTip, "-m", params.message];
    const commitResult = git(params.origin, commitArgs);
    mergedCommit = commitResult.stdout.split(/\r?\n/, 1)[0]?.trim();
    if (commitResult.status !== 0 || !mergedCommit) {
      lockedFailure = {
        status: "operational_error",
        exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
        detail: commandError(commitArgs, commitResult),
      };
    } else {
      if (targetWorktree.ownerPath && serialization) {
        const immediatePreCasState = matchesPreCasOwnerState(
          inspectExactOwnerState(
            params.origin,
            target,
            targetWorktree.ownerPath,
            git,
            serialization,
            indexedGit,
          ),
          { ownerPath: targetWorktree.ownerPath, target, tip: params.expectTip, indexTree: targetTree },
        );
        if (!immediatePreCasState.matches) {
          lockedFailure = {
            status: "operational_error",
            exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
            detail: immediatePreCasState.detail,
          };
        }
      }

      if (!lockedFailure) {
        const updateArgs = ["update-ref", target, mergedCommit, params.expectTip];
        const updateResult = git(params.origin, updateArgs);
        if (updateResult.status !== 0) {
          const currentResult = git(params.origin, ["rev-parse", "--verify", target]);
          const movedTip = currentResult.status === 0 ? currentResult.stdout : undefined;
          if (movedTip === params.expectTip) {
            lockedFailure = {
              status: "operational_error",
              exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
              detail: commandError(updateArgs, updateResult),
            };
          } else {
            emit({
              ...eventBase,
              event: "merge.target_moved",
              actualTip: movedTip,
              mergedTree,
              mergedCommit,
            });
            lockedFailure = {
              status: "target_moved",
              exitCode: MERGE_BRANCH_EXIT_CODES.targetMoved,
              expectedTip: params.expectTip,
              actualTip: movedTip,
              mergedTree,
              mergedCommit,
              detail: commandError(updateArgs, updateResult),
            };
          }
        }
      }
    }
    commitPhaseCompleted = true;
  } finally {
    if (serialization && (!commitPhaseCompleted || lockedFailure)) {
      releaseFailure = releaseCheckoutSerialization(serialization);
    }
  }

  if (releaseFailure) {
    return {
      status: "operational_error",
      exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
      detail: boundedDiagnostic(releaseFailure),
    };
  }
  if (lockedFailure) return lockedFailure;

  let finalResult: PlumbingMergeResult;
  try {
    let checkoutRefreshResult: CheckoutRefreshResult;
    if (targetWorktree.ownerPath && serialization) {
      const transitionalState = matchesPostCasOwnerState(
        inspectExactOwnerState(
          params.origin,
          target,
          targetWorktree.ownerPath,
          git,
          serialization,
          indexedGit,
        ),
        { ownerPath: targetWorktree.ownerPath, target, tip: mergedCommit, indexTree: targetTree },
      );
      checkoutRefreshResult = transitionalState.matches
        ? refreshCheckedOutTarget(
          targetWorktree.ownerPath,
          targetTree,
          mergedTree,
          serialization,
          indexedGit,
        )
        : { detail: transitionalState.detail };
    } else {
      checkoutRefreshResult = refreshCheckedOutTarget(
        targetWorktree.ownerPath,
        targetTree,
        mergedTree,
        serialization,
        indexedGit,
      );
    }
    if ("detail" in checkoutRefreshResult) {
      if (!targetWorktree.ownerPath || !serialization) {
        finalResult = {
          status: "operational_error",
          exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
          detail: `checkout refresh failed without target worktree serialization: ${checkoutRefreshResult.detail}`,
        };
      } else {
        const checkoutSerialization = serialization;
        finalResult = {
          status: "operational_error",
          exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
          detail: handlePostCasFailure(
            params.origin,
            targetWorktree.ownerPath,
            target,
            params.expectTip,
            targetTree,
            mergedCommit,
            mergedTree,
            checkoutRefreshResult.detail,
            git,
            checkoutSerialization,
            indexedGit,
          ),
        };
      }
    } else if (targetWorktree.ownerPath && serialization) {
      const landedState = matchesLandedOwnerState(
        inspectExactOwnerState(
          params.origin,
          target,
          targetWorktree.ownerPath,
          git,
          serialization,
          indexedGit,
        ),
        { ownerPath: targetWorktree.ownerPath, target, tip: mergedCommit, indexTree: mergedTree },
      );
      if (!landedState.matches) {
        finalResult = {
          status: "operational_error",
          exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
          detail: handlePostCasFailure(
            params.origin,
            targetWorktree.ownerPath,
            target,
            params.expectTip,
            targetTree,
            mergedCommit,
            mergedTree,
            `landed-state attestation failed: ${landedState.detail}`,
            git,
            serialization,
            indexedGit,
          ),
        };
      } else {
        finalResult = {
          status: "landed",
          exitCode: MERGE_BRANCH_EXIT_CODES.landed,
          mergedCommit,
          mergedTree,
          target,
          noop: false,
          checkoutRefresh: checkoutRefreshResult.outcome,
        };
      }
    } else {
      finalResult = {
        status: "landed",
        exitCode: MERGE_BRANCH_EXIT_CODES.landed,
        mergedCommit,
        mergedTree,
        target,
        noop: false,
        checkoutRefresh: checkoutRefreshResult.outcome,
      };
    }
  } catch (error) {
    if (serialization) releaseCheckoutSerialization(serialization);
    throw error;
  }

  if (serialization) releaseFailure = releaseCheckoutSerialization(serialization);
  if (releaseFailure) {
    return {
      status: "operational_error",
      exitCode: MERGE_BRANCH_EXIT_CODES.operationalError,
      detail: boundedDiagnostic(releaseFailure),
    };
  }
  if (finalResult.status === "landed") {
    emit({
      ...eventBase,
      event: "merge.landed",
      mergedTree,
      mergedCommit,
      noop: false,
      checkoutRefresh: finalResult.checkoutRefresh,
    });
  }
  return finalResult;
}
