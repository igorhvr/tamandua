/**
 * Guest bridge protocol contract.
 *
 * MTLK guest stage (do-review-do-verify): shared, dependency-free protocol
 * vocabulary for the Matchlock guest helper pack and the scoped host broker.
 * Everything in this module is Node-core only and is safe to ship inside the
 * portable RO guest pack.
 *
 * Two transports use the same framed envelope and the same op vocabulary:
 *
 *   1. guest CLI  <->  guest-local bridge service   (guest-local Unix socket)
 *   2. guest bridge service <-> host broker         (injected exec_pipe byte pipe)
 *
 * A protocol/build handshake must complete before any command is accepted on
 * either transport. Frame contents are UTF-8 JSON envelopes described by the
 * `kind` discriminator (hello / hello-ack / req / res / err / ctrl).
 *
 * ── Suite surface (MTLK-SUITE-WIRE) ──────────────────────────────────────
 *
 * Since MTLK-SUITE-WIRE the vocabulary ALSO carries the SIX suite operations
 * of the typed GuestSuiteTransport (guest-suite-contract.ts): suite.lookup /
 * suite.claim / suite.record / suite.release / suite.duration-history /
 * suite.event. A suite `req` frame's `params` is the full op-specific
 * request record (namespace + ledger key + op fields) and its `res` payload
 * is `{ suite: <GuestSuiteCallResult> }`, so a refused/unavailable outcome
 * stays a structured op result (the guest engine degrades with an explicit
 * warning and never records/replays) rather than being flattened into an
 * `err` frame. Per-op request shape/type/bounds are re-checked at BOTH the
 * guest service boundary and the host broker boundary with
 * validateSuiteBridgeParams (below) — the single canonical wire validator.
 */

/** Version of the guest<->broker wire protocol. Bump on incompatible change. */
export const GUEST_BRIDGE_PROTOCOL_VERSION = 1;

/**
 * Version of the guest helper pack layout (bin/lib/skills/manifest). The pack
 * now ships the guest suite entry (bin/tamandua-test) in addition to the
 * worker CLI and bridge service (MTLK-SUITE-WIRE); the layout version stays 1
 * because the layout shape is unchanged and the new entry is additive.
 */
export const GUEST_PACK_LAYOUT_VERSION = 1;

/** Kind names understood by both the service and the broker. */
export const FRAME_KINDS = ["hello", "hello-ack", "req", "res", "err", "ctrl"] as const;
export type FrameKind = (typeof FRAME_KINDS)[number];

/** Length-prefix size in bytes (big-endian uint32). */
export const FRAME_HEADER_BYTES = 4;

/**
 * Absolute upper bound for one frame payload. Report/reason content is
 * bounded separately (smaller) so a single content payload always fits.
 */
export const MAX_FRAME_PAYLOAD_BYTES = 1 * 1024 * 1024;

/** Bounded content sizes (guest CLI reads files once and transfers content). */
export const MAX_HELLO_BYTES = 4096;
export const MAX_REPORT_BYTES = 256 * 1024;
export const MAX_REASON_BYTES = 16 * 1024;
export const MAX_STORIES_JSON_FILE_BYTES = 512 * 1024;
export const MAX_INPUT_LINE_BYTES = 4096;
/** Flat bound on lines accepted inside a transferred report/reason payload. */
export const MAX_CONTENT_LINES = 20000;

/**
 * US-004 (bounded run-scoped query surface): request-side byte bound on the
 * `run_id` carried by step.stories / workflow.status / logs.run requests.
 * Mirrors the guest-service generic id bound (256 bytes) so the canonical
 * wire validator and the service agree.
 */
export const GUEST_QUERY_RUN_ID_MAX_BYTES = 256;

/**
 * Bounded tail semantics for the run-scoped logs query (logs.run). The guest
 * never enumerates a whole run event file: it reads the most recent
 * `GUEST_RUN_LOG_DEFAULT_LIMIT` events (native getRunEvents(runId, limit)
 * tail semantics) and never more than `GUEST_RUN_LOG_LIMIT_MAX`. A request
 * that asks for more than the maximum is refused by the wire validator.
 */
export const GUEST_RUN_LOG_DEFAULT_LIMIT = 50;
export const GUEST_RUN_LOG_LIMIT_MAX = 200;

/**
 * Byte budget for one logs.run response payload (formatted native log lines,
 * UTF-8). The host query service keeps the NEWEST lines that fit and marks
 * the response truncated, so a run event file can never push an oversized
 * frame into the bounded guest bridge even when a single event carries a
 * very large detail field.
 */
export const GUEST_RUN_LOG_PAYLOAD_BYTES = 384 * 1024;

/** Bounded concurrency/queueing at the guest-local socket service. */
export const MAX_SOCKET_CONNECTIONS = 16;
export const MAX_QUEUED_PER_CONNECTION = 16;
export const MAX_INFLIGHT_TO_HOST = 8;
export const SOCKET_BACKLOG = 16;

