/**
 * MTLK guest suite: typed injectable suite-transport contract.
 *
 * This module is the explicit, typed contract for the SIX native suite
 * semantic operations a guest `tamandua-test` shim needs — lookup, claim,
 * record, exact-token release, duration-history, and the permitted suite
 * event set. It is deliberately NOT an HTTP/CLI/admin proxy: there is no
 * owner-wide release, no heartbeat endpoint and no general URL forwarder.
 * The scope binding (run/step/invocation) and the admitted environment
 * namespace are HOST-SUPPLIED inputs; a guest never asserts authority by
 * itself (design sections 7.2 and 8).
 *
 * Component stage: the guest suite engine (guest-suite-shim.ts) consumes a
 * `GuestSuiteTransport` implementation through this interface. This slice
 * ships the contract + the engine + a fake transport test gate; wiring the
 * transport into the existing guest socket service / scoped host broker /
 * authoritative host ledger adapter is a documented later integration step.
 *
 * Closure rule: Node-core only — safe for the portable RO guest pack
 * (guest-pack-builder walkGuestClosure allows only dist/installer/matchlock
 * modules importing node: prefixed packages).
 */

/** Version of the guest-suite transport contract. Bump on incompatible change. */
export const GUEST_SUITE_TRANSPORT_VERSION = 1;

// ── Bounded transfer sizes (mirror native tunables; never unbounded) ──

/** Combined stdout+stderr log tail retained for ledger records (native LOG_TAIL_KB). */
export const LOG_TAIL_KB = 20;
export const LOG_TAIL_BYTES = LOG_TAIL_KB * 1024;

/**
 * Command display captured per record (native cmd_display cap). The guest
 * engine clamps cmdDisplay to this REAL byte bound (clampDisplayBytes in
 * guest-suite-shim.ts — never a code-unit slice, so a multibyte command
 * cannot exceed it); a transport's OVERSIZED refusal is only a second line
 * of defense.
 */
export const CMD_DISPLAY_MAX_BYTES = 200;

/** Cache policy windows (byte-identical to native src/suite/config.ts). */
export const TTL_GREEN_MS = 24 * 60 * 60 * 1000;
export const RED_CONTEXT_WINDOW_MS = 15 * 60 * 1000;
export const FLAKE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CLAIM_TIMEOUT_MS = 30 * 60 * 1000;
export const SINGLEFLIGHT_POLL_INTERVAL_MS = 1000;

/** Default per-op deadline the shim passes to the transport (native control-client default). */
export const DEFAULT_SUITE_REQUEST_TIMEOUT_MS = 1500;

/** Finite lease on one transport request; transport enforces, shim never exceeds. */
export const MAX_SUITE_REQUEST_TIMEOUT_MS = 120_000;

// ── Namespace field bounds (nonsecret, host-attested) ─────────────────

/** Immutable image content identity, e.g. a content digest the controller pinned. */
export const IMAGE_CONTENT_ID_MAX_BYTES = 256;
/** Guest platform, e.g. "linux/amd64". */
export const GUEST_PLATFORM_MAX_BYTES = 64;
/** Helper contract identity, e.g. "guest-helper-<build>+suite-v1". */
export const HELPER_CONTRACT_MAX_BYTES = 128;
/** Bounded nonsecret compatibility fingerprint (hex/alnum only, no credentials). */
export const COMPATIBILITY_FINGERPRINT_MAX_BYTES = 64;
/** Bounded ASCII set for namespace fields (no control chars, no whitespace). */
const NAMESPACE_FIELD_RE = /^[A-Za-z0-9._:/@+-]+$/;

// ── Ops and excluded surface ──────────────────────────────────────────

/**
 * The SIX native semantic operations of the suite transport. Any other
 * operation (owner-wide release, heartbeat/liveness, arbitrary run state,
 * general URL proxy, host execution of a test command) is OUT OF SCOPE and
 * must fail explicitly as UNSUPPORTED.
 */
export const SUITE_TRANSPORT_OPS = [
  "suite.lookup",
  "suite.claim",
  "suite.record",
  "suite.release",
  "suite.duration-history",
  "suite.event",
] as const;
export type SuiteTransportOp = (typeof SUITE_TRANSPORT_OPS)[number];

