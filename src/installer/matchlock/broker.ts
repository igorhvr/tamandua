/**
 * Scoped host broker for one Matchlock harness invocation.
 *
 * The broker sits on the HOST side of the guest bridge. Its counterpart inside
 * the VM is the guest bridge service; the byte pipe between them is injected
 * (HostPipePair) — the broker never opens host sockets/ports, never runs a
 * generic host CLI/shell/exec/SQL/HTTP proxy and never touches a Matchlock
 * control client.
 *
 * Every request is checked against the immutable HostBinding AND fresh
 * authoritative claim state; mutations are serialised and carry
 * invocation-bound idempotency keys. The idempotency ledger records the FULL
 * canonical request identity (op + run/agent scope for scoped ops, op + step
 * target + content for step ops), so key reuse with ANY change — foreign
 * scope, different op, different step, different content — rejects before a
 * cached acknowledgement can be served (no foreign/changed-op replay success
 * or input disclosure). An accepted completion revokes further claim
 * mutations while allowing exact ack replay and bounded final flush; cancel
 * revokes new mutations without erasing an accepted transition; close revokes
 * all invocation authority.
 *
 * Late-mutation authority: revocation (cancel / close / a delegated-call
 * deadline) marks the in-flight request revoked, and every mutation path
 * re-checks that authority after EVERY await. A request whose
 * validateCompletion was still pending when revocation landed therefore never
 * starts the guarded mutation (submitCompletion/submitFail); a mutation that
 * was ALREADY admitted before revocation may commit (it cannot be un-run at
 * the adapter) — its accepted transition is preserved and the exact ack is
 * remembered for a truthful replay, but no second response is ever written.
 * A delegated call that exceeds its finite deadline fails the invocation
 * closed for further mutation admission rather than admitting concurrent
 * mutators behind an abandoned call.
 *
 * Terminal lifetime revocation (MTLK-BRIDGE-CLOSE): every terminal host
 * lifetime event — host close, guest pipe EOF/end/error, or the host cancel
 * of the WHOLE invocation (cancelRequest with no target id) — synchronously
 * revokes the invocation's adapter authority through the optional
 * revokeInvocationAuthority seam BEFORE anything is awaited, even when the
 * invocation is idle (no request ever issued, no claim ever held) and after
 * a prior request/claim settled. The notification is idempotent: it fires at
 * most once per broker lifetime (the first terminal authority event wins —
 * close after EOF, close after cancel, a second canceled request or a later
 * service deadline never spam the adapter), because adapter/registry-side
 * revocation is terminal and repeat notifications add nothing. A terminal
 * revocation prevents any future authorization, claim/reclaim, renew,
 * mutation or late async resurrection of the same invocation identity while
 * an already committed truthful acknowledgement stays preserved.
 *
 * Canceled QUEUED requests are answered and reaped at cancel time — removed
 * from the bounded request queue, never left as tombstones consuming
 * maxPendingRequests capacity — so repeated guest cancel cycles inside one
 * open invocation can never starve later live requests (a peek after queued
 * cancels is served, not QUEUE_FULL).
 *
 * Claim asymmetry (deliberate): a step.claim admitted before revocation has
 * its outcome DROPPED (aborted — nothing cached, no ack replayed), whereas a
 * step.complete/step.fail admitted before revocation that commits is preserved
 * and its exact ack is replayed. A revoked invocation cannot meaningfully act
 * on a freshly acquired claim, so dropping the claim outcome is not an
 * oversight: the revocation path already answered the request and a new claim
 * would be unusable by the revoked invocation anyway.
 *
 * Outbound frames honor Writable backpressure through a bounded queue with a
 * drain deadline: a non-reading guest cannot accumulate unbounded host
 * buffers, and write/encode errors fail the pipe closed without unhandled
 * promise rejections.
 *
 * Step semantics themselves live in the injected AuthoritativeStepServices
 * (see broker-services.ts for the adapter obligation).
 */

