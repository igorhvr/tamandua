/**
 * Host broker: scoped merge authorization/receipt contract (US-007).
 *
 * The guest `tamandua merge-branch` command never runs host Git. The guest CLI
 * asks the broker to type-check the finalizer binding (`merge.authorize`),
 * executes the shared dependency-free pure core (`runMergeCore`, US-005) with
 * GUEST git against the RW-mounted original, then reports the outcome
 * (`merge.report`). The broker refuses a request with a TYPED error BEFORE any
 * Git action when the finalizer/claim/origin/target/expect-tip/context
 * authority does not hold.
 *
 * The host service is a host-attested object built from immutable run scope
 * (original repository root + original branch + finalize_merge step identity +
 * admitted roots + image pin). It is NEVER built from guest input or ambient
 * env. `createHostMergeService` (host-merge-service.ts) is the production
 * implementation; tests inject a fake through the same contract.
 *
 * Executable-Git boundary: the ONLY Git the host performs is the narrow
 * authoritative target-tip read used to validate `--expect-tip` and to verify
 * the reported outcome. That read is a fixed `rev-parse --verify <ref>^{commit}`
 * plumbing call (no shell, no guest-supplied argv, no hooks/signing/credential
 * helpers, no worktree metadata path) executed with `-C <origin>` where origin
 * is first confirmed to be inside the admitted original repository root; it
 * cannot execute guest-controlled content or reach an unadmitted checkout.
 * Every hook/signing/helper-bearing plumbing operation (commit-tree, update-ref,
 * read-tree, symbolic-ref, worktree discovery, merge-tree) stays inside the
 * guest VM via runMergeCore.
 */

import type { HostBinding, HostClaim } from "./broker-services.js";
import type {
  BridgeErrorCode,
  MergeAuthorization,
  MergeAuthorizeRequest,
  MergeReportAck,
  MergeReportRequest,
} from "./guest-protocol.js";
import type { MergeCoreEvent } from "./merge-core.js";

/**
 * Host-attested merge context for one run. Built from immutable run scope by
 * the controller/runner; never from guest input or env.
 */
export interface HostMergeContext {
  /** Bare run uuid this invocation is bound to. */
  runId: string;
  /** Canonical absolute original repository root (the admitted origin). */
  originalRepositoryRoot: string;
  /** Original branch the run lands into (bare name, e.g. "main"). */
  originalBranch: string;
  /**
   * Host-attested finalize_merge step id (bare uuid) for this run. The
   * authorizing claim MUST be this step; a missing identity refuses (the
   * controller must supply it — see US-008 wiring).
   */
  finalizeMergeStepId?: string;
  /** Admitted repository roots (informational defense-in-depth). */
  admittedRoots: readonly string[];
  /** Immutable image content pin (context fingerprint; optional). */
  imageDigest?: string;
}

/** Injectable host dependencies for the production merge service. */
export interface HostMergeServiceDeps {
  /**
   * Narrow authoritative target-tip read. MUST be a bounded fixed plumbing
   * read that cannot execute guest-controlled hooks/signing/helpers and only
   * touches the admitted origin. Returns the 40-64 hex tip or null when the
   * ref does not resolve / the read fails.
   */
  readTargetTip(origin: string, into: string): Promise<string | null> | string | null;
  /** Real run-attributed host event sink (native merge.* emission). */
  emitEvent(event: MergeCoreEvent): void;
  /** Injectable clock for host-emitted events (tests). */
  now?: () => Date;
}

export interface MergeAuthorizeOutcome {
  ok: boolean;
  code?: BridgeErrorCode;
  message: string;
  authorization?: MergeAuthorization;
}

export interface MergeReportOutcome {
  ok: boolean;
  code?: BridgeErrorCode;
  message: string;
  ack?: MergeReportAck;
}

/**
 * Typed host merge authorization/receipt service injected into the broker.
 * `claim` is the broker's FRESH authoritative claim read (null when none).
 */
export interface HostMergeServices {
  authorize(
    binding: HostBinding,
    claim: HostClaim | null,
    request: MergeAuthorizeRequest,
  ): Promise<MergeAuthorizeOutcome>;
  report(
    binding: HostBinding,
    claim: HostClaim | null,
    report: MergeReportRequest,
  ): Promise<MergeReportOutcome>;
  /** Optional terminal revocation seam (broker close/cancel/EOF). */
  revokeAuthority?(reason: string): void;
}
