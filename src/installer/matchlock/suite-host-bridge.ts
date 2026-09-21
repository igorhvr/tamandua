/**
 * MTLK-SUITE-WIRE: host suite transport/services bridge for the scoped host
 * broker.
 *
 * This is the host-side object a suite-capable broker is injected with. It is
 * constructed ONLY from immutable controller-admitted scope (run/agent/job/
 * invocation identity, the host-owned explicit Matchlock evidence store, the
 * shared HostInvocationRegistry and the host-admitted environment namespace +
 * admitted repository roots) — never from guest data. Guest requests are only
 * ever validated *and then* delegated to an authoritative HostSuiteService
 * bound to the invocation's CURRENT host lease:
 *
 *   broker suite request
 *     → this bridge resolves the invocation's live registry lease
 *       (registry.getLeaseByInvocation — host state, never guest input)
 *     → builds/rebuilds an immutable HostSuiteService bound to that lease
 *       (stepRowId/stepId/claimId come from the registry lease, the namespace
 *       and roots from the host-admitted scope, the store is host-owned)
 *     → the service re-validates LIVE host admission + current owned step
 *       lease on EVERY op and again immediately before every store mutation,
 *       so close/EOF/cancel/deadline that terminally revokes this invocation
 *       in the shared registry also revokes ALL suite authority: no SQL
 *       mutation can occur after revocation, while an already accepted record
 *       acknowledgement stays truthful.
 *
 * Terminal broker lifetime events additionally call revokeAuthority(reason) —
 * the broker invokes it at most once per broker lifetime — which terminally
 * revokes THIS invocation in the SAME registry the step adapter uses, so a
 * broker whose injected step services are not registry-backed still revokes
 * host suite authority on idle close/EOF/cancel (MTLK-SUITE-WIRE obligation).
 *
 * The bridge NEVER executes command text, Git hooks, arbitrary URLs, admin
 * HTTP/CLI/DB fallback and never reads guest report paths; no host secret /
 * port / worker PID is ever placed in guest routing.
 */

import {
  GUEST_SUITE_NAMESPACE_FIELDS,
  normalizeGuestSuiteNamespace,
  type GuestSuiteCallResult,
  type GuestSuiteClaimRequest,
  type GuestSuiteDurationHistoryRequest,
  type GuestSuiteEventRequest,
  type GuestSuiteLookupRequest,
  type GuestSuiteNamespace,
  type GuestSuiteRecordRequest,
  type GuestSuiteReleaseRequest,
} from "./guest-suite-contract.js";
import { HostInvocationRegistry } from "./native-step-invocations.js";
import { HostSuiteService, type HostSuiteBinding } from "./host-suite-service.js";
import { HostSuiteStore } from "./host-suite-store.js";
import type { SuiteBridgeOp } from "./guest-protocol.js";

export interface HostSuiteBridgeScope {
  /** Fresh per-invocation uuid — the unit of host authority. */
  invocationId: string;
  /** Host run id the invocation belongs to (bare uuid). */
  runId: string;
  /** Host agent id (workflow role). */
  agentId: string;
  /** Scheduler job id (stable identity axis). */
  jobId: string;
  /** Shared host invocation registry (same instance the step adapter uses). */
  registry: HostInvocationRegistry;
  /** Explicit host-owned Matchlock evidence store (never native/live state). */
  store: HostSuiteStore;
  /** Host-admitted environment namespace (immutable; never guest-supplied). */
  namespace: GuestSuiteNamespace;
  /** Canonical realpaths of the admitted origin/work repository roots. */
  admittedRoots: readonly string[];
}

export interface HostSuiteBridge {
  readonly invocationId: string;
  /**
   * Serve one fully wire-validated suite request for this invocation. Resolves
   * null ONLY when the broker should answer a protocol-level error; otherwise
   * resolves the typed GuestSuiteCallResult to carry in the `res` frame.
   */
  serve(op: SuiteBridgeOp, params: Record<string, unknown>): Promise<GuestSuiteCallResult<unknown>>;
  /**
   * Terminal revocation seam — called by the broker at most once per broker
   * lifetime on the first terminal authority event (host close, guest pipe
   * EOF, host cancel-all, in-flight revocation, service deadline), even when
   * the invocation is idle. Terminally revokes this invocation in the shared
   * registry so every later suite op is refused by the authoritative service.
   */
  revokeAuthority(reason: string): void;
}

function frozenNamespace(ns: GuestSuiteNamespace): GuestSuiteNamespace {
  const original = { ...ns };
  const normalized = normalizeGuestSuiteNamespace({ ...ns });
  if (!normalized.ok) {
    throw new Error(`suite host bridge: invalid host-admitted namespace: ${normalized.error}`);
  }
  // The host MUST supply the namespace already canonical: a value that only
  // normalizes after trimming would silently become a DIFFERENT ledger key.
  for (const field of GUEST_SUITE_NAMESPACE_FIELDS) {
    if (normalized.value[field] !== original[field]) {
      throw new Error(`suite host bridge: host-admitted namespace field "${field}" must be supplied already canonical (no trim-able padding)`);
    }
  }
  return Object.freeze({ ...normalized.value });
}

