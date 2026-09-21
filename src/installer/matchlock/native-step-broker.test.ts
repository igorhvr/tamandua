/**
 * Host broker + REAL NativeStepServices integration tests (serial lane).
 *
 * Drives the real broker (broker.ts) with the real DB-backed adapter over an
 * in-memory wire, against a fresh isolated DB: full claim -> complete flows,
 * REJECTED retention with corrected resubmit, exact ack replay and opKey
 * misuse, foreign-invocation denial, and host revocation WHILE a completion
 * request is queued/in-flight (deterministic via the adapter's optional
 * service delay seam) — proving the authority guard runs at mutation time,
 * not just as an async precheck.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { closeDb, getDb } from "../../../dist/db.js";
import { createHostBroker, type HostBrokerHandle } from "../../../dist/installer/matchlock/broker.js";
import type { AuthoritativeStepServices } from "../../../dist/installer/matchlock/broker-services.js";
import { PassThrough } from "node:stream";
import {
  FrameDecoder,
  decodeJsonPayload,
  encodeJsonFrame,
} from "../../../dist/installer/matchlock/guest-framing.js";
import { GUEST_BRIDGE_PROTOCOL_VERSION, GUEST_PACK_LAYOUT_VERSION } from "../../../dist/installer/matchlock/guest-protocol.js";
import { NativeStepServices } from "../../../dist/installer/matchlock/native-step-services.js";
import { HostInvocationRegistry } from "../../../dist/installer/matchlock/native-step-invocations.js";
import {
  JOB_ID,
  RUN,
  applyEnv,
  bindingFor,
  createIsolatedState,
  snapshotEnv,
  type IsolatedState,
} from "../../../dist/installer/matchlock/native-step-test-utils.js";

const INV_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INV_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STEP1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const sticky = createIsolatedState("broker-sticky");
sticky.open();
const stickyEnv = snapshotEnv();

after(() => {
  try {
    closeDb();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(sticky.root, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

afterEach(() => {
  applyEnv(stickyEnv);
});

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

  async next(timeoutMs = 8000): Promise<Record<string, unknown>> {
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

async function sendReq(wire: Wire, id: string, op: string, params: unknown, opKey?: string): Promise<ReqOutcome> {
  wire.send({ kind: "req", id, op, params, ...(opKey !== undefined ? { opKey } : {}) });
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

async function hello(wire: Wire, handle: HostBrokerHandle, invocationId: string): Promise<void> {
  wire.send({
    kind: "hello",
    protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION,
    packLayoutVersion: GUEST_PACK_LAYOUT_VERSION,
    helperBuildVersion: "bv",
    capabilities: [],
    claimedRunId: `run-${RUN}`,
    claimedInvocationId: invocationId,
  });
  const ready = await handle.ready;
  assert.ok(ready.ok, `handshake accepted: ${ready.reason}`);
}

interface BrokerRig {
  st: IsolatedState;
  registry: HostInvocationRegistry;
  wireA: Wire;
  brokerA: HostBrokerHandle;
}

const openHandles: Array<{ wire: Wire; broker: HostBrokerHandle }> = [];

function startBroker(opts: {
  invocationId: string;
  registry: HostInvocationRegistry;
  delayMs?: number;
}): { wire: Wire; broker: HostBrokerHandle; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  const binding = bindingFor(opts.invocationId);
  // Host explicitly admits the invocation identity before guest work (host
  // controller lifecycle — independent of any claim it may later hold).
  const admit = opts.registry.admitInvocation({
    invocationId: opts.invocationId,
    runId: binding.runId,
    agentId: binding.agentId,
    jobId: binding.jobId,
  });
  assert.equal(admit.ok, true, admit.ok ? "" : admit.reason);
  const services = new NativeStepServices({
    binding,
    registry: opts.registry,
    workerOwnership: { jobId: JOB_ID, pid: 424242 },
    serviceDelayMs: opts.delayMs ?? 0,
    emit: (e) => events.push(e),
  });
  const wire = new Wire();
  const broker = createHostBroker({
    binding,
    services,
    pipe: wire.brokerPipe,
    handshakeTimeoutMs: 3000,
    serviceTimeoutMs: 15000,
    shutdownFlushMs: 300,
  });
  openHandles.push({ wire, broker });
  return { wire, broker, events };
}

afterEach(() => {
  for (const h of openHandles.splice(0)) {
    h.wire.destroy();
  }
});

function stepRow(): Record<string, unknown> {
  return getDb().prepare("SELECT * FROM steps WHERE id = ?").get(STEP1) as Record<string, unknown>;
}

describe("host broker + real NativeStepServices", () => {
  it("full claim -> current -> complete flow through the real broker", async () => {
    const st = createIsolatedState("brk-happy");
    st.open();
    try {
      st.insertRun();
      st.insertStep({ id: STEP1, status: "pending", expects: "STATUS: done\nCHANGES:" });
      const registry = new HostInvocationRegistry();
      const { wire, broker } = startBroker({ invocationId: INV_A, registry });
      await hello(wire, broker, INV_A);

      const peek = await sendReq(wire, "r1", "step.peek", { agentId: bindingFor(INV_A).agentId, runId: `run-${RUN}` });
      assert.equal(peek.ok, true);
      assert.equal((peek.payload as { peek: string }).peek, "HAS_WORK");

      const claim = await sendReq(wire, "r2", "step.claim", { agentId: bindingFor(INV_A).agentId, runId: `run-${RUN}` }, "op-claim");
      assert.equal(claim.ok, true);
      const claimPayload = (claim.payload as { claim: { found: boolean; stepId: string; runId: string } }).claim;
      assert.equal(claimPayload.found, true);
      assert.equal(claimPayload.stepId, `step-${STEP1}`);

      const current = await sendReq(wire, "r3", "step.current", { agentId: bindingFor(INV_A).agentId, runId: `run-${RUN}` });
      const currentPayload = (current.payload as { current: { found: boolean; stepId: string } }).current;
      assert.equal(currentPayload.found, true);
      assert.equal(currentPayload.stepId, `step-${STEP1}`);

      const complete = await sendReq(
        wire,
        "r4",
        "step.complete",
        { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: worked" },
        "op-complete",
      );
      assert.equal(complete.ok, true);
      const completePayload = complete.payload as { complete: { status: string } };
      assert.ok(
        completePayload.complete.status === "advanced" || completePayload.complete.status === "completed",
        `status ${completePayload.complete.status}`,
      );
      assert.equal(stepRow().status, "done");
      assert.equal(registry.size, 0);

      // Accepted completion revokes later NEW mutations (exact ack replay is
      // covered by the replay test below).
      const late = await sendReq(
        wire,
        "r5",
        "step.complete",
        { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: again" },
        "op-late",
      );
      assert.equal(late.ok, false);
      assert.equal(late.code, "INVOCATION_STATE");
      assert.equal(stepRow().status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("REJECTED at submit-time retains the claim; corrected resubmit (new opKey) completes", async () => {
    const st = createIsolatedState("brk-reject");
    st.open();
    try {
      st.insertRun();
      st.insertStep({ id: STEP1, status: "pending", expects: "STATUS: done\nCHANGES:" });
      const registry = new HostInvocationRegistry();
      const { wire, broker } = startBroker({ invocationId: INV_A, registry });
      await hello(wire, broker, INV_A);

      await sendReq(wire, "r1", "step.claim", { agentId: bindingFor(INV_A).agentId, runId: `run-${RUN}` }, "op-claim");
      const rejected = await sendReq(
        wire,
        "r2",
        "step.complete",
        { stepId: `step-${STEP1}`, output: "STATUS: done" },
        "op-bad",
      );
      assert.equal(rejected.ok, true);
      assert.equal((rejected.payload as { complete: { status: string } }).complete.status, "rejected");
      // Claim retained, retry budget untouched.
      assert.equal(stepRow().status, "running");
      assert.equal(stepRow().retry_count, 0);

      const good = await sendReq(
        wire,
        "r3",
        "step.complete",
        { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: fixed" },
        "op-good",
      );
      assert.equal(good.ok, true);
      const goodStatus = (good.payload as { complete: { status: string } }).complete.status;
      assert.ok(goodStatus === "advanced" || goodStatus === "completed");
      assert.equal(stepRow().status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("replays the exact acknowledgment for the same opKey and content; rejects reuse with changed content", async () => {
    const st = createIsolatedState("brk-replay");
    st.open();
    try {
      st.insertRun();
      st.insertStep({ id: STEP1, status: "pending", expects: "STATUS: done" });
      const registry = new HostInvocationRegistry();
      const { wire, broker } = startBroker({ invocationId: INV_A, registry });
      await hello(wire, broker, INV_A);

      await sendReq(wire, "r1", "step.claim", { agentId: bindingFor(INV_A).agentId, runId: `run-${RUN}` }, "op-claim");
      const first = await sendReq(
        wire,
        "r2",
        "step.complete",
        { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: x" },
        "op-complete",
      );
      assert.equal(first.ok, true);
      const firstStatus = (first.payload as { complete: { status: string } }).complete.status;
      assert.ok(firstStatus === "advanced" || firstStatus === "completed");

      // Exact ack replay: same opKey + same content replays the stored ack
      // without a second mutation (row stays done, no duplicate events).
      const replay = await sendReq(
        wire,
        "r3",
        "step.complete",
        { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: x" },
        "op-complete",
      );
      assert.equal(replay.ok, true);
      assert.equal((replay.payload as { complete: { status: string } }).complete.status, firstStatus);

      // Same opKey with changed content is rejected.
      const reuse = await sendReq(
        wire,
        "r4",
        "step.complete",
        { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: changed" },
        "op-complete",
      );
      assert.equal(reuse.ok, false);
      assert.equal(reuse.code, "IDEMPOTENCY");
      assert.equal(stepRow().status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("a second broker bound to the same job but a different invocation cannot touch the claim", async () => {
    const st = createIsolatedState("brk-foreign");
    st.open();
    try {
      st.insertRun();
      st.insertStep({ id: STEP1, status: "pending", expects: "STATUS: done" });
      const registry = new HostInvocationRegistry();
      const { wire: wireA, broker: brokerA } = startBroker({ invocationId: INV_A, registry });
      const { wire: wireB, broker: brokerB } = startBroker({ invocationId: INV_B, registry });
      await hello(wireA, brokerA, INV_A);
      await hello(wireB, brokerB, INV_B);

      const claimA = await sendReq(wireA, "a1", "step.claim", { agentId: bindingFor(INV_A).agentId, runId: `run-${RUN}` }, "a-claim");
      assert.equal(claimA.ok, true);

      // B's current: no claim held by THIS invocation -> found:false (no leak).
      const currentB = await sendReq(wireB, "b1", "step.current", { agentId: bindingFor(INV_B).agentId, runId: `run-${RUN}` });
      assert.equal((currentB.payload as { current: { found: boolean } }).current.found, false);

      // B's complete: no held claim -> CLAIM error before any mutation.
      const completeB = await sendReq(wireB, "b2", "step.complete", { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: B" }, "b-complete");
      assert.equal(completeB.ok, false);
      assert.equal(completeB.code, "CLAIM");
      assert.equal(stepRow().status, "running");
      assert.equal(stepRow().claim_job_id, JOB_ID);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("host revocation WHILE a completion is queued/in-flight is enforced at mutation time", async () => {
    const st = createIsolatedState("brk-revoke-queued");
    st.open();
    try {
      st.insertRun();
      st.insertStep({ id: STEP1, status: "pending", expects: "STATUS: done" });
      const registry = new HostInvocationRegistry();
      const { wire: wireA, broker: brokerA } = startBroker({ invocationId: INV_A, registry, delayMs: 400 });
      const { wire: wireB, broker: brokerB } = startBroker({ invocationId: INV_B, registry });
      await hello(wireA, brokerA, INV_A);
      await hello(wireB, brokerB, INV_B);

      const claimA = await sendReq(wireA, "a1", "step.claim", { agentId: bindingFor(INV_A).agentId, runId: `run-${RUN}` }, "a-claim");
      assert.equal(claimA.ok, true);

      // Send A's completion (broker captured the claim from a fresh readClaim
      // and is now inside the delegated mutation path, slowed by the seam).
      const pending = sendReq(wireA, "a2", "step.complete", { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: A" }, "a-complete");
      await new Promise((r) => setTimeout(r, 950)); // inside submitCompletion's delay, before the mutation guard

      // Host revokes A and dispatches B while A's completion is in flight.
      registry.revokeInvocation(INV_A);
      const claimB = await sendReq(wireB, "b1", "step.claim", { agentId: bindingFor(INV_B).agentId, runId: `run-${RUN}` }, "b-claim");
      assert.equal(claimB.ok, true);

      const result = await pending;
      assert.equal(result.ok, true);
      const status = (result.payload as { complete: { status: string } }).complete.status;
      // The stale completion is refused at the atomic mutation boundary:
      // A no longer holds the lease, so the guard returns blocked and the
      // row (now B's claim) is untouched by A.
      assert.equal(status, "blocked");
      assert.equal(stepRow().status, "running");
      assert.equal(stepRow().output, null);
      assert.equal(registry.getLeaseByInvocation(INV_B)?.stepRowId, STEP1);

      // B completes normally afterwards.
      const doneB = await sendReq(wireB, "b2", "step.complete", { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: B" }, "b-complete");
      assert.equal(doneB.ok, true);
      const doneStatus = (doneB.payload as { complete: { status: string } }).complete.status;
      assert.ok(doneStatus === "advanced" || doneStatus === "completed");
      assert.equal(stepRow().status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("a genuine internal failure during a delegated fail surfaces as SERVICE, not blocked", async () => {
    const st = createIsolatedState("brk-svc-error");
    st.open();
    try {
      st.insertRun();
      st.insertStep({ id: STEP1, status: "pending" });
      const registry = new HostInvocationRegistry();
      // Large delay so the delegated submitFail sits inside its service delay
      // (AFTER the broker's fresh readClaim resolved) when we delete the row.
      const { wire, broker } = startBroker({ invocationId: INV_A, registry, delayMs: 1200 });
      await hello(wire, broker, INV_A);

      const claim = await sendReq(wire, "s1", "step.claim", { agentId: bindingFor(INV_A).agentId, runId: `run-${RUN}` }, "s-claim");
      assert.equal(claim.ok, true);

      // The authoritative step row vanishes mid-flight (host anomaly) while
      // the fail is delegated. This is NOT an authority refusal and must NOT
      // come back as an ordinary blocked outcome: failStep throws the native
      // "Step not found" hard error, the adapter rethrows it, and the broker
      // surfaces it on its SERVICE error channel.
      const pending = sendReq(wire, "s2", "step.fail", { stepId: `step-${STEP1}`, reason: "row vanished" }, "s-fail");
      await new Promise((r) => setTimeout(r, 1800)); // inside submitFail's service delay
      getDb().prepare("DELETE FROM steps WHERE id = ?").run(STEP1);

      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(result.code, "SERVICE");
      assert.match(result.message ?? "", /Step not found/);
    } finally {
      st.dispose(stickyEnv);
    }
  });
});

describe("real broker + real adapter IDLE terminal revocation (MTLK-BRIDGE-CLOSE)", () => {
  /**
   * Rig for one terminal-lifetime scenario: fresh isolated DB with a pending
   * step, a shared registry, and a real broker A whose invocation was admitted
   * and handshaken. The rig leaves A idle (no request ever issued) so the test
   * decides when the terminal event happens — before first claim or after a
   * settled claim.
   */
  function rigA() {
    const st = createIsolatedState("brcl-idle");
    st.open();
    st.insertRun();
    st.insertStep({ id: STEP1, status: "pending", expects: "STATUS: done" });
    const registry = new HostInvocationRegistry();
    const { wire, broker } = startBroker({ invocationId: INV_A, registry });
    return { st, registry, wire, broker };
  }

  /** Same-invocation adapter instance sharing the registry (post-close reuse attempt). */
  function svcFor(invocationId: string, registry: HostInvocationRegistry): NativeStepServices {
    return new NativeStepServices({
      binding: bindingFor(invocationId),
      registry,
      workerOwnership: { jobId: JOB_ID, pid: 424242 },
      emit: () => {},
    });
  }

  /** Fresh successor (same run/agent/job, distinct invocation) claims and completes. */
  async function successorCompletes(registry: HostInvocationRegistry): Promise<void> {
    const { wire: wireB, broker: brokerB } = startBroker({ invocationId: INV_B, registry });
    await hello(wireB, brokerB, INV_B);
    const claimB = await sendReq(wireB, "b1", "step.claim", { agentId: bindingFor(INV_B).agentId, runId: `run-${RUN}` }, "b-claim");
    assert.equal(claimB.ok, true, `successor claim must succeed: ${claimB.message ?? ""}`);
    assert.equal((claimB.payload as { claim: { found: boolean } }).claim.found, true);
    const doneB = await sendReq(
      wireB,
      "b2",
      "step.complete",
      { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: B" },
      "b-complete",
    );
    assert.equal(doneB.ok, true);
    const doneStatus = (doneB.payload as { complete: { status: string } }).complete.status;
    assert.ok(doneStatus === "advanced" || doneStatus === "completed", `status ${doneStatus}`);
  }

  it("host close() of an IDLE invocation (before first claim) revokes adapter authority: same-identity claim refused without mutation; fresh successor completes", async () => {
    const { st, registry, wire, broker } = rigA();
    try {
      await hello(wire, broker, INV_A);
      assert.equal(registry.getAdmission(INV_A)?.state, "admitted");
      // No request was ever issued: the invocation is idle when the host closes.
      await broker.close();
      await broker.closed;
      // The broker's terminal close synchronously drove the adapter seam: the
      // registry admission is terminally revoked (not just lease-less).
      assert.equal(registry.getAdmission(INV_A)?.state, "revoked", "idle host close must revoke the admission");
      assert.equal(registry.getLeaseByInvocation(INV_A), undefined);
      // The same revoked identity cannot be re-admitted or claim, even through
      // a fresh adapter instance sharing the registry.
      assert.equal(
        registry.admitInvocation({ invocationId: INV_A, runId: bindingFor(INV_A).runId, agentId: bindingFor(INV_A).agentId, jobId: bindingFor(INV_A).jobId }).ok,
        false,
      );
      const svcA2 = svcFor(INV_A, registry);
      const refused = await svcA2.claim(bindingFor(INV_A));
      assert.equal(refused.found, false, "same-identity claim after idle close must be refused");
      const r = stepRow();
      assert.equal(r.status, "pending", "refused claim must not mutate the row");
      assert.equal(r.claim_job_id, null);
      assert.equal(
        fs.existsSync(path.join(process.env.TAMANDUA_STATE_DIR!, "events", `${RUN}.jsonl`))
          ? fs.readFileSync(path.join(process.env.TAMANDUA_STATE_DIR!, "events", `${RUN}.jsonl`), "utf-8").split("\n").filter((l) => l.includes('"event":"step.running"')).length
          : 0,
        0,
        "no step.running event for the closed invocation",
      );
      await successorCompletes(registry);
      assert.equal(stepRow().status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("host cancel-all of an IDLE invocation (before first claim) revokes adapter authority: same-identity claim/mutation refused; fresh successor completes", async () => {
    const { st, registry, wire, broker } = rigA();
    try {
      await hello(wire, broker, INV_A);
      // Host cancels the whole invocation while it is idle (no request in
      // flight): the seam must fire synchronously on the no-target cancel.
      broker.cancelRequest();
      assert.equal(registry.getAdmission(INV_A)?.state, "revoked", "idle host cancel-all must revoke the admission");
      const svcA2 = svcFor(INV_A, registry);
      const refused = await svcA2.claim(bindingFor(INV_A));
      assert.equal(refused.found, false);
      const stale = await svcA2.submitCompletion(bindingFor(INV_A), "never-held-claim", STEP1, "STATUS: done\nCHANGES: late");
      assert.equal(stale.status, "blocked");
      assert.equal(stale.mutated, false);
      const r = stepRow();
      assert.equal(r.status, "pending");
      await broker.close();
      await broker.closed;
      await successorCompletes(registry);
      assert.equal(stepRow().status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("guest EOF of an IDLE invocation (before first claim) revokes adapter authority: same-identity claim refused; fresh successor completes", async () => {
    const { st, registry, wire, broker } = rigA();
    try {
      await hello(wire, broker, INV_A);
      wire.fromGuest.end();
      await broker.closed;
      assert.equal(registry.getAdmission(INV_A)?.state, "revoked", "idle guest EOF must revoke the admission");
      const svcA2 = svcFor(INV_A, registry);
      const refused = await svcA2.claim(bindingFor(INV_A));
      assert.equal(refused.found, false);
      const r = stepRow();
      assert.equal(r.status, "pending");
      await broker.close();
      await successorCompletes(registry);
      assert.equal(stepRow().status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("host close AFTER a settled claim terminally revokes the invocation: stale same-identity mutation refused; successor adopts the running row", async () => {
    const st = createIsolatedState("brcl-settled");
    st.open();
    try {
      st.insertRun();
      st.insertStep({ id: STEP1, status: "pending", expects: "STATUS: done" });
      const registry = new HostInvocationRegistry();
      const { wire: wireA, broker: brokerA } = startBroker({ invocationId: INV_A, registry });
      await hello(wireA, brokerA, INV_A);
      const claimA = await sendReq(wireA, "a1", "step.claim", { agentId: bindingFor(INV_A).agentId, runId: `run-${RUN}` }, "a-claim");
      assert.equal(claimA.ok, true);
      assert.equal((claimA.payload as { claim: { found: boolean } }).claim.found, true);
      assert.equal(stepRow().status, "running");
      const heldA = registry.getLeaseByInvocation(INV_A);
      assert.ok(heldA, "A must hold the claim lease after the settled claim");

      // A's claim request settled; the invocation now sits idle. Host close()
      // must terminally revoke it — even though no request is in flight.
      await brokerA.close();
      await brokerA.closed;
      assert.equal(registry.getAdmission(INV_A)?.state, "revoked");
      assert.equal(registry.getLeaseByInvocation(INV_A), undefined, "close drops the settled lease too");

      // Stale same-identity mutation is refused at the adapter (no DB change);
      // the already-committed truthful claim row is untouched.
      const svcA2 = svcFor(INV_A, registry);
      const stale = await svcA2.submitCompletion(bindingFor(INV_A), heldA.claimId, STEP1, "STATUS: done\nCHANGES: late A");
      assert.equal(stale.status, "blocked");
      assert.equal(stale.mutated, false);
      const r = stepRow();
      assert.equal(r.status, "running");
      assert.equal(r.output, null);

      await successorCompletes(registry);
      assert.equal(stepRow().status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("a REFUSED (malformed) HELLO terminally revokes the pre-admitted invocation: fail-closed at the registry; fresh successor completes", async () => {
    const { st, registry, wire, broker } = rigA();
    try {
      // Host admission precedes any guest frame (controller lifecycle), so the
      // registry holds the invocation ADMITTED when the guest sends a malformed
      // HELLO (missing helper build + pack layout metadata). The strict
      // handshake must refuse it AND the refusal must terminally revoke the
      // pre-admitted invocation through the seam — Requirement C's fail-closed
      // behavior made explicit at the registry level, not only at the broker.
      assert.equal(registry.getAdmission(INV_A)?.state, "admitted");
      wire.send({ kind: "hello", protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION });
      const ready = await broker.ready;
      assert.equal(ready.ok, false, "malformed HELLO must be refused, not accepted");
      assert.match(ready.reason ?? "", /helperBuildVersion must be a nonempty string/);
      await broker.closed;
      assert.equal(broker.state(), "canceled");

      // The refuseHandshake -> closeInternal path drove the adapter seam: the
      // pre-admitted registry admission is terminally revoked.
      assert.equal(registry.getAdmission(INV_A)?.state, "revoked", "refused handshake must revoke the admission");
      assert.equal(registry.getLeaseByInvocation(INV_A), undefined);
      // The revoked identity cannot be re-admitted, even by a fresh adapter
      // instance sharing the registry.
      assert.equal(
        registry.admitInvocation({ invocationId: INV_A, runId: bindingFor(INV_A).runId, agentId: bindingFor(INV_A).agentId, jobId: bindingFor(INV_A).jobId }).ok,
        false,
      );
      const svcA2 = svcFor(INV_A, registry);
      const refused = await svcA2.claim(bindingFor(INV_A));
      assert.equal(refused.found, false, "same-identity claim after refused handshake must be refused");
      const r = stepRow();
      assert.equal(r.status, "pending", "refused claim must not mutate the row");
      assert.equal(r.claim_job_id, null);
      assert.equal(
        fs.existsSync(path.join(process.env.TAMANDUA_STATE_DIR!, "events", `${RUN}.jsonl`))
          ? fs.readFileSync(path.join(process.env.TAMANDUA_STATE_DIR!, "events", `${RUN}.jsonl`), "utf-8").split("\n").filter((l) => l.includes('"event":"step.running"')).length
          : 0,
        0,
        "no step.running event for the refused-handshake invocation",
      );

      // Non-vacuous positive control: a FRESH host-admitted successor claims
      // and completes the untouched pending step.
      await successorCompletes(registry);
      assert.equal(stepRow().status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });
});

describe("real broker + real adapter revocation (MTLK-STEP-REVOKE)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * Read the response for ONE request id while skipping unrelated frames
   * (hello-ack, earlier requests). Frames are consumed strictly in wire order,
   * so two in-flight requests never steal each other's responses.
   */
  async function readFor(wire: Wire, id: string, timeoutMs = 8000): Promise<ReqOutcome> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`wire frame timeout waiting for ${id}`);
      const frame = await wire.next(Math.min(remaining, 8000));
      if (frame.kind === "res" && frame.id === id) {
        return { ok: true, payload: frame.payload as Record<string, unknown> };
      }
      if (frame.kind === "err" && (frame.id === undefined || frame.id === id)) {
        return { ok: false, code: frame.code as string, message: frame.message as string };
      }
    }
  }

  it("host revocation while a FIRST claim is queued behind another request: claim never mutates; fresh successor completes", async () => {
    const st = createIsolatedState("brk-queued-claim");
    st.open();
    try {
      st.insertRun();
      st.insertStep({ id: STEP1, status: "pending", expects: "STATUS: done" });
      const registry = new HostInvocationRegistry();
      // A is slow (every delegated op waits in the adapter service delay) so
      // the claim request sits QUEUED behind the active peek.
      const { wire: wireA, broker: brokerA } = startBroker({ invocationId: INV_A, registry, delayMs: 400 });
      await hello(wireA, brokerA, INV_A);

      const params = { agentId: bindingFor(INV_A).agentId, runId: `run-${RUN}` };
      wireA.send({ kind: "req", id: "p1", op: "step.peek", params });
      wireA.send({ kind: "req", id: "c1", op: "step.claim", params, opKey: "c1-op" });
      await sleep(80); // peek active inside its service delay; claim is queued

      // The host controller terminally revokes A while the claim is queued
      // (broker cancel/close of the invocation lifecycle).
      assert.equal(registry.revokeInvocation(INV_A, "host canceled queued invocation"), 0);
      assert.equal(registry.getAdmission(INV_A)?.state, "revoked");

      const peekRes = await readFor(wireA, "p1");
      assert.equal(peekRes.ok, true);
      assert.equal((peekRes.payload as { peek: string }).peek, "NO_WORK", "revoked invocation is not told about work");

      // The queued claim dispatches AFTER the peek: the adapter's lifecycle
      // gate refuses BEFORE claimStep — no DB mutation, no event.
      const claimRes = await readFor(wireA, "c1");
      assert.equal(claimRes.ok, true);
      const claimPayload = (claimRes.payload as { claim: { found: boolean } }).claim;
      assert.equal(claimPayload.found, false);
      const r = stepRow();
      assert.equal(r.status, "pending");
      assert.equal(r.claim_job_id, null);
      assert.equal(
        fs.existsSync(path.join(process.env.TAMANDUA_STATE_DIR!, "events", `${RUN}.jsonl`))
          ? fs.readFileSync(path.join(process.env.TAMANDUA_STATE_DIR!, "events", `${RUN}.jsonl`), "utf-8").split("\n").filter((l) => l.includes('"event":"step.running"')).length
          : 0,
        0,
        "no step.running event for the revoked invocation",
      );

      // Positive control: a FRESH host-admitted successor broker B (same
      // run/agent/job) claims and completes the untouched pending step.
      const { wire: wireB, broker: brokerB } = startBroker({ invocationId: INV_B, registry });
      await hello(wireB, brokerB, INV_B);
      const claimB = await sendReq(wireB, "b1", "step.claim", { agentId: bindingFor(INV_B).agentId, runId: `run-${RUN}` }, "b-claim");
      assert.equal(claimB.ok, true);
      assert.equal((claimB.payload as { claim: { found: boolean } }).claim.found, true);
      const doneB = await sendReq(
        wireB,
        "b2",
        "step.complete",
        { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: B" },
        "b-complete",
      );
      assert.equal(doneB.ok, true);
      const doneStatus = (doneB.payload as { complete: { status: string } }).complete.status;
      assert.ok(doneStatus === "advanced" || doneStatus === "completed");
      assert.equal(stepRow().status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("guest cancellation of an in-flight completion drives revokeInvocationAuthority: no mutation, successor completes", async () => {
    const st = createIsolatedState("brk-guest-cancel");
    st.open();
    try {
      st.insertRun();
      st.insertStep({ id: STEP1, status: "pending", expects: "STATUS: done" });
      const registry = new HostInvocationRegistry();
      const { wire: wireA, broker: brokerA } = startBroker({ invocationId: INV_A, registry, delayMs: 600 });
      const { wire: wireB, broker: brokerB } = startBroker({ invocationId: INV_B, registry });
      await hello(wireA, brokerA, INV_A);
      await hello(wireB, brokerB, INV_B);

      const claimA = await sendReq(wireA, "a1", "step.claim", { agentId: bindingFor(INV_A).agentId, runId: `run-${RUN}` }, "a-claim");
      assert.equal(claimA.ok, true);
      assert.equal((claimA.payload as { claim: { found: boolean } }).claim.found, true);
      assert.equal(stepRow().status, "running");

      // Fire a completion; it is now inside an async adapter service wait
      // (validateCompletion's delay) when the GUEST cancels it via ctrl.
      const pending = sendReq(
        wireA,
        "a2",
        "step.complete",
        { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: A" },
        "a-complete",
      );
      await sleep(800); // inside validateCompletion's service delay
      wireA.send({ kind: "ctrl", op: "cancel", id: "a2" });

      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(result.code, "CANCELED");

      // The broker's cancellation invoked the adapter seam: A is terminally
      // revoked in the registry (admission state, not just lease).
      assert.equal(registry.getAdmission(INV_A)?.state, "revoked");
      assert.equal(registry.getLeaseByInvocation(INV_A), undefined);
      await sleep(1400); // let any late delegated continuation settle

      // The canceled completion never mutated the row.
      const r = stepRow();
      assert.equal(r.status, "running");
      assert.equal(r.output, null);
      const eventsFile = path.join(process.env.TAMANDUA_STATE_DIR!, "events", `${RUN}.jsonl`);
      const events = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf-8").split("\n").filter((l) => l.includes('"event":"step.done"')) : [];
      assert.equal(events.length, 0, "no step.done from the canceled completion");

      // Fresh successor B adopts the running claim and completes normally.
      const claimB = await sendReq(wireB, "b1", "step.claim", { agentId: bindingFor(INV_B).agentId, runId: `run-${RUN}` }, "b-claim");
      assert.equal(claimB.ok, true);
      const doneB = await sendReq(
        wireB,
        "b2",
        "step.complete",
        { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: B" },
        "b-complete",
      );
      assert.equal(doneB.ok, true);
      const doneStatus = (doneB.payload as { complete: { status: string } }).complete.status;
      assert.ok(doneStatus === "advanced" || doneStatus === "completed");
      assert.equal(stepRow().status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("host close() and guest EOF revoke adapter authority: in-flight mutations can never land afterwards", async () => {
    const st = createIsolatedState("brk-close-eof");
    st.open();
    try {
      st.insertRun();
      st.insertStep({ id: STEP1, status: "pending", expects: "STATUS: done" });
      const registry = new HostInvocationRegistry();

      // ── host close() while a completion is inside the adapter wait ──
      const { wire: wireA, broker: brokerA } = startBroker({ invocationId: INV_A, registry, delayMs: 700 });
      await hello(wireA, brokerA, INV_A);
      const claimA = await sendReq(wireA, "a1", "step.claim", { agentId: bindingFor(INV_A).agentId, runId: `run-${RUN}` }, "a-claim");
      assert.equal(claimA.ok, true);
      const pending = sendReq(
        wireA,
        "a2",
        "step.complete",
        { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: A" },
        "a-complete",
      );
      await sleep(1000); // inside the delegated wait
      await brokerA.close();
      const closeResult = await pending;
      assert.equal(closeResult.ok, false);
      assert.equal(registry.getAdmission(INV_A)?.state, "revoked", "host close revokes adapter authority");
      await sleep(1200); // late continuation settles
      let r = stepRow();
      assert.equal(r.status, "running", "close-revoked completion must not mutate");
      assert.equal(r.output, null);

      // ── guest pipe EOF while a completion is inside the adapter wait ──
      const { wire: wireC, broker: brokerC } = startBroker({ invocationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", registry, delayMs: 700 });
      await hello(wireC, brokerC, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
      const claimC = await sendReq(wireC, "c1", "step.claim", { agentId: bindingFor(INV_A).agentId, runId: `run-${RUN}` }, "c-claim");
      assert.equal(claimC.ok, true);
      const pendingC = sendReq(
        wireC,
        "c2",
        "step.complete",
        { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: C" },
        "c-complete",
      );
      await sleep(1000);
      wireC.fromGuest.end(); // EOF
      await brokerC.closed;
      const eofResult = await pendingC;
      assert.equal(eofResult.ok, false);
      assert.equal(
        registry.getAdmission("dddddddd-dddd-4ddd-8ddd-dddddddddddd")?.state,
        "revoked",
        "guest EOF revokes adapter authority",
      );
      await sleep(1200);
      r = stepRow();
      assert.equal(r.status, "running", "EOF-revoked completion must not mutate");
      assert.equal(r.output, null);

      // Fresh successor completes.
      const { wire: wireB, broker: brokerB } = startBroker({ invocationId: INV_B, registry });
      await hello(wireB, brokerB, INV_B);
      const claimB = await sendReq(wireB, "b1", "step.claim", { agentId: bindingFor(INV_B).agentId, runId: `run-${RUN}` }, "b-claim");
      assert.equal(claimB.ok, true);
      const doneB = await sendReq(
        wireB,
        "b2",
        "step.complete",
        { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: B" },
        "b-complete",
      );
      assert.equal(doneB.ok, true);
      assert.equal(stepRow().status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("service deadline revokes adapter authority: a late mutation inside the wait can never commit", async () => {
    const st = createIsolatedState("brk-deadline");
    st.open();
    try {
      st.insertRun();
      st.insertStep({ id: STEP1, status: "pending", expects: "STATUS: done" });
      const registry = new HostInvocationRegistry();
      const binding = bindingFor(INV_A);
      registry.admitInvocation({ invocationId: INV_A, runId: binding.runId, agentId: binding.agentId, jobId: binding.jobId });
      const inner = new NativeStepServices({
        binding,
        registry,
        workerOwnership: { jobId: JOB_ID, pid: 424242 },
        emit: () => {},
      });
      // Only the guarded MUTATION is slowed (far beyond the broker's finite
      // service deadline) so the deadline fires while submitCompletion is
      // genuinely inside its async wait; everything else stays fast so the
      // claim itself cannot time out.
      const services: AuthoritativeStepServices = {
        readClaim: (b) => inner.readClaim(b),
        peek: (b) => inner.peek(b),
        claim: (b) => inner.claim(b),
        validateCompletion: (b, s, o) => inner.validateCompletion(b, s, o),
        submitCompletion: async (b, c, s, o) => {
          await new Promise((r) => setTimeout(r, 900));
          return inner.submitCompletion(b, c, s, o);
        },
        submitFail: async (b, c, s, r) => {
          await new Promise((res) => setTimeout(res, 900));
          return inner.submitFail(b, c, s, r);
        },
        revokeInvocationAuthority: (id, reason) => inner.revokeInvocationAuthority(id, reason),
        emit: (e) => inner.emit(e),
      };
      const wire = new Wire();
      const broker = createHostBroker({
        binding,
        services,
        pipe: wire.brokerPipe,
        handshakeTimeoutMs: 3000,
        serviceTimeoutMs: 150,
        shutdownFlushMs: 200,
      });
      openHandles.push({ wire, broker });
      await hello(wire, broker, INV_A);

      const claim = await sendReq(wire, "d1", "step.claim", { agentId: binding.agentId, runId: `run-${RUN}` }, "d-claim");
      assert.equal(claim.ok, true);
      const pending = sendReq(
        wire,
        "d2",
        "step.complete",
        { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: late" },
        "d-complete",
      );
      const deadline = await pending;
      assert.equal(deadline.ok, false);
      assert.equal(deadline.code, "DEADLINE");
      // The deadline revoked the invocation through the seam (mutating op).
      assert.equal(registry.getAdmission(INV_A)?.state, "revoked");
      assert.equal(broker.state(), "canceled");
      await sleep(1600); // the 900ms guarded-mutation wait resolves long after revocation
      const r = stepRow();
      assert.equal(r.status, "running", "late deadline-revoked completion must not mutate");
      assert.equal(r.output, null);
      // A new mutation on the canceled invocation is refused broker-side too.
      const late = await sendReq(
        wire,
        "d3",
        "step.complete",
        { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: again" },
        "d-complete-2",
      );
      assert.equal(late.ok, false);
      assert.equal(late.code, "INVOCATION_STATE");

      // Fresh successor B completes the row.
      const { wire: wireB, broker: brokerB } = startBroker({ invocationId: INV_B, registry });
      await hello(wireB, brokerB, INV_B);
      const claimB = await sendReq(wireB, "b1", "step.claim", { agentId: bindingFor(INV_B).agentId, runId: `run-${RUN}` }, "b-claim");
      assert.equal(claimB.ok, true);
      const doneB = await sendReq(
        wireB,
        "b2",
        "step.complete",
        { stepId: `step-${STEP1}`, output: "STATUS: done\nCHANGES: B" },
        "b-complete",
      );
      assert.equal(doneB.ok, true);
      assert.equal(stepRow().status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });
});
