/**
 * MTLK host suite: authoritative host-side adapter for the SIX
 * GuestSuiteTransport operations, backed by the explicit host-owned
 * Matchlock evidence store (host-suite-store.ts).
 *
 * Host semantics implemented here (design sections 7.2/8; MTLK-SUITE-HOST):
 *
 *   - The constructor binds IMMUTABLE copies of the host-admitted namespace
 *     (image content / guest platform / helper contract / nonsecret
 *     compatibility fingerprint), the run/agent/job/invocation identity, the
 *     admitted origin/work roots, the HostInvocationRegistry and the current
 *     owned step lease (stepRowId) the invocation must still hold. Guest
 *     identity/PID is never trusted: a guest PID is not host authority, and
 *     no request can broaden the bound run/step/namespace/roots.
 *   - Every request is validated at the host boundary (shape/size/type,
 *     finite numerics, byte-bounded log tail and cmd display, permitted
 *     suite events) and bound to the LIVE host admission + currently owned
 *     step lease before any store mutation. Normalization never mutates the
 *     caller's object and never silently shortens a namespace into a
 *     different key.
 *   - Guest origin/path is ONLY a key confined to the exact admitted roots;
 *     it is never dereferenced as a host command/path. There is no host
 *     Git/hooks/signing/shell execution, no daemon secret/loopback, no
 *     general URL proxy, no owner-wide guest release/heartbeat and no
 *     process liveness check by guest PID.
 *   - Mutation validation stays adjacent to commit: if an injected async
 *     gate (serviceDelayMs, tests) awaits between validation and commit, the
 *     authority/admission/lease state is re-validated after the await and
 *     before the SQL mutation. Accepted acknowledgments are never erased by
 *     cancellation. Revoked / idle-closed identities can never regain
 *     authority (registry.isInvocationLive is the host authority; store rows
 *     never re-admit anyone).
 *   - Errors returned to the engine are bounded and nonsecret: no raw SQL /
 *     config / credentials cross this boundary.
 *
 * This service is NOT socket/pack/scheduler wiring — it is the exported typed
 * service component (actual rows, actual registry lease verification) that a
 * later broker/socket integration binds behind an immutable invocation.
 */

import {
  CMD_DISPLAY_MAX_BYTES,
  GUEST_SUITE_TRANSPORT_VERSION,
  LOG_TAIL_BYTES,
  MAX_SUITE_REQUEST_TIMEOUT_MS,
  guestSuiteNamespaceId,
  isPermittedSuiteEvent,
  normalizeGuestSuiteNamespace,
  paramsMatchSuiteOp,
  responseNamespaceMatches,
  type GuestSuiteCallResult,
  type GuestSuiteClaimRequest,
  type GuestSuiteClaimResult,
  type GuestSuiteDurationHistoryRequest,
  type GuestSuiteDurationHistoryResult,
  type GuestSuiteEventRequest,
  type GuestSuiteEventResult,
  type GuestSuiteLatestRow,
  type GuestSuiteLookupRequest,
  type GuestSuiteLookupResult,
  type GuestSuiteNamespace,
  type GuestSuiteRecordRequest,
  type GuestSuiteRecordResult,
  type GuestSuiteReleaseRequest,
  type GuestSuiteReleaseResult,
  type GuestSuiteTransport,
  type SuiteTransportOp,
} from "./guest-suite-contract.js";
import { HostInvocationRegistry } from "./native-step-invocations.js";
import { admittedRootMatches } from "./repository-scope.js";
import {
  HostSuiteClaimOwnerMismatchError,
  HostSuiteMismatchedRetryError,
  HostSuiteStore,
  HostSuiteStoreError,
  boundEventFieldsJson,
  type HostSuiteLedgerKey,
} from "./host-suite-store.js";

// ── Host-side field bounds (mirror the guest/contract tunables) ────────

