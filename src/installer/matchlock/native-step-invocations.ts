/**
 * Host-only invocation admission/lifetime + active-claim lease registry
 * (MTLK-STEP-REVOKE).
 *
 * Native claim identity in the DB is `claim_job_id` (the scheduler job id,
 * STABLE across rounds) with a second-granular timestamp fallback, so it is
 * NOT a unique invocation lease: two successive harness invocations for the
 * same job share a jobId, and SQLite `datetime('now')` has one-second
 * granularity. Treating jobId equality as a fresh claim generation would let a
 * stale or superseded invocation mutate another invocation's claim.
 *
 * The registry therefore separates TWO host-only lifecycles:
 *
 *   1. INVOCATION ADMISSION/LIFETIME — independent of any held claim. The host
 *      explicitly admits a unique invocation identity ({invocationId, runId,
 *      agentId, jobId}) before that invocation may perform ANY step operation.
 *      Revocation is TERMINAL for that identity for the whole registry scope:
 *      once `revokeInvocation` (cancel / VM close / broker EOF / deadline /
 *      supersede) records an invocation as revoked, neither a guest-facing
 *      claim nor register() nor a second `admitInvocation` can resurrect it.
 *      A revoked identity stays revoked even if it never held a lease
 *      (revocation BEFORE first claim) or lost its claim while a claim was
 *      queued. Only the host admits a FRESH successor identity; the revoked
 *      identity is never re-admitted from guest input.
 *
 *   2. CLAIM LEASE — the single active holder of one authoritative step row.
 *      A lease is registered by the services adapter the moment a claim is
 *      made/adopted; `claimId` (an opaque lease id) is what the broker's fresh
 *      readClaim returns and what the broker hands back as `expectedClaimId`.
 *      `rowToken` mirrors the row's host worker-claim identity (job + worker
 *      pid/pgid + claim timestamp) captured right after the claim, so
 *      mutation-time checks detect host-side release/reassignment of the row
 *      even when the scheduler job id is stable (see native-step-services.ts
 *      hostClaimRowToken).
 *
 * `releaseIfHeldBy` is the LEGITIMATE post-transition release (an accepted
 * completion/fail consumed the claim): it drops only the lease and leaves the
 * invocation admitted. `revokeInvocation`/`revokeStep` are TERMINAL host
 * lifecycle revocations: they additionally mark the invocation dead so a
 * living revoked adapter can never act again. `clear()` discards the ENTIRE
 * registry scope (leases + admissions + revocation records) and permanently
 * refuses further admission/registration — it must only be called when the
 * whole authority scope (one run/agent controller lifetime) is dead, so it can
 * never silently restore a revoked-but-still-constructed service.
 *
 * Bounded teardown: revocation records are per unique host invocation identity
 * within ONE registry scope. A registry is scoped to an invocation/controller
 * authority lifetime and is discarded when that scope dies (clear or GC), so
 * tombstone growth is bounded by the number of distinct invocations admitted
 * in the scope — never unbounded across daemon lifetime. Cross-process
 * persistence of lease/admission state is a controller/coordinator decision
 * (see /root/matchlock-work/native-step-revocation-contract.json); this module
 * deliberately does not invent a weak DB-backed lease or require a schema
 * migration.
 */

/** One host invocation's claim on one authoritative step row. */
export interface InvocationLease {
  /** Steps table row id (bare uuid). */
  stepRowId: string;
  /** Public workflow step id (informational, e.g. "plan"). */
  stepId: string;
  /** Bare run uuid. */
  runId: string;
  agentId: string;
  /** Fresh per-invocation uuid — the unit of authority. */
  invocationId: string;
  /** Scheduler job id (stable across rounds; never used alone as a lease). */
  jobId: string;
  /** Opaque claim identity returned as HostClaim.claimId / expectedClaimId. */
  claimId: string;
  /** Authoritative row claim-identity token captured at claim/adoption time. */
  rowToken: string;
  /** Host clock ms when the lease was registered. */
  claimedAtMs: number;
}

/** Host admission input (host-attested, never guest-supplied). */
export interface InvocationAdmissionInput {
  /** Fresh per-invocation uuid — the unit of authority. */
  invocationId: string;
  runId: string;
  agentId: string;
  jobId: string;
  /** Host clock ms (defaults to Date.now). */
  admittedAtMs?: number;
}

export type InvocationAdmissionState = "admitted" | "revoked";