/** Finite deadlines. Never an unbounded readiness/request wait. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_SHUTDOWN_FLUSH_MS = 2_000;

/** Env vars understood by the guest CLI/service (controller-provisioned). */
export const ENV_GUEST_SOCKET_DIR = "TAMANDUA_GUEST_SOCKET_DIR";
export const ENV_GUEST_SOCKET = "TAMANDUA_GUEST_SOCKET";
export const ENV_BRIDGE_REQUEST_TIMEOUT_MS = "TAMANDUA_BRIDGE_REQUEST_TIMEOUT_MS";
export const ENV_BRIDGE_HANDSHAKE_TIMEOUT_MS = "TAMANDUA_BRIDGE_HANDSHAKE_TIMEOUT_MS";

/** Socket file name inside the guest-owned socket directory. */
export const GUEST_SOCKET_FILENAME = "bridge.sock";

/**
 * Ops the guest CLI may issue. Anything else fails explicitly.
 *
 * MTLK-SUITE-WIRE: the six suite ops are part of the explicit protocol
 * vocabulary (design section 8: the suite surface crosses the same scoped
 * bridge). They are only SERVED when the guest bridge service is configured
 * with a suite-capable host (suiteEnabled) and the host broker was injected
 * with a host suite transport/services bridge — otherwise they fail
 * explicitly as UNSUPPORTED / refused and the guest engine degrades to real
 * guest-local execution with an explicit warning (never a recorded/replayed
 * green, never a native host fallback).
 */
export const BRIDGE_OPS = [
  "step.peek",
  "step.claim",
  "step.current",
  "step.complete",
  "step.fail",
  "step.stories",
  "workflow.status",
  "logs.run",
  "merge.authorize",
  "merge.report",
  "suite.lookup",
  "suite.claim",
  "suite.record",
  "suite.release",
  "suite.duration-history",
  "suite.event",
] as const;
export type BridgeOp = (typeof BRIDGE_OPS)[number];

/**
 * US-004: the three read-only, run-scoped query ops (guest CLI `step stories
 * <run> [--json]`, `workflow status <run> --json` and bounded run-scoped
 * `logs <run>`). They are served ONLY for the invocation's own bound run and
 * never mutate invocation/host state: no opKey is required and no idempotency
 * ledger entry is written for them.
 */
export const QUERY_BRIDGE_OPS = [
  "step.stories",
  "workflow.status",
  "logs.run",
] as const;
export type QueryBridgeOp = (typeof QUERY_BRIDGE_OPS)[number];

/** True when `op` is one of the three read-only run-scoped query operations. */
export function isQueryBridgeOp(op: string): op is QueryBridgeOp {
  return (QUERY_BRIDGE_OPS as readonly string[]).includes(op);
}

/**
 * US-007: the two scoped merge ops. `merge.authorize` asks the host broker to
 * type-check the finalizer binding (role/claim/origin/target/expect-tip/
 * context) BEFORE any Git action; `merge.report` carries the guest-executed
 * shared pure-core outcome back so the host can independently verify the
 * authoritative target tip, emit the run-attributed merge event and return a
 * replayable acknowledgement. Neither op is a general host Git/exec surface.
 */
export const MERGE_BRIDGE_OPS = ["merge.authorize", "merge.report"] as const;
export type MergeBridgeOp = (typeof MERGE_BRIDGE_OPS)[number];

/** True when `op` is one of the two scoped merge operations. */
export function isMergeBridgeOp(op: string): op is MergeBridgeOp {
  return (MERGE_BRIDGE_OPS as readonly string[]).includes(op);
}

// ── US-007 merge authorization wire bounds ──────────────────────────────
/** Bound on a repository/root path carried by a merge request. */
export const MERGE_WIRE_PATH_MAX_BYTES = 4096;
/** Bound on a branch/target name carried by a merge request. */
export const MERGE_WIRE_NAME_MAX_BYTES = 1024;
/** Bound on the complete commit message (multiline/Unicode safe). */
export const MERGE_WIRE_MESSAGE_MAX_BYTES = 128 * 1024;
/** Bound on the host-issued authorization id echoed back by merge.report. */
export const MERGE_WIRE_AUTH_ID_MAX_BYTES = 128;
/** Bound on a single-line operational detail / parked reason. */
export const MERGE_WIRE_DETAIL_MAX_BYTES = 16 * 1024;
/** Bound on the Git conflict listing transferred back for a conflicts result. */
export const MERGE_WIRE_CONFLICTS_MAX_BYTES = 256 * 1024;

const MERGE_WIRE_TIP_RE = /^[0-9a-f]{40,64}$/;

/** Terminal statuses a guest merge outcome may report. */
export const MERGE_REPORT_STATUSES = ["landed", "target_moved", "conflicts", "operational_error"] as const;
export type MergeReportStatus = (typeof MERGE_REPORT_STATUSES)[number];

/** The six suite ops of the typed GuestSuiteTransport carried by the bridge. */
export const SUITE_BRIDGE_OPS = [
  "suite.lookup",
  "suite.claim",
  "suite.record",
  "suite.release",
  "suite.duration-history",
  "suite.event",
] as const;
export type SuiteBridgeOp = (typeof SUITE_BRIDGE_OPS)[number];