/**
 * Build the host suite transport/services bridge for one invocation from the
 * immutable host-admitted scope. Throws on invalid scope (host configuration
 * error — fail closed, never silently serve suite ops).
 */
export function createHostSuiteBridge(scope: HostSuiteBridgeScope): HostSuiteBridge {
  const namespace = frozenNamespace(scope.namespace);
  const admittedRoots = Object.freeze([...scope.admittedRoots]);
  const registry = scope.registry;
  if (!(registry instanceof HostInvocationRegistry)) {
    throw new Error("suite host bridge requires a HostInvocationRegistry");
  }
  if (!(scope.store instanceof HostSuiteStore) || !scope.store.isOpen) {
    throw new Error("suite host bridge requires an open HostSuiteStore");
  }
  const scopeIds: ReadonlyArray<readonly [string, string]> = [
    ["invocationId", scope.invocationId],
    ["runId", scope.runId],
    ["agentId", scope.agentId],
    ["jobId", scope.jobId],
  ];
  for (const [name, value] of scopeIds) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`suite host bridge scope field "${name}" must be a non-empty string`);
    }
  }

  // Cache one authoritative service per (stepRowId@claimId): rebuilding for
  // every request is safe (registerNamespace is INSERT OR IGNORE) but wasteful;
  // a fresh lease (successor claim) yields a fresh immutable binding.
  const servicesByLease = new Map<string, HostSuiteService>();

  /**
   * Resolve the invocation's CURRENT host lease into an authoritative
   * HostSuiteService (host state only — never guest input). Returns a refusal
   * when the invocation is not admitted or holds no live owned step lease.
   */
  const resolveService = (): { service: HostSuiteService } | { refusal: GuestSuiteCallResult<unknown> } => {
    const admission = registry.getAdmission(scope.invocationId);
    if (!admission || admission.state !== "admitted") {
      return {
        refusal: {
          ok: false,
          reason: "refused",
          code: "DENIED",
          message: "host invocation is not admitted (never admitted or terminally revoked) — suite authority refused",
        },
      };
    }
    const lease = registry.getLeaseByInvocation(scope.invocationId);
    if (!lease) {
      return {
        refusal: {
          ok: false,
          reason: "refused",
          code: "DENIED",
          message: "host invocation holds no current owned step lease — suite authority refused",
        },
      };
    }
    const leaseId = `${lease.stepRowId}@${lease.claimId}`;
    let service = servicesByLease.get(leaseId);
    if (!service) {
      const binding: HostSuiteBinding = {
        runId: lease.runId,
        agentId: lease.agentId,
        jobId: lease.jobId,
        invocationId: lease.invocationId,
        stepRowId: lease.stepRowId,
        stepId: lease.stepId,
        namespace,
        admittedRoots,
        registry,
        expectedClaimId: lease.claimId,
      };
      service = new HostSuiteService({ store: scope.store, binding });
      servicesByLease.set(leaseId, service);
    }
    return { service };
  };

  return {
    invocationId: scope.invocationId,
    async serve(op, params): Promise<GuestSuiteCallResult<unknown>> {
      const resolved = resolveService();
      if ("refusal" in resolved) return resolved.refusal;
      const service = resolved.service;
      try {
        switch (op) {
          case "suite.lookup":
            return (await service.lookup(params as unknown as GuestSuiteLookupRequest)) as GuestSuiteCallResult<unknown>;
          case "suite.claim":
            return (await service.claim(params as unknown as GuestSuiteClaimRequest)) as GuestSuiteCallResult<unknown>;
          case "suite.record":
            return (await service.record(params as unknown as GuestSuiteRecordRequest)) as GuestSuiteCallResult<unknown>;
          case "suite.release":
            return (await service.release(params as unknown as GuestSuiteReleaseRequest)) as GuestSuiteCallResult<unknown>;
          case "suite.duration-history":
            return (await service.durationHistory(params as unknown as GuestSuiteDurationHistoryRequest)) as GuestSuiteCallResult<unknown>;
          case "suite.event":
            return (await service.emitEvent(params as unknown as GuestSuiteEventRequest)) as GuestSuiteCallResult<unknown>;
          default:
            return { ok: false, reason: "refused", code: "UNSUPPORTED", message: `unsupported suite op: ${String(op)}` };
        }
      } catch (err) {
        // Never leak raw SQL/config/credentials across the boundary.
        return {
          ok: false,
          reason: "unavailable",
          message: `host suite service operation failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    revokeAuthority(reason: string): void {
      try {
        servicesByLease.clear();
        registry.revokeInvocation(scope.invocationId, reason);
      } catch {
        /* registry revocation is host-owned; failures must not break the broker */
      }
    },
  };
}
