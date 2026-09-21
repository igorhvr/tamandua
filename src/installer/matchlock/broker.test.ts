/**
 * Host broker + framing/protocol contract tests (parallel lane, in-memory).
 *
 * Exercises the broker boundary with an in-memory wire and the FakeStepServices
 * authoritative service: binding enforcement, fresh-claim validation, atomic
 * stale-claim rejection, submit-time REJECTED retention, accepted-completion
 * revocation + exact ack replay, idempotency-key rules, cancel/close semantics,
 * and frame-level robustness (partial/oversized/malformed frames).
 *
 * These tests spawn nothing; subprocess (built-pack CLI/service) contract
 * tests live in guest-bridge.test.ts (serial lane).
 */

import { describe, it, before, after, afterEach } from "node:test";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import {
  createHostBroker,
  canonicalRequestIdentity,
  mutatingBridgeOp,
  type HostBrokerHandle,
} from "../../../dist/installer/matchlock/broker.js";
import {
  FakeStepServices,
  FakeQueryServices,
  diagnosticFromValidation,
  validateExpectsLike,
  type FakeStepRow,
  type FakeQueryFixture,
} from "../../../dist/installer/matchlock/broker-test-services.js";
import type {
  AuthoritativeStepServices,
  ClaimOutcome,
  CompleteOutcome,
  FailOutcome,
  HostBinding,
  HostClaim,
  PeekVerdict,
  ValidationDiagnostic,
} from "../../../dist/installer/matchlock/broker-services.js";
import {
  FrameDecoder,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
} from "../../../dist/installer/matchlock/guest-framing.js";
import {
  GUEST_BRIDGE_PROTOCOL_VERSION,
  GUEST_PACK_LAYOUT_VERSION,
  GUEST_RUN_LOG_LIMIT_MAX,
  MAX_FRAME_PAYLOAD_BYTES,
  detectWrongPrefix,
  paramsMatchOp,
  prefixRunId,
  prefixStepId,
  stripIdPrefix,
  type GuestLogsPayload,
  type GuestStoriesPayload,
} from "../../../dist/installer/matchlock/guest-protocol.js";
// Native parity reference for prefix helpers (pure module, no DB/admin graph).
import {
  detectWrongPrefix as nativeDetectWrongPrefix,
  prefixRunId as nativePrefixRunId,
  prefixStepId as nativePrefixStepId,
  stripIdPrefix as nativeStripIdPrefix,
} from "../../../dist/lib/id-prefix.js";
import {
  MAX_REPORT_BYTES,
} from "../../../dist/installer/matchlock/guest-protocol.js";
import {
  dereferenceStoriesJsonFile,
  readFlagFileBounded,
} from "../../../dist/installer/matchlock/guest-files.js";
import { createHostMergeService } from "../../../dist/installer/matchlock/host-merge-service.js";
import type { HostMergeContext } from "../../../dist/installer/matchlock/host-merge-services.js";
import type { MergeCoreEvent } from "../../../dist/installer/matchlock/merge-core.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const INV = "22222222-2222-4222-8222-222222222222";
const AGENT = "feature-dev-merge_developer";
const STEP1 = "33333333-3333-4333-8333-333333333333";
const STEP2 = "44444444-4444-4444-8444-444444444444";

function makeBinding(): HostBinding {
  return {
    runId: RUN,
    invocationId: INV,
    agentId: AGENT,
    jobId: "job-1",
    role: "developer",
    admittedRoots: ["/work"],
    helperProtocolVersion: "bv+p1",
    helperBuildVersion: "bv",
  };
}

function step(stepId: string, over: Partial<FakeStepRow> = {}): FakeStepRow {
  return {
    stepId,
    agentId: AGENT,
    runId: RUN,
    status: "pending",
    expects: "",
    input: `task for ${stepId}`,
    retryCount: 0,
    maxRetries: 2,
    claimId: null,
    ...over,
  };
}

class Wire {
  readonly toGuest = new PassThrough();
  readonly fromGuest = new PassThrough();
  readonly brokerPipe = { toGuest: this.toGuest, fromGuest: this.fromGuest };
  private incoming: unknown[] = [];
  private waiters: Array<(v: unknown) => void> = [];
  private readonly decoder = new FrameDecoder({
    onFrame: (payload) => {
      const parsed = decodeJsonPayload<unknown>(payload);
      if (parsed.ok) this.deliver(parsed.value);
      else this.deliver({ kind: "err", code: "BAD_FRAME", message: parsed.error });
    },
    onError: () => this.deliver({ kind: "err", code: "BAD_FRAME", message: "frame decoder error" }),
  });

  constructor() {
    this.toGuest.on("data", (chunk: Buffer) => this.decoder.push(chunk));
  }

  private deliver(value: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.incoming.push(value);
  }

  async next(timeoutMs = 3000): Promise<Record<string, unknown>> {
    const existing = this.incoming.shift();
    if (existing !== undefined) return existing as Record<string, unknown>;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("wire frame timeout")), timeoutMs);
      this.waiters.push((v) => {
        clearTimeout(timer);
        resolve(v as Record<string, unknown>);
      });
    });
  }

  send(frame: unknown): void {
    this.fromGuest.write(encodeJsonFrame(frame));
  }

  sendRaw(buffer: Buffer): void {
    this.fromGuest.write(buffer);
  }

  destroy(): void {
    this.toGuest.destroy();
    this.fromGuest.destroy();
  }
}

interface ReqOutcome {
  ok: boolean;
  payload?: Record<string, unknown>;
  code?: string;
  message?: string;
}

async function sendReq(
  wire: Wire,
  id: string,
  op: string,
  params: unknown,
  opKey?: string,
): Promise<ReqOutcome> {
  wire.send({
    kind: "req",
    id,
    op,
    params,
    ...(opKey !== undefined ? { opKey } : {}),
  });
  for (;;) {
    const frame = await wire.next();
    if (frame.kind === "res" && frame.id === id) {
      return { ok: true, payload: frame.payload as Record<string, unknown> };
    }
    if (frame.kind === "err" && (frame.id === undefined || frame.id === id)) {
      return { ok: false, code: frame.code as string, message: frame.message as string };
    }
  }
}

async function hello(wire: Wire, handle: HostBrokerHandle, overrides: Record<string, unknown> = {}): Promise<void> {
  wire.send({
    kind: "hello",
    protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION,
    packLayoutVersion: GUEST_PACK_LAYOUT_VERSION,
    helperBuildVersion: "bv",
    capabilities: [],
    ...overrides,
  });
  const ready = await handle.ready;
  assert.ok(ready.ok, `handshake should be accepted: ${ready.reason}`);
}

const openHandles: Array<{ wire: Wire; broker: HostBrokerHandle }> = [];

function startBroker(services: FakeStepServices, overrides: Partial<Parameters<typeof createHostBroker>[0]> = {}) {
  const wire = new Wire();
  const broker = createHostBroker({
    binding: makeBinding(),
    services,
    pipe: wire.brokerPipe,
    serviceTimeoutMs: 2000,
    ...overrides,
  });
  openHandles.push({ wire, broker });
  return { wire, broker };
}

afterEach(() => {
  for (const h of openHandles.splice(0)) {
    h.wire.destroy();
  }
});

describe("guest protocol prefix/id parity with native lib/id-prefix", () => {
  it("strip/prefix helpers behave identically", () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    assert.equal(prefixRunId(id), nativePrefixRunId(id));
    assert.equal(prefixStepId(id), nativePrefixStepId(id));
    assert.equal(stripIdPrefix(prefixRunId(id)), nativeStripIdPrefix(prefixRunId(id)));
    assert.equal(stripIdPrefix("bare-uuid"), nativeStripIdPrefix("bare-uuid"));
  });
  it("detectWrongPrefix matches native wording", () => {
    for (const [id, kind] of [
      ["step-x", "run"],
      ["run-x", "step"],
      ["plain", "run"],
      ["plain", "step"],
    ] as const) {
      assert.equal(detectWrongPrefix(id, kind), nativeDetectWrongPrefix(id, kind));
    }
  });
});

describe("guest framing", () => {
  it("round-trips a payload across arbitrary chunk splits", () => {
    const payload = JSON.stringify({ hello: "world", n: 42, text: "héllo — ✓ unicode" });
    const frame = encodeFrame(Buffer.from(payload, "utf-8"));
    const received: Buffer[] = [];
    const decoder = new FrameDecoder({
      onFrame: (b) => received.push(b),
      onError: () => assert.fail("unexpected frame error"),
    });
    // Feed the frame in small sequential pieces of varying sizes (1..3 bytes),
    // splitting mid-header and mid-UTF8-char on purpose.
    let offset = 0;
    let piece = 1;
    while (offset < frame.byteLength) {
      const end = Math.min(frame.byteLength, offset + piece);
      decoder.push(frame.subarray(offset, end));
      offset = end;
      piece = (piece % 3) + 1;
    }
    assert.equal(received.length, 1);
    assert.equal(received[0].toString("utf-8"), payload);
  });

  it("handles multiple frames inside one chunk and a zero-length payload", () => {
    const received: Buffer[] = [];
    const decoder = new FrameDecoder({
      onFrame: (b) => received.push(b),
      onError: () => assert.fail("unexpected frame error"),
    });
    decoder.push(Buffer.concat([encodeJsonFrame({ a: 1 }), encodeFrame(Buffer.alloc(0)), encodeJsonFrame({ b: 2 })]));
    assert.equal(received.length, 3);
    assert.equal(decodeJsonPayload<{ a: number }>(received[0]).value?.a, 1);
    assert.equal(received[1].byteLength, 0);
    assert.equal(decodeJsonPayload<{ b: number }>(received[2]).value?.b, 2);
  });

  it("rejects an oversized declared frame and stops parsing", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_PAYLOAD_BYTES + 1, 0);
    let errors = 0;
    const decoder = new FrameDecoder({
      onFrame: () => assert.fail("no frame should be emitted"),
      onError: () => { errors += 1; },
    });
    decoder.push(header);
    assert.equal(decoder.isFailed(), true);
    decoder.push(encodeJsonFrame({ after: true }));
    assert.equal(errors, 1);
  });

  it("encodeJsonFrame refuses payloads over the limit", () => {
    const big = { blob: "x".repeat(MAX_FRAME_PAYLOAD_BYTES + 1) };
    assert.throws(() => encodeJsonFrame(big), /exceeds limit/);
  });

  it("decodeJsonPayload reports invalid JSON instead of throwing", () => {
    const bad = decodeJsonPayload<unknown>(Buffer.from("{not json", "utf-8"));
    assert.equal(bad.ok, false);
  });
});