/** Host-controlled lifetime record for one unique invocation identity. */
export interface InvocationAdmission {
  invocationId: string;
  runId: string;
  agentId: string;
  jobId: string;
  admittedAtMs: number;
  state: InvocationAdmissionState;
  /** Set when state becomes "revoked" (terminal). */
  revokedAtMs?: number;
  revokeReason?: string;
}

export interface LeaseConflict {
  ok: false;
  reason: string;
}

export type RegisterLeaseResult = { ok: true } | LeaseConflict;
export type AdmitResult = { ok: true } | LeaseConflict;

export class HostInvocationRegistry {
  private readonly byStep = new Map<string, InvocationLease>();
  private readonly byInvocation = new Map<string, InvocationLease>();
  private readonly admissions = new Map<string, InvocationAdmission>();
  /** Whole-scope teardown flag: nothing may be admitted/registered after this. */
  private discarded = false;

  /** Number of currently active (registered) leases. */
  get size(): number {
    return this.byStep.size;
  }

  /** Number of admission records (live + revoked) in this registry scope. */
  get admissionCount(): number {
    return this.admissions.size;
  }

  /** Number of terminally revoked invocation identities in this scope. */
  get revocationCount(): number {
    let n = 0;
    for (const a of this.admissions.values()) {
      if (a.state === "revoked") n += 1;
    }
    return n;
  }

  /**
   * HOST admission of a unique invocation identity (run/agent/job scope). Must
   * be called by the host controller BEFORE the invocation performs any step
   * operation. Idempotent for an already-live admission with the same
   * identity; refused for an identity that was terminally revoked (revocation
   * is never undone by guest-facing admission/claim) and after the scope was
   * discarded.
   */
  admitInvocation(input: InvocationAdmissionInput): AdmitResult {
    if (this.discarded) {
      return { ok: false, reason: `registry scope was discarded; invocation ${input.invocationId} cannot be admitted` };
    }
    const existing = this.admissions.get(input.invocationId);
    if (existing) {
      if (existing.state === "revoked") {
        return {
          ok: false,
          reason: `invocation ${input.invocationId} was revoked by the host${
            existing.revokeReason ? ` (${existing.revokeReason})` : ""
          } and cannot be re-admitted`,
        };
      }
      if (
        existing.runId !== input.runId ||
        existing.agentId !== input.agentId ||
        existing.jobId !== input.jobId
      ) {
        return {
          ok: false,
          reason: `invocation ${input.invocationId} is already admitted with a different identity (run ${existing.runId}/agent ${existing.agentId}/job ${existing.jobId})`,
        };
      }
      return { ok: true };
    }
    this.admissions.set(input.invocationId, {
      invocationId: input.invocationId,
      runId: input.runId,
      agentId: input.agentId,
      jobId: input.jobId,
      admittedAtMs: input.admittedAtMs ?? Date.now(),
      state: "admitted",
    });
    return { ok: true };
  }

  /** Admission record for an identity (undefined when the host never admitted it). */
  getAdmission(invocationId: string): InvocationAdmission | undefined {
    return this.admissions.get(invocationId);
  }

  /** True when the host admitted this identity at all (live OR revoked). */
  isInvocationAdmitted(invocationId: string): boolean {
    return this.admissions.has(invocationId);
  }

  /** True when the invocation is ADMITTED and not terminally revoked — independent of any held lease. */
  isInvocationLive(invocationId: string): boolean {
    const a = this.admissions.get(invocationId);
    return a !== undefined && a.state === "admitted";
  }

  /**
   * True when the invocation is a live host admission (admitted and not
   * revoked) — NOT merely "holds a lease". A live invocation may act (claim,
   * peek, mutate its own lease); a revoked one may not, even if a stale
   * reference to it still exists.
   */
  isInvocationActive(invocationId: string): boolean {
    return this.isInvocationLive(invocationId);
  }

