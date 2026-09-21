/**
 * MTLK-SUITE-WIRE: GuestSuiteTransport implemented over the guest bridge
 * socket (MTLK-SUITE-WIRE).
 *
 * The guest suite engine (guest-suite-shim.ts) consumes a typed
 * GuestSuiteTransport. This module provides the REAL wired implementation for
 * a packed `bin/tamandua-test`: every six-op call travels
 *
 *     packed tamandua-test ──▶ guest-local Unix socket (guest bridge service)
 *                              ──▶ bounded framed exec-pipe channel ──▶ host broker
 *                              ──▶ injected host suite transport/services bridge
 *
 * One fresh socket connection per op call (like the worker CLI), bounded
 * handshake/request deadlines, framed payloads. Response mapping:
 *
 *   - a `res` frame whose payload is `{ suite: SuiteWireResult }` rebuilds the
 *     typed GuestSuiteCallResult (ok | unavailable | refused) verbatim;
 *   - an `err` frame maps onto the same result vocabulary: transport/service
 *     outage codes degrade as `unavailable` (the engine runs the real command
 *     with an explicit warning and never records/replays), while protocol /
 *     binding / shape codes surface as `refused` (the engine treats the
 *     answer as untrusted and degrades the same way).
 *
 * The transport ALSO verifies that every ok answer echoes the canonical id of
 * the namespace this transport was bound to — a response from another
 * namespace is never forwarded to the engine as a trusted result.
 *
 * Node-core only — safe for the guest pack closure.
 */

import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  GUEST_SOCKET_FILENAME,
  type SuiteWireResult,
} from "./guest-protocol.js";
import { guestRequest } from "./guest-socket-client.js";
import {
  DEFAULT_SUITE_REQUEST_TIMEOUT_MS,
  GUEST_SUITE_TRANSPORT_VERSION,
  MAX_SUITE_REQUEST_TIMEOUT_MS,
  guestSuiteNamespaceId,
  type GuestSuiteCallResult,
  type GuestSuiteClaimRequest,
  type GuestSuiteClaimResult,
  type GuestSuiteDurationHistoryRequest,
  type GuestSuiteDurationHistoryResult,
  type GuestSuiteErrorCode,
  type GuestSuiteEventRequest,
  type GuestSuiteEventResult,
  type GuestSuiteLookupRequest,
  type GuestSuiteLookupResult,
  type GuestSuiteNamespace,
  type GuestSuiteRecordRequest,
  type GuestSuiteRecordResult,
  type GuestSuiteReleaseRequest,
  type GuestSuiteReleaseResult,
  type GuestSuiteTransport,
} from "./guest-suite-contract.js";

export interface GuestSuiteSocketTransportOptions {
  /** Guest-local bridge service socket path. */
  socketPath: string;
  /** Pack manifest helper build version declared in the protocol hello. */
  helperBuildVersion: string;
  /**
   * Host-attested namespace this transport is bound to. Every ok answer must
   * echo its canonical id; null disables socket use (callers fall back to the
   * unavailable transport with an explicit warning).
   */
  namespace: GuestSuiteNamespace | null;
  handshakeTimeoutMs?: number;
  /** Default per-op deadline (bounded; per-call timeoutMs overrides). */
  requestTimeoutMs?: number;
}

/** Outage/refusal bridge codes that map to the transport result vocabulary. */
function mapBridgeFailure(code: string, message: string): GuestSuiteCallResult<never> {
  const outage = new Set([
    "DEADLINE",
    "IO",
    "CLOSED",
    "CANCELED",
    "QUEUE_FULL",
    "SERVICE",
    "HANDSHAKE",
  ]);
  if (outage.has(code)) {
    return { ok: false, reason: "unavailable", message: message || `guest bridge: ${code}` };
  }
  let guestCode: "UNSUPPORTED" | "OVERSIZED" | "BAD_REQUEST" | "WRONG_NAMESPACE" | "DENIED";
  if (code === "UNSUPPORTED" || code === "OVERSIZED" || code === "BAD_REQUEST" || code === "WRONG_NAMESPACE") {
    guestCode = code;
  } else {
    // BINDING / INVOCATION_STATE / IDEMPOTENCY / CLAIM / BAD_FRAME / unknown
    // are all untrusted protocol outcomes → refused DENIED or BAD_REQUEST.
    guestCode = code === "BAD_FRAME" ? "BAD_REQUEST" : "DENIED";
  }
  return { ok: false, reason: "refused", code: guestCode, message: message || `guest bridge refused: ${code}` };
}

function toResult<T>(value: Record<string, unknown> | undefined): GuestSuiteCallResult<T> {
  if (value === undefined) {
    return { ok: false, reason: "unavailable", message: "guest bridge answered without a suite payload" };
  }
  return { ok: true, value: value as unknown as T };
}

/**
 * Build the GuestSuiteTransport the packed guest engine uses when the host
 * suite service IS present: socket path resolves, an attested namespace was
 * supplied and the guest bridge service was launched suite-enabled
 * (TAMANDUA_GUEST_SUITE_ENABLED=1). Every op opens a fresh bounded socket
 * connection to the guest bridge service.
 */