describe("host broker authority", () => {
  it("rejects a protocol-mismatched handshake and stays closed", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const { wire, broker } = startBroker(services);
    wire.send({
      kind: "hello",
      protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION + 99,
      packLayoutVersion: GUEST_PACK_LAYOUT_VERSION,
      helperBuildVersion: "bv",
      capabilities: [],
    });
    const ready = await broker.ready;
    assert.equal(ready.ok, false);
    assert.match(ready.reason ?? "", /protocol version 100/);
    wire.destroy();
  });

  it("never trusts guest-claimed identity that disagrees with the binding", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const { wire, broker } = startBroker(services);
    wire.send({
      kind: "hello",
      protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION,
      packLayoutVersion: GUEST_PACK_LAYOUT_VERSION,
      helperBuildVersion: "bv",
      capabilities: [],
      claimedRunId: "run-99999999-9999-4999-8999-999999999999",
    });
    const ready = await broker.ready;
    assert.equal(ready.ok, false);
    assert.match(ready.reason ?? "", /claimed run/);
    wire.destroy();
  });

  it("full happy flow: peek -> claim -> current -> complete(accepted) revokes later mutations but replays the exact ack", async () => {
    const services = new FakeStepServices({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { status: "pending", expects: "STATUS: done\nCHANGES:" })],
    });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);

    const peek = await sendReq(wire, "r1", "step.peek", { agentId: AGENT, runId: `run-${RUN}` });
    assert.equal(peek.ok, true);
    assert.equal((peek.payload as { peek: string }).peek, "HAS_WORK");

    const claim = await sendReq(wire, "r2", "step.claim", { agentId: AGENT, runId: RUN }, "opk-claim-1");
    assert.equal(claim.ok, true);
    const claimPayload = (claim.payload as { claim: { found: boolean; stepId: string; input: string } }).claim;
    assert.equal(claimPayload.found, true);
    assert.equal(claimPayload.stepId, `step-${STEP1}`);

    const cur = await sendReq(wire, "r3", "step.current", { agentId: AGENT, runId: RUN });
    assert.equal(cur.ok, true);
    assert.equal((cur.payload as { current: { stepId: string } }).current.stepId, `step-${STEP1}`);

    const complete = await sendReq(
      wire,
      "r4",
      "step.complete",
      { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: implemented\nTESTS: unit" },
      "opk-complete-1",
    );
    assert.equal(complete.ok, true);
    assert.equal((complete.payload as { complete: { status: string } }).complete.status, "advanced");
    assert.equal(broker.state(), "completed");
    assert.equal(services.row(STEP1)?.status, "done");

    // A NEW mutation after an accepted completion is revoked...
    const late = await sendReq(wire, "r5", "step.complete", { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: x" }, "opk-complete-2");
    assert.equal(late.ok, false);
    assert.equal(late.code, "INVOCATION_STATE");

    // ...while the exact ack replay (same opKey + same content) is honored.
    const replay = await sendReq(
      wire,
      "r6",
      "step.complete",
      { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: implemented\nTESTS: unit" },
      "opk-complete-1",
    );
    assert.equal(replay.ok, true);
    assert.equal((replay.payload as { complete: { status: string } }).complete.status, "advanced");

    // Same opKey with DIFFERENT content rejects.
    const changed = await sendReq(wire, "r7", "step.complete", { stepId: `step-${STEP1}`, output: "different" }, "opk-complete-1");
    assert.equal(changed.ok, false);
    assert.equal(changed.code, "IDEMPOTENCY");

    await broker.close();
    await broker.closed;
  });

  it("submit-time REJECTED retains the claim and retry budget for correction", async () => {
    const services = new FakeStepServices({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { status: "pending", expects: "STATUS: done\nCHANGES:" })],
    });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    await sendReq(wire, "c1", "step.claim", { agentId: AGENT, runId: RUN }, "opk-claim");

    const bad = await sendReq(
      wire,
      "c2",
      "step.complete",
      { stepId: `step-${STEP1}`, output: "STATUS: done\nTESTS: no-changes-key" },
      "opk-complete-bad",
    );
    assert.equal(bad.ok, true);
    const rejected = (bad.payload as { complete: { rejected: { message: string } } }).complete.rejected;
    assert.ok(rejected, "expected a REJECTED completion payload");
    assert.match(rejected.message, /output does not satisfy expects/);
    assert.match(rejected.message, /CHANGES/);

    // Claim retained, retry budget untouched, no transition.
    assert.equal(services.row(STEP1)?.status, "running");
    assert.equal(services.row(STEP1)?.retryCount, 0);
    assert.equal(broker.state(), "open");
    assert.ok(services.events.some((e) => e.event === "step.submit.rejected"));

    // Correction with a NEW opKey succeeds in the same round.
    const good = await sendReq(
      wire,
      "c3",
      "step.complete",
      { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: fixed\nTESTS: yes" },
      "opk-complete-good",
    );
    assert.equal(good.ok, true);
    assert.equal((good.payload as { complete: { status: string } }).complete.status, "advanced");
    assert.equal(services.row(STEP1)?.status, "done");
    await broker.close();
    await broker.closed;
  });

  it("agent/run outside the immutable binding are rejected before any service call", async () => {
    let serviceCalls = 0;
    const base = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [step(STEP1)] });
    const services = new Proxy(base, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && ["peek", "claim", "readClaim"].includes(prop)) {
          return (...args: unknown[]) => {
            serviceCalls += 1;
            return (target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as FakeStepServices;
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);

    const wrongAgent = await sendReq(wire, "a1", "step.peek", { agentId: "somebody-else", runId: RUN });
    assert.equal(wrongAgent.ok, false);
    assert.equal(wrongAgent.code, "BINDING");

    const wrongRun = await sendReq(wire, "a2", "step.claim", { agentId: AGENT, runId: "run-99999999-9999-4999-8999-999999999999" }, "opk-x");
    assert.equal(wrongRun.ok, false);
    assert.equal(wrongRun.code, "BINDING");

    const wrongPrefix = await sendReq(wire, "a3", "step.peek", { agentId: AGENT, runId: `step-${RUN}` });
    assert.equal(wrongPrefix.ok, false);
    assert.equal(wrongPrefix.code, "BINDING");
    assert.equal(serviceCalls, 0);
    await broker.close();
    await broker.closed;
  });

  it("service that is bound to a different run fails loudly (defense in depth)", async () => {
    const services = new FakeStepServices({ runId: "99999999-9999-4999-8999-999999999999", agentId: AGENT, steps: [] });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    const peek = await sendReq(wire, "d1", "step.peek", { agentId: AGENT, runId: RUN });
    assert.equal(peek.ok, false);
    assert.equal(peek.code, "SERVICE");
    assert.match(peek.message ?? "", /binding mismatch/);
    await broker.close();
    await broker.closed;
  });

  it("atomic stale-claim rejection at the mutation service preserves the accepted state", async () => {
    const services = new FakeStepServices({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { status: "running", claimId: "claim-c1", expects: "STATUS: done\nCHANGES:" })],
    });
    // Direct service-level check (broker would pass the fresh claim id): a
    // mutation carrying an outdated expectedClaimId is rejected atomically.
    const outcome = await services.submitCompletion(
      makeBinding(),
      "claim-OLD-STALE",
      STEP1,
      "STATUS: done\nCHANGES: x\nTESTS: y",
    );
    assert.equal(outcome.status, "blocked");
    assert.equal(outcome.mutated, false);
    assert.match(outcome.detail ?? "", /stale claim rejected/);
    assert.equal(services.row(STEP1)?.status, "running");
    assert.equal(services.row(STEP1)?.retryCount, 0);
  });

  it("fail flow: fail(accepted) revokes later mutations", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [step(STEP1)] });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    await sendReq(wire, "f1", "step.claim", { agentId: AGENT, runId: RUN }, "opk-claim");
    const fail = await sendReq(wire, "f2", "step.fail", { stepId: `step-${STEP1}`, reason: "cannot do it" }, "opk-fail");
    assert.equal(fail.ok, true);
    assert.equal((fail.payload as { fail: { status: string } }).fail.status, "retrying");
    assert.equal(broker.state(), "completed");
    const second = await sendReq(wire, "f3", "step.fail", { stepId: `step-${STEP1}`, reason: "again" }, "opk-fail-2");
    assert.equal(second.ok, false);
    assert.equal(second.code, "INVOCATION_STATE");
    await broker.close();
    await broker.closed;
  });

  it("STATUS: retry verdict keeps native reroute semantics (re-pends; mutations revoked)", async () => {
    const services = new FakeStepServices({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { expects: "STATUS: done\nSTATUS: retry" })],
    });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    await sendReq(wire, "e1", "step.claim", { agentId: AGENT, runId: RUN }, "opk-claim");
    const retry = await sendReq(
      wire,
      "e2",
      "step.complete",
      { stepId: `step-${STEP1}`, output: "STATUS: retry" },
      "opk-retry-1",
    );
    assert.equal(retry.ok, true);
    const complete = (retry.payload as { complete: { status: string } }).complete;
    assert.equal(complete.status, "retrying");
    assert.equal(services.row(STEP1)?.status, "pending"); // re-pended for the next round
    assert.equal(services.row(STEP1)?.claimId, null);
    assert.equal(broker.state(), "completed");
    const second = await sendReq(
      wire,
      "e3",
      "step.complete",
      { stepId: `step-${STEP1}`, output: "STATUS: retry" },
      "opk-retry-2",
    );
    assert.equal(second.ok, false);
    assert.equal(second.code, "INVOCATION_STATE");
    await broker.close();
    await broker.closed;
  });

  it("service-level retry budget exhaustion fails the step (native budget semantics)", async () => {
    const services = new FakeStepServices({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { status: "running", claimId: "claim-c1", expects: "STATUS: retry", retryCount: 1, maxRetries: 2 })],
    });
    const outcome = await services.submitCompletion(makeBinding(), "claim-c1", STEP1, "STATUS: retry");
    assert.equal(outcome.status, "retrying");
    assert.equal(services.row(STEP1)?.retryCount, 2);
    await services.claim(makeBinding()); // re-claimed for the next round
    const held = await services.readClaim(makeBinding());
    assert.ok(held);
    const last = await services.submitCompletion(makeBinding(), held!.claimId, STEP1, "STATUS: retry");
    assert.equal(last.status, "failed");
    assert.equal(services.row(STEP1)?.status, "failed");
  });

  it("host cancel revokes new mutations without erasing an accepted transition", async () => {
    const services = new FakeStepServices({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { expects: "STATUS: done\nCHANGES:" })],
    });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    await sendReq(wire, "g1", "step.claim", { agentId: AGENT, runId: RUN }, "opk-claim");

    broker.cancelRequest();
    assert.equal(broker.state(), "canceled");

    const mutation = await sendReq(wire, "g2", "step.complete", { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: x" }, "opk-new");
    assert.equal(mutation.ok, false);
    assert.equal(mutation.code, "INVOCATION_STATE");

    // Read-only current still allowed during final flush.
    const cur = await sendReq(wire, "g3", "step.current", { agentId: AGENT, runId: RUN });
    assert.equal(cur.ok, true);
    assert.equal((cur.payload as { current: { found: boolean } }).current.found, true);
    await broker.close();
    await broker.closed;
  });

  it("cancel of an exact in-flight request answers CANCELED and drops the late result", async () => {
    const services = new FakeStepServices({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { expects: "STATUS: done\nCHANGES:" })],
      delayMs: 120,
    });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    await sendReq(wire, "h1", "step.claim", { agentId: AGENT, runId: RUN }, "opk-claim");

    wire.send({
      kind: "req",
      id: "h2",
      op: "step.complete",
      params: { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: x" },
      opKey: "opk-complete-h",
    });
    await new Promise((r) => setTimeout(r, 40)); // let the op enter the service
    broker.cancelRequest("h2");
    for (;;) {
      const frame = await wire.next();
      if (frame.id === "h2") {
        assert.equal(frame.kind, "err");
        assert.equal(frame.code, "CANCELED");
        break;
      }
    }
    // Late service result is dropped (no duplicate res for h2).
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(services.row(STEP1)?.status, "running");
    await broker.close();
    await broker.closed;
  });

  it("request before handshake and unsupported ops are refused", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const { wire, broker } = startBroker(services);
    wire.send({ kind: "req", id: "x1", op: "step.peek", params: { agentId: AGENT, runId: RUN } });
    const early = await wire.next();
    assert.equal(early.kind, "err");
    assert.equal(early.code, "HANDSHAKE");

    await hello(wire, broker);
    const unsupported = await sendReq(wire, "x2", "workflow.status", { runId: RUN });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.code, "UNSUPPORTED");
    await broker.close();
    await broker.closed;
  });

  it("malformed/oversized frames on the pipe produce err frames and stop parsing", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);

    // First garbage makes the decoder fail; the broker answers BAD_FRAME.
    wire.sendRaw(Buffer.from("not a frame at all", "utf-8"));
    let first: Record<string, unknown>;
    do {
      first = await wire.next();
    } while (first.kind !== "err"); // skip the earlier hello-ack
    assert.equal(first.code, "BAD_FRAME");

    // An oversized declared frame is refused by the wire decoder, which then
    // stops parsing further input (no more responses may be served).
    const huge = Buffer.alloc(4);
    huge.writeUInt32BE(MAX_FRAME_PAYLOAD_BYTES + 5, 0);
    wire.sendRaw(huge);
    wire.send({ kind: "req", id: "m1", op: "step.peek", params: { agentId: AGENT, runId: RUN } });
    await new Promise((r) => setTimeout(r, 150));
    await broker.close();
    await broker.closed;
  });

  it("claims only bind to the invocation's own run/agent (idempotent claim returns held step)", async () => {
    const services = new FakeStepServices({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1), step(STEP2, { input: "second task" })],
    });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    const c1 = await sendReq(wire, "i1", "step.claim", { agentId: AGENT, runId: RUN }, "opk-c1");
    const c2 = await sendReq(wire, "i2", "step.claim", { agentId: AGENT, runId: RUN }, "opk-c2");
    const a = (c1.payload as { claim: { stepId: string } }).claim;
    const b = (c2.payload as { claim: { stepId: string } }).claim;
    assert.equal(a.stepId, b.stepId);
    assert.equal(a.stepId, `step-${STEP1}`);
    await broker.close();
    await broker.closed;
  });
});

