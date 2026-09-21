/**
 * Production AuthoritativeStepServices: real isolated DB-backed native step
 * semantics behind the scoped host broker (MTLK-STEP).
 *
 * This adapter replaces broker-test-services.ts's in-memory fake in the host
 * broker. It wires the broker's typed service contract to the REAL step
 * state machine (peekStep/claimStep/stepCurrent/completeStep/failStep in
 * src/installer/step-ops.ts) and the real event stream, WITHOUT duplicating
 * state-machine semantics and WITHOUT touching the worker CLI or scheduler.
 *
 * Authority model (MTLK-STEP-REVOKE):
 *
 *   - Every service call asserts the passed HostBinding equals the binding
 *     the adapter was constructed for (defense in depth; the broker already
 *     validated the request against the same binding).
 *   - INVOCATION ADMISSION is a host lifecycle separate from any held claim
 *     (native-step-invocations.ts). The host admits each unique invocation
 *     identity before it may act; revocation is TERMINAL for that identity
 *     (revocation before first claim, while a claim is queued, or mid-flight
 *     all stick), and no guest-facing claim/register/admit can resurrect it.
 *     Every adapter op checks liveness AFTER its awaits and BEFORE any native
 *     claim/adoption/mutation: peek/readClaim refuse to observe work,
 *     claim refuses BEFORE claimStep so a revoked/never-admitted invocation
 *     can never drive the DB claim mutation, and the guarded mutations carry
 *     the same check inside the atomic boundary.
 *   - The broker's optional revokeInvocationAuthority(invocationId, reason)
 *     seam (broker-services.ts) is implemented: every TERMINAL host lifetime
 *     event — cancel / close / guest EOF / service deadline, and even a host
 *     close or cancel of an IDLE invocation (before its first claim) or after
 *     a settled claim — terminally revokes this invocation in the registry, so
 *     a mutation paused inside an async service wait can never commit
 *     afterwards and no late async continuation can resurrect the identity.
 *   - The registry additionally binds each claim to exactly ONE invocation.
 *     jobId is stable across scheduler rounds and SQLite claim timestamps are
 *     second-granular, so neither is ever treated as a fresh claim
 *     generation: readClaim returns a claim only when THIS invocation's lease
 *     is active AND the authoritative row still carries the captured
 *     host claim-identity token (hostClaimRowToken: job + worker pid/pgid +
 *     claim timestamp — NOT claim_job_id alone).
 *   - submitCompletion/submitFail carry `expectedClaimId` captured by the
 *     broker from a fresh readClaim. The adapter checks it ATOMICALLY inside
 *     the existing mutation boundary via the opt-in authority seam on
 *     completeStep/failStep (step-ops.ts StepMutationOptions): the guard runs
 *     inside completeStep's BEGIN IMMEDIATE transaction and, for failStep,
 *     at entry and again AFTER the only await (getOnFailPolicy) on a fresh
 *     row read, immediately before the mutation it authorizes — the
 *     on_fail.retry_step reroute AND the terminal run-failure transition are
 *     both re-checked. A stale/foreign/revoked/reassigned claim is refused
 *     with { status: "blocked", mutated: false } — no mutation, no events,
 *     claim retained.
 *   - Genuine internal failures (an unexpected exception from the native
 *     machinery, e.g. a step row vanishing mid-flight or an event-stream /
 *     DB error) are RETHROWN so the broker's SERVICE error channel surfaces
 *     them distinctly; "blocked" is reserved strictly for authority refusals
 *     and genuine no-ops (which the native machinery RETURNS, never throws).
 *   - submit-time expects validation mirrors the native CLI: it runs only for
 *     nonempty output and never mutates; a rejection returns REJECTED with
 *     the claim and retry budget retained and emits step.submit.rejected +
 *     step.expects.validated (outcome=rejected) with native field shapes.
 *     Empty output is NOT pre-rejected — native acceptance semantics apply.
 *   - Guest-provided file paths are never opened on the host. Guest files are
 *     dereferenced to bounded content by the guest pack; a residual
 *     STORIES_JSON_FILE: file-reference line arriving at the host is refused
 *     (never interpreted).
 *
 * Native return statuses are preserved (advanced/completed/rerouted/
 * retrying/failed/blocked); mutated:false is reported only for genuine
 * no-ops/refusals. A refused stale transition is never reported as success.
 *
 * The lifecycle binding (VM close -> registry revocation, successor
 * dispatch, orphan recovery) is injected by the production integration; a
 * component with injected lifecycle binding is not yet a qualified full
 * backend (see native-step-services-contract.json remaining_integration).
 */