import type { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import {
  BRIDGE_OPS,
  GUEST_BRIDGE_PROTOCOL_VERSION,
  GUEST_PACK_LAYOUT_VERSION,
  GUEST_RUN_LOG_DEFAULT_LIMIT,
  GUEST_RUN_LOG_LIMIT_MAX,
  detectWrongPrefix,
  isMergeBridgeOp,
  isQueryBridgeOp,
  isSuiteBridgeOp,
  mutatingSuiteBridgeOp,
  paramsMatchOp,
  stripIdPrefix,
  validateMergeBridgeParams,
  validateQueryBridgeParams,
  type BridgeErrorCode,
  type BridgeRequest,
  type BridgeRequestParams,
  type BridgeResponsePayload,
  type MergeAuthorizeRequest,
  type MergeReportRequest,
  type SuiteWireResult,
  validateSuiteBridgeParams,
} from "./guest-protocol.js";
import { FrameDecoder, decodeJsonPayload, encodeJsonFrame } from "./guest-framing.js";
import {
  type AuthoritativeStepServices,
  type HostBinding,
  type HostClaim,
  type InvocationState,
} from "./broker-services.js";
import type { HostSuiteBridge } from "./suite-host-bridge.js";
import type { HostQueryServices } from "./host-query-services.js";
import type { HostMergeServices } from "./host-merge-services.js";
import type { GuestSuiteCallResult } from "./guest-suite-contract.js";
import { Deadline } from "../../lib/instant.js";

export interface HostPipePair {
  /** Host -> guest byte pipe (write framed bytes here). */
  toGuest: Writable;
  /** Guest -> host byte pipe (read framed bytes here). */
  fromGuest: Readable;
}

export interface HostBrokerOptions {
  binding: HostBinding;
  services: AuthoritativeStepServices;
  pipe: HostPipePair;
  /**
   * MTLK-SUITE-WIRE: host suite transport/services bridge injected when the
   * host wired a suite-capable ledger for this invocation. Constructed ONLY
   * from immutable controller-admitted scope (see suite-host-bridge.ts).
   * Absent ⇒ every suite.* request is refused UNSUPPORTED ("host suite
   * service absent") — the guest engine degrades to real guest-local
   * execution with an explicit warning; it never records or replays green.
   * Delegation is NOT a passthrough: the bridge resolves the invocation's
   * live host lease and delegates to an authoritative HostSuiteService that
   * re-validates live admission + the current owned step lease on EVERY op
   * and again before every store mutation, and terminal broker events revoke
   * suite authority through the bridge's revokeAuthority seam.
   */
  suite?: HostSuiteBridge;
  /**
   * US-004: optional run-scoped read-only QUERY service injected when the
   * host wired run-scoped stories/status/logs reads for this invocation.
   * Constructed ONLY from immutable controller-admitted scope (see
   * host-query-services.ts). Absent ⇒ every step.stories / workflow.status /
   * logs.run request is refused UNSUPPORTED ("host query service absent").
   * Queries never require an opKey and never mutate invocation state; the
   * broker refuses any requested run that differs from the bound run with a
   * typed BINDING error BEFORE any host read.
   */
  query?: HostQueryServices;
  /**
   * US-007: optional scoped MERGE authorization/receipt service injected when
   * the host wired a merger-capable merge service for this invocation.
   * Constructed ONLY from immutable controller-admitted scope (see
   * host-merge-services.ts). Absent ⇒ every merge.authorize / merge.report
   * request is refused UNSUPPORTED ("host merge service absent"). The service
   * type-checks the finalizer binding BEFORE any Git action and independently
   * verifies the reported outcome against the authoritative target tip before
   * emitting a run-attributed merge.* event.
   */
  merge?: HostMergeServices;
  /** Finite handshake deadline (ready settles {ok:false} when no hello completes). */
  handshakeTimeoutMs?: number;
  /** Deadline for a single delegated service call (finite, never unbounded). */
  serviceTimeoutMs?: number;
  /** Bounded queue of incoming requests awaiting serialised dispatch. */
  maxPendingRequests?: number;
  /** Bounded idempotency ledger size. */
  maxIdempotencyEntries?: number;
  /** Bounded final-flush window while a delegated call is in flight. */
  shutdownFlushMs?: number;
  /** Bounded host->guest outbound queue; overflow fails the pipe closed. */
  maxOutboundQueueBytes?: number;
  /** How long the broker waits for a drained writable before failing closed. */
  writeDrainTimeoutMs?: number;
}

export interface HostBrokerHandle {
  /** Resolves when the guest handshake completes (accepted/rejected) or the broker closes. */
  ready: Promise<{ ok: boolean; reason?: string }>;
  /** Resolves after close() finishes and the host pipe is ended. */
  closed: Promise<void>;
  /** Host-side graceful close: revoke authority, bounded flush, end pipe. */
  close(): Promise<void>;
  /** Cancel an exact in-flight/queued request (all when id omitted). */
  cancelRequest(id?: string): void;
  state(): InvocationState;
}

type ServiceResult =
  | BridgeResponsePayload
  | { kind: "err"; code: BridgeErrorCode; message: string };

/**
 * handleOp outcome. `aborted` means the request's mutation authority was
 * revoked while a delegated call was in flight: the revocation path already
 * answered this request (CANCELED/DEADLINE/CLOSED) and no mutation was newly
 * started (or, if a mutation was already admitted, it committed and its ack
 * was recorded for replay) — nothing further may be written or cached.
 */
type OpOutcome = ServiceResult | { kind: "aborted" };

interface QueuedOp {
  frame: BridgeRequest;
  canceled: boolean;
  /** Mutation authority revoked (cancel/close/deadline) — no NEW guarded mutation may start. */
  revoked: boolean;
}

interface IdempotencyEntry {
  opKey: string;
  /** Canonical identity of the ORIGINAL request that produced this entry. */
  identity: string;
  response: ServiceResult;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_SERVICE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PENDING = 32;
const DEFAULT_MAX_IDEMPOTENCY = 128;
const DEFAULT_SHUTDOWN_FLUSH_MS = 2_000;
const DEFAULT_MAX_OUTBOUND_QUEUE_BYTES = 4 * 1024 * 1024;
const DEFAULT_WRITE_DRAIN_TIMEOUT_MS = 5_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** Validate a finite positive millisecond option (deadline config). */
function readTimeoutMs(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new RangeError(
      `host broker option ${name} must be a finite number >= 1 ms (got ${String(value)}) — refusing an unbounded/ignored deadline`,
    );
  }
  return value;
}

/** Validate a positive integer option (counts/bounds). */
function readCount(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new RangeError(
      `host broker option ${name} must be a positive integer (got ${String(value)})`,
    );
  }
  return value;
}

/** True when the op mutates step state (guarded + revocation-tracked). */
export function mutatingBridgeOp(op: string): boolean {
  return op === "step.claim" || op === "step.complete" || op === "step.fail" || op === "merge.report";
}

/**
 * Canonical identity of a request for idempotency. Composed ONLY from the
 * request's own normalized content (never the host binding alone), so the
 * ledger can distinguish: foreign run/agent scope under a reused key, a
 * different op, a different step target, and changed report/reason content.
 * Exact same-operation replays keep the same identity and may acknowledge.
 */
export function canonicalRequestIdentity(frame: Pick<BridgeRequest, "op" | "params">): string {
  const op = frame.op;
  const params = frame.params as Record<string, unknown>;
  if (op === "step.complete") {
    const stepId = typeof params.stepId === "string" ? stripIdPrefix(params.stepId) : "";
    const output = typeof params.output === "string" ? params.output : "";
    return `op:${op}|step:${stepId}|content:${contentHash(output)}`;
  }
  if (op === "step.fail") {
    const stepId = typeof params.stepId === "string" ? stripIdPrefix(params.stepId) : "";
    const reason = typeof params.reason === "string" ? params.reason : "";
    return `op:${op}|step:${stepId}|content:${contentHash(reason)}`;
  }
  if (op === "merge.report") {
    const authId = typeof params.authorizationId === "string" ? params.authorizationId : "";
    // The whole report record is the content identity: an identical replay
    // returns the same acknowledgement, ANY changed field rejects.
    return `op:${op}|auth:${authId}|content:${contentHash(JSON.stringify(params))}`;
  }
  // step.peek | step.claim | step.current carry run+agent scope.
  const runId = typeof params.runId === "string" ? stripIdPrefix(params.runId) : "";
  const agentId = typeof params.agentId === "string" ? params.agentId : "";
  return `op:${op}|run:${runId}|agent:${agentId}`;
}