export class GuestSuiteSocketTransport implements GuestSuiteTransport {
  readonly contractVersion = GUEST_SUITE_TRANSPORT_VERSION;
  readonly namespace: GuestSuiteNamespace | null;
  private readonly socketPath: string;
  private readonly helperBuildVersion: string;
  private readonly handshakeTimeoutMs: number;
  private readonly defaultRequestTimeoutMs: number;
  private readonly namespaceId: string | null;

  constructor(opts: GuestSuiteSocketTransportOptions) {
    this.socketPath = opts.socketPath;
    this.helperBuildVersion = opts.helperBuildVersion;
    this.namespace = opts.namespace;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const requested = opts.requestTimeoutMs ?? DEFAULT_SUITE_REQUEST_TIMEOUT_MS;
    this.defaultRequestTimeoutMs = Math.max(
      1,
      Math.min(Number.isFinite(requested) ? requested : DEFAULT_SUITE_REQUEST_TIMEOUT_MS, MAX_SUITE_REQUEST_TIMEOUT_MS),
    );
    this.namespaceId = this.namespace ? guestSuiteNamespaceId(this.namespace) : null;
  }

  /** Resolve the socket directory env var → default socket file name. */
  static socketPathFromEnv(envGet: (name: string) => string | undefined, socketDirEnv: string): string | null {
    const direct = envGet("TAMANDUA_GUEST_SOCKET")?.trim();
    if (direct) return direct;
    const dir = envGet(socketDirEnv)?.trim();
    if (dir) return `${dir.replace(/\/+$/, "")}/${GUEST_SOCKET_FILENAME}`;
    return null;
  }

  /** Bound per-call deadline honoring the engine's finite timeoutMs. */
  private timeoutOf(timeoutMs?: number): number {
    if (timeoutMs === undefined) return this.defaultRequestTimeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 1) {
      return this.defaultRequestTimeoutMs;
    }
    return Math.min(timeoutMs, MAX_SUITE_REQUEST_TIMEOUT_MS);
  }

  private async request<T>(
    op: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<GuestSuiteCallResult<T>> {
    const outcome = await guestRequest(
      {
        socketPath: this.socketPath,
        helperBuildVersion: this.helperBuildVersion,
        handshakeTimeoutMs: this.handshakeTimeoutMs,
        requestTimeoutMs: this.timeoutOf(timeoutMs),
      },
      { op, params },
    );
    if (!outcome.ok) {
      return mapBridgeFailure(outcome.code, outcome.message);
    }
    const payload = outcome.payload as { suite?: SuiteWireResult } | undefined;
    const wire = payload && typeof payload === "object" ? payload.suite : undefined;
    if (wire === undefined) {
      return { ok: false, reason: "unavailable", message: "guest bridge answered with a non-suite payload" };
    }
    if (wire.ok !== true) {
      if (wire.reason === "refused") {
        return {
          ok: false,
          reason: "refused",
          code: wire.code as GuestSuiteErrorCode,
          message: wire.message ?? "guest bridge suite refusal",
        };
      }
      return { ok: false, reason: "unavailable", message: wire.message ?? "guest bridge suite unavailable" };
    }
    // Never forward an answer that was not echoed from OUR namespace: a
    // cross-namespace answer is an untrusted result the engine must not use.
    const value = wire.value as Record<string, unknown> | undefined;
    if (this.namespaceId !== null) {
      const echoed = value?.namespaceId;
      if (typeof echoed !== "string" || echoed !== this.namespaceId) {
        return {
          ok: false,
          reason: "refused",
          code: "WRONG_NAMESPACE",
          message: `guest bridge suite answer echoed namespace "${String(echoed)}" but this transport is bound to "${this.namespaceId}"`,
        };
      }
    }
    return toResult<T>(value);
  }

  lookup(req: GuestSuiteLookupRequest, timeoutMs?: number): Promise<GuestSuiteCallResult<GuestSuiteLookupResult>> {
    return this.request("suite.lookup", req as unknown as Record<string, unknown>, timeoutMs);
  }

  claim(req: GuestSuiteClaimRequest, timeoutMs?: number): Promise<GuestSuiteCallResult<GuestSuiteClaimResult>> {
    return this.request("suite.claim", req as unknown as Record<string, unknown>, timeoutMs);
  }

  record(req: GuestSuiteRecordRequest, timeoutMs?: number): Promise<GuestSuiteCallResult<GuestSuiteRecordResult>> {
    return this.request("suite.record", req as unknown as Record<string, unknown>, timeoutMs);
  }

  release(req: GuestSuiteReleaseRequest, timeoutMs?: number): Promise<GuestSuiteCallResult<GuestSuiteReleaseResult>> {
    return this.request("suite.release", req as unknown as Record<string, unknown>, timeoutMs);
  }

  durationHistory(
    req: GuestSuiteDurationHistoryRequest,
    timeoutMs?: number,
  ): Promise<GuestSuiteCallResult<GuestSuiteDurationHistoryResult>> {
    return this.request("suite.duration-history", req as unknown as Record<string, unknown>, timeoutMs);
  }

  emitEvent(req: GuestSuiteEventRequest, timeoutMs?: number): Promise<GuestSuiteCallResult<GuestSuiteEventResult>> {
    return this.request("suite.event", req as unknown as Record<string, unknown>, timeoutMs);
  }
}
