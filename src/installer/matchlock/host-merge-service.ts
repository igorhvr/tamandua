/**
 * Production host merge authorization/receipt service (US-007).
 *
 * See host-merge-services.ts for the contract and the executable-Git boundary.
 * This module is HOST-ONLY (never shipped in the portable RO guest pack): it
 * imports node:path + the host merge types, and the host injects the narrow
 * target-tip reader + native event sink.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { HostBinding, HostClaim } from "./broker-services.js";
import type {
  MergeAuthorization,
  MergeAuthorizeRequest,
  MergeReportAck,
  MergeReportRequest,
  MergeReportStatus,
} from "./guest-protocol.js";
import { MERGE_REPORT_STATUSES } from "./guest-protocol.js";
import type { MergeCoreEvent } from "./merge-core.js";
import type {
  HostMergeContext,
  HostMergeServiceDeps,
  HostMergeServices,
  MergeAuthorizeOutcome,
  MergeReportOutcome,
} from "./host-merge-services.js";

const MERGE_TIP_RE = /^[0-9a-f]{40,64}$/;
const MAX_AUTHORIZATIONS = 64;

/** Required status/exit-code consistency for a reported merge outcome. */
const REQUIRED_EXIT: Record<MergeReportStatus, number> = {
  landed: 0,
  target_moved: 2,
  conflicts: 3,
  operational_error: 1,
};

interface StoredAuthorization {
  authorization: MergeAuthorization;
  invocationId: string;
  claimId: string;
  fingerprint: string;
  /** Set once an accepted report has been recorded (idempotent replay). */
  consumed?: { identity: string; ack: MergeReportAck };
}