import { createHash, randomUUID } from "node:crypto";
import { emitEvent } from "../events.js";
import { getDb } from "../../db.js";
import {
  claimStep,
  completeStep,
  failStep,
  peekStep,
  stepCurrent,
  validateExpects,
  type StepClaimEvidence,
  type StepProgressOptions,
  type RunProgressAccessLike,
  type WorkerOwnership,
} from "../step-ops.js";
import type {
  AuthoritativeStepServices,
  ClaimOutcome,
  CompleteOutcome,
  FailOutcome,
  HostBinding,
  HostClaim,
  PeekVerdict,
  ValidationDiagnostic,
} from "./broker-services.js";
import type { FinalizeMergeEvidenceSource } from "../ledger-gate.js";
import { HostInvocationRegistry } from "./native-step-invocations.js";

/** Host-supplied worker ownership forwarded to native claimStep. */
export interface HostWorkerOwnership extends WorkerOwnership {
  jobId: string;
  pid: number;
  pgid?: number;
}

export interface NativeStepServicesOptions {
  binding: HostBinding;
  /**
   * Shared host invocation registry for this (run, agent) lifetime across
   * successive invocations. Injected by production integration; tests drive
   * real revocation/supersession through it.
   */
  registry: HostInvocationRegistry;
  /**
   * Host-owned worker identity recorded on claims (jobId/pid/pgid from the
   * host controller/scheduler binding — NEVER guest-supplied). When omitted,
   * claims mirror the native CLI shape without worker env (no claim fields).
   */
  workerOwnership?: HostWorkerOwnership;
  /**
   * Native event sink for adapter-emitted records (submit rejection /
   * accepts-validation parity). Defaults to the real event stream
   * (events.emitEvent), so parity events land exactly where native CLI
   * events land.
   */
  emit?: (event: Record<string, unknown>) => void;
  /**
   * Optional uniform delay (ms) before every delegated op so host
   * revocation/cancellation tests are deterministic. Off (0) in production.
   */
  serviceDelayMs?: number;
  /** Host clock for lease timestamps (defaults to Date.now). */
  now?: () => number;
  /**
   * Opt-in host progress-resource accessor (MTLK-PROGRESS).
   *
   * When present, ACTUAL claimed/current input rendered for the guest carries
   * the guest-visible progress pointer (`access.guestFile`) instead of the
   * host canonical path, and host story-plan writes (completeStep) go through
   * the confined resource accessor to the SAME document the guest sees. When
   * absent every path mirrors native step-ops behavior byte-for-byte.
   */
  progressResource?: RunProgressAccessLike;
  /**
   * Opt-in host-attested Matchlock finalizer evidence source (US-006).
   *
   * Supplied ONLY by the controller-attested invocation runner
   * (`pi-invocation-runner`) from the SAME host-owned suite store + canonical
   * namespace the suite bridge serves. When present, a finalize_merge claim or
   * completion in this invocation is gated on Matchlock evidence instead of the
   * native `suite_results` ledger. When absent (native/no-flag/test fakes) the
   * native behavior is byte-identical; no env/context can activate it.
   */
  ledgerEvidenceSource?: FinalizeMergeEvidenceSource;
}

/** Evidence row used for CLI-parity validation events. */
export interface EvidenceStep {
  id: string;
  run_id: string;
  step_id: string;
  expects: string;
  status: string;
  claim_job_id: string | null;
  claim_pid: number | null;
  claim_pgid: number | null;
  claim_updated_at: string | null;
  updated_at: string;
}