/**
 * Permitted suite.* events (design section 8 list): cache hit, flaky
 * detection, single-flight wait, execution start, tree drift and the
 * applicable special-exit evidence. Anything else is refused UNSUPPORTED.
 */
export const SUITE_PERMITTED_EVENTS = [
  "suite.cache_hit",
  "suite.flaky_detected",
  "suite.singleflight_wait",
  "suite.execute_started",
  "suite.tree_drift_detected",
  "suite.special_exit_observed",
] as const;
export type SuitePermittedEvent = (typeof SUITE_PERMITTED_EVENTS)[number];

export function isPermittedSuiteEvent(event: string): event is SuitePermittedEvent {
  return (SUITE_PERMITTED_EVENTS as readonly string[]).includes(event);
}

/** Transport-level error codes. */
export const GUEST_SUITE_ERROR_CODES = [
  "BAD_REQUEST",
  "OVERSIZED",
  "WRONG_NAMESPACE",
  "DENIED",
  "UNSUPPORTED",
  "SERVICE",
  "DEADLINE",
  "IO",
  "CLOSED",
] as const;
export type GuestSuiteErrorCode = (typeof GUEST_SUITE_ERROR_CODES)[number];

// ── Environment namespace ─────────────────────────────────────────────

/**
 * Attested environment identity that scopes every ledger key/record of a
 * Matchlock guest invocation. All fields are host-supplied (the controller /
 * helper manifest), nonsecret and bounded. The shim NEVER fabricates this
 * namespace and NEVER derives it from guest-asserted authority; without an
 * attested namespace the engine refuses to trust any lookup/record result
 * and degrades to real guest execution with an explicit warning.
 */
export interface GuestSuiteNamespace {
  /** Immutable image content identity (digest or equivalent pinned content). */
  imageContentId: string;
  /** Guest platform, e.g. "linux/amd64". */
  guestPlatform: string;
  /** Helper contract identity (build + suite transport version). */
  helperContract: string;
  /** Bounded nonsecret compatibility fingerprint of effective env inputs. */
  compatibilityFingerprint: string;
}

export type GuestSuiteNamespaceField = keyof GuestSuiteNamespace;

/** All namespace fields, for shape validation. */
export const GUEST_SUITE_NAMESPACE_FIELDS: readonly GuestSuiteNamespaceField[] = [
  "imageContentId",
  "guestPlatform",
  "helperContract",
  "compatibilityFingerprint",
];

const NAMESPACE_MAX_BYTES: Record<GuestSuiteNamespaceField, number> = {
  imageContentId: IMAGE_CONTENT_ID_MAX_BYTES,
  guestPlatform: GUEST_PLATFORM_MAX_BYTES,
  helperContract: HELPER_CONTRACT_MAX_BYTES,
  compatibilityFingerprint: COMPATIBILITY_FINGERPRINT_MAX_BYTES,
};

/**
 * Validate and normalize a namespace. Returns the trimmed namespace or a
 * human message describing the first invalid field. Oversized, empty,
 * whitespace-bearing or control-character values are invalid: a malformed
 * namespace must not be quietly shortened or folded into a different key.
 */
export function normalizeGuestSuiteNamespace(
  input: GuestSuiteNamespace,
): { ok: true; value: GuestSuiteNamespace } | { ok: false; error: string } {
  for (const field of GUEST_SUITE_NAMESPACE_FIELDS) {
    const raw = input[field];
    if (typeof raw !== "string") {
      return { ok: false, error: `guest suite namespace field "${field}" must be a string` };
    }
    const value = raw.trim();
    if (value.length === 0) {
      return { ok: false, error: `guest suite namespace field "${field}" must not be empty` };
    }
    const byteLen = Buffer.byteLength(value, "utf-8");
    const max = NAMESPACE_MAX_BYTES[field];
    if (byteLen > max) {
      return { ok: false, error: `guest suite namespace field "${field}" exceeds ${max} bytes` };
    }
    if (!NAMESPACE_FIELD_RE.test(value)) {
      return {
        ok: false,
        error:
          `guest suite namespace field "${field}" contains unsupported characters ` +
          `(allowed: [A-Za-z0-9._:/@+-]; no whitespace/control characters)`,
      };
    }
    input[field] = value;
  }
  return { ok: true, value: input };
}