/** True when `op` is one of the six suite operations. */
export function isSuiteBridgeOp(op: string): op is SuiteBridgeOp {
  return (SUITE_BRIDGE_OPS as readonly string[]).includes(op);
}

/** Suite ops that mutate the host suite ledger/claims (claim/record/release/event). */
export function mutatingSuiteBridgeOp(op: string): boolean {
  return op === "suite.claim" || op === "suite.record" || op === "suite.release" || op === "suite.event";
}

/** Protocol-level error codes carried in `err` frames. */
export const BRIDGE_ERROR_CODES = [
  "BAD_FRAME",
  "BAD_REQUEST",
  "UNSUPPORTED",
  "HANDSHAKE",
  "BINDING",
  "INVOCATION_STATE",
  "IDEMPOTENCY",
  "CLAIM",
  "SERVICE",
  "DEADLINE",
  "CANCELED",
  "CLOSED",
  "QUEUE_FULL",
  "OVERSIZED",
  "IO",
  // US-007 typed merge authorization/receipt refusals (issued by the host
  // broker/merge service BEFORE any Git action, except MERGE_VERIFY which is
  // the post-execution authoritative-tip verification failure).
  "MERGE_ROLE",
  "MERGE_CLAIM",
  "MERGE_BINDING",
  "MERGE_ORIGIN",
  "MERGE_TARGET",
  "MERGE_TIP",
  "MERGE_CONTEXT",
  "MERGE_AUTHORIZATION",
  "MERGE_REPLAY",
  "MERGE_VERIFY",
  "MERGE_SERVICE",
] as const;
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

// ── Suite request validation (MTLK-SUITE-WIRE) ──────────────────────────
// Bounds/helpers shared by the guest service boundary and the host broker
// boundary. The typed contract's per-op shape rules live in
// guest-suite-contract.ts (paramsMatchSuiteOp); this validator is the
// canonical WIRE validator: it checks every suite op's actual request fields
// (shape, type, byte bounds, finite numerics, permitted events, canonical
// namespace form) so malformed/oversized/nonfinite/foreign-shape requests are
// rejected identically at BOTH boundaries before any forwarding or mutation.

import {
  CMD_DISPLAY_MAX_BYTES,
  GUEST_SUITE_NAMESPACE_FIELDS,
  LOG_TAIL_BYTES,
  SUITE_PERMITTED_EVENTS,
  isPermittedSuiteEvent,
  normalizeGuestSuiteNamespace,
  type GuestSuiteNamespace,
  type SuiteTransportOp,
} from "./guest-suite-contract.js";

/** Bound on request-side id/attribution strings (mirror host-suite-service). */
export const SUITE_WIRE_ID_MAX_BYTES = 256;
/** Bound on the exact-owner claim token (mirror host-suite-service). */
export const SUITE_WIRE_OWNER_TOKEN_MAX_BYTES = 128;
/** Bound on the origin repo key field carried over the wire. */
export const SUITE_WIRE_ORIGIN_REPO_MAX_BYTES = 4096;