const STORIES_JSON_FILE_RE = /^STORIES_JSON_FILE:\s*\S+/m;

type DbHandle = ReturnType<typeof getDb>;

/** Native completion-claim derivation (mirrors the worker CLI). */
export function completionClaimId(step: Pick<EvidenceStep, "id" | "claim_job_id" | "claim_updated_at" | "updated_at">): string {
  return step.claim_job_id ?? `${step.id}:${step.claim_updated_at ?? step.updated_at}`;
}

/**
 * Host row claim-identity token captured at claim/adoption time and compared
 * at every mutation. Includes the FULL host worker-claim identity — job id +
 * worker pid + worker pgid + claim timestamp — because the scheduler job id
 * alone is STABLE across rounds and is not row-freshness proof: an
 * out-of-band native release/reclaim by a DIFFERENT worker (distinct
 * pid/pgid) must change the token even when jobId and the second-granular
 * timestamps collide. When the host recorded no worker-claim fields, fall
 * back to the native completion-claim derivation (row id + claim/update
 * timestamp). This deliberately does NOT change completionClaimId — the
 * event-parity claim id must stay byte-identical to the native CLI's.
 */
export function hostClaimRowToken(row: {
  id?: string;
  claim_job_id: string | null;
  claim_pid: number | null;
  claim_pgid: number | null;
  claim_updated_at: string | null;
  updated_at: string;
}): string {
  if (row.claim_job_id !== null) {
    return [row.claim_job_id, row.claim_pid ?? "", row.claim_pgid ?? "", row.claim_updated_at ?? ""].join("|");
  }
  return `${row.id ?? ""}:${row.claim_updated_at ?? row.updated_at}`;
}

/** Row claim-identity token derived exactly like the native completion claim id. */
export function claimTokenFromEvidence(evidence: StepClaimEvidence): string {
  return hostClaimRowToken({
    id: evidence.stepRowId,
    claim_job_id: evidence.claimJobId,
    claim_pid: evidence.claimPid,
    claim_pgid: evidence.claimPgid,
    claim_updated_at: evidence.claimUpdatedAt,
    updated_at: evidence.updatedAt,
  });
}

/** Expected KEY: literals from an expects contract (mirrors worker CLI). */
function expectsKeys(expects: string): string[] {
  const keys = new Set<string>();
  for (const line of expects.split("\n")) {
    const literal = line.trim().match(/^([A-Z][A-Z0-9_]*):/);
    if (literal) keys.add(literal[1]);
  }
  return [...keys];
}