  register(lease: InvocationLease): RegisterLeaseResult {
    if (this.discarded) {
      return { ok: false, reason: `registry scope was discarded; invocation ${lease.invocationId} cannot register a lease` };
    }
    const admission = this.admissions.get(lease.invocationId);
    if (!admission || admission.state !== "admitted") {
      return {
        ok: false,
        reason: `invocation ${lease.invocationId} is not a live host admission (revoked or never admitted); it cannot hold a claim`,
      };
    }
    if (
      admission.runId !== lease.runId ||
      admission.agentId !== lease.agentId ||
      admission.jobId !== lease.jobId
    ) {
      return {
        ok: false,
        reason: `invocation ${lease.invocationId} lease identity (run ${lease.runId}/agent ${lease.agentId}/job ${lease.jobId}) does not match its admission`,
      };
    }
    const existingStep = this.byStep.get(lease.stepRowId);
    if (existingStep && existingStep.invocationId !== lease.invocationId) {
      return {
        ok: false,
        reason: `step ${lease.stepRowId} is already actively claimed by invocation ${existingStep.invocationId}`,
      };
    }
    const existingInvocation = this.byInvocation.get(lease.invocationId);
    if (existingInvocation && existingInvocation.stepRowId !== lease.stepRowId) {
      return {
        ok: false,
        reason: `invocation ${lease.invocationId} already holds step ${existingInvocation.stepRowId}`,
      };
    }
    this.byStep.set(lease.stepRowId, lease);
    this.byInvocation.set(lease.invocationId, lease);
    return { ok: true };
  }

  /** Lease currently active for a step row (undefined when unclaimed/unregistered). */
  getLeaseByStep(stepRowId: string): InvocationLease | undefined {
    return this.byStep.get(stepRowId);
  }

  /** Lease currently held by an invocation (an invocation holds at most one step). */
  getLeaseByInvocation(invocationId: string): InvocationLease | undefined {
    return this.byInvocation.get(invocationId);
  }

  /**
   * TERMINAL host lifecycle revocation (VM close / cancel / broker EOF /
   * deadline / supersede of the invocation). Drops the invocation's lease (if
   * any) AND marks the identity revoked forever within this registry scope —
   * including an invocation revoked before its first claim. Revocation alone
   * never mutates the DB row; host orphan recovery re-pends the row when the
   * invocation truly died. Returns the number of leases released.
   */
  revokeInvocation(invocationId: string, reason?: string): number {
    const lease = this.byInvocation.get(invocationId);
    if (lease) {
      this.byInvocation.delete(invocationId);
      this.byStep.delete(lease.stepRowId);
    }
    const existing = this.admissions.get(invocationId);
    if (existing) {
      if (existing.state !== "revoked") {
        existing.state = "revoked";
        existing.revokedAtMs = Date.now();
        if (reason !== undefined) existing.revokeReason = reason;
      }
    } else {
      // Defensive: an identity the host revokes but never admitted is still
      // recorded as terminally revoked so a later admit/claim of the same id
      // can never resurrect guest-facing authority.
      this.admissions.set(invocationId, {
        invocationId,
        runId: lease?.runId ?? "",
        agentId: lease?.agentId ?? "",
        jobId: lease?.jobId ?? "",
        admittedAtMs: lease?.claimedAtMs ?? Date.now(),
        state: "revoked",
        revokedAtMs: Date.now(),
        ...(reason !== undefined ? { revokeReason: reason } : {}),
      });
    }
    return lease ? 1 : 0;
  }

  /**
   * TERMINAL host supersede/reassign of a specific step: drops whatever lease
   * holds the row (e.g. orphan recovery dispatching a successor invocation)
   * AND terminally revokes that holder — the superseded invocation must not
   * re-claim the released row. Returns the released lease when one existed.
   */
  revokeStep(stepRowId: string): InvocationLease | undefined {
    const lease = this.byStep.get(stepRowId);
    if (!lease) return undefined;
    this.byStep.delete(stepRowId);
    this.byInvocation.delete(lease.invocationId);
    this.revokeInvocation(lease.invocationId, `superseded on step ${stepRowId}`);
    return lease;
  }

  /**
   * Release the invocation's own lease for a step after an ACCEPTED transition
   * consumed/released the claim. LEGITIMATE transition release only: the
   * invocation's admission stays live (it is not terminally revoked). No-op
   * when the invocation does not hold that step.
   */
  releaseIfHeldBy(invocationId: string, stepRowId: string): boolean {
    const lease = this.byInvocation.get(invocationId);
    if (!lease || lease.stepRowId !== stepRowId) return false;
    this.byInvocation.delete(invocationId);
    this.byStep.delete(stepRowId);
    return true;
  }

  /**
   * Discard the ENTIRE registry scope (leases + admissions + revocation
   * records). After this the scope refuses all future admission/registration,
   * so clearing leases can never silently restore a living revoked service.
   * Call ONLY when the whole authority scope (one run/agent controller
   * lifetime) is dead; individual legit lease releases go through
   * releaseIfHeldBy.
   */
  clear(): void {
    this.discarded = true;
    this.byStep.clear();
    this.byInvocation.clear();
    this.admissions.clear();
  }
}