const SUITE_WIRE_TREE_HASH_RE = /^[0-9a-f]{40}$/;
const SUITE_WIRE_CMD_HASH_RE = /^[0-9a-f]{64}$/;
const SUITE_WIRE_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function wireBytes(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

function wireIsRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate the `namespace` member of a suite request WITHOUT mutating the
 * caller's object: the namespace must be a plain object of four bounded
 * canonical (non-whitespace) ASCII fields. Returns a refusal code or null.
 */
function suiteNamespaceWireRefusal(ns: unknown): BridgeErrorCode | null {
  if (!wireIsRecord(ns)) return "BAD_REQUEST";
  const original: Record<string, string> = {};
  for (const field of GUEST_SUITE_NAMESPACE_FIELDS) {
    const value = ns[field];
    if (typeof value !== "string") return "BAD_REQUEST";
    original[field] = value;
  }
  // normalizeGuestSuiteNamespace trims its input in place; normalize a COPY
  // and compare against the caller's original (never-mutated) values.
  const copy: Record<string, unknown> = { ...original };
  const normalized = normalizeGuestSuiteNamespace(copy as unknown as GuestSuiteNamespace);
  if (!normalized.ok) {
    // Oversized fields are OVERSIZED; any other malformation is BAD_REQUEST.
    return normalized.error.includes("exceeds") ? "OVERSIZED" : "BAD_REQUEST";
  }
  // Canonical-form enforcement: a namespace that only normalizes after
  // trimming (leading/trailing whitespace) would silently become a DIFFERENT
  // key — refuse it instead of folding it into the canonical one.
  for (const field of GUEST_SUITE_NAMESPACE_FIELDS) {
    if (normalized.value[field] !== original[field]) return "BAD_REQUEST";
  }
  return null;
}

/**
 * Canonical wire validation for one suite request (`params` is the full
 * op-specific request record). Rejects unknown/malformed field sets, oversized
 * fields, non-finite/non-integer numerics, invalid hashes, wrong timestamp
 * form, unpermitted events and non-canonical namespaces at BOTH the guest
 * service and the host broker boundary. Returns a BridgeErrorCode + message
 * or null when the request is well-formed (semantic host validation —
 * namespace identity, roots, invocation binding — still happens at the host
 * suite service, which owns the ledger).
 */
export function validateSuiteBridgeParams(
  op: string,
  params: unknown,
): { code: BridgeErrorCode; message: string } | null {
  if (!isSuiteBridgeOp(op)) {
    return { code: "UNSUPPORTED", message: `unsupported suite op: ${String(op)}` };
  }
  if (!wireIsRecord(params)) {
    return { code: "BAD_REQUEST", message: "suite request params must be an object" };
  }
  const nsRefusal = suiteNamespaceWireRefusal(params.namespace);
  if (nsRefusal) {
    return {
      code: nsRefusal,
      message: nsRefusal === "OVERSIZED"
        ? "suite request namespace field exceeds its byte bound"
        : "suite request namespace is malformed (four canonical non-whitespace ASCII fields required)",
    };
  }
  const str = (name: string, maxBytes: number): { code: BridgeErrorCode; message: string } | null => {
    const v = params[name];
    if (typeof v !== "string") {
      return { code: "BAD_REQUEST", message: `suite request "${name}" must be a string` };
    }
    if (wireBytes(v) > maxBytes) {
      return { code: "OVERSIZED", message: `suite request "${name}" exceeds ${maxBytes} bytes` };
    }
    return null;
  };
  const optStr = (name: string, maxBytes: number): { code: BridgeErrorCode; message: string } | null => {
    const v = params[name];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") {
      return { code: "BAD_REQUEST", message: `suite request "${name}" must be a string` };
    }
    if (wireBytes(v) > maxBytes) {
      return { code: "OVERSIZED", message: `suite request "${name}" exceeds ${maxBytes} bytes` };
    }
    return null;
  };

  if (op === "suite.event") {
    const event = params.event;
    if (typeof event !== "string" || !isPermittedSuiteEvent(event)) {
      return {
        code: "UNSUPPORTED",
        message: `suite event ${String(event)} is not in the permitted suite event set`,
      };
    }
    return str("runId", SUITE_WIRE_ID_MAX_BYTES)
      ?? optStr("stepId", SUITE_WIRE_ID_MAX_BYTES)
      ?? null;
  }

  const origin = str("originRepo", SUITE_WIRE_ORIGIN_REPO_MAX_BYTES);
  if (origin) return origin;
  if (typeof params.originRepo !== "string" || params.originRepo.length === 0) {
    return { code: "BAD_REQUEST", message: "suite request originRepo must be non-empty" };
  }

  if (op === "suite.duration-history") {
    const cmd = str("cmdHash", 128);
    if (cmd) return cmd;
    if (typeof params.cmdHash !== "string" || !SUITE_WIRE_CMD_HASH_RE.test(params.cmdHash)) {
      return { code: "BAD_REQUEST", message: "suite request cmd_hash must be the 64-hex SHA-256 of the exact raw command" };
    }
    return null;
  }

  const tree = str("treeHash", 128);
  if (tree) return tree;
  const cmd = str("cmdHash", 128);
  if (cmd) return cmd;
  if (typeof params.treeHash !== "string" || !SUITE_WIRE_TREE_HASH_RE.test(params.treeHash)) {
    return { code: "BAD_REQUEST", message: "suite request tree_hash must be a 40-hex tree hash" };
  }
  if (typeof params.cmdHash !== "string" || !SUITE_WIRE_CMD_HASH_RE.test(params.cmdHash)) {
    return { code: "BAD_REQUEST", message: "suite request cmd_hash must be the 64-hex SHA-256 of the exact raw command" };
  }

  if (op === "suite.claim" || op === "suite.release") {
    const token = str("ownerToken", SUITE_WIRE_OWNER_TOKEN_MAX_BYTES);
    if (token) return token;
    if (typeof params.ownerToken !== "string" || params.ownerToken.length === 0) {
      return { code: "BAD_REQUEST", message: "suite request ownerToken must be a non-empty token" };
    }
    return optStr("runId", SUITE_WIRE_ID_MAX_BYTES)
      ?? optStr("stepId", SUITE_WIRE_ID_MAX_BYTES)
      ?? optStr("invocationId", SUITE_WIRE_ID_MAX_BYTES)
      ?? optStr("reason", 4096)
      ?? null;
  }

  // suite.record — full typed record payload checks (finite numerics etc.).
  if (op === "suite.record") {
    if (typeof params.cmdDisplay !== "string" || params.cmdDisplay.length === 0
      || wireBytes(params.cmdDisplay) > CMD_DISPLAY_MAX_BYTES) {
      return { code: "OVERSIZED", message: `suite request cmd_display must be ≤ ${CMD_DISPLAY_MAX_BYTES} bytes` };
    }
    const exitCode = params.exitCode;
    if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
      return { code: "BAD_REQUEST", message: "suite request exit_code must be an integer in the real [0, 255] range" };
    }
    const durationMs = params.durationMs;
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || !Number.isSafeInteger(durationMs) || durationMs < 0) {
      return { code: "BAD_REQUEST", message: "suite request duration_ms must be a finite non-negative integer" };
    }
    if (params.logTail !== null && params.logTail !== undefined) {
      if (typeof params.logTail !== "string" || wireBytes(params.logTail) > LOG_TAIL_BYTES) {
        return { code: "OVERSIZED", message: `suite request log_tail must be ≤ ${LOG_TAIL_BYTES} bytes or null` };
      }
    }
    if (params.runId !== null && params.runId !== undefined && typeof params.runId !== "string") {
      return { code: "BAD_REQUEST", message: "suite request run_id must be a string or null" };
    }
    if (params.stepId !== null && params.stepId !== undefined && typeof params.stepId !== "string") {
      return { code: "BAD_REQUEST", message: "suite request step_id must be a string or null" };
    }
    if (typeof params.startedAt !== "string" || !SUITE_WIRE_ISO_RE.test(params.startedAt) || !Number.isFinite(Date.parse(params.startedAt))) {
      return { code: "BAD_REQUEST", message: "suite request started_at must be a finite UTC ISO instant" };
    }
    return null;
  }

  // suite.lookup — full key only.
  return optStr("runId", SUITE_WIRE_ID_MAX_BYTES)
    ?? optStr("stepId", SUITE_WIRE_ID_MAX_BYTES)
    ?? null;
}

