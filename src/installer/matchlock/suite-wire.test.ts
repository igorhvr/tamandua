/**
 * MTLK-SUITE-WIRE focused gate (PARALLEL lane — no child spawns).
 *
 * Covers, all in-process on isolated temp roots/random sockets:
 *   - the canonical suite bridge request validator (validateSuiteBridgeParams)
 *     at both boundaries: unknown ops, malformed fields, oversized payloads,
 *     nonfinite numerics, unpermitted events, non-canonical namespaces;
 *   - the host suite transport/services bridge (createHostSuiteBridge): real
 *     HostSuiteStore (file) + real HostInvocationRegistry; per-op authority,
 *     missing-lease/never-admitted refusals, terminal revokeAuthority;
 *   - the REAL end-to-end seam IN PROCESS: GuestSuiteSocketTransport → guest
 *     bridge service (suite-enabled) → host broker → injected suite bridge →
 *     real host suite SQLite store. Lookup/claim/record (duplicate-exact
 *     replay vs mismatched-retry refusal)/lookup/duration-history/event are
 *     driven in one round trip with namespace echo; suite.release is driven
 *     in its own seam case (exact-token release released:true + namespace
 *     echo, mismatched/foreign-token release refused DENIED); absent-suite
 *     refusals and idle-close terminal revocation of host suite authority are
 *     covered as well.
 *
 * No live daemon/models/VMs; labelled NOT actualVM. Real tiny SQLite store +
 * real registry; guard isolation via temp HOME/state.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { createTempHome } from "../../../tests/helpers/test-env.ts";
import {
  GUEST_PACK_LAYOUT_VERSION,
  SUITE_BRIDGE_OPS,
  isSuiteBridgeOp,
  mutatingSuiteBridgeOp,
  validateSuiteBridgeParams,
} from "../../../dist/installer/matchlock/guest-protocol.js";
import { createHostBroker } from "../../../dist/installer/matchlock/broker.js";
import type { HostBinding } from "../../../dist/installer/matchlock/broker-services.js";
import { FakeStepServices } from "../../../dist/installer/matchlock/broker-test-services.js";
import { startGuestBridgeService } from "../../../dist/installer/matchlock/guest-service.js";
import { GuestSuiteSocketTransport } from "../../../dist/installer/matchlock/suite-socket-transport.js";
import {
  createHostSuiteBridge,
  type HostSuiteBridgeScope,
} from "../../../dist/installer/matchlock/suite-host-bridge.js";
import { HostInvocationRegistry } from "../../../dist/installer/matchlock/native-step-invocations.js";
import { openHostSuiteStore, type HostSuiteStore } from "../../../dist/installer/matchlock/host-suite-store.js";
import {
  guestSuiteNamespaceId,
  type GuestSuiteNamespace,
  type GuestSuiteRecordResult,
} from "../../../dist/installer/matchlock/guest-suite-contract.js";

const NS_A: GuestSuiteNamespace = {
  imageContentId: "sha256:wire0123456789abcdef0123456789abcdef0123456789abcdef",
  guestPlatform: "linux/amd64",
  helperContract: "guest-helper-wire+suite-v1",
  compatibilityFingerprint: "wire-fp-001",
};
const NS_A_ID = guestSuiteNamespaceId(NS_A);
const BV = "20260909T000000Z_wire";
const AGENT = "wire-agent";
const JOB = "job-wire-1";
const RUN = "run-wire-1";
const STEP = "suite-step-1";
const ORIGIN = "/work/suite-fixture";

const ROOT = createTempHome("suite-wire-");
const STORE_PATH = join(ROOT.root, "host-suite.sqlite");
let store: HostSuiteStore;

function bindings(invocationId: string, registry: HostInvocationRegistry): {
  bridgeScope: HostSuiteBridgeScope;
  brokerBinding: HostBinding;
} {
  const bridgeScope: HostSuiteBridgeScope = {
    invocationId,
    runId: RUN,
    agentId: AGENT,
    jobId: JOB,
    registry,
    store,
    namespace: NS_A,
    admittedRoots: [ORIGIN],
  };
  const brokerBinding: HostBinding = {
    runId: RUN,
    invocationId,
    agentId: AGENT,
    jobId: JOB,
    role: "developer",
    admittedRoots: [ORIGIN],
    helperProtocolVersion: `${BV}+p1`,
    helperBuildVersion: BV,
  };
  return { bridgeScope, brokerBinding };
}

function admitAndLease(registry: HostInvocationRegistry, invocationId: string): string {
  const admitted = registry.admitInvocation({ invocationId, runId: RUN, agentId: AGENT, jobId: JOB });
  assert.deepEqual(admitted, { ok: true });
  const stepRowId = randomUUID();
  const claimId = `claim-${stepRowId}`;
  const registered = registry.register({
    stepRowId,
    stepId: STEP,
    runId: RUN,
    agentId: AGENT,
    jobId: JOB,
    invocationId,
    claimId,
    rowToken: `rowtok-${stepRowId}`,
    claimedAtMs: Date.now(),
  });
  assert.deepEqual(registered, { ok: true });
  return stepRowId;
}

const treeHash = "a".repeat(40); // synthetic committed tree (fixture-level key)
function cmdHash(cmd: string): string {
  // Local SHA-256 (keeps this parallel file free of child_process imports).
  return createHash("sha256").update(cmd, "utf-8").digest("hex");
}

// ── canonical wire validator ────────────────────────────────────────────

function nsParams(namespace: GuestSuiteNamespace = NS_A): Record<string, unknown> {
  return { namespace };
}

describe("suite-wire: canonical bridge request validator", () => {
  it("accepts the six well-formed op request shapes", () => {
    const lookup = { ...nsParams(), originRepo: ORIGIN, treeHash, cmdHash: cmdHash("echo x") };
    assert.equal(validateSuiteBridgeParams("suite.lookup", lookup), null);
    const claim = { ...nsParams(), originRepo: ORIGIN, treeHash, cmdHash: cmdHash("echo x"), ownerToken: "tok-1", runId: RUN, stepId: STEP };
    assert.equal(validateSuiteBridgeParams("suite.claim", claim), null);
    const record = {
      ...nsParams(),
      originRepo: ORIGIN,
      treeHash,
      cmdHash: cmdHash("echo x"),
      cmdDisplay: "echo x",
      exitCode: 0,
      durationMs: 5,
      logTail: null,
      runId: RUN,
      stepId: STEP,
      force: false,
      startedAt: "2026-09-09T00:00:00.000Z",
    };
    assert.equal(validateSuiteBridgeParams("suite.record", record), null);
    const release = { ...nsParams(), originRepo: ORIGIN, treeHash, cmdHash: cmdHash("echo x"), ownerToken: "tok-1" };
    assert.equal(validateSuiteBridgeParams("suite.release", release), null);
    const dh = { ...nsParams(), originRepo: ORIGIN, cmdHash: cmdHash("echo x") };
    assert.equal(validateSuiteBridgeParams("suite.duration-history", dh), null);
    const event = { ...nsParams(), event: "suite.execute_started", runId: RUN, stepId: STEP };
    assert.equal(validateSuiteBridgeParams("suite.event", event), null);
  });

  it("rejects an unknown operation and non-object params", () => {
    assert.equal(validateSuiteBridgeParams("suite.owner_release", { ...nsParams(), originRepo: ORIGIN })?.code, "UNSUPPORTED");
    assert.equal(validateSuiteBridgeParams("step.peek", { ...nsParams(), originRepo: ORIGIN })?.code, "UNSUPPORTED");
    assert.equal(validateSuiteBridgeParams("suite.lookup", "nope")?.code, "BAD_REQUEST");
    assert.equal(validateSuiteBridgeParams("suite.lookup", [])?.code, "BAD_REQUEST");
  });

  it("rejects malformed/oversized namespaces without mutating the caller", () => {
    const missing = { originRepo: ORIGIN, treeHash, cmdHash: cmdHash("x") };
    assert.equal(validateSuiteBridgeParams("suite.lookup", missing)?.code, "BAD_REQUEST");
    const oversized = { namespace: { ...NS_A, imageContentId: "x".repeat(300) }, originRepo: ORIGIN, treeHash, cmdHash: cmdHash("x") };
    assert.equal(validateSuiteBridgeParams("suite.lookup", oversized)?.code, "OVERSIZED");
    const padded = { namespace: { ...NS_A, imageContentId: ` ${NS_A.imageContentId} ` }, originRepo: ORIGIN, treeHash, cmdHash: cmdHash("x") };
    assert.equal(validateSuiteBridgeParams("suite.lookup", padded)?.code, "BAD_REQUEST");
    assert.equal((padded.namespace as GuestSuiteNamespace).imageContentId, ` ${NS_A.imageContentId} `, "caller object must not be mutated");
  });

  it("rejects oversized key fields, bad hashes and unbounded ids", () => {
    const bigOrigin = { ...nsParams(), originRepo: "x".repeat(5000), treeHash, cmdHash: cmdHash("x") };
    assert.equal(validateSuiteBridgeParams("suite.lookup", bigOrigin)?.code, "OVERSIZED");
    const badTree = { ...nsParams(), originRepo: ORIGIN, treeHash: "abc", cmdHash: cmdHash("x") };
    assert.equal(validateSuiteBridgeParams("suite.claim", { ...badTree, ownerToken: "t" })?.code, "BAD_REQUEST");
    const badCmd = { ...nsParams(), originRepo: ORIGIN, treeHash, cmdHash: "not64hex" };
    assert.equal(validateSuiteBridgeParams("suite.duration-history", badCmd)?.code, "BAD_REQUEST");
    const bigToken = { ...nsParams(), originRepo: ORIGIN, treeHash, cmdHash: cmdHash("x"), ownerToken: "t".repeat(300) };
    assert.equal(validateSuiteBridgeParams("suite.release", bigToken)?.code, "OVERSIZED");
  });

  it("rejects malformed record payloads (nonfinite/negative/oversized)", () => {
    const base = {
      ...nsParams(),
      originRepo: ORIGIN,
      treeHash,
      cmdHash: cmdHash("echo x"),
      cmdDisplay: "echo x",
      durationMs: 1,
      logTail: null,
      runId: RUN,
      stepId: STEP,
      force: false,
      startedAt: "2026-09-09T00:00:00.000Z",
    };
    assert.equal(validateSuiteBridgeParams("suite.record", { ...base, exitCode: Number.NaN })?.code, "BAD_REQUEST");
    assert.equal(validateSuiteBridgeParams("suite.record", { ...base, exitCode: 1.5 })?.code, "BAD_REQUEST");
    // Refined host boundary parity: a real exit code is an integer in
    // [0, 255] (POSIX status); out-of-range integers are refused here too so
    // the guest-service and host-broker boundaries agree with the host suite
    // service (run32 3556b98 alignment).
    assert.equal(validateSuiteBridgeParams("suite.record", { ...base, exitCode: -1 })?.code, "BAD_REQUEST");
    assert.equal(validateSuiteBridgeParams("suite.record", { ...base, exitCode: 256 })?.code, "BAD_REQUEST");
    assert.equal(validateSuiteBridgeParams("suite.record", { ...base, exitCode: 0 }), null);
    assert.equal(validateSuiteBridgeParams("suite.record", { ...base, exitCode: 255 }), null);
    assert.equal(validateSuiteBridgeParams("suite.record", { ...base, exitCode: 0, durationMs: Number.NaN })?.code, "BAD_REQUEST");
    assert.equal(validateSuiteBridgeParams("suite.record", { ...base, exitCode: 0, durationMs: -5 })?.code, "BAD_REQUEST");
    assert.equal(validateSuiteBridgeParams("suite.record", { ...base, exitCode: 0, durationMs: 1.5 })?.code, "BAD_REQUEST");
    assert.equal(validateSuiteBridgeParams("suite.record", { ...base, exitCode: 0, durationMs: 1, cmdDisplay: "c".repeat(300) })?.code, "OVERSIZED");
    assert.equal(validateSuiteBridgeParams("suite.record", { ...base, exitCode: 0, durationMs: 1, logTail: "z".repeat(21 * 1024) })?.code, "OVERSIZED");
    assert.equal(validateSuiteBridgeParams("suite.record", { ...base, exitCode: 0, durationMs: 1, startedAt: "yesterday" })?.code, "BAD_REQUEST");
  });

  it("rejects unpermitted suite events and wrong field types", () => {
    const badEvent = { ...nsParams(), event: "suite.owner_release", runId: RUN };
    assert.equal(validateSuiteBridgeParams("suite.event", badEvent)?.code, "UNSUPPORTED");
    const noRun = { ...nsParams(), event: "suite.cache_hit" };
    assert.equal(validateSuiteBridgeParams("suite.event", noRun)?.code, "BAD_REQUEST");
  });

  it("exposes the six-op vocabulary and mutating classification", () => {
    assert.deepEqual([...SUITE_BRIDGE_OPS].sort(), [
      "suite.claim",
      "suite.duration-history",
      "suite.event",
      "suite.lookup",
      "suite.record",
      "suite.release",
    ].sort());
    assert.ok(isSuiteBridgeOp("suite.lookup"));
    assert.ok(!isSuiteBridgeOp("step.claim"));
    assert.ok(mutatingSuiteBridgeOp("suite.record"));
    assert.ok(!mutatingSuiteBridgeOp("suite.lookup"));
  });
});

// ── host suite bridge (unit) ────────────────────────────────────────────

describe("suite-wire: host suite bridge authority + lifecycle", () => {
  let registry: HostInvocationRegistry;
  let invocationId: string;
  let bridge: ReturnType<typeof createHostSuiteBridge>;

  before(() => {
    store = openHostSuiteStore(STORE_PATH);
    registry = new HostInvocationRegistry();
    invocationId = randomUUID();
    admitAndLease(registry, invocationId);
    const { bridgeScope } = bindings(invocationId, registry);
    bridge = createHostSuiteBridge(bridgeScope);
  });

  it("serves a lookup under the host-admitted namespace echo", async () => {
    const result = await bridge.serve("suite.lookup", {
      ...nsParams(),
      originRepo: ORIGIN,
      treeHash,
      cmdHash: cmdHash("echo x"),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal((result.value as { namespaceId?: string }).namespaceId, NS_A_ID);
      assert.equal((result.value as { latest?: unknown }).latest, null);
    }
  });

  it("refuses a request whose origin root is not admitted", async () => {
    const result = await bridge.serve("suite.lookup", {
      ...nsParams(),
      originRepo: "/other/path",
      treeHash,
      cmdHash: cmdHash("echo x"),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "DENIED");
  });

  it("refuses when the invocation was never admitted / revoked / holds no lease", async () => {
    const other = new HostInvocationRegistry();
    const { bridgeScope } = bindings(randomUUID(), other);
    const neverAdmitted = createHostSuiteBridge(bridgeScope);
    const denied = await neverAdmitted.serve("suite.lookup", { ...nsParams(), originRepo: ORIGIN, treeHash, cmdHash: cmdHash("x") });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.code, "DENIED");

    const freshReg = new HostInvocationRegistry();
    const inv = randomUUID();
    freshReg.admitInvocation({ invocationId: inv, runId: RUN, agentId: AGENT, jobId: JOB });
    const { bridgeScope: scope2 } = bindings(inv, freshReg);
    const noLease = createHostSuiteBridge(scope2);
    const noLeaseResult = await noLease.serve("suite.lookup", { ...nsParams(), originRepo: ORIGIN, treeHash, cmdHash: cmdHash("x") });
    assert.equal(noLeaseResult.ok, false);
    if (!noLeaseResult.ok) assert.equal(noLeaseResult.code, "DENIED");
  });

  it("terminal revokeAuthority permanently revokes host suite authority", async () => {
    const okBefore = await bridge.serve("suite.duration-history", { ...nsParams(), originRepo: ORIGIN, cmdHash: cmdHash("echo x") });
    assert.equal(okBefore.ok, true);
    bridge.revokeAuthority("test idle close");
    assert.equal(registry.revocationCount, 1);
    const after = await bridge.serve("suite.lookup", { ...nsParams(), originRepo: ORIGIN, treeHash, cmdHash: cmdHash("echo x") });
    assert.equal(after.ok, false);
    if (!after.ok) assert.equal(after.code, "DENIED");
    // A second revokeAuthority notification is a harmless no-op (state terminal).
    bridge.revokeAuthority("again");
    assert.equal(registry.revocationCount, 1);
  });

  it("rejects a host-admitted namespace that was never canonicalized (fail closed)", () => {
    const reg = new HostInvocationRegistry();
    assert.throws(
      () => createHostSuiteBridge({
        invocationId: randomUUID(),
        runId: RUN,
        agentId: AGENT,
        jobId: JOB,
        registry: reg,
        store,
        namespace: { ...NS_A, guestPlatform: " linux/amd64 " },
        admittedRoots: [ORIGIN],
      }),
      /namespace/,
    );
  });
});

// ── real in-process seam: transport → service → broker → suite bridge → store

interface Rig {
  socketPath: string;
  transport: GuestSuiteSocketTransport;
  broker: ReturnType<typeof createHostBroker>;
  registry: HostInvocationRegistry;
  invocationId: string;
  stepRowId: string;
  close: () => Promise<void>;
}

async function startRig(opts: { suiteEnabled: boolean; injectSuiteBridge: boolean }): Promise<Rig> {
  const registry = new HostInvocationRegistry();
  const invocationId = randomUUID();
  const stepRowId = admitAndLease(registry, invocationId);
  const { bridgeScope, brokerBinding } = bindings(invocationId, registry);
  const suiteBridge = opts.injectSuiteBridge ? createHostSuiteBridge(bridgeScope) : undefined;

  // Two independent pipe segments: broker writes into svcIn (service stdin),
  // the service writes into svcOut (broker fromGuest).
  const svcIn = new PassThrough();
  const svcOut = new PassThrough();
  const broker = createHostBroker({
    binding: brokerBinding,
    services: new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] }),
    pipe: { toGuest: svcIn, fromGuest: svcOut },
    handshakeTimeoutMs: 5000,
    serviceTimeoutMs: 8000,
    ...(suiteBridge ? { suite: suiteBridge } : {}),
  });

  const socketDir = join(ROOT.root, `sock-${randomUUID()}`);
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const socketPath = join(socketDir, "bridge.sock");
  const service = await startGuestBridgeService({
    socketPath,
    stdin: svcIn,
    stdout: svcOut,
    stderr: process.stderr,
    helperBuildVersion: BV,
    packLayoutVersion: GUEST_PACK_LAYOUT_VERSION,
    suiteEnabled: opts.suiteEnabled,
    // runId claim is omitted: hello claims must be uuid-form to be accepted
    // by the strict broker handshake, and our fixture ids are arbitrary
    // strings. Invocation/agent claims match the host binding exactly.
    claimedIdentity: { invocationId, agentId: AGENT },
  });
  const ready = await withTimeout(service.ready, 6000, "service ready");
  assert.equal(ready.ok, true, ready.reason);

  const transport = new GuestSuiteSocketTransport({
    socketPath,
    helperBuildVersion: BV,
    namespace: NS_A,
    requestTimeoutMs: 4000,
  });
  return {
    socketPath,
    transport,
    broker,
    registry,
    invocationId,
    stepRowId,
    close: async () => {
      await withTimeout(broker.close(), 4000, "broker close");
      await withTimeout(broker.closed, 4000, "broker closed");
      await withTimeout(service.shutdown(), 4000, "service shutdown");
      store.close();
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

describe("suite-wire: real seam over guest service + host broker + real store", () => {
  it("seam round trip: lookup/claim/record with duplicate-exact replay + mutated-retry refusal, lookup, duration-history, event", async () => {
    store = openHostSuiteStore(STORE_PATH);
    const rig = await startRig({ suiteEnabled: true, injectSuiteBridge: true });
    try {
      const cmd = "echo wired";
      const ch = cmdHash(cmd);
      const tree = treeHash; // fixture-level synthetic committed-tree key
      const lookup0 = await rig.transport.lookup({ originRepo: ORIGIN, treeHash: tree, cmdHash: ch, namespace: NS_A });
      assert.equal(lookup0.ok, true);
      if (lookup0.ok) assert.equal(lookup0.value.latest, null);

      const claim = await rig.transport.claim({
        originRepo: ORIGIN,
        treeHash: tree,
        cmdHash: ch,
        namespace: NS_A,
        ownerToken: "token-wire-1",
        runId: RUN,
        stepId: STEP,
        invocationId: rig.invocationId,
      });
      assert.equal(claim.ok, true);
      if (claim.ok) assert.equal(claim.value.action, "run");

      const startedAt = "2026-09-09T01:00:00.000Z";
      const record = await rig.transport.record({
        originRepo: ORIGIN,
        treeHash: tree,
        cmdHash: ch,
        namespace: NS_A,
        cmdDisplay: cmd,
        exitCode: 0,
        durationMs: 12,
        logTail: "wired output",
        runId: RUN,
        stepId: STEP,
        force: false,
        startedAt,
      });
      assert.equal(record.ok, true);
      if (!record.ok) throw new Error(`record refused: ${record.code}: ${record.message}`);
      const firstId = record.value.id;

      // Exact duplicate record replay returns the ORIGINAL ack, no dup row.
      const replay = await rig.transport.record({
        originRepo: ORIGIN,
        treeHash: tree,
        cmdHash: ch,
        namespace: NS_A,
        cmdDisplay: cmd,
        exitCode: 0,
        durationMs: 12,
        logTail: "wired output",
        runId: RUN,
        stepId: STEP,
        force: false,
        startedAt,
      });
      assert.equal(replay.ok, true);
      if (replay.ok) assert.equal(replay.value.id, firstId);

      // Mutated replay (different payload, same idempotency key) is refused.
      const mutated = await rig.transport.record({
        originRepo: ORIGIN,
        treeHash: tree,
        cmdHash: ch,
        namespace: NS_A,
        cmdDisplay: cmd,
        exitCode: 3,
        durationMs: 99,
        logTail: "changed payload",
        runId: RUN,
        stepId: STEP,
        force: false,
        startedAt,
      });
      assert.equal(mutated.ok, false);
      if (!mutated.ok) assert.equal(mutated.code, "DENIED");

      // Lookup now returns the recorded row under the SAME namespace id.
      const lookup1 = await rig.transport.lookup({ originRepo: ORIGIN, treeHash: tree, cmdHash: ch, namespace: NS_A });
      assert.equal(lookup1.ok, true);
      if (lookup1.ok) {
        assert.equal(lookup1.value.namespaceId, NS_A_ID);
        assert.equal(lookup1.value.latest?.id, firstId);
      }

      const dh = await rig.transport.durationHistory({ originRepo: ORIGIN, cmdHash: ch, namespace: NS_A });
      assert.equal(dh.ok, true);
      if (dh.ok) assert.equal(dh.value.namespaceId, NS_A_ID);

      const ev = await rig.transport.emitEvent({
        namespace: NS_A,
        event: "suite.execute_started",
        runId: RUN,
        stepId: STEP,
        fields: { cmd_display: cmd },
      });
      assert.equal(ev.ok, true);
      if (ev.ok) assert.equal(ev.value.emitted, true);

      const badEvent = await rig.transport.emitEvent({ namespace: NS_A, event: "suite.owner_release", runId: RUN });
      assert.equal(badEvent.ok, false);
      if (!badEvent.ok) assert.equal(badEvent.code, "UNSUPPORTED");
    } finally {
      await rig.close();
    }
  });

  it("exact-token suite.release over the real seam: released:true + namespace echo; foreign-token release refused DENIED", async () => {
    store = openHostSuiteStore(STORE_PATH);
    const rig = await startRig({ suiteEnabled: true, injectSuiteBridge: true });
    try {
      const cmd = "echo release-wired";
      const ch = cmdHash(cmd);
      const tree = treeHash;
      // Claim a FRESH key so this test never collides with the claim rows of
      // earlier seam cases (the store file is shared within this test file).
      const ledgerKey = { namespaceId: NS_A_ID, originRepo: ORIGIN, treeHash: tree, cmdHash: ch };
      assert.equal(store.peekClaim(ledgerKey), null, "the fresh key starts unclaimed");
      const claim = await rig.transport.claim({
        originRepo: ORIGIN,
        treeHash: tree,
        cmdHash: ch,
        namespace: NS_A,
        ownerToken: "token-wire-rel",
        runId: RUN,
        stepId: STEP,
        invocationId: rig.invocationId,
      });
      assert.equal(claim.ok, true);
      if (claim.ok) assert.equal(claim.value.action, "run");
      assert.equal(store.peekClaim(ledgerKey)?.owner_token, "token-wire-rel", "a live exact-token claim row exists after suite.claim");

      // A foreign token can never release an exact-token claim: the host suite
      // service maps the store owner-mismatch to a DENIED refusal that travels
      // back through bridge → broker → guest service → transport unchanged.
      const foreign = await rig.transport.release({
        originRepo: ORIGIN,
        treeHash: tree,
        cmdHash: ch,
        namespace: NS_A,
        ownerToken: "token-wire-FOREIGN",
      });
      assert.equal(foreign.ok, false);
      if (!foreign.ok) {
        assert.equal(foreign.reason, "refused");
        assert.equal(foreign.code, "DENIED");
        assert.match(foreign.message, /owned by another caller|owner/i);
      }
      assert.equal(store.peekClaim(ledgerKey)?.owner_token, "token-wire-rel", "the refused foreign release must not delete the claim");

      // Exact-token release through the SAME transport → guest service →
      // broker → bridge → service → store path: released:true with the bound
      // namespace echoed so the transport trusts the answer.
      const release = await rig.transport.release({
        originRepo: ORIGIN,
        treeHash: tree,
        cmdHash: ch,
        namespace: NS_A,
        ownerToken: "token-wire-rel",
      });
      assert.equal(release.ok, true);
      if (release.ok) {
        assert.equal(release.value.released, true);
        assert.equal(release.value.namespaceId, NS_A_ID);
      }
      // The exact release consumed the single-flight claim row.
      assert.equal(store.peekClaim(ledgerKey), null, "no live claim remains for the released key");
    } finally {
      await rig.close();
    }
  });

  it("refuses suite ops when the host broker has no injected suite bridge (absent service)", async () => {
    store = openHostSuiteStore(STORE_PATH);
    const rig = await startRig({ suiteEnabled: true, injectSuiteBridge: false });
    try {
      const res = await rig.transport.lookup({
        originRepo: ORIGIN,
        treeHash,
        cmdHash: cmdHash("echo x"),
        namespace: NS_A,
      });
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.reason, "refused");
        assert.equal(res.code, "UNSUPPORTED");
      }
    } finally {
      await rig.close();
    }
  });

  it("refuses suite ops at the guest service when not launched suite-enabled", async () => {
    store = openHostSuiteStore(STORE_PATH);
    const rig = await startRig({ suiteEnabled: false, injectSuiteBridge: true });
    try {
      const res = await rig.transport.lookup({
        originRepo: ORIGIN,
        treeHash,
        cmdHash: cmdHash("echo x"),
        namespace: NS_A,
      });
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.reason, "refused");
        assert.equal(res.code, "UNSUPPORTED");
        assert.match(res.message, /absent/i);
      }
    } finally {
      await rig.close();
    }
  });

  it("terminal host close of an IDLE invocation revokes host suite authority (no late mutation)", async () => {
    store = openHostSuiteStore(STORE_PATH);
    const registry = new HostInvocationRegistry();
    const invocationId = randomUUID();
    admitAndLease(registry, invocationId);
    const { bridgeScope, brokerBinding } = bindings(invocationId, registry);
    const suiteBridge = createHostSuiteBridge(bridgeScope);

    const svcIn = new PassThrough();
    const svcOut = new PassThrough();
    const broker = createHostBroker({
      binding: brokerBinding,
      services: new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] }),
      pipe: { toGuest: svcIn, fromGuest: svcOut },
      handshakeTimeoutMs: 5000,
      serviceTimeoutMs: 8000,
      suite: suiteBridge,
    });
    const socketDir = join(ROOT.root, `sock-${randomUUID()}`);
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    const service = await startGuestBridgeService({
      socketPath: join(socketDir, "bridge.sock"),
      stdin: svcIn,
      stdout: svcOut,
      helperBuildVersion: BV,
      packLayoutVersion: GUEST_PACK_LAYOUT_VERSION,
      suiteEnabled: true,
      claimedIdentity: { invocationId, agentId: AGENT },
    });
    const ready = await withTimeout(service.ready, 6000, "service ready");
    assert.equal(ready.ok, true, ready.reason);
    const rowsBefore = store.resultCount();
    // Idle: no request ever issued. Host close must terminally revoke suite
    // authority through the bridge (registry-backed, shared seam).
    await withTimeout(broker.close(), 4000, "broker close");
    await withTimeout(broker.closed, 4000, "broker closed");
    assert.equal(registry.revocationCount, 1, "idle host close revokes the invocation in the shared registry");
    // Any late suite attempt is refused (never admitted → cannot mutate).
    const late = await suiteBridge.serve("suite.record", {
      ...nsParams(),
      originRepo: ORIGIN,
      treeHash,
      cmdHash: cmdHash("echo x"),
      cmdDisplay: "echo x",
      exitCode: 0,
      durationMs: 1,
      logTail: null,
      runId: RUN,
      stepId: STEP,
      force: false,
      startedAt: "2026-09-09T02:00:00.000Z",
    });
    assert.equal(late.ok, false);
    if (!late.ok) assert.equal(late.code, "DENIED");
    assert.equal(store.resultCount(), rowsBefore, "no SQL mutation after revocation");
    await withTimeout(service.shutdown(), 4000, "service shutdown");
    store.close();
  });
});