/** Run/step attribution string bound (ids are short host/workflow tokens). */
export const HOST_RUN_STEP_ID_MAX_BYTES = 256;
/** Exact-owner claim token bound (guest mints a uuid). */
export const HOST_OWNER_TOKEN_MAX_BYTES = 128;
/** Admitted origin repository path bound (key field, never dereferenced). */
export const HOST_ORIGIN_REPO_MAX_BYTES = 4096;
/** Tree hash / command hash are 40- and 64-hex SHA strings. */
const TREE_HASH_RE = /^[0-9a-f]{40}$/;
const CMD_HASH_RE = /^[0-9a-f]{64}$/;
/** A startedAt that must parse to a finite UTC instant. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export interface HostSuiteServiceOptions {
  /** Explicit host-owned evidence store (never native/live state). */
  store: HostSuiteStore;
  /** Immutable host-admitted binding for ONE invocation. */
  binding: HostSuiteBinding;
  /**
   * Optional uniform async gate (ms) before every store mutation so host
   * revocation/cancellation between validation and commit is deterministic
   * in tests. Off (0) in production — the sync path validates adjacent to
   * commit anyway.
   */
  serviceDelayMs?: number;
}

/**
 * Immutable host-supplied binding for one host invocation. Constructed once
 * by the host (controller/scheduler), validated + copied by
 * validateHostSuiteBinding — never assembled from guest input.
 */
export interface HostSuiteBinding {
  /** Host run id (uuid) the invocation belongs to. */
  runId: string;
  /** Host agent id (workflow role). */
  agentId: string;
  /** Scheduler job id (stable across rounds; identity axis only). */
  jobId: string;
  /** Fresh per-invocation uuid — the unit of host authority. */
  invocationId: string;
  /** Bare steps-table row id this invocation currently owns. */
  stepRowId: string;
  /** Public workflow step id (informational). */
  stepId: string;
  /**
   * Host-admitted environment namespace (image content id / guest platform /
   * helper contract / nonsecret compatibility fingerprint). The service
   * serves ONLY this namespace and echoes its canonical id on every answer.
   */
  namespace: GuestSuiteNamespace;
  /**
   * Admitted origin/work repository roots (US-001 records BOTH the exact host
   * spelling and the canonical realpath; US-002 admits EITHER spelling by
   * realpath identity). A request can never broaden them.
   */
  admittedRoots: readonly string[];
  /**
   * Host invocation registry for this (run, agent) authority lifetime. Live
   * admission + the current owned step lease are verified on EVERY op.
   */
  registry: HostInvocationRegistry;
  /** Optional expected lease claimId (stricter host seam). */
  expectedClaimId?: string;
}

/** Refusal detail for one request (bounded, nonsecret). */
export interface HostSuiteRefusal {
  code: "BAD_REQUEST" | "OVERSIZED" | "WRONG_NAMESPACE" | "DENIED" | "UNSUPPORTED" | "SERVICE";
  message: string;
}