/** Suites of permitted events (exported for wire-level checks/tests). */
export const SUITE_WIRE_PERMITTED_EVENTS = SUITE_PERMITTED_EVENTS;

/**
 * Canonical wire validation for one run-scoped QUERY request (US-004). The
 * `params` is the op-specific request record — step.stories/workflow.status
 * carry `{ runId }`, logs.run carries `{ runId, limit? }`. Enforced at BOTH
 * the guest bridge service boundary and the host broker boundary so a
 * malformed/oversized/foreign-shape query request never reaches the host
 * query service. Run-id validation mirrors the native CLI (wrong `step-`
 * prefix refused with the native wording); semantic binding (the requested
 * run must equal the invocation's bound run) stays with the host broker.
 * Returns a refusal or null when the request is well-formed.
 */
export function validateQueryBridgeParams(
  op: string,
  params: unknown,
): { code: BridgeErrorCode; message: string } | null {
  if (!isQueryBridgeOp(op)) {
    return { code: "UNSUPPORTED", message: `unsupported query op: ${String(op)}` };
  }
  if (!wireIsRecord(params)) {
    return { code: "BAD_REQUEST", message: "query request params must be an object" };
  }
  const runId = (params as { runId?: unknown }).runId;
  if (typeof runId !== "string" || runId.length === 0) {
    return { code: "BAD_REQUEST", message: "query request run_id must be a non-empty string" };
  }
  if (wireBytes(runId) > GUEST_QUERY_RUN_ID_MAX_BYTES) {
    return { code: "OVERSIZED", message: `query request run_id exceeds ${GUEST_QUERY_RUN_ID_MAX_BYTES} bytes` };
  }
  // Prefixed-id validation identical to native: a step id is never a run id.
  const wrong = detectWrongPrefix(runId, "run");
  if (wrong) return { code: "BAD_REQUEST", message: wrong };
  if (op === "logs.run") {
    const limit = (params as { limit?: unknown }).limit;
    if (limit !== undefined && limit !== null) {
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
        return { code: "BAD_REQUEST", message: "logs.run limit must be a positive integer" };
      }
      if (limit > GUEST_RUN_LOG_LIMIT_MAX) {
        return {
          code: "BAD_REQUEST",
          message: `logs.run limit ${limit} exceeds the bounded maximum tail of ${GUEST_RUN_LOG_LIMIT_MAX}`,
        };
      }
    }
  }
  return null;
}

/**
 * Canonical wire validation for one scoped MERGE request (US-007). Enforced at
 * BOTH the guest bridge service boundary and the host broker boundary so a
 * malformed/oversized/foreign-shape merge request never reaches the host merge
 * service and never triggers a host Git read. Shape/type/bounds only —
 * semantic authority (finalizer binding, admitted root, target tip, context)
 * stays with the host broker/merge service. Returns a refusal or null.
 */
