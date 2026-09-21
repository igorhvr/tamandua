/**
 * Host broker: binding + authoritative-service contract.
 *
 * The host broker is an ISOLATED module bound by the host to ONE harness
 * invocation: {runId, invocationId, agentId, jobId, role, admittedRoots}.
 * It never trusts guest-supplied identity or PIDs to nominate host targets;
 * every operation is validated against the immutable binding AND the fresh
 * authoritative claim state before any mutation.
 *
 * The broker is NOT a step state machine and NOT a DB adapter. It owns the
 * boundary logic (binding validation, serialisation, bounded invocation
 * idempotency, accepted-completion revocation, cancel/close semantics) and
 * delegates every step operation to an injected AuthoritativeStepServices
 * implementation that carries the EXISTING native step semantics.
 *
 * ── Adapter obligation (documented contract for the later integration run) ──
 *
 * The production adapter wires AuthoritativeStepServices to the real
 * DB-backed step ops (peekStep/claimStep/stepCurrent/completeStep/failStep in
 * src/installer/step-ops.ts + src/cli/commands/step.ts events). It MUST:
 *
 *   1. Services receive the HOST binding (runId/invocationId/agentId/jobId),
 *      never arbitrary guest IDs. readClaim() returns the invocation's
 *      current authoritative claim or null.
 *
 *   2. Claim replacement / stale-claim rejection must be ATOMIC at mutation
 *      time. submitCompletion/submitFail receive the expectedClaimId the
 *      broker captured from the fresh readClaim(); the adapter must reject the
 *      mutation when the authoritative row no longer matches that claim (a
 *      guarded UPDATE ... WHERE id=? AND claim fields = expected, or an
 *      equivalent atomic check). An async precheck alone is insufficient.
 *
 *   3. submit-time expects validation mirrors the native CLI: validate the
 *      output against the authoritative `expects` BEFORE any mutation; a
 *      rejection is returned to the guest as REJECTED (claim retained, retry
 *      budget untouched) and the adapter emits the native rejection events
 *      (step.submit.rejected, step.expects.validated outcome=rejected).
 *
 *   4. submitCompletion reproduces the native acceptance path (completeStep):
 *      second expects check at acceptance, STATUS: retry/failed verdict
 *      handling, retry-count bookkeeping, reroute and terminal failure
 *      semantics, context merge and pipeline advance. Returned statuses stay
 *      native: advanced/completed/rerouted/retrying/failed/blocked with
 *      `mutated` false only for blocked no-op outcomes.
 *
 *   5. Events (step.submit.rejected, step.expects.validated with native
 *      fields, step.retry, step.failed, ...) are emitted by the adapter via
 *      emit(); the broker never skips them — the parity contract includes
 *      them.
 *
 * ── Late-mutation authority obligation (MTLK-GUEST-GUARD) ──
 *
 * The broker enforces revocation at ITS boundary: cancel/close/service
 * deadline mark the in-flight request revoked, every mutation path re-checks
 * that authority after every await, and a request whose validateCompletion
 * was still pending when revocation landed NEVER starts the guarded mutation.
 * The broker additionally refuses to admit further mutations once a mutating
 * delegated call exceeds its deadline (fail closed), so an abandoned call can
 * never be joined by concurrent mutators. The broker NEVER relies on an
 * optional adapter cancellation hook for correctness.
 *
 * The ADAPTER's obligation is the complementary, atomic half:
 *
 *   a. claim replacement / stale-claim rejection is checked ATOMICALLY inside
 *      submitCompletion/submitFail against the expectedClaimId the broker
 *      captured from a fresh readClaim() (guarded UPDATE ... WHERE id=? AND
 *      claim identity = expected, or equivalent) — an async precheck alone is
 *      insufficient (see native-step-services contract: registry active lease
 *      bound to THIS invocationId + row claim-identity token equality inside
 *      the mutation transaction; a stable scheduler jobId is NOT a fresh
 *      lease).
 *   b. revokeInvocationAuthority() (optional narrow seam below) is invoked by
 *      the broker at most ONCE per broker lifetime, synchronously, when the
 *      invocation's authority is TERMINALLY revoked: host close, guest pipe
 *      EOF/end/error, host cancel of the whole invocation (no target id), an
 *      in-flight request revocation, or the finite service deadline. The
 *      notification happens even when the invocation is IDLE (before its
 *      first request/claim) and after a prior request/claim settled — a
 *      closing/EOF'd broker ends the identity regardless of activity. An
 *      adapter that threads host revocation into its in-flight mutations
 *      should abort them here; an adapter that cannot cancel an in-flight
 *      mutation synchronously must document that and rely on the broker's
 *      precommit guard + the atomic claim check. This stage's synthetic
 *      services prove the broker-side guard; the seam is optional so simple
 *      fakes can omit it.
 *   c. A guarded mutation ALREADY admitted before revocation may commit — the
 *      broker preserves the accepted transition and remembers the exact ack
 *      for replay; it never rewrites the past. Adapters must likewise not
 *      pretend an admitted mutation was canceled.
 *
 * This stage's tests exercise the contract with fakes that enforce captured
 * binding and claim replacement, not unconditional success.
 */