/** True when `candidate` is inside `root` (or equal to it), lexically. */
export function isInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const rel = path.relative(resolvedRoot, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function reportIdentity(report: MergeReportRequest): string {
  return JSON.stringify([
    report.authorizationId,
    report.status,
    report.exitCode,
    report.mergedTree ?? "",
    report.mergedCommit ?? "",
    report.noop ?? null,
    report.checkoutRefresh ?? "",
    report.parkedBranch ?? "",
    report.parkedReason ?? "",
    report.expectedTip ?? "",
    report.actualTip ?? "",
    report.detail ?? "",
    report.conflicts ?? "",
  ]);
}

function ackFor(report: MergeReportRequest): MergeReportAck {
  return {
    status: report.status,
    exitCode: report.exitCode,
    ...(report.mergedTree !== undefined ? { mergedTree: report.mergedTree } : {}),
    ...(report.mergedCommit !== undefined ? { mergedCommit: report.mergedCommit } : {}),
    ...(report.noop !== undefined ? { noop: report.noop } : {}),
    ...(report.checkoutRefresh !== undefined ? { checkoutRefresh: report.checkoutRefresh } : {}),
    ...(report.parkedBranch !== undefined ? { parkedBranch: report.parkedBranch } : {}),
    ...(report.parkedReason !== undefined ? { parkedReason: report.parkedReason } : {}),
  };
}

const refuse = (code: MergeAuthorizeOutcome["code"], message: string): { ok: false; code: NonNullable<MergeAuthorizeOutcome["code"]>; message: string } => ({
  ok: false,
  code: code!,
  message,
});

/** Create the production host merge service over an immutable run context. */
export function createHostMergeService(
  context: HostMergeContext,
  deps: HostMergeServiceDeps,
): HostMergeServices {
  const now = deps.now ?? (() => new Date());
  const authorizations = new Map<string, StoredAuthorization>();
  let revoked = false;

  const fingerprint = (): string =>
    [
      context.runId,
      context.originalRepositoryRoot,
      context.originalBranch,
      context.finalizeMergeStepId ?? "",
      context.imageDigest ?? "",
    ].join("|");

  const claimRefusal = (binding: HostBinding, claim: HostClaim | null): string | null => {
    if (!claim) return "no current claim is held by this invocation";
    if (claim.runId !== binding.runId) return `authoritative claim run "${claim.runId}" does not match the bound run "${binding.runId}"`;
    if (claim.agentId !== binding.agentId) return `authoritative claim agent "${claim.agentId}" does not match the bound agent "${binding.agentId}"`;
    if (!context.finalizeMergeStepId) {
      return "finalize_merge step identity is not available for this run — merge authorization is refused";
    }
    if (claim.stepId !== context.finalizeMergeStepId) {
      return `current claim step ${claim.stepId} is not the run's finalize_merge step ${context.finalizeMergeStepId}`;
    }
    return null;
  };

  const storeAuthorization = (entry: StoredAuthorization): void => {
    authorizations.set(entry.authorization.authorizationId, entry);
    while (authorizations.size > MAX_AUTHORIZATIONS) {
      const oldest = authorizations.keys().next().value;
      if (oldest !== undefined) authorizations.delete(oldest);
    }
  };

  const authorize = async (
    binding: HostBinding,
    claim: HostClaim | null,
    request: MergeAuthorizeRequest,
  ): Promise<MergeAuthorizeOutcome> => {
    if (binding.role !== "merger") {
      return refuse("MERGE_ROLE", `role "${binding.role}" is not authorized to merge; only the merger finalizer may land a branch`);
    }
    if (revoked) {
      return refuse("MERGE_SERVICE", "merge authority for this invocation was terminally revoked");
    }
    const claimError = claimRefusal(binding, claim);
    if (claimError) return refuse("MERGE_CLAIM", claimError);

    // Explicit run id (when supplied) must agree with the immutable binding;
    // the guest value is never trusted as authority.
    if (request.runId !== undefined && request.runId !== "") {
      const bare = request.runId.startsWith("run-") ? request.runId.slice(4) : request.runId;
      if (bare !== binding.runId) {
        return refuse("MERGE_BINDING", `run "${request.runId}" does not match the bound run "run-${binding.runId}"`);
      }
    }

    // Origin must be inside the admitted original repository root — checked
    // BEFORE any Git read so an unadmitted origin never reaches host Git.
    if (!path.isAbsolute(request.origin) || !isInsideRoot(context.originalRepositoryRoot, request.origin)) {
      return refuse(
        "MERGE_ORIGIN",
        `origin "${request.origin}" is outside the admitted original repository root "${context.originalRepositoryRoot}"`,
      );
    }
    if (request.into !== context.originalBranch) {
      return refuse("MERGE_TARGET", `--into "${request.into}" is not this run's original branch "${context.originalBranch}"`);
    }
    if (request.branch.length === 0) {
      return refuse("MERGE_BINDING", "--branch must be a non-empty branch name");
    }

    // Narrow authoritative target-tip read (the only host Git activity).
    let tip: string | null;
    try {
      tip = await deps.readTargetTip(path.resolve(request.origin), context.originalBranch);
    } catch (err) {
      return refuse("MERGE_SERVICE", `cannot read the authoritative target tip: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof tip !== "string" || !MERGE_TIP_RE.test(tip)) {
      return refuse("MERGE_SERVICE", `authoritative target ref refs/heads/${context.originalBranch} did not resolve to a commit`);
    }
    if (tip !== request.expectTip) {
      return refuse(
        "MERGE_TIP",
        `--expect-tip ${request.expectTip} does not match the current authoritative target tip ${tip}`,
      );
    }

    const authorization: MergeAuthorization = {
      authorizationId: randomUUID(),
      origin: path.resolve(request.origin),
      branch: request.branch,
      into: context.originalBranch,
      expectTip: tip,
      message: request.message,
      runId: binding.runId,
      admittedRoot: context.originalRepositoryRoot,
      targetRef: `refs/heads/${context.originalBranch}`,
    };
    storeAuthorization({
      authorization,
      invocationId: binding.invocationId,
      claimId: claim!.claimId,
      fingerprint: fingerprint(),
    });
    return { ok: true, message: "", authorization };
  };

  const verifyReportShape = (report: MergeReportRequest): string | null => {
    if (!(MERGE_REPORT_STATUSES as readonly string[]).includes(report.status)) {
      return `unsupported merge report status ${String(report.status)}`;
    }
    if (report.exitCode !== REQUIRED_EXIT[report.status]) {
      return `merge report status ${report.status} requires exit_code ${REQUIRED_EXIT[report.status]} (got ${report.exitCode})`;
    }
    if (report.status === "landed") {
      if (report.mergedCommit === undefined || !MERGE_TIP_RE.test(report.mergedCommit)) {
        return "landed merge report requires a merged_commit";
      }
      if (report.mergedTree === undefined || !MERGE_TIP_RE.test(report.mergedTree)) {
        return "landed merge report requires a merged_tree";
      }
      if (typeof report.noop !== "boolean") return "landed merge report requires a boolean noop";
      if (typeof report.checkoutRefresh !== "string" || report.checkoutRefresh.length === 0) {
        return "landed merge report requires a checkout_refresh";
      }
    } else if (report.status === "target_moved") {
      if (report.actualTip === undefined || !MERGE_TIP_RE.test(report.actualTip)) {
        return "target_moved merge report requires an actual_tip";
      }
    } else if (report.status === "operational_error") {
      if (typeof report.detail !== "string" || report.detail.length === 0) {
        return "operational_error merge report requires a detail";
      }
    }
    return null;
  };

  const report = async (
    binding: HostBinding,
    claim: HostClaim | null,
    incoming: MergeReportRequest,
  ): Promise<MergeReportOutcome> => {
    const stored = authorizations.get(incoming.authorizationId);
    if (!stored) {
      return refuse("MERGE_AUTHORIZATION", `unknown or expired merge authorization ${incoming.authorizationId}`);
    }
    const { authorization } = stored;
    if (binding.runId !== authorization.runId || binding.invocationId !== stored.invocationId) {
      return refuse("MERGE_BINDING", "merge authorization is not bound to this invocation");
    }
    const identity = reportIdentity(incoming);
    if (stored.consumed) {
      if (stored.consumed.identity === identity) {
        return { ok: true, message: "", ack: stored.consumed.ack };
      }
      return refuse("MERGE_REPLAY", "merge authorization already recorded a different outcome");
    }
    if (revoked) {
      return refuse("MERGE_SERVICE", "merge authority for this invocation was terminally revoked");
    }
    const claimError = claimRefusal(binding, claim);
    if (claimError) return refuse("MERGE_CLAIM", claimError);
    if (claim!.claimId !== stored.claimId) {
      return refuse("MERGE_CLAIM", "the finalize_merge claim changed after authorization; refusing a stale landing report");
    }
    if (fingerprint() !== stored.fingerprint) {
      return refuse("MERGE_CONTEXT", "run root/branch/image context changed after merge authorization");
    }
    const shapeError = verifyReportShape(incoming);
    if (shapeError) return refuse("MERGE_BINDING", shapeError);

    // Independent host verification against the authoritative target tip.
    let current: string | null;
    try {
      current = await deps.readTargetTip(authorization.origin, authorization.into);
    } catch (err) {
      return refuse("MERGE_SERVICE", `cannot verify the authoritative target tip: ${err instanceof Error ? err.message : String(err)}`);
    }
    const expectedCurrent = incoming.status === "landed" ? incoming.mergedCommit
      : incoming.status === "target_moved" ? incoming.actualTip
      : authorization.expectTip;
    if (current !== expectedCurrent) {
      return refuse(
        "MERGE_VERIFY",
        `reported ${incoming.status} but the authoritative target tip is ${current ?? "unresolved"} (expected ${expectedCurrent})`,
      );
    }
    if (incoming.status === "target_moved" && incoming.actualTip === authorization.expectTip) {
      return refuse("MERGE_VERIFY", "reported target_moved but the target tip did not move");
    }
    if (incoming.status === "landed" && incoming.noop && incoming.mergedCommit !== authorization.expectTip) {
      return refuse("MERGE_VERIFY", "reported no-op landing but the merged commit is not the authorized target tip");
    }

    const ack = ackFor(incoming);
    // Emit the native run-attributed merge event (host clock + binding run id).
    const eventBase = {
      ts: now().toISOString(),
      runId: binding.runId,
      origin: authorization.origin,
      branch: authorization.branch,
      target: authorization.targetRef,
      expectedTip: authorization.expectTip,
    };
    if (incoming.status === "landed") {
      deps.emitEvent({
        ...eventBase,
        event: "merge.landed",
        mergedTree: incoming.mergedTree!,
        mergedCommit: incoming.mergedCommit!,
        noop: incoming.noop!,
        checkoutRefresh: incoming.checkoutRefresh as MergeCoreEvent["checkoutRefresh"],
        ...(incoming.parkedBranch && incoming.parkedReason
          ? { parkedBranch: incoming.parkedBranch, parkedReason: incoming.parkedReason }
          : {}),
      });
    } else if (incoming.status === "target_moved") {
      deps.emitEvent({
        ...eventBase,
        event: "merge.target_moved",
        actualTip: incoming.actualTip!,
        ...(incoming.mergedTree !== undefined ? { mergedTree: incoming.mergedTree } : {}),
        ...(incoming.mergedCommit !== undefined ? { mergedCommit: incoming.mergedCommit } : {}),
      });
    } else if (incoming.status === "conflicts") {
      deps.emitEvent({
        ...eventBase,
        event: "merge.conflicts",
        ...(incoming.mergedTree !== undefined ? { mergedTree: incoming.mergedTree } : {}),
      });
    }
    // operational_error emits no merge.* event (native parity).

    stored.consumed = { identity, ack };
    return { ok: true, message: "", ack };
  };

  return {
    authorize,
    report,
    revokeAuthority: (reason: string) => {
      // Terminal invocation authority: no NEW authorization/report may be
      // recorded, while an already-consumed authorization keeps its exact ack
      // replayable (the broker's own opKey ledger additionally replays it).
      void reason;
      revoked = true;
    },
  };
}