export function validateMergeBridgeParams(
  op: string,
  params: unknown,
): { code: BridgeErrorCode; message: string } | null {
  if (!isMergeBridgeOp(op)) {
    return { code: "UNSUPPORTED", message: `unsupported merge op: ${String(op)}` };
  }
  if (!wireIsRecord(params)) {
    return { code: "BAD_REQUEST", message: "merge request params must be an object" };
  }
  const str = (
    name: string,
    maxBytes: number,
    opts: { nonEmpty?: boolean } = {},
  ): { code: BridgeErrorCode; message: string } | null => {
    const v = params[name];
    if (typeof v !== "string") {
      return { code: "BAD_REQUEST", message: `merge request "${name}" must be a string` };
    }
    if (opts.nonEmpty && v.length === 0) {
      return { code: "BAD_REQUEST", message: `merge request "${name}" must be non-empty` };
    }
    if (wireBytes(v) > maxBytes) {
      return { code: "OVERSIZED", message: `merge request "${name}" exceeds ${maxBytes} bytes` };
    }
    return null;
  };
  const optStr = (name: string, maxBytes: number): { code: BridgeErrorCode; message: string } | null => {
    const v = params[name];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") {
      return { code: "BAD_REQUEST", message: `merge request "${name}" must be a string` };
    }
    if (wireBytes(v) > maxBytes) {
      return { code: "OVERSIZED", message: `merge request "${name}" exceeds ${maxBytes} bytes` };
    }
    return null;
  };

  if (op === "merge.authorize") {
    return str("origin", MERGE_WIRE_PATH_MAX_BYTES, { nonEmpty: true })
      ?? str("branch", MERGE_WIRE_NAME_MAX_BYTES, { nonEmpty: true })
      ?? str("into", MERGE_WIRE_NAME_MAX_BYTES, { nonEmpty: true })
      ?? str("message", MERGE_WIRE_MESSAGE_MAX_BYTES)
      ?? (() => {
        const tip = str("expectTip", 64, { nonEmpty: true });
        if (tip) return tip;
        if (typeof params.expectTip !== "string" || !MERGE_WIRE_TIP_RE.test(params.expectTip)) {
          return { code: "BAD_REQUEST" as const, message: "merge request expect_tip must be a 40-64 hex object id" };
        }
        return null;
      })()
      ?? (() => {
        const runId = optStr("runId", GUEST_QUERY_RUN_ID_MAX_BYTES);
        if (runId) return runId;
        if (typeof params.runId === "string") {
          const wrong = detectWrongPrefix(params.runId, "run");
          if (wrong) return { code: "BAD_REQUEST" as const, message: wrong };
        }
        return null;
      })();
  }

  // merge.report
  const auth = str("authorizationId", MERGE_WIRE_AUTH_ID_MAX_BYTES, { nonEmpty: true });
  if (auth) return auth;
  const status = params.status;
  if (typeof status !== "string" || !(MERGE_REPORT_STATUSES as readonly string[]).includes(status)) {
    return { code: "BAD_REQUEST", message: `merge report status ${String(status)} is not a terminal merge outcome` };
  }
  const exitCode = params.exitCode;
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    return { code: "BAD_REQUEST", message: "merge report exit_code must be an integer in the real [0, 255] range" };
  }
  if (params.noop !== undefined && typeof params.noop !== "boolean") {
    return { code: "BAD_REQUEST", message: "merge report noop must be a boolean" };
  }
  if (params.mergedTree !== undefined && params.mergedTree !== null) {
    if (typeof params.mergedTree !== "string" || !MERGE_WIRE_TIP_RE.test(params.mergedTree)) {
      return { code: "BAD_REQUEST", message: "merge report merged_tree must be a 40-64 hex tree id" };
    }
  }
  if (params.mergedCommit !== undefined && params.mergedCommit !== null) {
    if (typeof params.mergedCommit !== "string" || !MERGE_WIRE_TIP_RE.test(params.mergedCommit)) {
      return { code: "BAD_REQUEST", message: "merge report merged_commit must be a 40-64 hex commit id" };
    }
  }
  if (params.expectedTip !== undefined && params.expectedTip !== null) {
    if (typeof params.expectedTip !== "string" || !MERGE_WIRE_TIP_RE.test(params.expectedTip)) {
      return { code: "BAD_REQUEST", message: "merge report expected_tip must be a 40-64 hex object id" };
    }
  }
  if (params.actualTip !== undefined && params.actualTip !== null) {
    if (typeof params.actualTip !== "string" || !MERGE_WIRE_TIP_RE.test(params.actualTip)) {
      return { code: "BAD_REQUEST", message: "merge report actual_tip must be a 40-64 hex object id" };
    }
  }
  return optStr("checkoutRefresh", MERGE_WIRE_DETAIL_MAX_BYTES)
    ?? optStr("parkedBranch", MERGE_WIRE_NAME_MAX_BYTES)
    ?? optStr("parkedReason", MERGE_WIRE_DETAIL_MAX_BYTES)
    ?? optStr("detail", MERGE_WIRE_DETAIL_MAX_BYTES)
    ?? optStr("conflicts", MERGE_WIRE_CONFLICTS_MAX_BYTES);
}

/**
 * Guest CLI <=> service "hello": negotiated on the guest-local socket before
 * any request. `clientId` is a fresh uuid per CLI process.
 */
export interface GuestHello {
  kind: "hello";
  protocolVersion: number;
  helperBuildVersion: string;
  clientId: string;
}

export interface GuestHelloAck {
  kind: "hello-ack";
  accepted: boolean;
  protocolVersion: number;
  reason?: string;
}

/** Service <=> broker "hello" over the exec pipe (sent by the service). */
export interface BrokerHello {
  kind: "hello";
  protocolVersion: number;
  packLayoutVersion: number;
  helperBuildVersion: string;
  /** Guest-supplied identity. The broker validates, never trusts it. */
  claimedRunId?: string;
  claimedInvocationId?: string;
  claimedAgentId?: string;
  capabilities: string[];
}

export interface BrokerHelloAck {
  kind: "hello-ack";
  accepted: boolean;
  protocolVersion: number;
  reason?: string;
}