/**
 * AuthoritativeStepServices whose delegated readClaim never settles (dispatch
 * wedge regression). The serialised broker dispatch must abandon such a call at
 * the finite service deadline instead of stalling every request queued behind
 * it. `peek` stays live so a queued read-only request can be served after the
 * wedged call is abandoned.
 */
class WedgedReadClaimServices implements AuthoritativeStepServices {
  readonly starts = { readClaim: 0, peek: 0 };

  async readClaim(): Promise<HostClaim | null> {
    this.starts.readClaim += 1;
    return new Promise<HostClaim | null>(() => {
      /* never settles */
    });
  }

  async peek(): Promise<PeekVerdict> {
    this.starts.peek += 1;
    return "NO_WORK";
  }

  async claim(): Promise<ClaimOutcome> {
    return { found: false };
  }

  async validateCompletion(): Promise<ValidationDiagnostic> {
    return { verdict: "accept", code: "EXPECTS_SATISFIED", message: "", missingKeys: [], invalidKeys: [] };
  }

  async submitCompletion(): Promise<CompleteOutcome> {
    return { status: "advanced", mutated: true };
  }

  async submitFail(): Promise<FailOutcome> {
    return { status: "retrying", mutated: true };
  }

  emit(): void {
    /* no-op */
  }
}

/**
 * Misbehaving-adapter stand-in (claim-scope regression): readClaim returns a
 * claim scoped to a DIFFERENT run/agent even though the stepId matches what
 * the guest asked for. The broker must refuse guarded mutations and read-outs
 * before any service validation/mutation call is made.
 */
class ForeignClaimServices implements AuthoritativeStepServices {
  readonly calls = { validate: 0, submit: 0, fail: 0 };
  private readonly claim: HostClaim;

  constructor(claim: HostClaim) {
    this.claim = claim;
  }

  async readClaim(): Promise<HostClaim | null> {
    return this.claim;
  }

  async peek(): Promise<PeekVerdict> {
    return "HAS_WORK";
  }

  async claim(): Promise<ClaimOutcome> {
    return { found: true, stepId: this.claim.stepId, runId: this.claim.runId, input: this.claim.input };
  }

  async validateCompletion(): Promise<ValidationDiagnostic> {
    this.calls.validate += 1;
    return { verdict: "accept", code: "EXPECTS_SATISFIED", message: "", missingKeys: [], invalidKeys: [] };
  }

  async submitCompletion(): Promise<CompleteOutcome> {
    this.calls.submit += 1;
    return { status: "advanced", mutated: true };
  }

  async submitFail(): Promise<FailOutcome> {
    this.calls.fail += 1;
    return { status: "retrying", mutated: true };
  }

  emit(): void {
    /* no-op */
  }
}

describe("host broker dispatch robustness and claim-scope hardening", () => {
  it("a never-settling delegated call is abandoned at the service deadline; queued requests are served after their own deadline", async () => {
    const services = new WedgedReadClaimServices();
    const { wire, broker } = startBroker(services, { serviceTimeoutMs: 120 });
    await hello(wire, broker);

    // w1 occupies the serialised dispatch with a delegated call that never
    // settles; w2 (a live peek) queues behind it.
    wire.send({ kind: "req", id: "w1", op: "step.current", params: { agentId: AGENT, runId: RUN } });
    wire.send({ kind: "req", id: "w2", op: "step.peek", params: { agentId: AGENT, runId: RUN } });

    const order: string[] = [];
    for (;;) {
      const frame = await wire.next();
      if (frame.kind === "err" && frame.id === "w1") {
        assert.equal(frame.code, "DEADLINE");
        order.push("w1-deadline");
      } else if (frame.kind === "res" && frame.id === "w2") {
        order.push("w2-res");
      } else if (frame.kind === "err" && frame.id === "w2") {
        order.push(`w2-${String(frame.code)}`);
      }
      if (order.includes("w1-deadline") && (order.includes("w2-res") || order.some((s) => s.startsWith("w2-")))) break;
    }
    // Regression: without the deadline race the loop would stay wedged on the
    // never-settling call — w2 either never served or (when re-entrant dispatch
    // was possible) dispatched concurrently BEFORE w1's DEADLINE.
    assert.ok(
      order.indexOf("w1-deadline") < order.indexOf("w2-res"),
      `expected the wedged call to abandon (DEADLINE) before the queued peek is served; wire order was: ${order.join(" -> ")}`,
    );
    assert.ok(services.starts.readClaim >= 1, "the wedged readClaim must have been dispatched once");
    assert.ok(services.starts.peek >= 1, "the queued peek must be dispatched after the wedge abandons");
    await broker.close();
    await broker.closed;
  });

  it("a mis-scoped authoritative claim (foreign run) cannot route a guarded mutation or read-out even when the stepId matches", async () => {
    const foreign: HostClaim = {
      stepId: STEP1,
      runId: "99999999-9999-4999-8999-999999999999",
      agentId: AGENT,
      claimId: "claim-foreign",
      expects: "STATUS: done\nCHANGES:",
      input: "foreign input",
    };
    const services = new ForeignClaimServices(foreign);
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);

    // step.current must not present a claim owned by a different run.
    const cur = await sendReq(wire, "m1", "step.current", { agentId: AGENT, runId: RUN });
    assert.equal(cur.ok, false);
    assert.equal(cur.code, "CLAIM");
    assert.match(cur.message ?? "", /does not match the bound run/);

    // step.complete must be refused BEFORE validateCompletion/submitCompletion.
    const done = await sendReq(
      wire,
      "m2",
      "step.complete",
      { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: x" },
      "opk-m2",
    );
    assert.equal(done.ok, false);
    assert.equal(done.code, "CLAIM");
    assert.match(done.message ?? "", /does not match the bound run/);
    assert.equal(services.calls.validate, 0, "no validation call before the scope refusal");
    assert.equal(services.calls.submit, 0, "no mutation before the scope refusal");

    // step.fail likewise never reaches the mutation service.
    const failed = await sendReq(wire, "m3", "step.fail", { stepId: `step-${STEP1}`, reason: "no" }, "opk-m3");
    assert.equal(failed.ok, false);
    assert.equal(failed.code, "CLAIM");
    assert.equal(services.calls.fail, 0);
    await broker.close();
    await broker.closed;
  });

  it("per-op param shape is enforced at the broker boundary (paramsMatchOp) before any service call", async () => {
    const base = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [step(STEP1)] });
    let serviceCalls = 0;
    const counting = new Proxy(base, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && ["readClaim", "peek", "claim", "validateCompletion", "submitCompletion", "submitFail"].includes(prop)) {
          return (...args: unknown[]) => {
            serviceCalls += 1;
            return (target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as FakeStepServices;
    const { wire, broker } = startBroker(counting);
    await hello(wire, broker);

    // step.complete with a valid stepId but NO output is malformed for its op.
    const noOutput = await sendReq(wire, "p1", "step.complete", { stepId: `step-${STEP1}` }, "opk-p1");
    assert.equal(noOutput.ok, false);
    assert.equal(noOutput.code, "UNSUPPORTED");

    // step.current requires agentId+runId, not stepId.
    const wrongShape = await sendReq(wire, "p2", "step.current", { stepId: `step-${STEP1}` });
    assert.equal(wrongShape.ok, false);
    assert.equal(wrongShape.code, "UNSUPPORTED");

    assert.equal(serviceCalls, 0, "malformed param shapes must be refused before any service call");
    await broker.close();
    await broker.closed;
  });

  it("paramsMatchOp is the shared per-op shape contract", () => {
    assert.equal(paramsMatchOp({ agentId: AGENT, runId: RUN }, "step.peek"), true);
    assert.equal(paramsMatchOp({ agentId: AGENT, runId: RUN }, "step.claim"), true);
    assert.equal(paramsMatchOp({ agentId: AGENT, runId: RUN }, "step.current"), true);
    assert.equal(paramsMatchOp({ stepId: `step-${STEP1}`, output: "x" }, "step.complete"), true);
    assert.equal(paramsMatchOp({ stepId: `step-${STEP1}`, reason: "x" }, "step.fail"), true);
    assert.equal(paramsMatchOp({ stepId: `step-${STEP1}` }, "step.complete"), false);
    assert.equal(paramsMatchOp({ agentId: AGENT }, "step.peek"), false);
    assert.equal(paramsMatchOp({ agentId: AGENT, runId: RUN }, "step.fail"), false);
  });
});

describe("validateExpectsLike (fake parity helper)", () => {
  it("accepts an output satisfying literal and regex expectations", () => {
    assert.equal(validateExpectsLike("STATUS: done\nCHANGES: x\nCOMMITS: abc", "STATUS: done\nCHANGES:\nregex:COMMITS: \\w+"), null);
  });
  it("rejects a missing literal key", () => {
    const err = validateExpectsLike("STATUS: done", "STATUS: done\nCHANGES:");
    assert.ok(err !== null && err.includes("CHANGES"));
    const diag = diagnosticFromValidation(err!);
    assert.deepEqual(diag.missingKeys, ["CHANGES"]);
    assert.equal(diag.code, "EXPECTS_MISSING_CHANGES");
  });
  it("honest STATUS: retry variant passes when the expects contract allows it", () => {
    assert.equal(validateExpectsLike("STATUS: retry", "STATUS: done\nCHANGES:\nSTATUS: retry"), null);
  });
});

describe("guest files (bounded transfer + STORIES_JSON_FILE parity)", () => {
  let dir: string;
  let orig: string;
  before(() => {
    dir = tamanduaTempDir("tamandua-guest-files-");
    orig = process.cwd();
    process.chdir(dir);
  });
  after(() => {
    process.chdir(orig);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("readFlagFileBounded refuses an oversized report file", () => {
    const big = path.join(dir, "big.txt");
    fs.writeFileSync(big, "x".repeat(MAX_REPORT_BYTES + 10));
    const result = readFlagFileBounded("big.txt", dir, "--file");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /too large to transfer/);
  });

  it("readFlagFileBounded resolves relative to caller cwd with native wording", () => {
    const missing = readFlagFileBounded("nope.txt", dir, "--file");
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.message, /^Cannot read --file "nope\.txt":/);
  });

  it("STORIES_JSON_FILE dereference converts a valid array and rejects a non-array", () => {
    const stories = path.join(dir, "stories.json");
    fs.writeFileSync(stories, JSON.stringify([{ id: "US-1" }]));
    const good = dereferenceStoriesJsonFile("STATUS: done\nSTORIES_JSON_FILE: stories.json", dir);
    assert.equal(good.ok, true);
    if (good.ok) assert.match(good.text, /STORIES_JSON: \[.*US-1/);

    fs.writeFileSync(stories, JSON.stringify({ not: "array" }));
    const bad = dereferenceStoriesJsonFile("STATUS: done\nSTORIES_JSON_FILE: stories.json", dir);
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.message, /must contain a JSON array, got object/);
  });

  it("STORIES_JSON_FILE missing file message matches native", () => {
    const bad = dereferenceStoriesJsonFile("STATUS: done\nSTORIES_JSON_FILE: absent.json", dir);
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.message, /^STORIES_JSON_FILE error: cannot read file "absent\.json":/);
  });
});