/**
 * Canonical identity of a namespace. This is what keys/records are scoped
 * with and what every transport response must echo so the shim can reject
 * results that actually came from a different namespace. The string itself
 * stays bounded because every field is bounded.
 */
export function guestSuiteNamespaceId(ns: GuestSuiteNamespace): string {
  return [
    `img:${ns.imageContentId}`,
    `plt:${ns.guestPlatform}`,
    `hlp:${ns.helperContract}`,
    `fp:${ns.compatibilityFingerprint}`,
  ].join("|");
}

// ── Typed request/response records (mirror native suite semantics) ────

/** Content-addressed key of one suite (origin + committed tree + exact cmd). */
export interface GuestSuiteLedgerKey {
  /** Admitted origin repository (realpath), as the native shim derives it. */
  originRepo: string;
  /** Committed tree hash (HEAD^{tree}) or tracked tree hash as applicable. */
  treeHash: string;
  /** SHA-256 of the exact raw command string. NEVER decorated with env data. */
  cmdHash: string;
}

export interface GuestSuiteLookupRequest extends GuestSuiteLedgerKey {
  namespace: GuestSuiteNamespace;
}

/** Latest execution entry — mirrors native SuiteLookupResult row shape. */
export interface GuestSuiteLatestRow {
  id?: number;
  origin_repo?: string;
  tree_hash?: string;
  cmd_hash?: string;
  cmd_display?: string;
  exit_code?: number;
  duration_ms?: number;
  log_tail?: string | null;
  run_id?: string | null;
  step_id?: string | null;
  created_at?: string;
  namespace?: string;
  [key: string]: unknown;
}

export interface GuestSuiteLookupResult {
  /** Echoed canonical namespace the result was served from. */
  namespaceId: string;
  latest: GuestSuiteLatestRow | null;
  passCount: number;
  failCount: number;
  flaky: boolean;
}

export interface GuestSuiteClaimRequest extends GuestSuiteLedgerKey {
  namespace: GuestSuiteNamespace;
  /** Opaque exact-owner token minted by THIS guest invocation (never a host pid). */
  ownerToken: string;
  /** run/step attribution (host-bound); empty allowed on replay-only probes. */
  runId?: string;
  stepId?: string;
  /** Host invocation identity that binds the token, when supplied by integration. */
  invocationId?: string;
}

export interface GuestSuiteClaimResult {
  namespaceId: string;
  action: "run" | "wait";
  claimedAt?: string;
}

export interface GuestSuiteRecordRequest extends GuestSuiteLedgerKey {
  namespace: GuestSuiteNamespace;
  cmdDisplay: string;
  exitCode: number;
  durationMs: number;
  logTail: string | null;
  runId: string | null;
  stepId: string | null;
  force: boolean;
  startedAt: string;
}

export interface GuestSuiteRecordResult {
  namespaceId: string;
  id: number;
  created_at: string;
}

export interface GuestSuiteReleaseRequest extends GuestSuiteLedgerKey {
  namespace: GuestSuiteNamespace;
  /** Exact token minted by the claiming invocation. */
  ownerToken: string;
  reason?: string;
}

export interface GuestSuiteReleaseResult {
  namespaceId: string;
  released: boolean;
}

export interface GuestSuiteDurationHistoryRequest {
  originRepo: string;
  cmdHash: string;
  namespace: GuestSuiteNamespace;
}

export interface GuestSuiteDurationHistoryResult {
  namespaceId: string;
  durations: number[];
}

/** Permitted event payload. `event` must be in SUITE_PERMITTED_EVENTS. */
export interface GuestSuiteEventRequest {
  namespace: GuestSuiteNamespace;
  event: string;
  runId: string;
  stepId?: string;
  fields?: Record<string, unknown>;
}