function bytes(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

/**
 * Validate + normalize a HOST-side binding. Returns the immutable normalized
 * binding or a bounded refusal detail. Never mutates the input objects.
 */
export function validateHostSuiteBinding(
  input: HostSuiteBinding,
): { ok: true; value: HostSuiteBinding } | { ok: false; error: string } {
  const idFields: Array<[string, string]> = [
    ["runId", input.runId],
    ["agentId", input.agentId],
    ["jobId", input.jobId],
    ["invocationId", input.invocationId],
    ["stepRowId", input.stepRowId],
    ["stepId", input.stepId],
  ];
  for (const [name, value] of idFields) {
    if (typeof value !== "string" || value.length === 0 || bytes(value) > HOST_RUN_STEP_ID_MAX_BYTES) {
      return { ok: false, error: `host suite binding field "${name}" must be a non-empty string ≤ ${HOST_RUN_STEP_ID_MAX_BYTES} bytes` };
    }
  }
  if (typeof input.admittedRoots !== "object" || input.admittedRoots.length === 0) {
    return { ok: false, error: "host suite binding requires at least one admitted origin/work root" };
  }
  for (const root of input.admittedRoots) {
    if (typeof root !== "string" || root.length === 0 || bytes(root) > HOST_ORIGIN_REPO_MAX_BYTES) {
      return { ok: false, error: `host suite binding admitted root must be a non-empty string ≤ ${HOST_ORIGIN_REPO_MAX_BYTES} bytes` };
    }
  }
  if (!(input.registry instanceof HostInvocationRegistry)) {
    return { ok: false, error: "host suite binding registry must be a HostInvocationRegistry" };
  }
  const normalized = normalizeGuestSuiteNamespace({ ...input.namespace });
  if (!normalized.ok) {
    return { ok: false, error: `host suite binding namespace is invalid: ${normalized.error}` };
  }
  // Never silently shorten a namespace into a different key: reject any field
  // the normalizer would have trimmed.
  const raw = input.namespace;
  if (
    normalized.value.imageContentId !== raw.imageContentId
    || normalized.value.guestPlatform !== raw.guestPlatform
    || normalized.value.helperContract !== raw.helperContract
    || normalized.value.compatibilityFingerprint !== raw.compatibilityFingerprint
  ) {
    return { ok: false, error: "host suite binding namespace must be supplied already canonical (no trim-able padding)" };
  }
  return {
    ok: true,
    value: {
      runId: input.runId,
      agentId: input.agentId,
      jobId: input.jobId,
      invocationId: input.invocationId,
      stepRowId: input.stepRowId,
      stepId: input.stepId,
      namespace: Object.freeze({ ...normalized.value }),
      admittedRoots: Object.freeze([...input.admittedRoots]),
      registry: input.registry,
      ...(input.expectedClaimId !== undefined ? { expectedClaimId: input.expectedClaimId } : {}),
    },
  };
}

/** Shallow frozen copy of a binding (constructor stores this immutable value). */
function freezeBinding(binding: HostSuiteBinding): HostSuiteBinding {
  return {
    runId: binding.runId,
    agentId: binding.agentId,
    jobId: binding.jobId,
    invocationId: binding.invocationId,
    stepRowId: binding.stepRowId,
    stepId: binding.stepId,
    namespace: binding.namespace,
    admittedRoots: binding.admittedRoots,
    registry: binding.registry,
    ...(binding.expectedClaimId !== undefined ? { expectedClaimId: binding.expectedClaimId } : {}),
  };
}

function isoOf(raw: string): boolean {
  if (!ISO_RE.test(raw)) return false;
  const t = Date.parse(raw);
  return Number.isFinite(t);
}

/**
 * Authoritative host-side implementation of the six-op GuestSuiteTransport.
 *
 * One service instance = ONE host invocation = ONE immutable binding. It is
 * constructed by host code and handed to the guest suite engine (later: the
 * broker/socket integration); a guest never constructs or re-binds it.
 */
export class HostSuiteService implements GuestSuiteTransport {
  readonly contractVersion = GUEST_SUITE_TRANSPORT_VERSION;
  readonly namespace: GuestSuiteNamespace;
  readonly binding: HostSuiteBinding;
  private readonly store: HostSuiteStore;
  private readonly delayMs: number;

  constructor(opts: HostSuiteServiceOptions) {
    const validated = validateHostSuiteBinding(opts.binding);
    if (!validated.ok) {
      throw new Error(`HostSuiteService: ${validated.error}`);
    }
    if (!(opts.store instanceof HostSuiteStore) || !opts.store.isOpen) {
      throw new Error("HostSuiteService: an open HostSuiteStore is required");
    }
    this.binding = freezeBinding(validated.value);
    this.namespace = this.binding.namespace;
    this.store = opts.store;
    this.delayMs = opts.serviceDelayMs ?? 0;
    // Register the host-admitted namespace row up front so later lookups are
    // served under the canonical id and no guest op can (re)define it.
    this.store.registerNamespace(this.namespace);
  }

  private get namespaceId(): string {
    return guestSuiteNamespaceId(this.binding.namespace);
  }

  // ── authority guards ─────────────────────────────────────────────────

  /**
   * LIVE host admission + current owned step lease verification. The lease
   * must still be held by THIS invocation for THIS step row; revoked /
   * superseded / never-admitted identities are refused. Called at the START
   * of every op and AGAIN immediately before each store mutation (revalidate
   * after any injected await).
   */
  private authorityRefusal(): HostSuiteRefusal | null {
    const b = this.binding;
    const registry = b.registry;
    const admission = registry.getAdmission(b.invocationId);
    if (!admission) {
      return { code: "DENIED", message: "invocation was never admitted by the host" };
    }
    if (admission.state !== "admitted") {
      return { code: "DENIED", message: "invocation was revoked by the host and cannot act" };
    }
    if (admission.runId !== b.runId || admission.agentId !== b.agentId || admission.jobId !== b.jobId) {
      return { code: "DENIED", message: "invocation admission identity does not match the host binding" };
    }
    const lease = registry.getLeaseByStep(b.stepRowId);
    if (!lease) {
      return { code: "DENIED", message: "invocation holds no active lease for its current step" };
    }
    if (lease.invocationId !== b.invocationId) {
      return { code: "DENIED", message: "current step is claimed by another invocation" };
    }
    if (lease.runId !== b.runId || lease.agentId !== b.agentId || lease.jobId !== b.jobId) {
      return { code: "DENIED", message: "current step lease identity does not match the host binding" };
    }
    if (b.expectedClaimId !== undefined && lease.claimId !== b.expectedClaimId) {
      return { code: "DENIED", message: "current step lease claim id does not match the host binding" };
    }
    return null;
  }

  /** Re-run authority + binding checks synchronously right before a mutation. */
  private preMutationCheck(): HostSuiteRefusal | null {
    return this.authorityRefusal();
  }

  private async gate(): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    }
  }

  // ── request validation helpers ───────────────────────────────────────

  private validateKeyShape(req: Record<string, unknown>, op: SuiteTransportOp): HostSuiteRefusal | null {
    if (!paramsMatchSuiteOp(op, req)) {
      return { code: "BAD_REQUEST", message: `request shape does not match ${op}` };
    }
    const originRepo = String(req.originRepo);
    const treeHash = String(req.treeHash ?? "");
    const cmdHash = String(req.cmdHash ?? "");
    if (originRepo.length === 0 || bytes(originRepo) > HOST_ORIGIN_REPO_MAX_BYTES) {
      return { code: "OVERSIZED", message: "origin_repo is empty or exceeds the host bound" };
    }
    if (op !== "suite.duration-history") {
      if (!TREE_HASH_RE.test(treeHash)) {
        return { code: "BAD_REQUEST", message: "tree_hash must be a 40-hex committed/tracked tree hash" };
      }
    }
    if (!CMD_HASH_RE.test(cmdHash)) {
      return { code: "BAD_REQUEST", message: "cmd_hash must be the 64-hex SHA-256 of the exact raw command" };
    }
    return null;
  }

  /**
   * Origin key must be confined to the admitted roots — by realpath identity,
   * never string equality alone: the policy records the EXACT host spelling of
   * a work/evidence root (the spelling the guest sees as its cwd) and records
   * the canonical target separately, so a symlink-spelled `originRepo` must be
   * admitted when it resolves to the same root. The ORIGIN IS NEVER
   * CANONICALIZED: it stays the guest-presented spelling and remains the exact
   * ledger key (host-suite-store). Any root that is not realpath-identical to
   * an admitted root is still refused with the same DENIED message.
   */
  private rootRefusal(originRepo: string): HostSuiteRefusal | null {
    if (!admittedRootMatches(originRepo, this.binding.admittedRoots)) {
      return { code: "DENIED", message: "origin_repo is not one of this invocation's admitted repository roots" };
    }
    return null;
  }

  /**
   * Request namespace must equal the bound host-admitted namespace. The
   * request object is COPIED before normalization (no caller mutation) and a
   * namespace that normalizes into a different key is refused.
   */
  private namespaceRefusal(ns: GuestSuiteNamespace | undefined): HostSuiteRefusal | null {
    if (ns === undefined || typeof ns !== "object") {
      return { code: "BAD_REQUEST", message: "missing suite namespace" };
    }
    const normalized = normalizeGuestSuiteNamespace({ ...ns });
    if (!normalized.ok) {
      const oversized = [
        ["imageContentId", 256],
        ["guestPlatform", 64],
        ["helperContract", 128],
        ["compatibilityFingerprint", 64],
      ].some(([field, max]) => {
        const raw = (ns as unknown as Record<string, unknown>)[field as string];
        return typeof raw === "string" && bytes(raw) > (max as number);
      });
      return {
        code: oversized ? "OVERSIZED" : "BAD_REQUEST",
        message: `invalid suite namespace: ${normalized.error}`,
      };
    }
    if (guestSuiteNamespaceId(normalized.value) !== this.namespaceId) {
      return {
        code: "WRONG_NAMESPACE",
        message: "suite request namespace does not match this invocation's host-admitted namespace",
      };
    }
    return null;
  }

  /** runId/stepId/invocationId in a request can never broaden the binding. */
  private idBroadeningRefusal(reqRunId: unknown, reqStepId: unknown, reqInvocationId?: unknown): HostSuiteRefusal | null {
    const b = this.binding;
    if (reqRunId !== undefined && reqRunId !== null && String(reqRunId).length > 0 && String(reqRunId) !== b.runId) {
      return { code: "DENIED", message: "request run id does not match the host-bound run" };
    }
    if (reqStepId !== undefined && reqStepId !== null && String(reqStepId).length > 0 && String(reqStepId) !== b.stepId) {
      return { code: "DENIED", message: "request step id does not match the host-bound step" };
    }
    if (reqInvocationId !== undefined && reqInvocationId !== null && String(reqInvocationId).length > 0 && String(reqInvocationId) !== b.invocationId) {
      return { code: "DENIED", message: "request invocation id does not match the host-bound invocation" };
    }
    return null;
  }

  private storeKey(
    req: { originRepo: unknown; treeHash: unknown; cmdHash: unknown },
  ): HostSuiteLedgerKey {
    return {
      namespaceId: this.namespaceId,
      originRepo: String(req.originRepo),
      treeHash: String(req.treeHash),
      cmdHash: String(req.cmdHash),
    };
  }

  /**
   * Map a store exception into a bounded, nonsecret transport failure.
   * Known ownership/retry conflicts are REFUSED (DENIED) — they must never
   * be silently acked or recorded under the wrong identity. IO/closed store
   * and any unknown internal error degrade as UNAVAILABLE (never raw SQL /
   * config / credentials cross this boundary).
   */
  private mapFailure<T>(err: unknown): GuestSuiteCallResult<T> {
    if (err instanceof HostSuiteClaimOwnerMismatchError) {
      return { ok: false, reason: "refused", code: "DENIED", message: "suite claim is owned by another caller" };
    }
    if (err instanceof HostSuiteMismatchedRetryError) {
      return { ok: false, reason: "refused", code: "DENIED", message: "a different suite record for this invocation/execution was already accepted; mismatched retry refused" };
    }
    if (err instanceof HostSuiteStoreError && (err.code === "IO" || err.code === "CLOSED")) {
      return { ok: false, reason: "unavailable", message: "host suite store is unavailable" };
    }
    if (err instanceof HostSuiteStoreError && err.code === "BAD_STATE") {
      return { ok: false, reason: "unavailable", message: "host suite store rejected the request" };
    }
    // Unknown internal error — bounded and nonsecret (never raw SQL).
    return { ok: false, reason: "unavailable", message: "host suite store operation failed" };
  }

  // ── GuestSuiteTransport ops ──────────────────────────────────────────

  async lookup(req: GuestSuiteLookupRequest, _timeoutMs?: number): Promise<GuestSuiteCallResult<GuestSuiteLookupResult>> {
    const shape = this.validateKeyShape(req as unknown as Record<string, unknown>, "suite.lookup")
      ?? this.namespaceRefusal(req.namespace)
      ?? this.rootRefusal(String(req.originRepo));
    if (shape) return { ok: false, reason: "refused", code: shape.code, message: shape.message };
    const auth = this.authorityRefusal();
    if (auth) return { ok: false, reason: "refused", code: auth.code, message: auth.message };
    const key = this.storeKey(req);
    let latest: GuestSuiteLatestRow | null;
    let passCount: number;
    let failCount: number;
    let flaky: boolean;
    try {
      const outcome = this.store.lookup(key);
      latest = outcome.latest as GuestSuiteLatestRow | null;
      passCount = outcome.passCount;
      failCount = outcome.failCount;
      flaky = outcome.flaky;
    } catch (err) {
      return this.mapFailure(err);
    }
    return { ok: true, value: { namespaceId: this.namespaceId, latest, passCount, failCount, flaky } };
  }

  async claim(req: GuestSuiteClaimRequest, _timeoutMs?: number): Promise<GuestSuiteCallResult<GuestSuiteClaimResult>> {
    const shape = this.validateKeyShape(req as unknown as Record<string, unknown>, "suite.claim")
      ?? this.namespaceRefusal(req.namespace)
      ?? this.rootRefusal(String(req.originRepo))
      ?? this.idBroadeningRefusal(req.runId, req.stepId, req.invocationId);
    if (shape) return { ok: false, reason: "refused", code: shape.code, message: shape.message };
    if (typeof req.ownerToken !== "string" || req.ownerToken.length === 0 || bytes(req.ownerToken) > HOST_OWNER_TOKEN_MAX_BYTES) {
      return { ok: false, reason: "refused", code: "OVERSIZED", message: "owner_token must be a bounded non-empty token" };
    }
    const auth = this.authorityRefusal();
    if (auth) return { ok: false, reason: "refused", code: auth.code, message: auth.message };
    await this.gate();
    // Revalidate after any await, immediately before the SQL mutation.
    const postGate = this.preMutationCheck()
      ?? this.namespaceRefusal(req.namespace)
      ?? this.idBroadeningRefusal(req.runId, req.stepId, req.invocationId);
    if (postGate) return { ok: false, reason: "refused", code: postGate.code, message: postGate.message };
    const b = this.binding;
    let outcome: { action: "run" | "wait"; claimedAt: string };
    try {
      outcome = this.store.claim(
        {
          ...this.storeKey(req),
          ownerToken: req.ownerToken,
          ...(req.runId ? { runId: req.runId } : {}),
          ...(req.stepId ? { stepId: req.stepId } : {}),
          invocationId: b.invocationId,
          agentId: b.agentId,
          jobId: b.jobId,
        },
        // Explicit owner-death predicate grounded in the host registry: a
        // claim is dead ONLY when its owner is known to this registry scope
        // and terminally revoked — never by PID, never by mere absence.
        (ownerInvocationId: string) => {
          if (ownerInvocationId === b.invocationId) return !b.registry.isInvocationLive(ownerInvocationId);
          const admission = b.registry.getAdmission(ownerInvocationId);
          return admission !== undefined && admission.state !== "admitted";
        },
      );
    } catch (err) {
      return this.mapFailure(err);
    }
    return {
      ok: true,
      value: { namespaceId: this.namespaceId, action: outcome.action, claimedAt: outcome.claimedAt },
    };
  }

  async record(req: GuestSuiteRecordRequest, _timeoutMs?: number): Promise<GuestSuiteCallResult<GuestSuiteRecordResult>> {
    const shape = this.validateKeyShape(req as unknown as Record<string, unknown>, "suite.record")
      ?? this.namespaceRefusal(req.namespace)
      ?? this.rootRefusal(String(req.originRepo))
      ?? this.idBroadeningRefusal(req.runId, req.stepId);
    if (shape) return { ok: false, reason: "refused", code: shape.code, message: shape.message };
    // Field-level host boundary checks (finite numerics, byte bounds).
    if (typeof req.cmdDisplay !== "string" || req.cmdDisplay.length === 0 || bytes(req.cmdDisplay) > CMD_DISPLAY_MAX_BYTES) {
      return { ok: false, reason: "refused", code: "OVERSIZED", message: `cmd_display must be ≤ ${CMD_DISPLAY_MAX_BYTES} bytes` };
    }
    if (!Number.isInteger(req.exitCode) || req.exitCode < 0 || req.exitCode > 255) {
      return { ok: false, reason: "refused", code: "BAD_REQUEST", message: "exit_code must be an integer in the real [0, 255] range" };
    }
    if (!Number.isSafeInteger(req.durationMs) || req.durationMs < 0) {
      return { ok: false, reason: "refused", code: "BAD_REQUEST", message: "duration_ms must be a finite non-negative integer" };
    }
    if (req.logTail !== null && (typeof req.logTail !== "string" || bytes(req.logTail) > LOG_TAIL_BYTES)) {
      return { ok: false, reason: "refused", code: "OVERSIZED", message: `log_tail must be ≤ ${LOG_TAIL_BYTES} bytes` };
    }
    if (req.runId !== null && typeof req.runId !== "string") {
      return { ok: false, reason: "refused", code: "BAD_REQUEST", message: "run_id must be a string or null" };
    }
    if (req.stepId !== null && typeof req.stepId !== "string") {
      return { ok: false, reason: "refused", code: "BAD_REQUEST", message: "step_id must be a string or null" };
    }
    if (typeof req.startedAt !== "string" || !isoOf(req.startedAt)) {
      return { ok: false, reason: "refused", code: "BAD_REQUEST", message: "started_at must be a finite UTC ISO instant" };
    }
    const auth = this.authorityRefusal();
    if (auth) return { ok: false, reason: "refused", code: auth.code, message: auth.message };
    await this.gate();
    const postGate = this.preMutationCheck()
      ?? this.namespaceRefusal(req.namespace)
      ?? this.idBroadeningRefusal(req.runId, req.stepId);
    if (postGate) return { ok: false, reason: "refused", code: postGate.code, message: postGate.message };
    const b = this.binding;
    let outcome: { id: number; createdAt: string; inserted: boolean };
    try {
      outcome = this.store.record({
        ...this.storeKey(req),
        cmdDisplay: req.cmdDisplay,
        exitCode: req.exitCode,
        durationMs: req.durationMs,
        logTail: req.logTail,
        runId: req.runId,
        stepId: req.stepId,
        startedAt: req.startedAt,
        invocationId: b.invocationId,
        agentId: b.agentId,
        jobId: b.jobId,
        force: req.force === true,
      });
    } catch (err) {
      return this.mapFailure(err);
    }
    return { ok: true, value: { namespaceId: this.namespaceId, id: outcome.id, created_at: outcome.createdAt } };
  }

  async release(req: GuestSuiteReleaseRequest, _timeoutMs?: number): Promise<GuestSuiteCallResult<GuestSuiteReleaseResult>> {
    const shape = this.validateKeyShape(req as unknown as Record<string, unknown>, "suite.release")
      ?? this.namespaceRefusal(req.namespace)
      ?? this.rootRefusal(String(req.originRepo));
    if (shape) return { ok: false, reason: "refused", code: shape.code, message: shape.message };
    if (typeof req.ownerToken !== "string" || req.ownerToken.length === 0 || bytes(req.ownerToken) > HOST_OWNER_TOKEN_MAX_BYTES) {
      return { ok: false, reason: "refused", code: "OVERSIZED", message: "owner_token must be a bounded non-empty token" };
    }
    const auth = this.authorityRefusal();
    if (auth) return { ok: false, reason: "refused", code: auth.code, message: auth.message };
    await this.gate();
    const postGate = this.preMutationCheck()
      ?? this.namespaceRefusal(req.namespace)
      ?? this.rootRefusal(String(req.originRepo));
    if (postGate) return { ok: false, reason: "refused", code: postGate.code, message: postGate.message };
    try {
      const outcome = this.store.release({
        ...this.storeKey(req),
        ownerToken: req.ownerToken,
        invocationId: this.binding.invocationId,
        ...(typeof req.reason === "string" && req.reason.length > 0 ? { reason: req.reason } : {}),
      });
      return { ok: true, value: { namespaceId: this.namespaceId, released: outcome.released } };
    } catch (err) {
      return this.mapFailure(err);
    }
  }

  async durationHistory(
    req: GuestSuiteDurationHistoryRequest,
    _timeoutMs?: number,
  ): Promise<GuestSuiteCallResult<GuestSuiteDurationHistoryResult>> {
    const shape = this.validateKeyShape(req as unknown as Record<string, unknown>, "suite.duration-history")
      ?? this.namespaceRefusal(req.namespace)
      ?? this.rootRefusal(String(req.originRepo));
    if (shape) return { ok: false, reason: "refused", code: shape.code, message: shape.message };
    const auth = this.authorityRefusal();
    if (auth) return { ok: false, reason: "refused", code: auth.code, message: auth.message };
    const key = { namespaceId: this.namespaceId, originRepo: String(req.originRepo), cmdHash: String(req.cmdHash) };
    let durations: number[];
    try {
      durations = this.store.durationHistory(key);
    } catch (err) {
      return this.mapFailure(err);
    }
    return { ok: true, value: { namespaceId: this.namespaceId, durations } };
  }

  async emitEvent(req: GuestSuiteEventRequest, _timeoutMs?: number): Promise<GuestSuiteCallResult<GuestSuiteEventResult>> {
    if (!isPermittedSuiteEvent(req.event)) {
      return { ok: false, reason: "refused", code: "UNSUPPORTED", message: `${req.event} is not a permitted suite event` };
    }
    const nsRefusal = this.namespaceRefusal(req.namespace);
    if (nsRefusal) return { ok: false, reason: "refused", code: nsRefusal.code, message: nsRefusal.message };
    if (typeof req.runId !== "string") {
      return { ok: false, reason: "refused", code: "BAD_REQUEST", message: "suite event requires a run id" };
    }
    const broaden = this.idBroadeningRefusal(req.runId, req.stepId);
    if (broaden) return { ok: false, reason: "refused", code: broaden.code, message: broaden.message };
    const auth = this.authorityRefusal();
    if (auth) return { ok: false, reason: "refused", code: auth.code, message: auth.message };
    await this.gate();
    const postGate = this.preMutationCheck() ?? this.namespaceRefusal(req.namespace);
    if (postGate) return { ok: false, reason: "refused", code: postGate.code, message: postGate.message };
    let fieldsJson: string | null;
    try {
      fieldsJson = boundEventFieldsJson(req.fields);
    } catch (err) {
      if (err instanceof HostSuiteStoreError) {
        // Oversized AFTER successful serialization is a size-limit refusal.
        return { ok: false, reason: "refused", code: "OVERSIZED", message: "suite event fields exceed the bounded size limit" };
      }
      // JSON.stringify itself threw (circular reference / unsupported value):
      // a malformed request, not an oversize one — labeled honestly BAD_REQUEST.
      return { ok: false, reason: "refused", code: "BAD_REQUEST", message: "suite event fields cannot be serialized (circular reference or unsupported value)" };
    }
    try {
      this.store.emitEvent({
        namespaceId: this.namespaceId,
        event: req.event,
        runId: req.runId,
        ...(req.stepId ? { stepId: req.stepId } : {}),
        fieldsJson,
        createdAt: new Date(this.store.now()).toISOString(),
      });
    } catch (err) {
      return this.mapFailure(err);
    }
    return { ok: true, value: { namespaceId: this.namespaceId, emitted: true } };
  }
}

/**
 * True when a transport answer's echoed namespace matches the request's
 * namespace (helper the guest engine already uses; exported for wiring).
 */
export { responseNamespaceMatches };

/** Re-exported host-side bound on per-op deadlines (contract parity). */
export const HOST_SUITE_MAX_REQUEST_TIMEOUT_MS = MAX_SUITE_REQUEST_TIMEOUT_MS;
