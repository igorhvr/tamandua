/**
 * runner-error.test.ts — MTLK-CLEANUP US-001.
 *
 * ONE structured serializer for every error on the Matchlock invocation path:
 * `serializeMatchlockError(err, ctx, opts?)` must render name/code/message/
 * stack frames + phase + vmId + controller stderr tail as a single,
 * byte-bounded line and can NEVER produce `[object Object]` (the incident's
 * `'vm close/dispose: [object Object]'`).
 *
 * Pure unit tests — no VM, no model, no child process.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MATCHLOCK_ERROR_TAIL_MAX_BYTES,
  MatchlockRunnerError,
  boundMatchlockErrorText,
  describeMatchlockError,
  serializeMatchlockError,
} from "../../../dist/installer/matchlock/runner-error.js";

const V = "vm-394274ee";
const PHASE = "close";

describe("serializeMatchlockError (MTLK-CLEANUP US-001)", () => {
  it("AC1: renders an Error's name, message and at least one stack frame (never [object Object])", () => {
    const text = serializeMatchlockError(new Error("boom"));
    assert.match(text, /name=Error/);
    assert.match(text, /message=boom/);
    assert.match(text, /stack=at /, "at least one stack frame is present");
    assert.doesNotMatch(text, /\[object Object\]/);
  });

  it("AC2: renders a plain RPC body {code,message,stderrTail} (never [object Object])", () => {
    const text = serializeMatchlockError(
      { code: 7, message: "vm not running", stderrTail: "guest exited" },
      { phase: PHASE, vmId: V },
    );
    assert.match(text, /7/);
    assert.match(text, /vm not running/);
    assert.match(text, /guest exited/);
    assert.match(text, /name=MatchlockRpcError/);
    assert.match(text, new RegExp(`phase=${PHASE}`));
    assert.match(text, new RegExp(`vmId=${V}`));
    assert.doesNotMatch(text, /\[object Object\]/);
  });

  it("includes code from a typed MatchlockRunnerError", () => {
    const err = new MatchlockRunnerError("matchlock_cleanup_failed", "cleanup failed");
    const text = serializeMatchlockError(err, { phase: "dispose", vmId: V, runId: "run-abc", invocationId: "inv-1" });
    assert.match(text, /name=MatchlockRunnerError/);
    assert.match(text, /code=matchlock_cleanup_failed/);
    assert.match(text, /message=cleanup failed/);
    assert.match(text, /phase=dispose/);
    assert.match(text, /vmId=vm-394274ee/);
    assert.match(text, /runId=run-abc/);
    assert.match(text, /invocationId=inv-1/);
  });

  it("passes a bare string through as the message", () => {
    const text = serializeMatchlockError("already a string");
    assert.match(text, /message=already a string/);
    assert.doesNotMatch(text, /\[object Object\]/);
  });

  it("falls back to bounded JSON for a non-RPC object (never [object Object])", () => {
    const text = serializeMatchlockError({ weird: "shape", nested: { depth: 1 } });
    assert.match(text, /weird/);
    assert.match(text, /nested/);
    assert.doesNotMatch(text, /\[object Object\]/);
  });

  it("renders a circular object as [unserializable matchlock error], never [object Object]", () => {
    const circular: Record<string, unknown> = { label: "cycle" };
    circular.self = circular;
    const text = serializeMatchlockError(circular, { phase: PHASE, vmId: V });
    assert.match(text, /\[unserializable matchlock error\]/);
    assert.doesNotMatch(text, /\[object Object\]/);
  });

  it("prefers the caller-supplied controller stderr tail over the error body's", () => {
    const text = serializeMatchlockError(
      { code: -32000, message: "close failed", stderrTail: "body tail" },
      { phase: PHASE, vmId: V, stderrTail: "controller tail" },
    );
    assert.match(text, /controller tail/);
    assert.doesNotMatch(text, /body tail/);
  });

  it("AC4: byte-bounds the whole rendering to MATCHLOCK_ERROR_TAIL_MAX_BYTES with an explicit marker", () => {
    const huge = "x".repeat(MATCHLOCK_ERROR_TAIL_MAX_BYTES * 3);
    const text = serializeMatchlockError(new Error(huge), { phase: PHASE, vmId: V, stderrTail: huge });
    assert.ok(
      Buffer.byteLength(text, "utf8") <= MATCHLOCK_ERROR_TAIL_MAX_BYTES,
      `rendering must be <= ${MATCHLOCK_ERROR_TAIL_MAX_BYTES} bytes, got ${Buffer.byteLength(text, "utf8")}`,
    );
    assert.match(text, /…\[truncated\]/);
  });

  it("accepts a caller byte budget via opts.maxBytes", () => {
    const text = serializeMatchlockError(new Error("boom"), {}, { maxBytes: 32 });
    assert.ok(Buffer.byteLength(text, "utf8") <= 32);
  });

  it("is a single line (no embedded newline) and bounds the stack frame count", () => {
    const err = new Error("multi\nline\nmessage");
    err.stack = ["Error: multi", ...Array.from({ length: 12 }, (_, i) => `    at frame${i} (/x.js:${i}:1)`)].join("\n");
    const text = serializeMatchlockError(err, { phase: PHASE, vmId: V });
    assert.equal(text.includes("\n"), false, "serialized error must be one line");
    const frameMatches = text.match(/at frame\d+/g) ?? [];
    assert.ok(frameMatches.length >= 3 && frameMatches.length <= 5, `expected 3..5 frames, got ${frameMatches.length}`);
    // Newlines collapse to single spaces, so the message text survives as one line.
    assert.match(text, /multi line message/);
  });

  it("renders null/undefined without throwing", () => {
    assert.match(serializeMatchlockError(null), /message=null/);
    assert.match(serializeMatchlockError(undefined), /message=undefined/);
    assert.doesNotMatch(serializeMatchlockError(null), /\[object Object\]/);
  });

  it("describeMatchlockError keeps its existing output contract (regression)", () => {
    // Other callers (scheduler classification) pin this exact shape.
    assert.equal(describeMatchlockError(new Error("plain failure")), "plain failure");
    assert.equal(describeMatchlockError("already a string"), "already a string");
    assert.match(describeMatchlockError({ code: -32000, message: "rpc refused" }), /matchlock rpc error -32000: rpc refused/);
    assert.ok(boundMatchlockErrorText("abc", 10) === "abc");
  });
});

/**
 * MTLK-CLEANUP US-002 — regression pin for the vaimetal #44 close/dispose
 * incident (2026-09-18T21:29:28Z, run 0e1131db, invocation f2c3107f,
 * vm vm-394274ee). The daemon logged `vm close/dispose: [object Object]`
 * because the RPC client rejects with a PLAIN JSON-RPC error body
 * (`rpc-client.ts` onLine: `pending.reject(obj.error)`) and the pre-US-001
 * runner stringified it. The observed body SHAPE is matchlock's
 * `handleClose` mapping of any `(*Sandbox).Close` aggregate error:
 * `{ code: ErrCodeVMFailed (-32000), message: <errors.Join(...)> }`.
 *
 * The exact message is unrecoverable (see the MTLK-CLEANUP contract
 * `rootCause.closeErrorMessageStatus`), but the shape — and the fact that the
 * US-001 serializer renders it fully instead of `[object Object]` — is pinned
 * here so the incident can never render opaquely again.
 */