/** Create + start the host broker on an injected pipe pair. */
export function createHostBroker(opts: HostBrokerOptions): HostBrokerHandle {
  const { binding, services, pipe } = opts;
  const suite = opts.suite;
  const query = opts.query;
  const merge = opts.merge;
  const handshakeTimeoutMs = readTimeoutMs(opts.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS, "handshakeTimeoutMs");
  const serviceTimeoutMs = readTimeoutMs(opts.serviceTimeoutMs, DEFAULT_SERVICE_TIMEOUT_MS, "serviceTimeoutMs");
  const maxPending = readCount(opts.maxPendingRequests, DEFAULT_MAX_PENDING, "maxPendingRequests");
  const maxIdempotency = readCount(opts.maxIdempotencyEntries, DEFAULT_MAX_IDEMPOTENCY, "maxIdempotencyEntries");
  const shutdownFlushMs = readTimeoutMs(opts.shutdownFlushMs, DEFAULT_SHUTDOWN_FLUSH_MS, "shutdownFlushMs");
  const maxOutboundBytes = readCount(opts.maxOutboundQueueBytes, DEFAULT_MAX_OUTBOUND_QUEUE_BYTES, "maxOutboundQueueBytes");
  const writeDrainTimeoutMs = readTimeoutMs(opts.writeDrainTimeoutMs, DEFAULT_WRITE_DRAIN_TIMEOUT_MS, "writeDrainTimeoutMs");

  let state: InvocationState = "open";
  let handshakeAccepted = false;
  let closeStarted = false;
  const queue: QueuedOp[] = [];
  const idempotency = new Map<string, IdempotencyEntry>();
  let active: QueuedOp | null = null;
  // Serialised dispatch bookkeeping: only ONE dispatch loop runs at a time,
  // and an in-flight delegated call is bounded by the service deadline (or
  // abandoned early by cancel/close) so the loop can never wedge forever.
  let dispatching = false;
  let activeDeadlineTimer: NodeJS.Timeout | undefined;
  let abandonActive: (() => void) | null = null;
  let handshakeTimer: NodeJS.Timeout | undefined;

  let resolveReady: (v: { ok: boolean; reason?: string }) => void = () => {};
  const ready = new Promise<{ ok: boolean; reason?: string }>((r) => { resolveReady = r; });
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((r) => { resolveClosed = r; });

  // ── bounded outbound (host -> guest) write path ────────────────────────

  const outbound: Buffer[] = [];
  let outboundBytes = 0;
  let awaitingDrain = false;
  let outboundDead = false;
  let drainTimer: NodeJS.Timeout | undefined;

  const clearDrainTimer = (): void => {
    if (drainTimer !== undefined) {
      clearTimeout(drainTimer);
      drainTimer = undefined;
    }
  };

  /** Fail the outbound path closed (overflow, write/encode error, no drain). */
  const failOutbound = (reason: string): void => {
    if (outboundDead) return;
    outboundDead = true;
    outbound.length = 0;
    outboundBytes = 0;
    clearDrainTimer();
    awaitingDrain = false;
    void closeInternal(reason);
  };

  const onDrained = (): void => {
    if (!awaitingDrain) return;
    awaitingDrain = false;
    clearDrainTimer();
    pumpOutbound();
  };

  const pumpOutbound = (): void => {
    if (outboundDead || awaitingDrain) return;
    while (outbound.length > 0) {
      const frame = outbound[0];
      if (pipe.toGuest.destroyed || pipe.toGuest.writableEnded) {
        // Peer is gone/ended; remaining queued frames are undeliverable.
        outbound.length = 0;
        outboundBytes = 0;
        return;
      }
      let ok = false;
      try {
        ok = pipe.toGuest.write(frame, (err) => {
          if (err) failOutbound(`host pipe write failed: ${err.message}`);
        });
      } catch (err) {
        failOutbound(`host pipe write failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      outbound.shift();
      outboundBytes -= frame.byteLength;
      if (!ok) {
        // Backpressure: stop writing until the writable drains, bounded by the
        // drain deadline. Any further frames stay in the bounded queue.
        awaitingDrain = true;
        pipe.toGuest.once("drain", onDrained);
        drainTimer = setTimeout(() => {
          drainTimer = undefined;
          if (awaitingDrain) {
            failOutbound(`host pipe did not drain within ${writeDrainTimeoutMs}ms (guest is not reading)`);
          }
        }, writeDrainTimeoutMs);
        return;
      }
    }
  };

  /**
   * Queue + pump one frame. Never throws: encode errors and peer loss fail the
   * pipe closed instead of escaping into event callbacks. Honors backpressure
   * through the bounded outbound queue (see pumpOutbound).
   */
  const writeFrame = (value: unknown): void => {
    if (outboundDead) return;
    if (pipe.toGuest.destroyed || pipe.toGuest.writableEnded) return;
    let buffer: Buffer;
    try {
      buffer = encodeJsonFrame(value);
    } catch (err) {
      failOutbound(`cannot encode host frame: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    outbound.push(buffer);
    outboundBytes += buffer.byteLength;
    if (outboundBytes > maxOutboundBytes) {
      failOutbound(`host outbound queue exceeded ${maxOutboundBytes} bytes (guest is not reading)`);
      return;
    }
    pumpOutbound();
  };

  const writeRes = (id: string, payload: BridgeResponsePayload): void => {
    writeFrame({ kind: "res", id, payload });
  };

  const writeErr = (id: string | undefined, code: BridgeErrorCode, message: string): void => {
    writeFrame({ kind: "err", ...(id !== undefined ? { id } : {}), code, message });
  };

  const remember = (entry: IdempotencyEntry): void => {
    idempotency.set(entry.opKey, entry);
    while (idempotency.size > maxIdempotency) {
      const oldest = idempotency.keys().next().value;
      if (oldest !== undefined) idempotency.delete(oldest);
    }
  };

  // ── revocation helpers ─────────────────────────────────────────────────

  /**
   * Optional narrow adapter seam (see broker-services.ts): lets a production
   * adapter abort genuinely in-flight authority work when the broker revokes
   * it. The broker NEVER relies on it for correctness — precommit revocation
   * is enforced broker-side regardless — and adapter throws must not break
   * the broker. Idempotent: revocation is TERMINAL for the invocation
   * identity, so the seam fires at most ONCE per broker lifetime (the first
   * terminal authority event: host close, guest EOF, host cancel of the whole
   * invocation, an in-flight request revocation, or the finite service
   * deadline). Later events of the same lifecycle are not re-reported — the
   * adapter/registry revocation they would trigger is already terminal.
   */
  let revocationNotified = false;
  const notifyRevocation = (reason: string): void => {
    if (revocationNotified) return;
    revocationNotified = true;
    try {
      services.revokeInvocationAuthority?.(binding.invocationId, reason);
    } catch {
      /* adapter-side failures are its own; the broker boundary stays intact */
    }
    // MTLK-SUITE-WIRE: terminal authority events revoke HOST SUITE authority
    // as well as step authority — even when the invocation is idle (before
    // its first request/claim) or after a settled claim. The suite bridge
    // terminally revokes this invocation in the SAME registry the step
    // adapter uses, so no suite op can mutate after close/EOF/cancel/deadline
    // and a late async suite callback is refused by the authoritative service.
    try {
      suite?.revokeAuthority(reason);
    } catch {
      /* host-owned registry revocation failures must not break the broker */
    }
    // US-007: terminal authority also revokes merge authorization for the
    // invocation (a consumed authorization keeps its exact ack replayable).
    try {
      merge?.revokeAuthority?.(reason);
    } catch {
      /* host-owned merge service revocation failures must not break the broker */
    }
  };

  const revoked = (item: QueuedOp): boolean => item.canceled || item.revoked;

  /**
   * Defense in depth: a fresh authoritative claim must be scoped to THIS
   * invocation's run/agent, not merely match the requested stepId. A
   * mis-scoped or misbehaving readClaim (adapter bug) can therefore never
   * route a guarded mutation against a step owned by a different run/agent
   * even when its claimId happens to match.
   */
  const claimScopedToInvocation = (claim: HostClaim): string | null => {
    if (claim.runId !== binding.runId) {
      return `authoritative claim run "${claim.runId}" does not match the bound run "${binding.runId}"`;
    }
    if (claim.agentId !== binding.agentId) {
      return `authoritative claim agent "${claim.agentId}" does not match the bound agent "${binding.agentId}"`;
    }
    return null;
  };

  // ── request validation helpers ─────────────────────────────────────────

  const requireBoundAgentRun = (frame: BridgeRequest): { runId: string } | { error: string } => {
    const params = frame.params as { agentId?: string; runId?: string };
    if (typeof params.agentId !== "string" || typeof params.runId !== "string") {
      return { error: "request is missing agentId/runId" };
    }
    const runWrong = detectWrongPrefix(params.runId, "run");
    if (runWrong) return { error: runWrong };
    const runId = stripIdPrefix(params.runId);
    if (params.agentId !== binding.agentId) {
      return { error: `agent "${params.agentId}" is not bound to this invocation (expected "${binding.agentId}")` };
    }
    if (runId !== binding.runId) {
      return { error: `run "${params.runId}" is not bound to this invocation (expected "${binding.runId}")` };
    }
    return { runId };
  };

  const requireOwnedStep = async (
    frame: BridgeRequest,
  ): Promise<{ ok: true; stepId: string; claim: HostClaim } | { ok: false; code: BridgeErrorCode; message: string }> => {
    const raw = (frame.params as { stepId?: unknown }).stepId;
    if (typeof raw !== "string" || raw.trim() === "") {
      return { ok: false, code: "BAD_REQUEST", message: "request is missing stepId" };
    }
    const wrong = detectWrongPrefix(raw.trim(), "step");
    if (wrong) return { ok: false, code: "CLAIM", message: wrong };
    const stepId = stripIdPrefix(raw.trim());
    const claim = await services.readClaim(binding);
    if (!claim) {
      return { ok: false, code: "CLAIM", message: "no current claim is held by this invocation" };
    }
    if (claim.stepId !== stepId) {
      return {
        ok: false,
        code: "CLAIM",
        message: `step ${raw.trim()} is not the step currently claimed by this invocation (current step: ${claim.stepId})`,
      };
    }
    const scopeError = claimScopedToInvocation(claim);
    if (scopeError) {
      return { ok: false, code: "CLAIM", message: scopeError };
    }
    return { ok: true, stepId, claim };
  };

  const mutationContent = (frame: BridgeRequest): string => {
    if (frame.op === "step.complete") {
      const output = (frame.params as { output?: unknown }).output;
      return typeof output === "string" ? output : "";
    }
    const reason = (frame.params as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : "";
  };

  // ── op implementations (binding + fresh claim state first) ─────────────

  const handleOp = async (item: QueuedOp): Promise<OpOutcome> => {
    const frame = item.frame;
    const op = frame.op;
    if (state === "closed") {
      return { kind: "err", code: "CLOSED", message: "invocation is closed — no further requests are accepted" };
    }

    const scoped = op === "step.peek" || op === "step.current" || op === "step.claim";
    const mutating = mutatingBridgeOp(op);

    // Authorization for run/agent-scoped ops happens BEFORE any cached-ack
    // consultation: a request whose scope is not THIS invocation can never be
    // served from the idempotency ledger (no foreign replay / input
    // disclosure), and a foreign claim can never start a service call.
    let bound: { runId: string } | { error: string } | null = null;
    if (scoped) {
      bound = requireBoundAgentRun(frame);
      if ("error" in bound) {
        return { kind: "err", code: "BINDING", message: bound.error };
      }
    }

    // Exact ack replay. Served ONLY when the current request's canonical
    // identity — op + scope/step target + content — exactly matches the
    // recorded entry. Any changed op/scope/step/content under a reused key
    // rejects (never a stale cached success). Replay is honored in every
    // state except closed so an accepted transition keeps its acknowledgement.
    if (frame.opKey !== undefined) {
      const existing = idempotency.get(frame.opKey);
      if (existing) {
        if (existing.identity !== canonicalRequestIdentity(frame)) {
          return {
            kind: "err",
            code: "IDEMPOTENCY",
            message: "opKey reuse with a different operation/scope/step/content is rejected",
          };
        }
        return existing.response;
      }
    }

    if (mutating && state !== "open") {
      const msg = state === "completed"
        ? "invocation already completed its claim — further mutations are revoked (exact ack replay only)"
        : "invocation is canceled — new mutations are revoked";
      return { kind: "err", code: "INVOCATION_STATE", message: msg };
    }

    // step.peek
    if (op === "step.peek") {
      const verdict = await services.peek(binding);
      if (revoked(item)) return { kind: "aborted" };
      return { peek: verdict };
    }

    // step.current (read-only)
    if (op === "step.current") {
      const claim = await services.readClaim(binding);
      if (revoked(item)) return { kind: "aborted" };
      if (!claim) return { current: { found: false } };
      const scopeError = claimScopedToInvocation(claim);
      if (scopeError) return { kind: "err", code: "CLAIM", message: scopeError };
      return {
        current: {
          found: true,
          stepId: `step-${claim.stepId}`,
          runId: `run-${claim.runId}`,
          input: claim.input,
        },
      };
    }

    // step.claim (mutating; idempotent by key and by native semantics)
    if (op === "step.claim") {
      if (!frame.opKey) return { kind: "err", code: "BAD_REQUEST", message: "claim requires an idempotency opKey" };
      if (revoked(item)) return { kind: "aborted" };
      const outcome = await services.claim(binding);
      if (revoked(item)) {
        // The claim service call was admitted before revocation. Unlike an
        // admitted complete/fail whose committed mutation is preserved and
        // ack-replayed, a revoked invocation's claim outcome is deliberately
        // DROPPED (see header "Claim asymmetry"): a fresh claim would be
        // unusable by the revoked invocation, and the revocation path already
        // answered this request — nothing is cached or written.
        return { kind: "aborted" };
      }
      const payload: BridgeResponsePayload = outcome.found
        ? { claim: { found: true, stepId: `step-${outcome.stepId!}`, runId: `run-${outcome.runId!}`, input: outcome.input! } }
        : { claim: { found: false } };
      remember({ opKey: frame.opKey, identity: canonicalRequestIdentity(frame), response: payload });
      return payload;
    }

    // step.complete (mutating)
    if (op === "step.complete") {
      if (!frame.opKey) return { kind: "err", code: "BAD_REQUEST", message: "complete requires an idempotency opKey" };
      const content = mutationContent(frame);
      if (revoked(item)) return { kind: "aborted" };
      const owned = await requireOwnedStep(frame);
      if (!owned.ok) return { kind: "err", code: owned.code, message: owned.message };
      // Re-check authority after the readClaim await: a revocation that landed
      // while the ownership check was in flight must stop the pipeline here.
      if (revoked(item)) return { kind: "aborted" };
      const { stepId, claim } = owned;

      // Submit-time expects validation — no mutation; the claim is retained
      // and the retry budget untouched on rejection (native REJECTED).
      const diagnostic = await services.validateCompletion(binding, stepId, content);
      // PRECOMMIT GUARD: cancellation/close/deadline while validation is
      // pending must never start the guarded mutation. The revocation path
      // already answered this request; a late validation resolution only
      // reaches here to be dropped.
      if (revoked(item)) return { kind: "aborted" };
      if (diagnostic.verdict === "reject") {
        const response: ServiceResult = {
          complete: {
            status: "rejected",
            rejected: { message: `output does not satisfy expects: ${diagnostic.message}` },
          },
        };
        remember({ opKey: frame.opKey, identity: canonicalRequestIdentity(frame), response });
        return response;
      }

      // Guarded atomic acceptance carrying the expected claim identity so the
      // integration can check atomically (a precheck alone is insufficient).
      const outcome = await services.submitCompletion(binding, claim.claimId, stepId, content);
      if (revoked(item)) {
        // The guarded mutation was admitted BEFORE revocation and has now
        // settled. If it committed, preserve the accepted transition and
        // remember the exact ack so an identical retry replays the truth; no
        // response is written (the revocation already answered this request).
        if (outcome.mutated) {
          state = "completed";
          remember({ opKey: frame.opKey, identity: canonicalRequestIdentity(frame), response: buildCompleteResponse(outcome) });
        }
        return { kind: "aborted" };
      }
      const response: ServiceResult = buildCompleteResponse(outcome);
      remember({ opKey: frame.opKey, identity: canonicalRequestIdentity(frame), response });
      if (outcome.mutated) state = "completed";
      return response;
    }

    // step.fail (mutating)
    if (op === "step.fail") {
      if (!frame.opKey) return { kind: "err", code: "BAD_REQUEST", message: "fail requires an idempotency opKey" };
      const content = mutationContent(frame);
      if (revoked(item)) return { kind: "aborted" };
      const owned = await requireOwnedStep(frame);
      if (!owned.ok) return { kind: "err", code: owned.code, message: owned.message };
      if (revoked(item)) return { kind: "aborted" };
      const { stepId, claim } = owned;
      const outcome = await services.submitFail(binding, claim.claimId, stepId, content);
      if (revoked(item)) {
        if (outcome.mutated) {
          state = "completed";
          remember({ opKey: frame.opKey, identity: canonicalRequestIdentity(frame), response: { fail: { status: outcome.status } } });
        }
        return { kind: "aborted" };
      }
      const response: ServiceResult = { fail: { status: outcome.status } };
      remember({ opKey: frame.opKey, identity: canonicalRequestIdentity(frame), response });
      if (outcome.mutated) state = "completed";
      return response;
    }

    // ── Run-scoped query ops (US-004) ──────────────────────────────────
    // Read-only stories/status/logs for THIS invocation's bound run. They do
    // not require an opKey, never consult/seed the idempotency ledger and
    // never mutate invocation state; they are served in any non-closed state
    // (like step.peek/step.current). The requested run is checked against the
    // immutable binding BEFORE any host read, and the injected query service
    // (when present) re-asserts the same binding as defense in depth.
    if (isQueryBridgeOp(op)) {
      if (!query) {
        return {
          kind: "err",
          code: "UNSUPPORTED",
          message:
            "host query service is absent for this invocation — the controller did not wire a run-scoped query bridge; stories/status/logs queries are not served",
        };
      }
      // Host-boundary canonical wire validation (shape/type/bounds/prefixed
      // run id) — malformed query requests never reach the host reader.
      const wireRefusal = validateQueryBridgeParams(op, frame.params);
      if (wireRefusal) {
        return { kind: "err", code: wireRefusal.code, message: wireRefusal.message };
      }
      // BINDING refusal BEFORE any host read: only the invocation's OWN run
      // may be queried. Any other run, a bare-number lookup, a foreign prefix
      // or a global enumeration shape is refused here, typed, with no
      // delegation to the query service.
      const runParam = (frame.params as { runId?: unknown }).runId;
      const requestedRun = typeof runParam === "string" ? stripIdPrefix(runParam) : "";
      if (requestedRun !== binding.runId) {
        return {
          kind: "err",
          code: "BINDING",
          message: `run "${String(runParam)}" is not bound to this invocation (expected "run-${binding.runId}")`,
        };
      }
      if (revoked(item)) return { kind: "aborted" };
      if (op === "step.stories") {
        const payload = await query.stories(binding);
        if (revoked(item)) return { kind: "aborted" };
        return { stories: payload };
      }
      if (op === "workflow.status") {
        const payload = await query.workflowStatus(binding);
        if (revoked(item)) return { kind: "aborted" };
        return { status: payload };
      }
      // logs.run — bounded tail; a malformed/oversized limit already refused
      // by the wire validator, so default to the bounded tail here.
      const limitParam = (frame.params as { limit?: unknown }).limit;
      const limit = typeof limitParam === "number"
        && Number.isInteger(limitParam)
        && limitParam >= 1
        && limitParam <= GUEST_RUN_LOG_LIMIT_MAX
        ? limitParam
        : GUEST_RUN_LOG_DEFAULT_LIMIT;
      const logsPayload = await query.runLogs(binding, limit);
      if (revoked(item)) return { kind: "aborted" };
      return { logs: logsPayload };
    }

    // ── Scoped merge ops (US-007) ──────────────────────────────────────
    // The guest merger asks for a typed authorization BEFORE running any
    // guest Git, then reports the pure-core outcome for independent host
    // verification + run-attributed event emission. A missing host merge
    // service refuses UNSUPPORTED (no fallback); a non-open invocation
    // refuses INVOCATION_STATE; canonical wire validation runs at BOTH
    // boundaries. The host performs NO Git until the authorization passes
    // role/claim/origin/target checks.
    if (isMergeBridgeOp(op)) {
      if (!merge) {
        return {
          kind: "err",
          code: "UNSUPPORTED",
          message:
            "host merge service is absent for this invocation — the controller did not wire a merger-capable merge service; merge-branch is not served",
        };
      }
      if (state !== "open") {
        const msg = state === "completed"
          ? "invocation already completed its claim — merge authorization is revoked"
          : "invocation is canceled — merge authorization is revoked";
        return { kind: "err", code: "INVOCATION_STATE", message: msg };
      }
      const wireRefusal = validateMergeBridgeParams(op, frame.params);
      if (wireRefusal) {
        return { kind: "err", code: wireRefusal.code, message: wireRefusal.message };
      }
      if (revoked(item)) return { kind: "aborted" };
      // Fresh authoritative claim (host-owned) is threaded to the service, so
      // a stale/foreign/reassigned finalizer claim refuses before any Git.
      const claim = await services.readClaim(binding);
      if (revoked(item)) return { kind: "aborted" };

      if (op === "merge.authorize") {
        const outcome = await merge.authorize(binding, claim, frame.params as MergeAuthorizeRequest);
        if (revoked(item)) return { kind: "aborted" };
        if (!outcome.ok || !outcome.authorization) {
          return { kind: "err", code: outcome.code ?? "MERGE_SERVICE", message: outcome.message };
        }
        return { mergeAuthorization: outcome.authorization };
      }

      // merge.report (mutating; exact ack replay via opKey).
      if (!frame.opKey) {
        return { kind: "err", code: "BAD_REQUEST", message: "merge.report requires an idempotency opKey" };
      }
      const outcome = await merge.report(binding, claim, frame.params as MergeReportRequest);
      if (revoked(item)) {
        // A report admitted before revocation that recorded successfully keeps
        // its exact ack for a truthful replay; no second response is written.
        if (outcome.ok && outcome.ack) {
          remember({ opKey: frame.opKey, identity: canonicalRequestIdentity(frame), response: { mergeReport: outcome.ack } });
        }
        return { kind: "aborted" };
      }
      if (!outcome.ok || !outcome.ack) {
        return { kind: "err", code: outcome.code ?? "MERGE_SERVICE", message: outcome.message };
      }
      const response: ServiceResult = { mergeReport: outcome.ack };
      remember({ opKey: frame.opKey, identity: canonicalRequestIdentity(frame), response });
      return response;
    }

    // ── Suite ops (MTLK-SUITE-WIRE) ─────────────────────────────────────
    if (isSuiteBridgeOp(op)) {
      if (!suite) {
        return {
          kind: "err",
          code: "UNSUPPORTED",
          message:
            "host suite service is absent for this invocation — the controller did not inject a suite-capable host bridge; suite requests are not served",
        };
      }
      // Host-boundary canonical wire validation (shape/type/bounds/finite
      // numerics/permitted events/namespace form) — malformed or oversized
      // suite requests never reach the host ledger.
      const wireRefusal = validateSuiteBridgeParams(op, frame.params);
      if (wireRefusal) {
        return { kind: "err", code: wireRefusal.code, message: wireRefusal.message };
      }
      // Suite mutations follow the same state machine as step mutations: a
      // closed/canceled/completed invocation cannot start NEW suite
      // mutations (exact ack replay is preserved by the host suite ledger).
      if (mutatingSuiteBridgeOp(op) && state !== "open") {
        const msg = state === "completed"
          ? "invocation already completed its claim — further suite mutations are revoked (host ledger ack replay only)"
          : "invocation is canceled — new suite mutations are revoked";
        return { kind: "err", code: "INVOCATION_STATE", message: msg };
      }
      if (revoked(item)) return { kind: "aborted" };
      // Read-only suite ops are allowed in any non-closed state; closed is
      // handled above.
      const callResult = await suite.serve(op as never, frame.params as Record<string, unknown>);
      if (revoked(item)) {
        // Suite authority was revoked while the delegated call was in flight
        // (close/EOF/cancel/deadline). The revocation path already answered
        // this request; a late result is dropped. The authoritative service
        // re-validates immediately before its own store mutation, so no SQL
        // mutation can occur after revocation — an already accepted record ack
        // was preserved by the service.
        return { kind: "aborted" };
      }
      return { suite: suiteWireResult(callResult) };
    }

    return { kind: "err", code: "UNSUPPORTED", message: `unsupported op: ${op}` };
  };

  const buildCompleteResponse = (outcome: { status: string; detail?: string }): ServiceResult => ({
    complete: outcome.detail !== undefined ? { status: outcome.status, detail: outcome.detail } : { status: outcome.status },
  });

  /** Convert the typed host-suite call result into the wire `res` payload. */
  const suiteWireResult = (result: GuestSuiteCallResult<unknown>): SuiteWireResult => {
    if (result.ok) {
      return { ok: true, value: (result.value ?? {}) as Record<string, unknown> };
    }
    return {
      ok: false,
      reason: result.reason,
      ...(result.reason === "refused" && result.code ? { code: result.code } : {}),
      message: result.message,
    };
  };

  // ── serialised dispatch loop ───────────────────────────────────────────

  /**
   * Abandon the currently in-flight delegated call (used by cancel/close): the
   * serialised loop must not stay suspended behind a call that will never
   * settle once its authority was revoked. The abandoned call's late
   * result/error is dropped by the deadline race below AND its handleOp
   * continuation re-checks revocation before it could ever start a mutation.
   */
  const abandonActiveRace = (): void => {
    if (activeDeadlineTimer !== undefined) {
      clearTimeout(activeDeadlineTimer);
      activeDeadlineTimer = undefined;
    }
    if (abandonActive) {
      const resolve = abandonActive;
      abandonActive = null;
      resolve();
    }
  };

  /**
   * One serialised dispatch loop per broker (guarded so two loops can never
   * run at once and interleave delegated service calls). Every delegated call
   * is raced against the finite service deadline: a call that never settles is
   * revoked at the deadline (its mutation authority dies with it), the guest
   * is answered DEADLINE, and — for a mutating op — the invocation fails
   * closed so no further mutation is admitted behind the abandoned call.
   * Queued requests behind a hung adapter are served after their own
   * deadlines instead of stalling forever.
   */
  const dispatchNext = async (): Promise<void> => {
    if (dispatching || closeStarted) return;
    dispatching = true;
    try {
      for (;;) {
        if (closeStarted) return;
        const item = queue.find((q) => !q.canceled);
        if (!item) return;
        queue.splice(queue.indexOf(item), 1);
        active = item;
        const call = handleOp(item).then(
          (value): { outcome: "ok"; value: OpOutcome } => ({ outcome: "ok", value }),
          (err: unknown): { outcome: "error"; message: string } => ({
            outcome: "error",
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        const deadline = new Promise<{ outcome: "deadline" } | { outcome: "abandoned" }>((resolve) => {
          abandonActive = () => resolve({ outcome: "abandoned" });
          activeDeadlineTimer = setTimeout(
            () => resolve({ outcome: "deadline" }),
            serviceTimeoutMs,
          );
        });
        let winner: { outcome: "ok"; value: OpOutcome } | { outcome: "error"; message: string }
          | { outcome: "deadline" } | { outcome: "abandoned" };
        try {
          winner = await Promise.race([call, deadline]);
        } finally {
          if (activeDeadlineTimer !== undefined) {
            clearTimeout(activeDeadlineTimer);
            activeDeadlineTimer = undefined;
          }
          abandonActive = null;
          active = null;
        }
        if (winner.outcome === "deadline") {
          // The delegated call did not settle in time. It may STILL be running
          // (uncancellable at the adapter): revoke its mutation authority so
          // its eventual continuation can never start a guarded mutation, and
          // fail the invocation closed for mutating ops so no concurrent
          // mutator is admitted behind the abandoned call.
          item.revoked = true;
          notifyRevocation(`delegated call exceeded the ${serviceTimeoutMs}ms service deadline`);
          if (!item.canceled) {
            writeErr(item.frame.id, "DEADLINE", `host broker service call exceeded ${serviceTimeoutMs}ms`);
          }
          if (mutatingBridgeOp(item.frame.op) && state === "open") state = "canceled";
          continue;
        }
        // "abandoned" means cancel/close already answered this request with a
        // CANCELED/CLOSED err frame — nothing more to write.
        if (winner.outcome === "abandoned") continue;
        // Defense: a revoked/canceled request was already answered (or is
        // being closed) — never write a second response for it.
        if (revoked(item)) continue;
        if (winner.outcome === "error") {
          writeErr(item.frame.id, "SERVICE", `service error: ${winner.message}`);
          continue;
        }
        // Only the "ok" outcome remains.
        const result = winner.value;
        if ("kind" in result) {
          // Either an internal `aborted` (mutation authority revoked
          // mid-flight — the revocation path already answered this request and
          // no response may be written) or a protocol-level err result.
          if (result.kind === "aborted") continue;
          writeErr(item.frame.id, result.code, result.message);
        } else {
          writeRes(item.frame.id, result as BridgeResponsePayload);
        }
      }
    } finally {
      dispatching = false;
    }
  };

  const cancelQueueAndActive = (id: string | undefined, code: BridgeErrorCode, message: string): void => {
    let revokedActive = false;
    // REAP canceled queued requests at cancel time: answering a queued request
    // and leaving it in `queue` as a canceled tombstone would permanently
    // consume one of the maxPendingRequests slots (dispatchNext only ever
    // splices the first NON-canceled item). Repeated guest cancel cycles in
    // one open invocation could then fill the queue with tombstones and deny
    // QUEUE_FULL to legitimate later requests even though nothing is live.
    // Every matched queued request is answered here and removed; only still-
    // live requests remain queued for the serialised dispatch loop.
    const survivors: QueuedOp[] = [];
    for (const item of queue) {
      if (item.canceled) continue; // already canceled (defensive; normally reaped)
      if (id !== undefined && item.frame.id !== id) {
        survivors.push(item);
        continue;
      }
      item.canceled = true;
      item.revoked = true;
      writeErr(item.frame.id, code, message);
    }
    queue.length = 0;
    queue.push(...survivors);
    if (active && !active.canceled && (id === undefined || active.frame.id === id)) {
      active.canceled = true;
      active.revoked = true;
      revokedActive = true;
      writeErr(active.frame.id, code, message);
      // Unstick the serialised loop: the revoked call is abandoned so queued
      // requests are served promptly instead of waiting on a zombie delegate.
      abandonActiveRace();
    }
    if (revokedActive) {
      notifyRevocation(message);
    }
  };

  // ── pipe ingestion ─────────────────────────────────────────────────────

  /**
   * Refuse a handshake (protocol/build/identity mismatch, duplicate/late
   * hello, deadline). Always writes the hello-ack refusal; settles ready
   * {ok:false} (only when it was not already accepted) and fails the broker
   * closed so no further frames are processed.
   */
  const refuseHandshake = (reason: string): void => {
    const alreadyAccepted = handshakeAccepted;
    writeFrame({ kind: "hello-ack", accepted: false, protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION, reason });
    if (!alreadyAccepted) {
      resolveReady({ ok: false, reason });
    }
    if (handshakeTimer !== undefined) {
      clearTimeout(handshakeTimer);
      handshakeTimer = undefined;
    }
    void closeInternal(reason);
  };

  const frameDecoder = new FrameDecoder({
    onFrame: (payload) => {
      const parsed = decodeJsonPayload<Record<string, unknown>>(payload);
      if (!parsed.ok) {
        writeErr(undefined, "BAD_FRAME", parsed.error);
        return;
      }
      const msg = parsed.value;
      if (closeStarted) return;

      if (msg.kind === "hello") {
        if (handshakeAccepted || state !== "open") {
          refuseHandshake("duplicate or late hello (handshake already accepted or invocation closed)");
          return;
        }
        const proto = typeof msg.protocolVersion === "number" ? msg.protocolVersion : -1;
        if (proto !== GUEST_BRIDGE_PROTOCOL_VERSION) {
          const reason = `guest protocol version ${proto} does not match host ${GUEST_BRIDGE_PROTOCOL_VERSION}`;
          refuseHandshake(reason);
          return;
        }
        // STRICT compatible HELLO (MTLK-BRIDGE-CLOSE): the guest must DECLARE
        // a nonempty, correctly typed helper build version and a supported
        // numeric pack layout that exactly match the host expectation.
        // Missing, empty, wrong-typed or mismatched declarations refuse the
        // handshake. A production guest sending fields does NOT justify
        // accepting a minimal handshake that omits them — this is protocol
        // compatibility (helper/controller contract), not cryptographic guest
        // attestation, so a genuinely compatible helper always has the real
        // metadata to declare.
        const hostRequiredBuild = typeof binding.helperBuildVersion === "string" ? binding.helperBuildVersion.trim() : "";
        if (hostRequiredBuild === "") {
          // Invalid HOST expectation: no legitimate guest metadata can match
          // an empty host-required build, so the broker fails closed instead
          // of silently skipping compatibility (a host configuration error).
          refuseHandshake("host-required helper build expectation is empty/invalid — no guest handshake can be accepted (host configuration error)");
          return;
        }
        const declaredBuild = msg.helperBuildVersion;
        if (typeof declaredBuild !== "string" || declaredBuild.trim() === "") {
          const shown = declaredBuild === undefined ? "missing" : JSON.stringify(declaredBuild);
          refuseHandshake(`guest hello helperBuildVersion must be a nonempty string (got ${shown}); host requires "${hostRequiredBuild}"`);
          return;
        }
        if (declaredBuild.trim() !== hostRequiredBuild) {
          refuseHandshake(`guest helper build "${declaredBuild}" does not match the host-required helper build "${hostRequiredBuild}"`);
          return;
        }
        const declaredLayout = msg.packLayoutVersion;
        if (typeof declaredLayout !== "number") {
          refuseHandshake(
            `guest hello packLayoutVersion must be the supported numeric layout (got ${declaredLayout === undefined ? "missing" : JSON.stringify(declaredLayout)}); host requires ${GUEST_PACK_LAYOUT_VERSION}`,
          );
          return;
        }
        if (declaredLayout !== GUEST_PACK_LAYOUT_VERSION) {
          refuseHandshake(`guest helper pack layout ${declaredLayout} does not match host ${GUEST_PACK_LAYOUT_VERSION}`);
          return;
        }
        // Guest-supplied identity is never trusted, but any claim the guest
        // makes must agree with the immutable host binding.
        const claimedRun = typeof msg.claimedRunId === "string" ? msg.claimedRunId : undefined;
        const claimedInvocation = typeof msg.claimedInvocationId === "string" ? msg.claimedInvocationId : undefined;
        const claimedAgent = typeof msg.claimedAgentId === "string" ? msg.claimedAgentId : undefined;
        if (claimedRun !== undefined && (stripIdPrefix(claimedRun) !== binding.runId || !isUuid(stripIdPrefix(claimedRun)))) {
          const reason = `guest claimed run ${claimedRun} does not match the bound run ${binding.runId}`;
          refuseHandshake(reason);
          return;
        }
        if (claimedInvocation !== undefined && claimedInvocation !== binding.invocationId) {
          const reason = `guest claimed invocation ${claimedInvocation} does not match the bound invocation ${binding.invocationId}`;
          refuseHandshake(reason);
          return;
        }
        if (claimedAgent !== undefined && claimedAgent !== binding.agentId) {
          const reason = `guest claimed agent ${claimedAgent} does not match the bound agent ${binding.agentId}`;
          refuseHandshake(reason);
          return;
        }
        handshakeAccepted = true;
        if (handshakeTimer !== undefined) {
          clearTimeout(handshakeTimer);
          handshakeTimer = undefined;
        }
        writeFrame({ kind: "hello-ack", accepted: true, protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION });
        resolveReady({ ok: true });
        void dispatchNext();
        return;
      }

      if (msg.kind === "req") {
        if (!handshakeAccepted) {
          writeErr(typeof msg.id === "string" ? msg.id : undefined, "HANDSHAKE", "request before handshake acceptance");
          return;
        }
        const req = msg as unknown as BridgeRequest;
        const paramsOk = typeof req.params === "object" && req.params !== null && !Array.isArray(req.params)
          && paramsMatchOp(req.params as BridgeRequestParams, req.op);
        if (!BRIDGE_OPS.includes(req.op) || !paramsOk || typeof req.id !== "string" || req.id.length === 0) {
          writeErr(typeof req.id === "string" ? req.id : undefined, "UNSUPPORTED", "unsupported or malformed request");
          return;
        }
        if (state === "closed") {
          writeErr(req.id, "CLOSED", "invocation is closed — no further requests are accepted");
          return;
        }
        if (queue.length >= maxPending) {
          writeErr(req.id, "QUEUE_FULL", `broker request queue is full (limit ${maxPending})`);
          return;
        }
        queue.push({ frame: req, canceled: false, revoked: false });
        void dispatchNext();
        return;
      }

      if (msg.kind === "ctrl") {
        const ctrl = msg as { op?: string; id?: string };
        if (ctrl.op === "cancel") {
          cancelQueueAndActive(typeof ctrl.id === "string" ? ctrl.id : undefined, "CANCELED", "request canceled");
        }
        return;
      }
    },
    onError: (err) => {
      writeErr(undefined, "BAD_FRAME", err.message);
    },
  });

  pipe.fromGuest.on("data", (chunk: Buffer) => frameDecoder.push(chunk));
  pipe.fromGuest.on("end", () => {
    void closeInternal("guest pipe ended");
  });
  pipe.fromGuest.on("error", () => {
    void closeInternal("guest pipe error");
  });
  // A destroyed/closed guest pipe must settle the broker even when no explicit
  // end/error event was emitted (deterministic teardown in tests/harnesses).
  pipe.fromGuest.on("close", () => {
    void closeInternal("guest pipe closed");
  });
  // Write-side errors must never crash the process as unhandled 'error'
  // events; they fail the pipe closed.
  pipe.toGuest.on("error", () => {
    void closeInternal("host pipe write-side error");
  });

  const closeInternal = async (reason: string): Promise<void> => {
    if (closeStarted) return;
    closeStarted = true;
    // TERMINAL LIFETIME REVOCATION, synchronously and BEFORE any await: a
    // closing broker ends this invocation's authority no matter what state it
    // is in — idle before the first request/claim, mid-request, or after a
    // prior request/claim settled. The adapter seam is notified immediately
    // (idempotent: once per broker lifetime) so no late async continuation can
    // ever authorize/claim/mutate afterwards. This is NOT conditional on an
    // in-flight request existing: a host close / guest EOF of an IDLE
    // connection must revoke adapter authority just the same.
    notifyRevocation(reason);
    if (handshakeTimer !== undefined) {
      clearTimeout(handshakeTimer);
      handshakeTimer = undefined;
    }
    // Settle `ready` on every close/EOF/refusal path before handshake
    // acceptance — a reader awaiting readiness must never be stranded.
    if (!handshakeAccepted) {
      resolveReady({ ok: false, reason: `host broker closed before handshake acceptance (${reason})` });
    }
    // Revoke queued requests; an accepted transition is never erased.
    if (state === "open") state = "canceled";
    cancelQueueAndActive(undefined, state === "completed" ? "CLOSED" : "CANCELED", "broker closing");
    // Bounded final flush: give an in-flight delegated call a moment to land.
    // TIME-CLOCKS rule 1: the flush budget is an in-process deadline, so it
    // is measured on the monotonic clock (a wall-clock jump can neither
    // extend nor cut short the flush).
    const flushDeadline = new Deadline(shutdownFlushMs);
    while (active !== null && !flushDeadline.expired()) {
      await new Promise((r) => setTimeout(r, 5));
    }
    if (state !== "completed") state = "canceled";
    try {
      if (!pipe.toGuest.destroyed && !pipe.toGuest.writableEnded) pipe.toGuest.end();
    } catch {
      /* ignore */
    }
    resolveClosed();
  };

  // Finite handshake deadline: the option is honored from construction. When
  // no acceptable hello completes in time, ready settles {ok:false} and the
  // broker closes safely — no ignored config knob, no stranded readers.
  handshakeTimer = setTimeout(() => {
    handshakeTimer = undefined;
    if (handshakeAccepted || closeStarted) return;
    refuseHandshake(`guest handshake did not complete within ${handshakeTimeoutMs}ms`);
  }, handshakeTimeoutMs);

  return {
    ready,
    closed,
    close: () => closeInternal("host close"),
    cancelRequest: (id?: string) => {
      if (id === undefined) {
        // Host cancel of the WHOLE invocation (no target request) is a
        // TERMINAL lifetime event: synchronously revoke adapter authority even
        // when the invocation is idle (nothing in flight or queued to cancel)
        // or after a settled claim — not merely when an active request
        // happened to be revoked. Exact-request cancel (id provided) stays
        // request-scoped below.
        notifyRevocation("invocation canceled by host");
      }
      // Cancellation revokes NEW mutations without erasing an accepted
      // transition (state === "completed" is never downgraded).
      if (state === "open") state = "canceled";
      cancelQueueAndActive(id, "CANCELED", "request canceled by host");
    },
    state: () => state,
  };
}