/** One request (guest side -> broker side). `id` correlates the response. */
export interface BridgeRequest {
  kind: "req";
  id: string;
  op: BridgeOp;
  /** Client-scoped nonce for local correlation (service -> host mapping). */
  clientId?: string;
  /** Invocation-bound idempotency key for mutating ops. */
  opKey?: string;
  params: BridgeRequestParams;
}

/**
 * Request params. Step ops carry the step-op field sets; a SUITE op's params
 * is the FULL op-specific GuestSuiteTransport request record (namespace +
 * ledger key + op fields) — its per-op shape/types/bounds are validated by
 * validateSuiteBridgeParams at both boundaries. A QUERY op (US-004) carries
 * `{ runId }` (logs.run also `{ limit? }`) and is validated by
 * validateQueryBridgeParams at both boundaries.
 */
export type BridgeRequestParams =
  | { agentId: string; runId: string } // step.peek | step.claim | step.current
  | { stepId: string; output: string } // step.complete
  | { stepId: string; reason: string } // step.fail
  | { runId: string; limit?: number } // step.stories | workflow.status | logs.run
  | MergeAuthorizeRequest // merge.authorize
  | MergeReportRequest // merge.report
  | Record<string, unknown>; // suite.* (validated by validateSuiteBridgeParams)

/** Canonical `merge.authorize` request record (US-007). */
export interface MergeAuthorizeRequest {
  origin: string;
  branch: string;
  into: string;
  expectTip: string;
  message: string;
  /** Optional explicit run id; when present it must match the invocation binding. */
  runId?: string;
}

/**
 * Host-issued, invocation-bound merge authorization. The guest executes the
 * shared pure core with these canonical host-validated values and echoes the
 * `authorizationId` back in its `merge.report`.
 */
export interface MergeAuthorization {
  authorizationId: string;
  origin: string;
  branch: string;
  into: string;
  expectTip: string;
  message: string;
  /** Bare run id (host-attested; never the guest-supplied value). */
  runId: string;
  /** Canonical admitted original repository root. */
  admittedRoot: string;
  /** Target ref the authorization permits advancing (refs/heads/<into>). */
  targetRef: string;
}

/** `merge.report` request record: the guest-observed pure-core outcome. */
export interface MergeReportRequest {
  authorizationId: string;
  status: MergeReportStatus;
  exitCode: number;
  mergedTree?: string;
  mergedCommit?: string;
  noop?: boolean;
  checkoutRefresh?: string;
  parkedBranch?: string;
  parkedReason?: string;
  expectedTip?: string;
  actualTip?: string;
  detail?: string;
  conflicts?: string;
}

/** Replayable host acknowledgement of an accepted `merge.report`. */
export interface MergeReportAck {
  status: MergeReportStatus;
  exitCode: number;
  mergedTree?: string;
  mergedCommit?: string;
  noop?: boolean;
  checkoutRefresh?: string;
  parkedBranch?: string;
  parkedReason?: string;
}

/**
 * True when `params` carries the field set required by `op`. Shape checks only —
 * semantic validation (binding, prefixes, sizes) happens at the service/broker
 * boundaries. Suite ops return true for any plain-object params; the full
 * suite request validation happens inside handleOp/validateRequest so a
 * malformed suite request gets a precise refusal code rather than a generic
 * "unsupported or malformed" answer. Query ops (US-004) require a runId; the
 * full query request validation happens in validateQueryBridgeParams.
 */
export function paramsMatchOp(params: BridgeRequestParams, op: BridgeOp): boolean {
  if (isSuiteBridgeOp(op)) {
    return typeof params === "object" && params !== null && !Array.isArray(params);
  }
  if (op === "step.peek" || op === "step.claim" || op === "step.current") {
    return typeof (params as { agentId?: unknown }).agentId === "string"
      && typeof (params as { runId?: unknown }).runId === "string";
  }
  if (op === "step.complete") {
    return typeof (params as { stepId?: unknown }).stepId === "string"
      && typeof (params as { output?: unknown }).output === "string";
  }
  if (op === "step.fail") {
    return typeof (params as { stepId?: unknown }).stepId === "string"
      && typeof (params as { reason?: unknown }).reason === "string";
  }
  if (op === "step.stories" || op === "workflow.status" || op === "logs.run") {
    // Any plain-object params reaches the canonical wire validator
    // (validateQueryBridgeParams), which produces the precise refusal
    // (BAD_REQUEST/OVERSIZED/prefixed-id wording) for malformed shapes —
    // mirroring the suite ops, so a bad query request never falls through to
    // the generic "unsupported or malformed" answer.
    return typeof params === "object" && params !== null && !Array.isArray(params);
  }
  if (isMergeBridgeOp(op)) {
    // Same contract as queries/suite: the canonical wire validator
    // (validateMergeBridgeParams) produces the precise refusal at BOTH
    // boundaries.
    return typeof params === "object" && params !== null && !Array.isArray(params);
  }
  return false;
}

/** Success response for a request. Payload is op-specific (native-shaped). */
export interface BridgeResponse {
  kind: "res";
  id: string;
  payload: BridgeResponsePayload;
}