describe("host broker close semantics", () => {
  it("close after an accepted completion preserves the completed state and ends the pipe", async () => {
    const services = new FakeStepServices({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { expects: "STATUS: done\nCHANGES:" })],
    });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    await sendReq(wire, "k1", "step.claim", { agentId: AGENT, runId: RUN }, "opk-claim");
    const done = await sendReq(wire, "k2", "step.complete", { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: x" }, "opk-done");
    assert.equal(done.ok, true);
    assert.equal(broker.state(), "completed");
    await broker.close();
    await broker.closed;
    assert.equal(broker.state(), "completed", "accepted transition is never erased by close");
  });

  it("close from the open state revokes authority (canceled) and drops later frames", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [step(STEP1)] });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    await broker.close();
    await broker.closed;
    assert.ok(["canceled", "completed"].includes(broker.state()));
    // Frames arriving after close are dropped (no mutation can slip through).
    wire.send({ kind: "req", id: "k3", op: "step.claim", params: { agentId: AGENT, runId: RUN }, opKey: "opk-late" });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(services.row(STEP1)?.status, "pending");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// MTLK-GUEST-GUARD regressions (root probe findings + bounded dispatch/shutdown)
// ───────────────────────────────────────────────────────────────────────────

/** FakeStepServices whose validateCompletion pauses until released (probe case 2). */
class ValidationGatedFake extends FakeStepServices {
  validateStarted = 0;
  submitCalls = 0;
  private release: (() => void) | null = null;

  override async validateCompletion(
    binding: HostBinding,
    stepId: string,
    output: string,
  ): Promise<ValidationDiagnostic> {
    this.validateStarted += 1;
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return { verdict: "accept", code: "EXPECTS_SATISFIED", message: "", missingKeys: [], invalidKeys: [] };
  }

  releaseValidation(): void {
    const release = this.release;
    this.release = null;
    release?.();
  }

  override async submitCompletion(
    binding: HostBinding,
    expectedClaimId: string,
    stepId: string,
    output: string,
  ): Promise<CompleteOutcome> {
    this.submitCalls += 1;
    return super.submitCompletion(binding, expectedClaimId, stepId, output);
  }
}

/** FakeStepServices whose submitCompletion pauses until released (admitted-before-revoke case). */
class SubmitGatedFake extends FakeStepServices {
  submitStarted = 0;
  private release: (() => void) | null = null;

  override async submitCompletion(
    binding: HostBinding,
    expectedClaimId: string,
    stepId: string,
    output: string,
  ): Promise<CompleteOutcome> {
    this.submitStarted += 1;
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    // The admitted mutation actually commits once released (atomic fake
    // semantics): the row transitions and the outcome reports mutated.
    return super.submitCompletion(binding, expectedClaimId, stepId, output);
  }

  releaseSubmit(): void {
    const release = this.release;
    this.release = null;
    release?.();
  }
}

/** FakeStepServices whose validateCompletion never settles (deadline stall). */
class WedgedValidateFake extends FakeStepServices {
  validateStarted = 0;
  override async validateCompletion(
    binding: HostBinding,
    stepId: string,
    output: string,
  ): Promise<ValidationDiagnostic> {
    this.validateStarted += 1;
    return new Promise<ValidationDiagnostic>(() => {
      /* never settles */
    });
  }
}

/** Writable that stops consuming until release() is called (backpressure fixtures). */
class StallingWritable extends Writable {
  readonly frames: Buffer[] = [];
  private stalled = true;
  private held: Buffer | null = null;
  private heldCb: (() => void) | null = null;

  constructor(hwm = 512) {
    super({ highWaterMark: hwm });
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (this.stalled) {
      this.held = Buffer.from(chunk);
      this.heldCb = cb as () => void;
      return;
    }
    this.frames.push(Buffer.from(chunk));
    cb();
  }

  releaseOne(): void {
    if (this.stalled) {
      this.stalled = false;
    }
    if (this.held && this.heldCb) {
      const chunk = this.held;
      const cb = this.heldCb;
      this.held = null;
      this.heldCb = null;
      this.frames.push(chunk);
      cb();
    }
  }
}

function drainFrames(writable: StallingWritable, count: number): void {
  for (let i = 0; i < count * 2; i++) {
    writable.releaseOne();
  }
}

describe("MTLK-GUEST-GUARD broker regressions", () => {
  it("cancel while validateCompletion is pending: the guarded mutation is never submitted", async () => {
    const services = new ValidationGatedFake({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { expects: "STATUS: done\nCHANGES:" })],
    });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    await sendReq(wire, "v0", "step.claim", { agentId: AGENT, runId: RUN }, "opk-claim");

    wire.send({
      kind: "req",
      id: "v1",
      op: "step.complete",
      params: { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: x" },
      opKey: "opk-complete-v1",
    });
    // Let the request enter validateCompletion (pending).
    for (;;) {
      await new Promise((r) => setTimeout(r, 5));
      if (services.validateStarted >= 1) break;
    }
    broker.cancelRequest("v1");
    services.releaseValidation();
    await new Promise((r) => setTimeout(r, 60));

    // The revoked request was answered CANCELED; the late validation
    // resolution must NOT start submitCompletion and must NOT complete state.
    assert.equal(services.submitCalls, 0, "submitCompletion must never run after cancellation");
    assert.equal(services.row(STEP1)?.status, "running", "claim must be retained (no mutation)");
    assert.equal(broker.state(), "canceled");
    assert.ok(
      services.revocations.length >= 1 && services.revocations.some((r) => r.invocationId === INV),
      "broker must drive the optional revocation seam for the in-flight request",
    );
    await broker.close();
    await broker.closed;
  });

  it("same opKey replayed with a FOREIGN run+agent is never served from cache (authorization before cache)", async () => {
    let serviceCalls = 0;
    const base = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const services = new Proxy(base, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && ["peek", "claim", "readClaim"].includes(prop)) {
          return (...args: unknown[]) => {
            serviceCalls += 1;
            return (target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as FakeStepServices;
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);

    const good = await sendReq(wire, "b0", "step.claim", { agentId: AGENT, runId: RUN }, "same-key");
    assert.equal(good.ok, true);
    assert.equal(serviceCalls, 1, "only the original claim reached the service");

    // Same opKey, foreign run+agent: MUST error (no cached res, no disclosure).
    const foreign = await sendReq(
      wire,
      "b1",
      "step.claim",
      { agentId: "foreign", runId: "44444444-4444-4444-8444-444444444444" },
      "same-key",
    );
    assert.equal(foreign.ok, false);
    assert.equal(foreign.code, "BINDING");
    assert.equal(serviceCalls, 1, "the foreign request must not reach any service call");

    // A same-scope exact replay is still served (identical canonical identity).
    const replay = await sendReq(wire, "b2", "step.claim", { agentId: AGENT, runId: RUN }, "same-key");
    assert.equal(replay.ok, true);
    await broker.close();
    await broker.closed;
  });

  it("same opKey with a different op, different step target, or changed content rejects", async () => {
    const services = new FakeStepServices({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { expects: "STATUS: done\nCHANGES:" })],
    });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);

    // Claim key "k-claim" then reuse it for step.complete: changed op.
    const claim = await sendReq(wire, "d0", "step.claim", { agentId: AGENT, runId: RUN }, "k-claim");
    assert.equal(claim.ok, true);
    const diffOp = await sendReq(
      wire,
      "d1",
      "step.complete",
      { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: x" },
      "k-claim",
    );
    assert.equal(diffOp.ok, false);
    assert.equal(diffOp.code, "IDEMPOTENCY");

    // A REJECTED completion caches its canonical identity (claim retained).
    const bad = await sendReq(
      wire,
      "d2",
      "step.complete",
      { stepId: `step-${STEP1}`, output: "STATUS: done\nTESTS: only" },
      "k-complete",
    );
    assert.equal(bad.ok, true);
    assert.ok((bad.payload as { complete: { rejected?: unknown } }).complete.rejected);

    // Changed content under the same key rejects (not a replay).
    const changed = await sendReq(
      wire,
      "d3",
      "step.complete",
      { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: different" },
      "k-complete",
    );
    assert.equal(changed.ok, false);
    assert.equal(changed.code, "IDEMPOTENCY");

    // Different step target under the same key rejects (never a stale success).
    const diffStep = await sendReq(
      wire,
      "d4",
      "step.complete",
      { stepId: `step-${STEP2}`, output: "STATUS: done\nTESTS: only" },
      "k-complete",
    );
    assert.equal(diffStep.ok, false);
    assert.equal(diffStep.code, "IDEMPOTENCY");

    // Exact same request replays the recorded (rejected) outcome.
    const exact = await sendReq(
      wire,
      "d5",
      "step.complete",
      { stepId: `step-${STEP1}`, output: "STATUS: done\nTESTS: only" },
      "k-complete",
    );
    assert.equal(exact.ok, true);
    assert.ok((exact.payload as { complete: { rejected?: unknown } }).complete.rejected);
    await broker.close();
    await broker.closed;
  });

  it("a validation that resolves AFTER the service deadline never starts the guarded mutation", async () => {
    const services = new ValidationGatedFake({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { expects: "STATUS: done\nCHANGES:" })],
    });
    const { wire, broker } = startBroker(services, { serviceTimeoutMs: 50 });
    await hello(wire, broker);
    await sendReq(wire, "x0", "step.claim", { agentId: AGENT, runId: RUN }, "opk-claim");
    wire.send({
      kind: "req",
      id: "x1",
      op: "step.complete",
      params: { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: late" },
      opKey: "opk-x1",
    });
    for (;;) {
      const frame = await wire.next();
      if (frame.id === "x1") {
        assert.equal(frame.kind, "err");
        assert.equal(frame.code, "DEADLINE");
        break;
      }
    }
    // Now the stalled validation eventually resolves: the revocation already
    // answered DEADLINE and revoked authority — submit must never run.
    services.releaseValidation();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(services.submitCalls, 0, "late validation resolution must not start submitCompletion");
    assert.equal(services.row(STEP1)?.status, "running");
    assert.equal(broker.state(), "canceled");
    await broker.close();
    await broker.closed;
  });

  it("close while validateCompletion is pending prevents the guarded mutation (no submit after close)", async () => {
    const services = new ValidationGatedFake({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { expects: "STATUS: done\nCHANGES:" })],
    });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    await sendReq(wire, "y0", "step.claim", { agentId: AGENT, runId: RUN }, "opk-claim");
    wire.send({
      kind: "req",
      id: "y1",
      op: "step.complete",
      params: { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: x" },
      opKey: "opk-y1",
    });
    for (;;) {
      await new Promise((r) => setTimeout(r, 5));
      if (services.validateStarted >= 1) break;
    }
    await broker.close();
    services.releaseValidation();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(services.submitCalls, 0, "close must revoke mutation authority before the pending validation resolves");
    assert.equal(services.row(STEP1)?.status, "running");
    assert.ok(["canceled", "completed"].includes(broker.state()));
  });

  it("a mutating service stall past the deadline revokes authority: eventual resolution never mutates, and further mutations fail closed", async () => {
    const services = new WedgedValidateFake({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { expects: "STATUS: done\nCHANGES:" })],
    });
    const { wire, broker } = startBroker(services, { serviceTimeoutMs: 60 });
    await hello(wire, broker);
    await sendReq(wire, "s0", "step.claim", { agentId: AGENT, runId: RUN }, "opk-claim");

    wire.send({
      kind: "req",
      id: "s1",
      op: "step.complete",
      params: { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: x" },
      opKey: "opk-complete-s1",
    });
    // The wedged validation is revoked at the deadline; the guest is answered.
    for (;;) {
      const frame = await wire.next();
      if (frame.id === "s1") {
        assert.equal(frame.kind, "err");
        assert.equal(frame.code, "DEADLINE");
        break;
      }
    }
    assert.equal(broker.state(), "canceled", "a mutating deadline fails the invocation closed");

    // New mutations are refused.
    const later = await sendReq(
      wire,
      "s2",
      "step.complete",
      { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: corrected" },
      "opk-complete-s2",
    );
    assert.equal(later.ok, false);
    assert.equal(later.code, "INVOCATION_STATE");
    assert.equal(services.row(STEP1)?.status, "running", "no mutation may have occurred");
    assert.equal(services.validateStarted, 1);
    await broker.close();
    await broker.closed;
  });

  it("a guarded mutation admitted before revocation that commits afterwards preserves the completed transition and replays its exact ack", async () => {
    const services = new SubmitGatedFake({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { expects: "STATUS: done\nCHANGES:" })],
    });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    await sendReq(wire, "t0", "step.claim", { agentId: AGENT, runId: RUN }, "opk-claim");

    wire.send({
      kind: "req",
      id: "t1",
      op: "step.complete",
      params: { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: admitted" },
      opKey: "opk-t1",
    });
    for (;;) {
      await new Promise((r) => setTimeout(r, 5));
      if (services.submitStarted >= 1) break;
    }
    // Cancel arrives AFTER the guarded mutation was admitted (in flight).
    broker.cancelRequest("t1");
    services.releaseSubmit();
    await new Promise((r) => setTimeout(r, 60));

    // The admitted mutation committed: state truthfully records completed and
    // the exact ack is remembered (no second response was written for t1).
    assert.equal(broker.state(), "completed");
    assert.equal(services.row(STEP1)?.status, "done");
    const replay = await sendReq(
      wire,
      "t2",
      "step.complete",
      { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: admitted" },
      "opk-t1",
    );
    assert.equal(replay.ok, true);
    assert.equal((replay.payload as { complete: { status: string } }).complete.status, "advanced");
    await broker.close();
    await broker.closed;
  });

  it("finite handshake deadline settles ready {ok:false} and closes safely when no hello arrives", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const wire = new Wire();
    const broker = createHostBroker({
      binding: makeBinding(),
      services,
      pipe: wire.brokerPipe,
      handshakeTimeoutMs: 25,
    });
    openHandles.push({ wire, broker });
    try {
      const ready = await broker.ready;
      assert.equal(ready.ok, false);
      assert.match(ready.reason ?? "", /did not complete within 25ms/);
      await broker.closed;
      assert.ok(["canceled", "completed"].includes(broker.state()));
    } finally {
      await broker.close();
      wire.destroy();
    }
  });

  it("helper build/layout identity declared in the handshake is verified (not ignored)", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const { wire, broker } = startBroker(services);
    wire.send({
      kind: "hello",
      protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION,
      packLayoutVersion: GUEST_PACK_LAYOUT_VERSION,
      helperBuildVersion: "some-other-build",
      capabilities: [],
    });
    const ready = await broker.ready;
    assert.equal(ready.ok, false);
    assert.match(ready.reason ?? "", /helper build/);
    await broker.closed;
    wire.destroy();

    const wire2 = new Wire();
    const broker2 = createHostBroker({ binding: makeBinding(), services: new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] }), pipe: wire2.brokerPipe });
    openHandles.push({ wire: wire2, broker: broker2 });
    wire2.send({
      kind: "hello",
      protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION,
      packLayoutVersion: GUEST_BRIDGE_PROTOCOL_VERSION + 99,
      helperBuildVersion: "bv",
      capabilities: [],
    });
    const ready2 = await broker2.ready;
    assert.equal(ready2.ok, false);
    assert.match(ready2.reason ?? "", /pack layout/);
    await broker2.closed;
    wire2.destroy();
  });

  it("duplicate/late hello after acceptance refuses the handshake and closes the broker", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    assert.equal((await broker.ready).ok, true);
    wire.send({ kind: "hello", protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION });
    // Expect a hello-ack refusal and then a clean close.
    let refused = false;
    for (;;) {
      const frame = await wire.next();
      if (frame.kind === "hello-ack") {
        if (frame.accepted === false) {
          refused = true;
          break;
        }
      }
      if (frame.kind === "err" && frame.code === "CLOSED") break;
    }
    assert.equal(refused, true, "duplicate hello must be refused, not silently accepted");
    await broker.closed;
    wire.destroy();
  });

  it("close before a hello settles ready {ok:false} and never strands readers", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const { wire, broker } = startBroker(services);
    await broker.close();
    const ready = await broker.ready;
    assert.equal(ready.ok, false);
    assert.match(ready.reason ?? "", /before handshake acceptance/);
    await broker.closed;
    assert.ok(["canceled", "completed"].includes(broker.state()));
  });

  it("guest pipe EOF before a hello settles ready {ok:false}", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const wire = new Wire();
    const broker = createHostBroker({ binding: makeBinding(), services, pipe: wire.brokerPipe });
    openHandles.push({ wire, broker });
    wire.fromGuest.end();
    const ready = await broker.ready;
    assert.equal(ready.ok, false);
    assert.match(ready.reason ?? "", /guest pipe ended/);
    await broker.closed;
  });

  it("guest pipe destroy (no end/error event) settles the broker via the close path", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [step(STEP1)] });
    const wire = new Wire();
    const broker = createHostBroker({ binding: makeBinding(), services, pipe: wire.brokerPipe });
    openHandles.push({ wire, broker });
    await hello(wire, broker);
    const closedP = broker.closed;
    wire.destroy();
    await closedP;
    assert.ok(["canceled", "completed"].includes(broker.state()));
  });

  it("invalid/non-finite/non-positive deadline and bound options are refused at construction", () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const wire = new Wire();
    const base = { binding: makeBinding(), services, pipe: wire.brokerPipe };
    for (const bad of [
      { handshakeTimeoutMs: 0 },
      { handshakeTimeoutMs: -5 },
      { handshakeTimeoutMs: Number.NaN },
      { serviceTimeoutMs: 0 },
      { serviceTimeoutMs: Number.POSITIVE_INFINITY },
      { shutdownFlushMs: -1 },
      { writeDrainTimeoutMs: 0 },
      { maxPendingRequests: 0 },
      { maxPendingRequests: 1.5 },
      { maxIdempotencyEntries: -1 },
      { maxOutboundQueueBytes: 0 },
    ]) {
      assert.throws(
        () => createHostBroker({ ...base, ...bad }),
        RangeError,
        `expected RangeError for ${JSON.stringify(bad)}`,
      );
    }
    wire.destroy();
  });

  it("repeated close is idempotent; cancel after close is a safe no-op", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [step(STEP1)] });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    await broker.close();
    const stateAfterFirst = broker.state();
    await broker.close(); // repeated close: must resolve, not hang or throw
    await broker.closed;
    broker.cancelRequest();
    broker.cancelRequest("anything");
    assert.equal(broker.state(), stateAfterFirst);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(broker.state(), stateAfterFirst);
  });

  it("canonical request identity distinguishes op/scope/step/content", () => {
    const runId = `run-${RUN}`;
    const stepId = `step-${STEP1}`;
    const step2 = `step-${STEP2}`;
    assert.notEqual(
      canonicalRequestIdentity({ op: "step.claim", params: { agentId: AGENT, runId } }),
      canonicalRequestIdentity({ op: "step.complete", params: { stepId, output: "x" } }),
      "different op must differ",
    );
    assert.notEqual(
      canonicalRequestIdentity({ op: "step.claim", params: { agentId: AGENT, runId } }),
      canonicalRequestIdentity({ op: "step.claim", params: { agentId: "foreign", runId: "44444444-4444-4444-8444-444444444444" } }),
      "foreign scope must differ",
    );
    assert.notEqual(
      canonicalRequestIdentity({ op: "step.complete", params: { stepId, output: "a" } }),
      canonicalRequestIdentity({ op: "step.complete", params: { stepId: step2, output: "a" } }),
      "different step target must differ",
    );
    assert.notEqual(
      canonicalRequestIdentity({ op: "step.complete", params: { stepId, output: "a" } }),
      canonicalRequestIdentity({ op: "step.complete", params: { stepId, output: "b" } }),
      "different content must differ",
    );
    assert.equal(mutatingBridgeOp("step.claim"), true);
    assert.equal(mutatingBridgeOp("step.complete"), true);
    assert.equal(mutatingBridgeOp("step.fail"), true);
    assert.equal(mutatingBridgeOp("step.peek"), false);
    assert.equal(mutatingBridgeOp("step.current"), false);
  });

  it("canceled queued requests are reaped: a peek is served after canceling queued requests (no QUEUE_FULL tombstones)", async () => {
    const raw = new ValidationGatedFake({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { expects: "STATUS: done\nCHANGES:" })],
    });
    let peekCalls = 0;
    const services = new Proxy(raw, {
      get(target, prop, receiver) {
        if (prop === "peek") {
          return (...args: unknown[]) => {
            peekCalls += 1;
            return (target as unknown as Record<string, (...a: unknown[]) => unknown>).peek(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as ValidationGatedFake;
    const { wire, broker } = startBroker(services, { maxPendingRequests: 4 });
    await hello(wire, broker);
    await sendReq(wire, "rc0", "step.claim", { agentId: AGENT, runId: RUN }, "opk-rc-claim");

    // Wedge one active mutating delegated call (validateCompletion pending) so
    // the bounded request queue actually accumulates behind it.
    wire.send({
      kind: "req",
      id: "rc1",
      op: "step.complete",
      params: { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: x" },
      opKey: "opk-rc1",
    });
    for (;;) {
      await new Promise((r) => setTimeout(r, 5));
      if (services.validateStarted >= 1) break;
    }

    // Fill the queue to its cap (maxPendingRequests = 4) with complete requests.
    const queuedIds = ["rc2", "rc3", "rc4", "rc5"];
    for (const id of queuedIds) {
      wire.send({
        kind: "req",
        id,
        op: "step.complete",
        params: { stepId: `step-${STEP1}`, output: `STATUS: done\nCHANGES: ${id}` },
        opKey: `opk-${id}`,
      });
    }
    await new Promise((r) => setTimeout(r, 30));

    // Cancel each queued request via guest ctrl. ctrl cancel must NOT change
    // the invocation state and (post-fix) must reap the entry from the queue —
    // a canceled request is answered and removed, never a lingering tombstone.
    for (const id of queuedIds) {
      wire.send({ kind: "ctrl", op: "cancel", id });
      for (;;) {
        const frame = await wire.next();
        if (frame.kind === "err" && frame.id === id) {
          assert.equal(frame.code, "CANCELED");
          break;
        }
      }
    }
    assert.equal(broker.state(), "open", "ctrl cancel of queued requests must not change the invocation state");

    // Abandon the wedged active call so the serialised loop can serve the peek.
    broker.cancelRequest("rc1");
    assert.equal(broker.state(), "canceled");

    // A later live request must be ACCEPTED and served: with the four canceled
    // entries reaped, the bounded queue (cap 4) is empty again. Pre-fix this
    // peek was answered QUEUE_FULL because the four tombstones still occupied
    // the queue and the service peek was never called.
    wire.send({ kind: "req", id: "rc6", op: "step.peek", params: { agentId: AGENT, runId: RUN } });
    for (;;) {
      const frame = await wire.next();
      if (frame.id !== "rc6") continue;
      assert.equal(frame.kind, "res", "peek after canceling queued requests must be served, not QUEUE_FULL");
      assert.ok((frame.payload as { peek?: string }).peek !== undefined);
      break;
    }
    assert.ok(peekCalls >= 1, "the post-cancel peek must reach the authoritative service");
    assert.equal(services.submitCalls, 0, "no canceled complete may reach submitCompletion");
    assert.equal(services.row(STEP1)?.status, "running", "claim must be retained (no mutation)");
    await broker.close();
    await broker.closed;
  });

  it("per-id cancel of queued requests keeps surviving queued requests live and in original order", async () => {
    const raw = new ValidationGatedFake({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { expects: "STATUS: done\nCHANGES:" })],
    });
    let peekCalls = 0;
    const services = new Proxy(raw, {
      get(target, prop, receiver) {
        if (prop === "peek") {
          return (...args: unknown[]) => {
            peekCalls += 1;
            return (target as unknown as Record<string, (...a: unknown[]) => unknown>).peek(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as ValidationGatedFake;
    const { wire, broker } = startBroker(services, { maxPendingRequests: 4 });
    await hello(wire, broker);
    await sendReq(wire, "wd0", "step.claim", { agentId: AGENT, runId: RUN }, "opk-wd-claim");

    // Wedge one active mutating delegated call so the queue accumulates.
    wire.send({
      kind: "req",
      id: "wd1",
      op: "step.complete",
      params: { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: x" },
      opKey: "opk-wd1",
    });
    for (;;) {
      await new Promise((r) => setTimeout(r, 5));
      if (services.validateStarted >= 1) break;
    }

    // Queue four read-only peeks (once the active is canceled, further
    // mutations are refused — peeks prove surviving QUEUED requests are still
    // served in order).
    for (const id of ["wd2", "wd3", "wd4", "wd5"]) {
      wire.send({ kind: "req", id, op: "step.peek", params: { agentId: AGENT, runId: RUN } });
    }
    await new Promise((r) => setTimeout(r, 30));

    // Cancel two queued peeks by id; the other two must remain queued and be
    // served in the original order once the wedged active call is abandoned.
    for (const id of ["wd2", "wd4"]) {
      wire.send({ kind: "ctrl", op: "cancel", id });
      for (;;) {
        const frame = await wire.next();
        if (frame.kind === "err" && frame.id === id) {
          assert.equal(frame.code, "CANCELED");
          break;
        }
      }
    }
    broker.cancelRequest("wd1");

    const servedIds: string[] = [];
    while (servedIds.length < 2) {
      const frame = await wire.next();
      if (frame.kind === "res" && frame.id !== undefined) {
        servedIds.push(frame.id as string);
        assert.ok((frame.payload as { peek?: string }).peek !== undefined, "surviving peek must be served");
      }
    }
    assert.deepEqual(servedIds, ["wd3", "wd5"], "surviving queued requests must be served in original queue order");
    assert.equal(peekCalls, 2, "exactly the two surviving peeks reach the service");
    assert.equal(services.submitCalls, 0, "no canceled complete may reach submitCompletion");
    await broker.close();
    await broker.closed;
  });
});

describe("MTLK-GUEST-GUARD bounded host->guest write path", () => {
  async function drainUntil(writable: StallingWritable, count: number, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (writable.frames.length < count && Date.now() < deadline) {
      writable.releaseOne();
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  it("honors backpressure with a bounded queue and delivers every frame once the guest drains", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const toGuest = new StallingWritable(512);
    const fromGuest = new PassThrough();
    const broker = createHostBroker({
      binding: makeBinding(),
      services,
      pipe: { toGuest, fromGuest },
      maxPendingRequests: 1000,
      serviceTimeoutMs: 2000,
    });
    try {
      // Handshake accepted (hello-ack flows into the stalled writable).
      fromGuest.write(encodeJsonFrame({ kind: "hello", protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION, packLayoutVersion: GUEST_PACK_LAYOUT_VERSION, helperBuildVersion: "bv", capabilities: [] }));
      await broker.ready;
      const N = 200;
      for (let i = 0; i < N; i++) {
        fromGuest.write(encodeJsonFrame({ kind: "req", id: `bp-${i}`, op: "step.peek", params: { agentId: AGENT, runId: RUN } }));
      }
      await new Promise((r) => setTimeout(r, 120));
      // The writable never drained: the broker must stay open (bounded queue),
      // not crash, and not have silently dropped the protocol.
      assert.ok(["open", "canceled"].includes(broker.state()));
      assert.ok(toGuest.frames.length < N, "frames must be gated behind backpressure");
      // Now let the guest drain: every response must arrive exactly once.
      await drainUntil(toGuest, N + 1);
      const decoded: Array<Record<string, unknown>> = [];
      const decoder = new FrameDecoder({
        onFrame: (payload) => {
          const parsed = decodeJsonPayload<Record<string, unknown>>(payload);
          if (parsed.ok) decoded.push(parsed.value);
        },
        onError: () => assert.fail("decoder error on drained frames"),
      });
      for (const frame of toGuest.frames) decoder.push(frame);
      const peeks = decoded.filter((f) => f.kind === "res" && String(f.id).startsWith("bp-"));
      assert.equal(peeks.length, N, "all peek responses must be delivered once the guest drains");
      const ids = new Set(peeks.map((f) => f.id));
      assert.equal(ids.size, N);
    } finally {
      await broker.close();
      fromGuest.destroy();
      toGuest.destroy();
    }
  });

  it("outbound queue overflow fails the pipe closed (bounded host buffers, no unbounded memory)", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const toGuest = new StallingWritable(256);
    const fromGuest = new PassThrough();
    const broker = createHostBroker({
      binding: makeBinding(),
      services,
      pipe: { toGuest, fromGuest },
      maxPendingRequests: 1000,
      maxOutboundQueueBytes: 2048,
      serviceTimeoutMs: 2000,
    });
    try {
      fromGuest.write(encodeJsonFrame({ kind: "hello", protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION, packLayoutVersion: GUEST_PACK_LAYOUT_VERSION, helperBuildVersion: "bv", capabilities: [] }));
      await broker.ready;
      for (let i = 0; i < 200; i++) {
        fromGuest.write(encodeJsonFrame({ kind: "req", id: `ov-${i}`, op: "step.peek", params: { agentId: AGENT, runId: RUN } }));
      }
      await broker.closed; // overflow must fail closed within a bounded time
      assert.equal(broker.state(), "canceled");
    } finally {
      fromGuest.destroy();
      toGuest.destroy();
    }
  });

  it("a guest that never drains triggers the bounded drain deadline and fails closed", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const toGuest = new StallingWritable(256);
    const fromGuest = new PassThrough();
    const broker = createHostBroker({
      binding: makeBinding(),
      services,
      pipe: { toGuest, fromGuest },
      maxPendingRequests: 1000,
      writeDrainTimeoutMs: 80,
      serviceTimeoutMs: 2000,
    });
    try {
      fromGuest.write(encodeJsonFrame({ kind: "hello", protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION, packLayoutVersion: GUEST_PACK_LAYOUT_VERSION, helperBuildVersion: "bv", capabilities: [] }));
      await broker.ready;
      for (let i = 0; i < 50; i++) {
        fromGuest.write(encodeJsonFrame({ kind: "req", id: `dd-${i}`, op: "step.peek", params: { agentId: AGENT, runId: RUN } }));
      }
      await broker.closed;
      assert.equal(broker.state(), "canceled");
    } finally {
      fromGuest.destroy();
      toGuest.destroy();
    }
  });

  it("a write-side peer error fails the pipe closed without an unhandled error", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const toGuest = new StallingWritable(256);
    const fromGuest = new PassThrough();
    const broker = createHostBroker({
      binding: makeBinding(),
      services,
      pipe: { toGuest, fromGuest },
      maxPendingRequests: 1000,
      serviceTimeoutMs: 2000,
    });
    try {
      fromGuest.write(encodeJsonFrame({ kind: "hello", protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION, packLayoutVersion: GUEST_PACK_LAYOUT_VERSION, helperBuildVersion: "bv", capabilities: [] }));
      await broker.ready;
      const closedP = broker.closed;
      toGuest.destroy(new Error("peer write side exited"));
      await closedP;
      assert.ok(["canceled", "completed"].includes(broker.state()));
    } finally {
      fromGuest.destroy();
      if (!toGuest.destroyed) toGuest.destroy();
    }
  });

  it("an over-limit response (unencodable frame) fails the pipe closed instead of crashing", async () => {
    const hugeInput = "x".repeat(MAX_FRAME_PAYLOAD_BYTES + 1024);
    const services = new FakeStepServices({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { input: hugeInput })],
    });
    const { wire, broker } = startBroker(services, { serviceTimeoutMs: 2000 });
    await hello(wire, broker);
    wire.send({ kind: "req", id: "big-1", op: "step.claim", params: { agentId: AGENT, runId: RUN }, opKey: "opk-big" });
    // The response cannot be encoded: the broker fails the pipe closed and the
    // request is answered by the close, never by a malformed/partial frame.
    await broker.closed;
    assert.equal(broker.state(), "canceled");
    await new Promise((r) => setTimeout(r, 50)); // no late/crashing frame after close
  });
});

describe("MTLK-BRIDGE-CLOSE strict compatible HELLO + idle terminal revocation", () => {
  /** Build a broker, send a hello, and await the handshake verdict. */
  async function tryHello(
    helloOverrides: Record<string, unknown>,
    bindingOverrides: Partial<HostBinding> = {},
  ): Promise<{ broker: HostBrokerHandle; wire: Wire; ready: { ok: boolean; reason?: string } }> {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [step(STEP1)] });
    const wire = new Wire();
    const broker = createHostBroker({
      binding: { ...makeBinding(), ...bindingOverrides },
      services,
      pipe: wire.brokerPipe,
      serviceTimeoutMs: 2000,
    });
    openHandles.push({ wire, broker });
    wire.send({
      kind: "hello",
      protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION,
      packLayoutVersion: GUEST_PACK_LAYOUT_VERSION,
      helperBuildVersion: "bv",
      capabilities: [],
      ...helloOverrides,
    });
    const ready = await broker.ready;
    return { broker, wire, ready };
  }

  it("accepts a fully legitimate HELLO (nonempty helper build + supported numeric pack layout) as the positive control", async () => {
    const { broker, wire, ready } = await tryHello({
      helperBuildVersion: "bv",
      packLayoutVersion: GUEST_PACK_LAYOUT_VERSION,
    });
    try {
      assert.equal(ready.ok, true, ready.reason ?? "");
      // The accepted invocation is live: a peek is served.
      const peek = await sendReq(wire, "hc1", "step.peek", { agentId: AGENT, runId: RUN });
      assert.equal(peek.ok, true);
      assert.equal((peek.payload as { peek: string }).peek, "HAS_WORK");
    } finally {
      await broker.close();
      await broker.closed;
    }
  });

  it("refuses a HELLO that omits helper build and pack layout metadata", async () => {
    const { broker, ready } = await tryHello({
      helperBuildVersion: undefined,
      packLayoutVersion: undefined,
    });
    try {
      assert.equal(ready.ok, false);
      assert.match(ready.reason ?? "", /helperBuildVersion must be a nonempty string/);
      await broker.closed;
    } finally {
      await broker.close();
    }
  });

  it("refuses a HELLO with an empty helperBuildVersion", async () => {
    const { broker, ready } = await tryHello({ helperBuildVersion: "" });
    try {
      assert.equal(ready.ok, false);
      assert.match(ready.reason ?? "", /helperBuildVersion must be a nonempty string/);
      await broker.closed;
    } finally {
      await broker.close();
    }
  });

  it("refuses a HELLO with a numeric helperBuildVersion", async () => {
    const { broker, ready } = await tryHello({ helperBuildVersion: 27 });
    try {
      assert.equal(ready.ok, false);
      assert.match(ready.reason ?? "", /helperBuildVersion must be a nonempty string/);
      await broker.closed;
    } finally {
      await broker.close();
    }
  });

  it("refuses a HELLO with a string packLayoutVersion (wrong type)", async () => {
    const { broker, ready } = await tryHello({ packLayoutVersion: "1" });
    try {
      assert.equal(ready.ok, false);
      assert.match(ready.reason ?? "", /packLayoutVersion must be the supported numeric layout/);
      await broker.closed;
    } finally {
      await broker.close();
    }
  });

  it("refuses a HELLO whose pack layout is an unsupported number", async () => {
    const { broker, ready } = await tryHello({ packLayoutVersion: GUEST_PACK_LAYOUT_VERSION + 99 });
    try {
      assert.equal(ready.ok, false);
      assert.match(ready.reason ?? "", /pack layout \d+ does not match host/);
      await broker.closed;
    } finally {
      await broker.close();
    }
  });

  it("refuses a HELLO whose helper build mismatches the host-required build", async () => {
    const { broker, ready } = await tryHello({ helperBuildVersion: "some-other-build" });
    try {
      assert.equal(ready.ok, false);
      assert.match(ready.reason ?? "", /does not match the host-required helper build/);
      await broker.closed;
    } finally {
      await broker.close();
    }
  });

  it("fails closed when the HOST-required helper build expectation is empty/invalid", async () => {
    // No legitimate guest metadata can match an empty host expectation; the
    // broker must refuse rather than silently skip compatibility.
    const { broker, ready } = await tryHello(
      { helperBuildVersion: "bv", packLayoutVersion: GUEST_PACK_LAYOUT_VERSION },
      { helperBuildVersion: "" },
    );
    try {
      assert.equal(ready.ok, false);
      assert.match(ready.reason ?? "", /host-required helper build expectation is empty\/invalid/);
      await broker.closed;
    } finally {
      await broker.close();
    }
  });

  it("a refused HELLO leaves the broker closed: no later request is accepted", async () => {
    const { broker, wire, ready } = await tryHello({ helperBuildVersion: "wrong" });
    try {
      assert.equal(ready.ok, false);
      await broker.closed;
      // A subsequent request (even with a legitimate hello first) is refused.
      wire.send({
        kind: "hello",
        protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION,
        packLayoutVersion: GUEST_PACK_LAYOUT_VERSION,
        helperBuildVersion: "bv",
        capabilities: [],
      });
      wire.send({ kind: "req", id: "x1", op: "step.peek", params: { agentId: AGENT, runId: RUN } });
      assert.equal(broker.state(), "canceled");
    } finally {
      await broker.close();
    }
  });

  it("host close() of an IDLE connection synchronously revokes adapter authority exactly once", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [step(STEP1)] });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    // No request has ever been issued — the invocation is idle.
    await broker.close();
    await broker.closed;
    assert.equal(services.revocations.length, 1, "idle host close must revoke exactly once");
    assert.equal(services.revocations[0].invocationId, INV);
    // Repeated close / post-close cancels are idempotent: still exactly one.
    await broker.close();
    broker.cancelRequest();
    broker.cancelRequest("anything");
    assert.equal(services.revocations.length, 1, "terminal revocation notification is idempotent");
  });

  it("host cancelRequest() of an IDLE connection (no target) revokes adapter authority once", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [step(STEP1)] });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    broker.cancelRequest();
    assert.equal(services.revocations.length, 1, "idle host cancel-all must revoke exactly once");
    assert.equal(services.revocations[0].invocationId, INV);
    assert.equal(broker.state(), "canceled");
    await broker.close();
    await broker.closed;
    assert.equal(services.revocations.length, 1);
  });

  it("guest EOF of an IDLE connection revokes adapter authority once", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [step(STEP1)] });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    wire.fromGuest.end();
    await broker.closed;
    assert.equal(services.revocations.length, 1, "idle guest EOF must revoke exactly once");
    assert.equal(services.revocations[0].invocationId, INV);
    // Late close/eof-style events after the first terminal event add nothing.
    await broker.close();
    broker.cancelRequest();
    assert.equal(services.revocations.length, 1);
  });

  it("a request-scoped cancel that matches no live request does NOT terminally revoke the invocation", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [step(STEP1)] });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    // Nothing in flight/queued: canceling a specific unknown id is a no-op for
    // authority — the invocation is NOT terminally revoked by it.
    broker.cancelRequest("does-not-exist");
    assert.equal(services.revocations.length, 0, "request-scoped cancel of nothing must not revoke the invocation");
    await broker.close();
    await broker.closed;
    assert.equal(services.revocations.length, 1, "the later terminal close revokes once");
  });

  it("terminal revocation is reported even after a settled request (revocations do not depend on an in-flight call)", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [step(STEP1)] });
    const { wire, broker } = startBroker(services);
    await hello(wire, broker);
    const claim = await sendReq(wire, "t0", "step.claim", { agentId: AGENT, runId: RUN }, "opk-idle-claim");
    assert.equal(claim.ok, true);
    // The claim settled; the invocation then sits idle until the host closes.
    await broker.close();
    await broker.closed;
    assert.equal(services.revocations.length, 1, "close after a settled claim still revokes adapter authority");
    assert.equal(services.revocations[0].invocationId, INV);
  });
});