/** Validation diagnostic derivation (mirrors the worker CLI helpers). */
function validationDiagnostic(validationError: string): { missingKeys: string[]; invalidKeys: string[]; code: string } {
  const missing = validationError.match(/^Output missing expects string: "([A-Z][A-Z0-9_]*):/);
  if (missing) return { missingKeys: [missing[1]], invalidKeys: [], code: `EXPECTS_MISSING_${missing[1]}` };
  const invalid = validationError.match(/^Invalid expects regex pattern:/);
  const digest = createHash("sha256").update(validationError).digest("hex").slice(0, 12).toUpperCase();
  return {
    missingKeys: [],
    invalidKeys: invalid ? ["EXPECTS_REGEX"] : ["EXPECTS_MATCH"],
    code: `${invalid ? "EXPECTS_INVALID_REGEX" : "EXPECTS_REGEX_MISMATCH"}_${digest}`,
  };
}

export class NativeStepServices implements AuthoritativeStepServices {
  /** Records passed to the event sink (convenience for tests). */
  readonly emitted: Array<Record<string, unknown>> = [];

  private readonly binding: HostBinding;
  private readonly registry: HostInvocationRegistry;
  private readonly workerOwnership?: HostWorkerOwnership;
  private readonly delayMs: number;
  private readonly nowFn: () => number;
  private readonly emitFn: (event: Record<string, unknown>) => void;
  private readonly progressResource?: RunProgressAccessLike;
  private readonly ledgerEvidenceSource?: FinalizeMergeEvidenceSource;

  constructor(private readonly opts: NativeStepServicesOptions) {
    this.binding = opts.binding;
    this.registry = opts.registry;
    this.workerOwnership = opts.workerOwnership;
    this.delayMs = opts.serviceDelayMs ?? 0;
    this.nowFn = opts.now ?? Date.now;
    this.emitFn = opts.emit ?? ((event) => emitEvent(event as unknown as Parameters<typeof emitEvent>[0]));
    this.progressResource = opts.progressResource;
    this.ledgerEvidenceSource = opts.ledgerEvidenceSource;
  }

  /**
   * Opt-in step options forwarded to claim/current/complete so the guest input
   * renders the guest progress pointer and the finalize_merge ledger gate
   * consults the host-attested Matchlock evidence source. Returns undefined
   * when no opt-in is configured so native callers stay byte-identical.
   */
  private stepProgressOptions(): StepProgressOptions | undefined {
    const options: StepProgressOptions = {};
    if (this.progressResource) options.progressAccess = this.progressResource;
    if (this.ledgerEvidenceSource) options.ledgerEvidenceSource = this.ledgerEvidenceSource;
    return Object.keys(options).length > 0 ? options : undefined;
  }

  // ── binding + shared helpers ────────────────────────────────────────

  private async gate(): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
  }

  private assertBinding(binding: HostBinding): void {
    const b = this.binding;
    if (
      binding.runId !== b.runId ||
      binding.invocationId !== b.invocationId ||
      binding.agentId !== b.agentId ||
      binding.jobId !== b.jobId
    ) {
      throw new Error(
        `NativeStepServices: binding mismatch (service bound to run ${b.runId}/invocation ${b.invocationId}/agent ${b.agentId}/job ${b.jobId}; got run ${binding.runId}/invocation ${binding.invocationId}/agent ${binding.agentId}/job ${binding.jobId})`,
      );
    }
  }

  /** Atomically-evaluated authority guard bound to THIS invocation + expectedClaimId. */
  private authorityGuard(expectedClaimId: string): (evidence: StepClaimEvidence) => string | null {
    const binding = this.binding;
    const registry = this.registry;
    return (evidence: StepClaimEvidence): string | null => {
      const lease = registry.getLeaseByStep(evidence.stepRowId);
      if (!lease) {
        return `invocation ${binding.invocationId} holds no active claim for step ${evidence.stepRowId}`;
      }
      if (lease.invocationId !== binding.invocationId) {
        return `step ${evidence.stepRowId} is claimed by invocation ${lease.invocationId}, not ${binding.invocationId}`;
      }
      if (lease.jobId !== binding.jobId) {
        return `lease job ${lease.jobId} does not match invocation job ${binding.jobId}`;
      }
      if (lease.claimId !== expectedClaimId) {
        return `expected claim id ${expectedClaimId} does not match the active claim id ${lease.claimId}`;
      }
      if (!registry.isInvocationActive(binding.invocationId)) {
        return `invocation ${binding.invocationId} was revoked/superseded by the host`;
      }
      if (evidence.status !== "running") {
        return `step ${evidence.stepRowId} is not running (status: ${evidence.status})`;
      }
      const token = claimTokenFromEvidence(evidence);
      if (token !== lease.rowToken) {
        return `authoritative claim row for step ${evidence.stepRowId} changed since this invocation claimed it (released/reassigned/recovered)`;
      }
      return null;
    };
  }

  /** Release our own lease once a mutation consumed/released the claim. */
  private releaseOwnLease(stepRowId: string): void {
    this.registry.releaseIfHeldBy(this.binding.invocationId, stepRowId);
  }

  /**
   * Host-admission liveness gate: returns a refusal detail when THIS
   * invocation is not a live host admission (never admitted, or terminally
   * revoked — even when the revocation happened before its first claim or
   * while a claim was queued). Must run AFTER every await and BEFORE any
   * claimStep/adoption/mutation so a revoked identity can never drive a
   * native mutation.
   */
  private lifecycleRefusal(binding: HostBinding): string | null {
    const admission = this.registry.getAdmission(binding.invocationId);
    if (!admission) {
      return `invocation ${binding.invocationId} has not been admitted by the host`;
    }
    if (admission.state !== "admitted") {
      return `invocation ${binding.invocationId} was revoked by the host${
        admission.revokeReason ? ` (${admission.revokeReason})` : ""
      } and cannot act again`;
    }
    if (
      admission.runId !== binding.runId ||
      admission.agentId !== binding.agentId ||
      admission.jobId !== binding.jobId
    ) {
      return `invocation ${binding.invocationId} admission identity (run ${admission.runId}/agent ${admission.agentId}/job ${admission.jobId}) does not match this binding`;
    }
    return null;
  }

  /**
   * Broker-driven terminal revocation seam (AuthoritativeStepServices
   * revokeInvocationAuthority?): the REAL host broker invokes this on
   * cancellation / close / EOF / service deadline. It terminally revokes THIS
   * adapter's invocation in the registry so a mutation already paused inside
   * an async service wait can never commit afterwards. Only the bound
   * invocation id is accepted — one broker can never revoke another
   * invocation through this seam.
   */
  revokeInvocationAuthority(invocationId: string, reason: string): void {
    if (invocationId !== this.binding.invocationId) return;
    this.registry.revokeInvocation(invocationId, reason);
  }

  private db(): DbHandle {
    return getDb();
  }

  private readEvidenceRow(stepRowId: string): EvidenceStep | undefined {
    return this.db().prepare(
      "SELECT id, run_id, step_id, expects, status, claim_job_id, claim_pid, claim_pgid, claim_updated_at, updated_at FROM steps WHERE id = ?",
    ).get(stepRowId) as EvidenceStep | undefined;
  }

  // ── CLI-parity validation events (Matchlock-local, not a CLI refactor) ──

  private emitNativeEvent(record: Record<string, unknown>): void {
    this.emitted.push(record);
    this.emitFn(record);
  }

  private emitSubmitRejected(
    step: EvidenceStep,
    diagnostic: { code: string; missingKeys: string[]; invalidKeys: string[] },
    validationCode: string,
  ): void {
    this.emitNativeEvent({
      ts: new Date().toISOString(),
      event: "step.submit.rejected",
      recordId: randomUUID(),
      runId: step.run_id,
      stepRowId: step.id,
      stepId: step.step_id,
      claimId: completionClaimId(step),
      validationCode,
      missingKeys: diagnostic.missingKeys,
      invalidKeys: diagnostic.invalidKeys,
      diagnosticCode: diagnostic.code,
    });
  }

  private emitExpectsValidated(
    step: EvidenceStep,
    fields: {
      outcome: "accepted" | "rejected";
      verdict: "done" | "retry" | "failed" | null;
      diagnosticCode: string;
      missingKeys?: string[];
      invalidKeys?: string[];
      transitionAction: "done" | "retry" | "reroute" | "fail";
    },
  ): void {
    this.emitNativeEvent({
      ts: new Date().toISOString(),
      event: "step.expects.validated",
      recordId: randomUUID(),
      runId: step.run_id,
      stepRowId: step.id,
      stepId: step.step_id,
      claimId: completionClaimId(step),
      outcome: fields.outcome,
      verdict: fields.verdict,
      expectsRequired: step.expects.trim() !== "",
      requiredKeys: expectsKeys(step.expects),
      missingKeys: fields.missingKeys ?? [],
      invalidKeys: fields.invalidKeys ?? [],
      diagnosticCode: fields.diagnosticCode,
      producerStepRowId: null,
      transitionAction: fields.transitionAction,
      transitionTargetStepRowId: step.id,
    });
  }

  // ── AuthoritativeStepServices ───────────────────────────────────────

  async readClaim(binding: HostBinding): Promise<HostClaim | null> {
    await this.gate();
    this.assertBinding(binding);
    // A revoked/never-admitted invocation holds no claim and must not observe
    // (or revive) one — checked after the await, before any lease/row reads.
    if (this.lifecycleRefusal(binding) !== null) return null;
    const lease = this.registry.getLeaseByInvocation(binding.invocationId);
    if (!lease) return null;
    if (lease.jobId !== binding.jobId || lease.runId !== binding.runId || lease.agentId !== binding.agentId) {
      return null;
    }
    // The authoritative row must still be the invocation's running claim with
    // an unchanged host claim-identity token; otherwise the claim was released
    // / reassigned / rerouted and this invocation no longer holds it (its
    // lifetime is terminally revoked — a fresh host-admitted successor may
    // adopt the row).
    const current = stepCurrent(binding.agentId, binding.runId, this.stepProgressOptions());
    if (!current || current.stepId !== lease.stepRowId) {
      this.registry.revokeInvocation(binding.invocationId, "claim row no longer held by this invocation (released/reassigned)");
      return null;
    }
    const row = this.readEvidenceRow(lease.stepRowId);
    if (!row || row.status !== "running" || row.run_id !== binding.runId) {
      this.registry.revokeInvocation(binding.invocationId, "claim row no longer running for this invocation");
      return null;
    }
    const rowToken = hostClaimRowToken(row);
    if (rowToken !== lease.rowToken) {
      // Row released/reassigned/recovered under us: authority is lost;
      // terminal revoke + surface no claim.
      this.registry.revokeInvocation(binding.invocationId, "authoritative claim row changed since this invocation claimed it");
      return null;
    }
    return {
      stepId: lease.stepRowId,
      runId: lease.runId,
      agentId: lease.agentId,
      claimId: lease.claimId,
      expects: row.expects ?? "",
      input: current.input,
    };
  }

  async peek(binding: HostBinding): Promise<PeekVerdict> {
    await this.gate();
    this.assertBinding(binding);
    // A revoked/never-admitted invocation is not told about work it may never
    // claim (read-only; fail closed).
    if (this.lifecycleRefusal(binding) !== null) return "NO_WORK";
    return peekStep(binding.agentId, binding.runId) === "HAS_WORK" ? "HAS_WORK" : "NO_WORK";
  }

  async claim(binding: HostBinding): Promise<ClaimOutcome> {
    await this.gate();
    this.assertBinding(binding);
    if (this.workerOwnership && this.workerOwnership.jobId !== binding.jobId) {
      throw new Error(
        `NativeStepServices: worker ownership job ${this.workerOwnership.jobId} does not match invocation job ${binding.jobId}`,
      );
    }
    // Lifecycle gate BEFORE the native claim mutation: a revoked (including
    // revoked-before-first-claim / revoked-while-queued) or never-admitted
    // invocation must never drive claimStep's pending->running write — no
    // partial claim, no step.running event, no story claim. The host admits a
    // FRESH successor identity instead.
    if (this.lifecycleRefusal(binding) !== null) {
      return { found: false };
    }
    // Native claimStep already enforces run+agent scoping, run status and
    // single-writer pending→running atomicity, and returns the invocation's
    // held step idempotently. It may also return a step held by a DIFFERENT
    // (still active) invocation — that is not authority for this invocation,
    // so the lease registry decides below and no other step's input leaks.
    const result = claimStep(binding.agentId, binding.runId, this.workerOwnership, this.stepProgressOptions());
    if (!result.found || !result.stepId || !result.runId) return { found: false };

    const existingLease = this.registry.getLeaseByStep(result.stepId);
    if (existingLease && existingLease.invocationId === binding.invocationId) {
      // Same invocation re-claim: idempotent; return the same held claim.
      return { found: true, stepId: result.stepId, runId: result.runId, input: result.resolvedInput };
    }
    if (existingLease && existingLease.invocationId !== binding.invocationId) {
      // A different invocation still actively holds this step. The host must
      // revoke/supersede it before this invocation may take over. Refuse
      // without mutating and without returning the other invocation's input.
      return { found: false };
    }
    // No active lease: this invocation claims/adopts the step. Record the
    // authoritative row's full host claim-identity token so later mutations
    // can be checked atomically against both registry state and row state.
    const row = this.readEvidenceRow(result.stepId);
    if (!row || row.status !== "running") {
      // claimStep reported a claim but the row is not running (post-claim
      // work unclaimed it): nothing to hold.
      return { found: false };
    }
    const rowToken = hostClaimRowToken(row);
    const lease = {
      stepRowId: result.stepId,
      stepId: row.step_id,
      runId: result.runId,
      agentId: binding.agentId,
      invocationId: binding.invocationId,
      jobId: binding.jobId,
      claimId: `${binding.invocationId}@${binding.jobId}`,
      rowToken,
      claimedAtMs: this.nowFn(),
    };
    const registered = this.registry.register(lease);
    if (!registered.ok) {
      // Lost a race with an active lease (another invocation registered
      // between our claim and this register) or our admission was revoked
      // after the claimStep adoption point.
      return { found: false };
    }
    return { found: true, stepId: result.stepId, runId: result.runId, input: result.resolvedInput };
  }

  async validateCompletion(binding: HostBinding, stepId: string, output: string): Promise<ValidationDiagnostic> {
    await this.gate();
    this.assertBinding(binding);
    // Read-only validation carries no mutation, but a revoked/never-admitted
    // invocation must not be answered with expects diagnostics or emit
    // rejection events on the invocation's behalf.
    const refusal = this.lifecycleRefusal(binding);
    if (refusal !== null) {
      return { verdict: "reject", code: "INVOCATION_REVOKED", message: refusal, missingKeys: [], invalidKeys: [] };
    }

    // Residual guest file-reference forms must be refused, never interpreted
    // (guest files were already dereferenced to bounded content by the pack).
    if (output !== "" && STORIES_JSON_FILE_RE.test(output)) {
      const diagnostic: ValidationDiagnostic = {
        verdict: "reject",
        code: "STORIES_JSON_FILE_UNDEREFERENCED",
        message:
          "output still references a guest file via STORIES_JSON_FILE; the guest helper must dereference it to inline STORIES_JSON before it crosses the bridge",
        missingKeys: [],
        invalidKeys: ["STORIES_JSON_FILE"],
      };
      const evidence = this.readEvidenceRow(stepId);
      if (evidence) {
        this.emitSubmitRejected(evidence, diagnostic as { code: string; missingKeys: string[]; invalidKeys: string[] }, "STORIES_JSON_FILE_UNDEREFERENCED");
      }
      return diagnostic;
    }

    // Native CLI gate: submit-time expects prevalidation runs only for
    // NONEMPTY output. Empty output is handled by native acceptance
    // semantics (completeStep), never pre-rejected here.
    if (output === "") {
      return { verdict: "accept", code: "EXPECTS_SATISFIED", message: "", missingKeys: [], invalidKeys: [] };
    }
    const evidence = this.readEvidenceRow(stepId);
    if (!evidence || !evidence.expects || evidence.expects.trim() === "") {
      return { verdict: "accept", code: "EXPECTS_SATISFIED", message: "", missingKeys: [], invalidKeys: [] };
    }
    const validationError = validateExpects(output, evidence.expects);
    if (validationError) {
      const diagnostic = validationDiagnostic(validationError);
      this.emitSubmitRejected(evidence, diagnostic, "EXPECTS_REJECTED");
      this.emitExpectsValidated(evidence, {
        outcome: "rejected",
        verdict: null,
        diagnosticCode: diagnostic.code,
        missingKeys: diagnostic.missingKeys,
        invalidKeys: diagnostic.invalidKeys,
        transitionAction: "retry",
      });
      return {
        verdict: "reject",
        message: validationError,
        code: diagnostic.code,
        missingKeys: diagnostic.missingKeys,
        invalidKeys: diagnostic.invalidKeys,
      };
    }
    return { verdict: "accept", code: "EXPECTS_SATISFIED", message: "", missingKeys: [], invalidKeys: [] };
  }

  async submitCompletion(
    binding: HostBinding,
    expectedClaimId: string,
    stepId: string,
    output: string,
  ): Promise<CompleteOutcome> {
    await this.gate();
    this.assertBinding(binding);
    // Lifecycle gate after the await and before any evidence read / mutation:
    // a revoked invocation (broker cancel/close/EOF/deadline raced into the
    // service wait) is refused with a genuine no-op outcome — no mutation, no
    // accepted event. The atomic authority guard below re-checks the same
    // state inside completeStep's transaction.
    if (this.lifecycleRefusal(binding) !== null) {
      return { status: "blocked", detail: `invocation ${binding.invocationId} was revoked by the host`, mutated: false };
    }

    // Evidence is captured BEFORE the mutation exactly like the worker CLI
    // captures it, so the accepted expects-validated event carries the
    // pre-completion claim identity. A vanished row is a genuine internal
    // anomaly, not an authority refusal: completeStep throws the native
    // "Step not found" hard error, which propagates (see below).
    const evidence = this.readEvidenceRow(stepId);

    // Unexpected internal failures — native machinery exceptions such as a
    // missing/vanished step row, event-stream write errors or DB errors — are
    // RETHROWN, never mapped to blocked, so the broker's existing SERVICE
    // error channel surfaces them distinctly for production debugging.
    // "blocked" is reserved strictly for authority refusals and genuine
    // native no-ops, which completeStep returns as { status: "blocked" }
    // rather than throwing.
    const result = completeStep(stepId, output, {
      authority: this.authorityGuard(expectedClaimId),
      progressAccess: this.progressResource,
      ...(this.ledgerEvidenceSource ? { ledgerEvidenceSource: this.ledgerEvidenceSource } : {}),
    });
    if (evidence && result.status !== "blocked") {
      const submittedVerdict = output.match(/^STATUS:\s*(done|retry|failed)\s*$/mi)?.[1]?.toLowerCase();
      const verdict = submittedVerdict === "retry" ? "retry" : submittedVerdict === "failed" ? "failed" : "done";
      const transitionAction = result.status === "rerouted"
        ? "reroute"
        : result.status === "retrying"
          ? "retry"
          : result.status === "failed"
            ? "fail"
            : "done";
      this.emitExpectsValidated(evidence, {
        outcome: "accepted",
        verdict,
        diagnosticCode: "EXPECTS_SATISFIED",
        transitionAction,
      });
    }
    const mutated = result.status !== "blocked";
    if (mutated) this.releaseOwnLease(stepId);
    return { status: result.status, detail: result.detail, mutated };
  }

  async submitFail(
    binding: HostBinding,
    expectedClaimId: string,
    stepId: string,
    reason: string,
  ): Promise<FailOutcome> {
    await this.gate();
    this.assertBinding(binding);
    // Lifecycle gate after the await: broker-driven revocation that landed in
    // the service wait refuses before the guarded mutation is even attempted
    // (the failStep entry + post-await re-checks are the atomic second half).
    if (this.lifecycleRefusal(binding) !== null) {
      return { status: "blocked", mutated: false };
    }
    // Unexpected internal failures (native machinery exceptions, e.g. the
    // step row vanishing mid-flight) are RETHROWN with their message intact —
    // never swallowed or mapped to blocked — so the broker's SERVICE error
    // channel surfaces them distinctly. "blocked" is reserved strictly for
    // authority refusals / genuine no-ops, which failStep returns as
    // { status: "blocked" } rather than throwing.
    const result = await failStep(stepId, reason, { authority: this.authorityGuard(expectedClaimId) });
    const mutated = result.status !== "blocked";
    if (mutated) this.releaseOwnLease(stepId);
    return { status: result.status, mutated };
  }

  emit(event: Record<string, unknown>): void {
    this.emitted.push(event);
    this.emitFn(event);
  }
}