/**
 * Structured suite result carried in a `res` frame (MTLK-SUITE-WIRE). It
 * mirrors the typed GuestSuiteCallResult so the guest-side suite transport can
 * rebuild the exact discriminated result (ok | unavailable | refused) for the
 * engine: `ok` carries the echoed op result, `unavailable` degrades to real
 * guest execution with a warning, `refused` is treated as untrusted and never
 * recorded/replayed. The value is op-specific (lookup/claim/record/release/
 * duration-history/event result object).
 */
export interface SuiteWireResult {
  ok: boolean;
  value?: Record<string, unknown>;
  reason?: "unavailable" | "refused";
  code?: string;
  message?: string;
}

export type BridgeResponsePayload =
  | { peek: "HAS_WORK" | "NO_WORK" }
  | { claim: ClaimResponse }
  | { current: CurrentResponse }
  | { complete: CompleteResponse }
  | { fail: FailResponse }
  | { suite: SuiteWireResult }
  // US-004 read-only run-scoped query results (native-shaped outputs).
  | { stories: GuestStoriesPayload }
  | { status: Record<string, unknown> }
  | { logs: GuestLogsPayload }
  // US-007 scoped merge authorization/receipt results.
  | { mergeAuthorization: MergeAuthorization }
  | { mergeReport: MergeReportAck };

/**
 * US-004 stories payload (step.stories). `runId` is the prefixed
 * presentation form (`run-<uuid>`) like every other guest-visible run id;
 * `stories` items carry the full native story presentation fields so the
 * guest CLI can render BOTH native contracts — the `--json` object
 * (runId + buildStoriesJson-shaped entries) and the native human listing
 * (storyId/title/status with retry + resume annotations).
 */
export interface GuestStoryItem {
  storyId: string;
  title: string;
  status: string;
  /** Raw native retry count (human listing suffix only). */
  retryCount: number;
  /** Raw native resume re-queue count (human listing label only). */
  resumeResetCount: number;
  abandonedCount?: number;
  updatedAt?: string;
}

export interface GuestStoriesPayload {
  runId: string;
  stories: GuestStoryItem[];
}

/**
 * US-004 logs payload (logs.run). `lines` are the pre-formatted NATIVE log
 * lines (host getRunEvents(runId, limit) + formatLogsTailLines), so the guest
 * output is byte-identical with `tamandua logs <run-id>` for the same events.
 * `truncated` is true when events were dropped at the tail/byte bound;
 * `limit` is the bounded tail actually applied.
 */
export interface GuestLogsPayload {
  runId: string;
  lines: string[];
  truncated: boolean;
  limit: number;
}

export interface ClaimResponse {
  found: boolean;
  stepId?: string; // prefixed presentation form
  runId?: string;
  input?: string;
}

export interface CurrentResponse {
  found: boolean;
  stepId?: string;
  runId?: string;
  input?: string;
}

/** Mirrors native completeStep result JSON ({status, detail?}). */
export interface CompleteResponse {
  status: string;
  detail?: string;
  /** Submit-time expects rejection: claim retained, exit 1, REJECTED on stderr. */
  rejected?: { message: string; hint?: string };
}

export interface FailResponse {
  status: string;
}

/** Protocol-level error. */
export interface BridgeError {
  kind: "err";
  id?: string; // set when the error answers a specific request
  code: BridgeErrorCode;
  message: string;
}

/** Host-initiated control frame (cancel / close). */
export interface BridgeControl {
  kind: "ctrl";
  op: "cancel" | "close";
  id?: string; // cancel may name an in-flight request id
}

export type BridgeFrame =
  | GuestHello
  | GuestHelloAck
  | BrokerHello
  | BrokerHelloAck
  | BridgeRequest
  | BridgeResponse
  | BridgeError
  | BridgeControl;

/**
 * Prefixed-id helpers mirroring native src/lib/id-prefix.ts semantics so the
 * guest CLI keeps identical "wrong prefix" behaviour. Kept local (core-only)
 * so the pack closure never imports native admin/DB-reachable modules.
 */
export const RUN_ID_PREFIX = "run-";
export const STEP_ID_PREFIX = "step-";

export function stripIdPrefix(id: string): string {
  if (id.startsWith(RUN_ID_PREFIX)) return id.slice(RUN_ID_PREFIX.length);
  if (id.startsWith(STEP_ID_PREFIX)) return id.slice(STEP_ID_PREFIX.length);
  return id;
}

export function prefixRunId(uuid: string): string {
  return `${RUN_ID_PREFIX}${uuid}`;
}

export function prefixStepId(uuid: string): string {
  return `${STEP_ID_PREFIX}${uuid}`;
}

/** Returns a native-style error message when `id` carries the WRONG prefix. */
export function detectWrongPrefix(id: string, expectedKind: "run" | "step"): string | null {
  if (expectedKind === "run" && id.startsWith(STEP_ID_PREFIX)) {
    return `that is a step id, not a run id — ${id}`;
  }
  if (expectedKind === "step" && id.startsWith(RUN_ID_PREFIX)) {
    return `that is a run id, not a step id — step complete needs the stepId from your claim JSON (got ${id})`;
  }
  return null;
}