export interface GuestSuiteEventResult {
  namespaceId: string;
  emitted: boolean;
}

// ── Result vocabulary and transport interface ─────────────────────────

/**
 * Every transport op resolves to a discriminated result:
 *   - ok         → typed value (namespace echo validated by the shim)
 *   - unavailable → transport absent / outage / deadline. The engine degrades
 *                   exactly like native control-plane unreachability: real
 *                   guest execution with an explicit warning, never a
 *                   recorded/replayed result.
 *   - refused    → protocol/binding/namespace/size refusal. The engine treats
 *                   the response as UNTRUSTED (never records into it, never
 *                   replays from it) and degrades with an explicit warning.
 */
export type GuestSuiteCallResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "unavailable"; message: string }
  | { ok: false; reason: "refused"; code: GuestSuiteErrorCode; message: string };

export interface GuestSuiteTransport {
  readonly contractVersion: number;
  readonly namespace: GuestSuiteNamespace | null;
  lookup(req: GuestSuiteLookupRequest, timeoutMs?: number): Promise<GuestSuiteCallResult<GuestSuiteLookupResult>>;
  claim(req: GuestSuiteClaimRequest, timeoutMs?: number): Promise<GuestSuiteCallResult<GuestSuiteClaimResult>>;
  record(req: GuestSuiteRecordRequest, timeoutMs?: number): Promise<GuestSuiteCallResult<GuestSuiteRecordResult>>;
  release(req: GuestSuiteReleaseRequest, timeoutMs?: number): Promise<GuestSuiteCallResult<GuestSuiteReleaseResult>>;
  durationHistory(
    req: GuestSuiteDurationHistoryRequest,
    timeoutMs?: number,
  ): Promise<GuestSuiteCallResult<GuestSuiteDurationHistoryResult>>;
  emitEvent(req: GuestSuiteEventRequest, timeoutMs?: number): Promise<GuestSuiteCallResult<GuestSuiteEventResult>>;
}

/**
 * A transport that is NOT wired yet (component stage / outage). Every op
 * reports `unavailable`, so the shim degrades to real guest execution with an
 * explicit warning and never records or replays a result. This is the honest
 * default until integration supplies the guest socket / broker / host ledger
 * adapter transport.
 */
export function createUnavailableSuiteTransport(
  reason = "guest suite transport is not wired in this component stage",
): GuestSuiteTransport {
  return {
    contractVersion: GUEST_SUITE_TRANSPORT_VERSION,
    namespace: null,
    async lookup() {
      return { ok: false, reason: "unavailable", message: reason };
    },
    async claim() {
      return { ok: false, reason: "unavailable", message: reason };
    },
    async record() {
      return { ok: false, reason: "unavailable", message: reason };
    },
    async release() {
      return { ok: false, reason: "unavailable", message: reason };
    },
    async durationHistory() {
      return { ok: false, reason: "unavailable", message: reason };
    },
    async emitEvent() {
      return { ok: false, reason: "unavailable", message: reason };
    },
  };
}

/**
 * Single source of truth for per-op parameter shape. The future host ledger
 * adapter and the guest socket service MUST re-check request shape with this
 * before any mutation (mirrors guest-protocol paramsMatchOp usage).
 */
export function paramsMatchSuiteOp(
  op: SuiteTransportOp,
  req: Record<string, unknown>,
): boolean {
  if (op === "suite.duration-history") {
    return typeof req.originRepo === "string" && typeof req.cmdHash === "string";
  }
  if (op === "suite.claim" || op === "suite.release") {
    return (
      typeof req.originRepo === "string"
      && typeof req.treeHash === "string"
      && typeof req.cmdHash === "string"
      && typeof req.ownerToken === "string"
    );
  }
  return (
    typeof req.originRepo === "string"
    && typeof req.treeHash === "string"
    && typeof req.cmdHash === "string"
  );
}

/** True when the response namespace matches the namespace the request used. */
export function responseNamespaceMatches(
  reqNamespaceId: string,
  value: { namespaceId?: unknown },
): boolean {
  return value.namespaceId === reqNamespaceId;
}