/** Immutable per-invocation host binding (bare uuids for run/invocation). */
export interface HostBinding {
  runId: string;
  invocationId: string;
  agentId: string;
  jobId: string;
  role: string;
  /** Admitted repository/work roots (informational + future validation). */
  admittedRoots: readonly string[];
  /** Protocol/build identity of the guest helper pack. */
  helperProtocolVersion: string;
  helperBuildVersion: string;
}

/** Authoritative current claim for the invocation. */
export interface HostClaim {
  /** Bare step uuid. */
  stepId: string;
  runId: string;
  agentId: string;
  /** Claim identity used for guarded mutations (mirrors native completionClaimId). */
  claimId: string;
  /** Raw expects contract ("" when none). */
  expects: string;
  /** Rendered step input shown to the worker (native claim/current `input`). */
  input: string;
}

export type PeekVerdict = "HAS_WORK" | "NO_WORK";

export interface ClaimOutcome {
  found: boolean;
  stepId?: string;
  runId?: string;
  input?: string;
}

export interface CompleteOutcome {
  status: string;
  detail?: string;
  /** True when the transition consumed/released the claim or re-pended it. */
  mutated: boolean;
}

export interface FailOutcome {
  status: string;
  mutated: boolean;
}

export interface ValidationDiagnostic {
  verdict: "accept" | "reject";
  /** e.g. EXPECTS_MISSING_STATUS, EXPECTS_REGEX_MISMATCH_<digest>, EXPECTS_SATISFIED. */
  code?: string;
  message: string;
  missingKeys: string[];
  invalidKeys: string[];
}

/**
 * Typed authoritative step service. Implementations carry the real step
 * semantics and MUST enforce the binding + expected claim identity atomically
 * (see adapter obligation above).
 */
export interface AuthoritativeStepServices {
  /** Fresh authoritative claim for this invocation (null when none held). */
  readClaim(binding: HostBinding): Promise<HostClaim | null>;
  /** Agent/run-scoped pending-work check (native peekStep). */
  peek(binding: HostBinding): Promise<PeekVerdict>;
  /**
   * Claim for this invocation's run+agent. Idempotent: returns the held step
   * when this invocation already holds one (native claimStep idempotency).
   */
  claim(binding: HostBinding): Promise<ClaimOutcome>;
  /** Submit-time expects validation ONLY — no mutation, claim untouched. */
  validateCompletion(binding: HostBinding, stepId: string, output: string): Promise<ValidationDiagnostic>;
  /**
   * Guarded atomic acceptance. `expectedClaimId` was captured from a fresh
   * readClaim() by the broker; the adapter rejects stale/foreign/reassigned
   * claims before mutating. Native acceptance semantics apply.
   */
  submitCompletion(
    binding: HostBinding,
    expectedClaimId: string,
    stepId: string,
    output: string,
  ): Promise<CompleteOutcome>;
  /** Guarded atomic failure (native failStep semantics). */
  submitFail(binding: HostBinding, expectedClaimId: string, stepId: string, reason: string): Promise<FailOutcome>;
  /**
   * OPTIONAL narrow revocation seam (see "Late-mutation authority obligation"
   * above). Invoked by the broker AT MOST ONCE per broker lifetime — at the
   * first TERMINAL authority event: host close, guest pipe EOF/end/error, host
   * cancel of the whole invocation, revocation of an in-flight request, or
   * the finite service deadline. The notification is synchronous and fires
   * even when the invocation is idle (before its first request/claim) or after
   * a prior request/claim settled. Adapters that can abort in-flight authority
   * work should do so here (e.g. terminally revoke the invocation in a host
   * registry so no late async continuation can ever claim/mutate again); the
   * broker enforces the precommit guard itself and never depends on this hook
   * for correctness. Throws from the seam never break the broker.
   */
  revokeInvocationAuthority?(invocationId: string, reason: string): void;
  /** Event sink for native-shaped records (validation/rejection/transition). */
  emit(event: Record<string, unknown>): void;
}

/** Lifecycle of one invocation at the broker. */
export const INVOCATION_STATES = ["open", "completed", "canceling", "canceled", "closed"] as const;
export type InvocationState = (typeof INVOCATION_STATES)[number];

/** Broker result codes surfaced to the guest CLI. */
export const BROKER_RESULT_CODES = [
  "BINDING",
  "INVOCATION_STATE",
  "CLAIM",
  "IDEMPOTENCY",
  "SERVICE",
  "DEADLINE",
  "CANCELED",
  "CLOSED",
  "BAD_REQUEST",
  "REJECTED",
] as const;
export type BrokerResultCode = (typeof BROKER_RESULT_CODES)[number];