describe("serializeMatchlockError (MTLK-CLEANUP US-002 incident close body)", () => {
  const INCIDENT_VM = "vm-394274ee";
  const INCIDENT_RUN = "0e1131db-a91f-4ca4-af6a-4a7989100c7b";
  const INCIDENT_INVOCATION = "f2c3107f-84c7-401e-9746-a9309247a37a";

  it("AC4: renders the observed close-error body (code -32000 + aggregate message) with phase/vmId/runId/invocationId", () => {
    // A representative `errors.Join` first error from the cleanup ops that
    // `(*Sandbox).Close` aggregates (machine/TAP close, nftables, VFS, subnet).
    const observedBody = {
      code: -32000,
      message: "machine close: delete tap fc-394274ee: operation not permitted",
    };
    const text = serializeMatchlockError(observedBody, {
      phase: "close",
      vmId: INCIDENT_VM,
      runId: INCIDENT_RUN,
      invocationId: INCIDENT_INVOCATION,
    });
    assert.match(text, /name=MatchlockRpcError/);
    assert.match(text, /code=-32000/);
    assert.match(text, /machine close/);
    assert.match(text, new RegExp(`phase=close`));
    assert.match(text, new RegExp(`vmId=${INCIDENT_VM}`));
    assert.match(text, new RegExp(`runId=${INCIDENT_RUN}`));
    assert.match(text, new RegExp(`invocationId=${INCIDENT_INVOCATION}`));
    assert.doesNotMatch(text, /\[object Object\]/);
  });

  it("AC4: documents the pre-US-001 rendering that lost the incident cause", () => {
    // The thrown value was the RPC client's plain `obj.error` body, not an
    // Error, so the old `String(err)` / `err.message` fallback produced the
    // exact literal the daemon recorded: `[object Object]`.
    const observedBody = { code: -32000, message: "sandbox close failed" };
    assert.equal(String(observedBody), "[object Object]");
    assert.equal(
      observedBody instanceof Error ? observedBody.message : String(observedBody),
      "[object Object]",
    );
  });
});