describe("US-004 run-scoped read-only query ops", () => {
  const OTHER_RUN = "99999999-9999-4999-8999-999999999999";

  function queryFixture(): { query: FakeQueryServices; fixture: FakeQueryFixture } {
    const fixture: FakeQueryFixture = {
      stories: [
        {
          storyId: "US-001",
          title: "Story one",
          status: "done",
          retryCount: 0,
          resumeResetCount: 0,
          abandonedCount: 0,
          updatedAt: "2026-09-09T00:00:00.000Z",
        },
        {
          storyId: "US-002",
          title: "Story two",
          status: "pending",
          retryCount: 1,
          resumeResetCount: 2,
        },
      ],
      status: { runId: `run-${RUN}`, workflowId: "feature-dev-merge-worktree", status: "running", steps: [] },
      logLines: ["9:09:09 AM  [run-11111111]  Step completed", "9:09:10 AM  [run-11111111]  Run nudged"],
    };
    return { query: new FakeQueryServices({ runId: RUN, fixture }), fixture };
  }

  it("serves step.stories for the bound run (prefixed run id + native story shape), no opKey needed", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const { query } = queryFixture();
    const { wire, broker } = startBroker(services, { query });
    await hello(wire, broker);

    const out = await sendReq(wire, "q1", "step.stories", { runId: RUN });
    assert.equal(out.ok, true);
    const stories = (out.payload as { stories: GuestStoriesPayload }).stories;
    assert.equal(stories.runId, `run-${RUN}`);
    assert.equal(stories.stories.length, 2);
    assert.equal(stories.stories[0].storyId, "US-001");
    assert.equal(stories.stories[0].abandonedCount, 0);
    assert.equal(stories.stories[1].resumeResetCount, 2);
    assert.deepEqual(query.calls, ["stories"]);
    // Read-only: the invocation state is untouched (no mutation, still open).
    assert.equal(broker.state(), "open");
    await broker.close();
  });

  it("serves step.stories when the run id is prefixed run-<uuid>", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const { query } = queryFixture();
    const { wire, broker } = startBroker(services, { query });
    await hello(wire, broker);
    const out = await sendReq(wire, "q2", "step.stories", { runId: `run-${RUN}` });
    assert.equal(out.ok, true);
    assert.equal((out.payload as { stories: GuestStoriesPayload }).stories.runId, `run-${RUN}`);
    await broker.close();
  });

  it("serves workflow.status for the bound run with the native run-JSON object", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const { query, fixture } = queryFixture();
    const { wire, broker } = startBroker(services, { query });
    await hello(wire, broker);
    const out = await sendReq(wire, "q3", "workflow.status", { runId: RUN });
    assert.equal(out.ok, true);
    assert.deepEqual((out.payload as { status: Record<string, unknown> }).status, fixture.status);
    assert.deepEqual(query.calls, ["workflowStatus"]);
    await broker.close();
  });

  it("serves logs.run with a bounded tail; an explicit in-range limit is honored and no opKey mutates state", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const { query, fixture } = queryFixture();
    const { wire, broker } = startBroker(services, { query });
    await hello(wire, broker);
    const out = await sendReq(wire, "q4", "logs.run", { runId: RUN, limit: 10 });
    assert.equal(out.ok, true);
    const logs = (out.payload as { logs: GuestLogsPayload }).logs;
    assert.equal(logs.runId, `run-${RUN}`);
    assert.deepEqual(logs.lines, fixture.logLines);
    assert.equal(logs.limit, 10);
    assert.deepEqual(query.calls, ["runLogs"]);
    assert.equal(broker.state(), "open");
    await broker.close();
  });

  it("refuses a query for a DIFFERENT run with a typed BINDING error before any host read", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const { query } = queryFixture();
    const { wire, broker } = startBroker(services, { query });
    await hello(wire, broker);
    for (const [id, op, params] of [
      ["r1", "step.stories", { runId: OTHER_RUN }],
      ["r2", "workflow.status", { runId: `run-${OTHER_RUN}` }],
      ["r3", "logs.run", { runId: OTHER_RUN }],
    ] as const) {
      const out = await sendReq(wire, id, op, params);
      assert.equal(out.ok, false);
      assert.equal(out.code, "BINDING");
      assert.match(out.message ?? "", /is not bound to this invocation/);
    }
    // No host read happened for ANY refused query.
    assert.deepEqual(query.calls, []);
    await broker.close();
  });

  it("refuses bare-number/global-enumeration style run ids and wrong prefixes as typed refusals before host reads", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const { query } = queryFixture();
    const { wire, broker } = startBroker(services, { query });
    await hello(wire, broker);
    const numeric = await sendReq(wire, "r4", "logs.run", { runId: "7" });
    assert.equal(numeric.ok, false);
    assert.equal(numeric.code, "BINDING");
    const wrongPrefix = await sendReq(wire, "r5", "step.stories", { runId: `step-${RUN}` });
    assert.equal(wrongPrefix.ok, false);
    assert.equal(wrongPrefix.code, "BAD_REQUEST");
    assert.match(wrongPrefix.message ?? "", /that is a step id, not a run id/);
    assert.deepEqual(query.calls, []);
    await broker.close();
  });

  it("refuses malformed/oversized query params at the broker wire validator without delegating", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const { query } = queryFixture();
    const { wire, broker } = startBroker(services, { query });
    await hello(wire, broker);
    const noRun = await sendReq(wire, "w1", "step.stories", {});
    assert.equal(noRun.ok, false);
    assert.equal(noRun.code, "BAD_REQUEST");
    const oversizeRun = await sendReq(wire, "w2", "workflow.status", { runId: `run-${"a".repeat(300)}` });
    assert.equal(oversizeRun.ok, false);
    assert.equal(oversizeRun.code, "OVERSIZED");
    const badLimit = await sendReq(wire, "w3", "logs.run", { runId: RUN, limit: 0 });
    assert.equal(badLimit.ok, false);
    assert.equal(badLimit.code, "BAD_REQUEST");
    const bigLimit = await sendReq(wire, "w4", "logs.run", { runId: RUN, limit: GUEST_RUN_LOG_LIMIT_MAX + 1 });
    assert.equal(bigLimit.ok, false);
    assert.equal(bigLimit.code, "BAD_REQUEST");
    assert.match(bigLimit.message ?? "", /bounded maximum tail/);
    assert.deepEqual(query.calls, []);
    await broker.close();
  });

  it("refuses every query op UNSUPPORTED when no query service is wired (host did not inject a query bridge)", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [step(STEP1)] });
    const { wire, broker } = startBroker(services); // no `query` option
    await hello(wire, broker);
    for (const [id, op, params] of [
      ["n1", "step.stories", { runId: RUN }],
      ["n2", "workflow.status", { runId: RUN }],
      ["n3", "logs.run", { runId: RUN }],
    ] as const) {
      const out = await sendReq(wire, id, op, params);
      assert.equal(out.ok, false);
      assert.equal(out.code, "UNSUPPORTED");
      assert.match(out.message ?? "", /query service is absent/);
    }
    // The step surface is unaffected by the missing query bridge.
    const peek = await sendReq(wire, "n4", "step.peek", { agentId: AGENT, runId: RUN });
    assert.equal(peek.ok, true);
    assert.equal((peek.payload as { peek: string }).peek, "HAS_WORK");
    await broker.close();
  });

  it("refuses admin/lifecycle ops (step release, workflow lifecycle) before any query/host read", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const { query } = queryFixture();
    const { wire, broker } = startBroker(services, { query });
    await hello(wire, broker);
    // Ops not in BRIDGE_OPS never reach handleOp: rejected as unsupported/malformed.
    const release = await sendReq(wire, "a1", "step.release", { runId: RUN });
    assert.equal(release.ok, false);
    assert.equal(release.code, "UNSUPPORTED");
    const wfRun = await sendReq(wire, "a2", "workflow.run", { runId: RUN, task: "x" });
    assert.equal(wfRun.ok, false);
    assert.equal(wfRun.code, "UNSUPPORTED");
    assert.deepEqual(query.calls, []);
    await broker.close();
  });
});

// ── US-007 scoped merge ops at the broker boundary ──────────────────────────

describe("US-007 broker merge authorization/receipt boundary", () => {
  const MERGER_AGENT = "feature-dev-merge-worktree_merger";
  const MERGE_STEP = "55555555-5555-4555-8555-555555555555";
  const T1 = "1".repeat(40);
  const T2 = "2".repeat(40);
  const TREE = "3".repeat(40);

  function mergerBinding(): HostBinding {
    return {
      runId: RUN,
      invocationId: INV,
      agentId: MERGER_AGENT,
      jobId: "job-merge",
      role: "merger",
      admittedRoots: [],
      helperProtocolVersion: "bv+p1",
      helperBuildVersion: "bv",
    };
  }

  function mergerServices(): FakeStepServices {
    return new FakeStepServices({
      runId: RUN,
      agentId: MERGER_AGENT,
      steps: [
        {
          stepId: MERGE_STEP,
          agentId: MERGER_AGENT,
          runId: RUN,
          status: "running",
          expects: "",
          input: "finalize",
          retryCount: 0,
          maxRetries: 0,
          claimId: "claim-merge",
        },
      ],
    });
  }

  function mergeHarness(opts: { role?: string; withService?: boolean } = {}) {
    let tip = T1;
    const tipReads: string[] = [];
    const events: MergeCoreEvent[] = [];
    const context: HostMergeContext = {
      runId: RUN,
      originalRepositoryRoot: "/work/origin",
      originalBranch: "main",
      finalizeMergeStepId: MERGE_STEP,
      admittedRoots: ["/work/origin"],
      imageDigest: "sha256:img",
    };
    const merge = createHostMergeService(context, {
      readTargetTip: (_origin, into) => {
        tipReads.push(into);
        return tip;
      },
      emitEvent: (event) => events.push(event),
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });
    const binding = opts.role === undefined ? mergerBinding() : { ...mergerBinding(), role: opts.role };
    const services = mergerServices();
    const { wire, broker } = startBroker(services, {
      binding,
      ...(opts.withService === false ? {} : { merge }),
    });
    return { wire, broker, services, events, tipReads, merge, setTip: (v: string) => { tip = v; } };
  }

  const authorizeParams = {
    origin: "/work/origin",
    branch: "feature",
    into: "main",
    expectTip: T1,
    message: "land feature",
  };

  it("authorizes the finalizer binding and refuses render-only requests before any Git read", async () => {
    const h = mergeHarness({ role: "developer" });
    await hello(h.wire, h.broker);
    const res = await sendReq(h.wire, "m1", "merge.authorize", authorizeParams);
    assert.equal(res.ok, false);
    assert.equal(res.code, "MERGE_ROLE");
    assert.deepEqual(h.tipReads, [], "role refusal must not touch host Git");
    await h.broker.close();
  });

  it("authorizes the merger claim, records a verified landed receipt and replays the exact ack", async () => {
    const h = mergeHarness();
    await hello(h.wire, h.broker);
    const auth = await sendReq(h.wire, "m1", "merge.authorize", authorizeParams);
    assert.equal(auth.ok, true, auth.message);
    const authorization = (auth.payload as { mergeAuthorization: { authorizationId: string; origin: string; runId: string; targetRef: string } }).mergeAuthorization;
    assert.equal(authorization.origin, "/work/origin");
    assert.equal(authorization.runId, RUN);
    assert.equal(authorization.targetRef, "refs/heads/main");

    // Guest lands the branch: the authoritative target tip moves to T2.
    h.setTip(T2);
    const report = {
      authorizationId: authorization.authorizationId,
      status: "landed",
      exitCode: 0,
      mergedTree: TREE,
      mergedCommit: T2,
      noop: false,
      checkoutRefresh: "refreshed",
    };
    const first = await sendReq(h.wire, "m2", "merge.report", report, "key-merge-1");
    assert.equal(first.ok, true, first.message);
    assert.equal((first.payload as { mergeReport: { status: string } }).mergeReport.status, "landed");
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0]!.event, "merge.landed");
    assert.equal(h.events[0]!.runId, RUN);

    // Exact replay: same opKey + identical content returns the same ack, no re-emit.
    const replay = await sendReq(h.wire, "m3", "merge.report", report, "key-merge-1");
    assert.deepEqual(replay.payload, first.payload);
    assert.equal(h.events.length, 1);
    await h.broker.close();
  });

  it("rejects opKey reuse with changed merge report content", async () => {
    const h = mergeHarness();
    await hello(h.wire, h.broker);
    const auth = await sendReq(h.wire, "m1", "merge.authorize", authorizeParams);
    const authorization = (auth.payload as { mergeAuthorization: { authorizationId: string } }).mergeAuthorization;
    h.setTip(T2);
    const report = {
      authorizationId: authorization.authorizationId,
      status: "landed", exitCode: 0, mergedTree: TREE, mergedCommit: T2, noop: false, checkoutRefresh: "refreshed",
    };
    const first = await sendReq(h.wire, "m2", "merge.report", report, "key-merge-2");
    assert.equal(first.ok, true, first.message);
    const changed = await sendReq(h.wire, "m3", "merge.report", { ...report, noop: true }, "key-merge-2");
    assert.equal(changed.ok, false);
    assert.equal(changed.code, "IDEMPOTENCY");
    await h.broker.close();
  });

  it("requires an opKey for merge.report and refuses after invocation cancel", async () => {
    const h = mergeHarness();
    await hello(h.wire, h.broker);
    const auth = await sendReq(h.wire, "m1", "merge.authorize", authorizeParams);
    const authorization = (auth.payload as { mergeAuthorization: { authorizationId: string } }).mergeAuthorization;
    const noKey = await sendReq(h.wire, "m2", "merge.report", {
      authorizationId: authorization.authorizationId,
      status: "conflicts", exitCode: 3, conflicts: "CONFLICT",
    });
    assert.equal(noKey.ok, false);
    assert.equal(noKey.code, "BAD_REQUEST");
    h.broker.cancelRequest();
    const afterCancel = await sendReq(h.wire, "m3", "merge.authorize", authorizeParams);
    assert.equal(afterCancel.ok, false);
    assert.equal(afterCancel.code, "INVOCATION_STATE");
    await h.broker.close();
  });

  it("refuses merge ops with UNSUPPORTED when no host merge service was wired", async () => {
    const h = mergeHarness({ withService: false });
    await hello(h.wire, h.broker);
    const res = await sendReq(h.wire, "m1", "merge.authorize", authorizeParams);
    assert.equal(res.ok, false);
    assert.equal(res.code, "UNSUPPORTED");
    assert.deepEqual(h.tipReads, []);
    await h.broker.close();
  });

  it("canonically refuses malformed/oversized merge requests before the host service", async () => {
    const h = mergeHarness();
    await hello(h.wire, h.broker);
    const badTip = await sendReq(h.wire, "m1", "merge.authorize", { ...authorizeParams, expectTip: "not-a-sha" });
    assert.equal(badTip.ok, false);
    assert.equal(badTip.code, "BAD_REQUEST");
    const oversized = await sendReq(h.wire, "m2", "merge.authorize", { ...authorizeParams, message: "x".repeat(128 * 1024 + 1) });
    assert.equal(oversized.ok, false);
    assert.equal(oversized.code, "OVERSIZED");
    const badStatus = await sendReq(h.wire, "m3", "merge.report", { authorizationId: "a", status: "nope", exitCode: 0 }, "k");
    assert.equal(badStatus.ok, false);
    assert.equal(badStatus.code, "BAD_REQUEST");
    assert.deepEqual(h.tipReads, [], "canonical refusals never reach the host service/Git");
    await h.broker.close();
  });
});
