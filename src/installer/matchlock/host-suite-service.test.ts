/**
 * HostSuiteService integration tests (serial lane: real git + /bin/sh guest
 * subprocess fixtures executed on vaivm — explicit labels NOT actualVM).
 *
 * REAL service/store/registry integration (not mocks): a positively-admitted
 * host invocation holding a REAL HostInvocationRegistry step lease drives the
 * REAL guest suite engine (runGuestSuiteShim) through the authoritative typed
 * adapter into a REAL explicit SQLite evidence store — claim → tiny guest
 * command via the adapter → record → exact lookup/ack with raw exit/output.
 *
 * Also covered: foreign namespace/run/step/root/token/oversize/nonnumeric
 * refusal, revocation before first claim and between validation/commit,
 * duplicate exact records (same → truthful original ack; changed → refused),
 * two bound invocation services contending for the exact key with exact-token
 * release/promotion, persisted-store reopen, cross-environment (namespace)
 * and native-store isolation, guest PID/identity never being host authority,
 * forbidden events/ops denied, interruption-87 evidence excluded from flaky
 * counts, and incomplete/refused records producing real execution with NO
 * fabricated green reuse. Symlink-spelled origin_repo admission by realpath
 * identity (US-002 / bead .32) is covered with real symlinked fixture dirs.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTempHome, cleanChildEnv } from "../../../tests/helpers/test-env.ts";
import { HostInvocationRegistry } from "../../../dist/installer/matchlock/native-step-invocations.js";
import {
  HostSuiteService,
  type HostSuiteBinding,
  type HostSuiteServiceOptions,
} from "../../../dist/installer/matchlock/host-suite-service.js";
import { openHostSuiteStore } from "../../../dist/installer/matchlock/host-suite-store.js";
import {
  runGuestSuiteShim,
  type GuestSuiteShimIo,
} from "../../../dist/installer/matchlock/guest-suite-shim.js";
import {
  computeCmdHash,
  committedTreeHash,
} from "../../../dist/installer/matchlock/guest-suite-git.js";
import {
  guestSuiteNamespaceId,
  type GuestSuiteNamespace,
  type GuestSuiteTransport,
} from "../../../dist/installer/matchlock/guest-suite-contract.js";

// ── shared identity + namespaces ──────────────────────────────────────

const NS_A: GuestSuiteNamespace = {
  imageContentId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  guestPlatform: "linux/amd64",
  helperContract: "guest-helper-host+suite-v1",
  compatibilityFingerprint: "envfp-aaa111",
};
const NS_B: GuestSuiteNamespace = {
  imageContentId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  guestPlatform: "linux/arm64",
  helperContract: "guest-helper-host+suite-v1",
  compatibilityFingerprint: "envfp-bbb222",
};
const NS_A_ID = guestSuiteNamespaceId(NS_A);
const NS_B_ID = guestSuiteNamespaceId(NS_B);

const RUN_ID = "run-suite-host-1";
const AGENT = "feature-dev-merge_verify";
const JOB = "job-suite-host-1";
const STEP_A = "verify-a";
const STEP_B = "verify-b";
const STEP_C = "verify-c";
const INV_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INV_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INV_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ROW_A = "11111111-1111-4111-8111-111111111111";
const ROW_B = "22222222-2222-4222-8222-222222222222";
const ROW_C = "33333333-3333-4333-8333-333333333333";

// ── fixture git repo (tiny guest-local real commands, NOT actualVM) ────

const ROOT = createTempHome("tamandua-host-suite-");
const FIXTURE_BASE = path.join(ROOT.root, "fixtures");

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: cleanChildEnv({
      HOME: process.env.HOME,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    }),
    stdio: "pipe",
  });
}

function initRepo(name: string): string {
  const repoDir = path.join(FIXTURE_BASE, name);
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["config", "user.email", "host-suite@test.invalid"]);
  git(repoDir, ["config", "user.name", "Host Suite Test"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Host fixture\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-q", "-m", "init"]);
  return repoDir;
}

before(() => {
  fs.mkdirSync(FIXTURE_BASE, { recursive: true });
});

// ── rig helpers ───────────────────────────────────────────────────────

interface Rig {
  root: string;
  storeFile: string;
  registry: HostInvocationRegistry;
  repo: string;
  originRepo: string;
}

function makeRig(name: string): Rig {
  const root = path.join(ROOT.root, "rigs", name);
  fs.mkdirSync(root, { recursive: true });
  const storeFile = path.join(root, "matchlock-evidence.db");
  const repo = initRepo(`repo-${name}`);
  // resolve the exact origin realpath (guest getOriginRepo parity)
  const originRepo = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: repo,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return { root, storeFile, registry: new HostInvocationRegistry(), repo, originRepo };
}

function admitAndLease(
  registry: HostInvocationRegistry,
  opts: { invocationId: string; stepRowId: string; stepId: string; runId?: string },
): void {
  const runId = opts.runId ?? RUN_ID;
  const admitted = registry.admitInvocation({ invocationId: opts.invocationId, runId, agentId: AGENT, jobId: JOB });
  assert.ok(admitted.ok, `admit ${opts.invocationId}: ${admitted.ok ? "" : admitted.reason}`);
  const lease = registry.register({
    stepRowId: opts.stepRowId,
    stepId: opts.stepId,
    runId,
    agentId: AGENT,
    invocationId: opts.invocationId,
    jobId: JOB,
    claimId: `claim-${opts.invocationId}`,
    rowToken: `rowtok-${opts.stepRowId}`,
    claimedAtMs: Date.now(),
  });
  assert.ok(lease.ok, `lease ${opts.invocationId}: ${lease.ok ? "" : lease.reason}`);
}

function bindingFor(rig: Rig, opts: {
  invocationId: string;
  stepRowId: string;
  stepId: string;
  registry?: HostInvocationRegistry;
  namespace?: GuestSuiteNamespace;
  admittedRoots?: string[];
  runId?: string;
}): HostSuiteBinding {
  return {
    runId: opts.runId ?? RUN_ID,
    agentId: AGENT,
    jobId: JOB,
    invocationId: opts.invocationId,
    stepRowId: opts.stepRowId,
    stepId: opts.stepId,
    namespace: opts.namespace ?? NS_A,
    admittedRoots: opts.admittedRoots ?? [rig.originRepo],
    registry: opts.registry ?? rig.registry,
  };
}

function serviceFor(rig: Rig, binding: HostSuiteBinding, over: Partial<HostSuiteServiceOptions> = {}): HostSuiteService {
  const store = openHostSuiteStore(rig.storeFile);
  return new HostSuiteService({ store, binding, ...over });
}

interface EngineRun {
  exitCode: number;
  out: string;
  err: string;
}

function runEngine(rig: Rig, svc: GuestSuiteTransport, argv: string[], opts: { namespace?: GuestSuiteNamespace; claimTimeoutMs?: number; ttlGreenMs?: number; singleflightPollIntervalMs?: number } = {}): Promise<EngineRun> {
  let outText = "";
  let errText = "";
  const io: GuestSuiteShimIo = {
    cwd: rig.repo,
    envGet: (n) => process.env[n],
    writeOut: (t) => { outText += t; },
    writeErr: (t) => { errText += t; },
  };
  return runGuestSuiteShim(argv, io, {
    transport: svc,
    namespace: opts.namespace ?? NS_A,
    options: {
      requestTimeoutMs: 3000,
      singleflightPollIntervalMs: opts.singleflightPollIntervalMs ?? 15,
      claimTimeoutMs: opts.claimTimeoutMs ?? 4000,
      ttlGreenMs: opts.ttlGreenMs ?? 60_000,
      redContextWindowMs: 15 * 60 * 1000,
    },
  }).then((r) => ({ exitCode: r.exitCode, out: outText, err: errText }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exact key for a command on the rig's committed tree. */
function keyOf(rig: Rig, cmd: string) {
  const treeHash = committedTreeHash(rig.repo)!;
  return { originRepo: rig.originRepo, treeHash, cmdHash: computeCmdHash(cmd) };
}

// ───────────────────────────────────────────────────────────────────────
describe("host-suite-service: positive admitted lease → engine → record → lookup (NOT actualVM)", () => {
  it("a real admitted lease drives the real guest engine through the typed adapter into the real store", async () => {
    const rig = makeRig("positive");
    admitAndLease(rig.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    const svc = serviceFor(rig, bindingFor(rig, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A }));
    const cmd = "printf 'HOST-POS-OUT\\n'; printf 'HOST-POS-ERR\\n' >&2; exit 0";
    const run = await runEngine(rig, svc, ["--repo", rig.repo, "--run", RUN_ID, "--step", STEP_A, "--", cmd]);
    assert.equal(run.exitCode, 0);
    assert.equal(run.out, "HOST-POS-OUT\n", "raw guest stdout streams through the adapter");
    assert.match(run.err, /HOST-POS-ERR/);
    // Exact lookup/ack through the same adapter.
    const lookup = await svc.lookup({ ...keyOf(rig, cmd), namespace: NS_A });
    assert.ok(lookup.ok);
    if (!lookup.ok) return;
    assert.equal(lookup.value.namespaceId, NS_A_ID);
    assert.equal(lookup.value.latest?.exit_code, 0);
    assert.equal(lookup.value.latest?.origin_repo, rig.originRepo);
    assert.equal(lookup.value.latest?.run_id, RUN_ID);
    assert.equal(lookup.value.latest?.step_id, STEP_A);
    assert.equal(lookup.value.passCount, 1);
    assert.equal(svc["store"].resultCount(), 1, "exactly one real execution row");
    assert.equal(svc["store"].claimCount(), 0, "the owner's record cleared the single-flight claim");
  });

  it("a second run of a fresh green key REPLAYS from the store without executing (no duplicate row)", async () => {
    const rig = makeRig("replay");
    admitAndLease(rig.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    const svc = serviceFor(rig, bindingFor(rig, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A }));
    const cmd = "echo replayable-green";
    const first = await runEngine(rig, svc, ["--repo", rig.repo, "--run", RUN_ID, "--step", STEP_A, "--", cmd]);
    assert.equal(first.exitCode, 0);
    const second = await runEngine(rig, svc, ["--repo", rig.repo, "--run", RUN_ID, "--step", STEP_A, "--", cmd]);
    assert.equal(second.exitCode, 0);
    assert.match(second.out, /TAMANDUA-TEST CACHED/, "green replay corridor served from the host store");
    assert.equal(svc["store"].resultCount(), 1, "replay records no new execution row");
    assert.equal(svc["store"].claimCount(), 0);
  });

  it("interruption-87 evidence is historical: never a flaky pass/fail and never replayed green", async () => {
    const rig = makeRig("interrupt87");
    admitAndLease(rig.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    const svc = serviceFor(rig, bindingFor(rig, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A }));
    const started = "2026-09-09T01:00:00.000Z";
    // An interrupted attempt (exit 87) is recorded as historical evidence.
    const rec87 = await svc.record({ ...keyOf(rig, "probe"), namespace: NS_A, cmdDisplay: "probe", exitCode: 87, durationMs: 1234, logTail: "KILLED", runId: RUN_ID, stepId: STEP_A, force: false, startedAt: started });
    assert.ok(rec87.ok);
    // A later real green (same key, same invocation, later started_at).
    const rec0 = await svc.record({ ...keyOf(rig, "probe"), namespace: NS_A, cmdDisplay: "probe", exitCode: 0, durationMs: 200, logTail: null, runId: RUN_ID, stepId: STEP_A, force: false, startedAt: "2026-09-09T01:01:00.000Z" });
    assert.ok(rec0.ok);
    const lookup = await svc.lookup({ ...keyOf(rig, "probe"), namespace: NS_A });
    assert.ok(lookup.ok);
    if (!lookup.ok) return;
    assert.equal(lookup.value.passCount, 1);
    assert.equal(lookup.value.failCount, 0, "interruption-87 is excluded from flaky counts");
    assert.equal(lookup.value.flaky, false);
    assert.equal(lookup.value.latest?.exit_code, 0);
    const history = await svc.durationHistory({ originRepo: rig.originRepo, cmdHash: keyOf(rig, "probe").cmdHash, namespace: NS_A });
    assert.ok(history.ok);
    if (history.ok) assert.deepEqual(history.value.durations, [200], "87 durations never enter the advisory history");
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("host-suite-service: negative host-boundary refusals", () => {
  let rig: Rig;
  before(() => {
    rig = makeRig("negative");
    admitAndLease(rig.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
  });

  function svc(over: Partial<HostSuiteServiceOptions> = {}): HostSuiteService {
    return serviceFor(rig, bindingFor(rig, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A }), over);
  }

  it("a foreign namespace is refused WRONG_NAMESPACE and never reaches the store", async () => {
    const s = svc();
    const lookup = await s.lookup({ ...keyOf(rig, "echo x"), namespace: NS_B });
    assert.equal(lookup.ok, false);
    if (lookup.ok) return;
    assert.equal(lookup.reason, "refused");
    if (lookup.reason === "refused") assert.equal(lookup.code, "WRONG_NAMESPACE");
    assert.equal(s["store"].resultCount(), 0);
  });

  it("a mismatched run or step id cannot broaden the binding", async () => {
    const s = svc();
    const claim = await s.claim({ ...keyOf(rig, "echo x"), namespace: NS_A, ownerToken: "tok-1", runId: "some-other-run", stepId: STEP_A });
    assert.equal(claim.ok, false);
    const claim2 = await s.claim({ ...keyOf(rig, "echo x"), namespace: NS_A, ownerToken: "tok-1", runId: RUN_ID, stepId: "some-other-step" });
    assert.equal(claim2.ok, false);
    assert.equal(s["store"].claimCount(), 0, "no mutation occurred");
  });

  it("a foreign origin root (not an admitted root) is refused DENIED", async () => {
    const s = svc();
    const claim = await s.claim({ originRepo: "/unadmitted/repo", treeHash: keyOf(rig, "x").treeHash, cmdHash: keyOf(rig, "x").cmdHash, namespace: NS_A, ownerToken: "tok-1" });
    assert.equal(claim.ok, false);
    if (!claim.ok) assert.equal(claim.reason, "refused");
  });

  it("oversized and non-finite fields are refused at the host boundary", async () => {
    const s = svc();
    const k = keyOf(rig, "echo x");
    const bigTail = await s.record({ ...k, namespace: NS_A, cmdDisplay: "echo x", exitCode: 0, durationMs: 10, logTail: "x".repeat(21 * 1024), runId: RUN_ID, stepId: STEP_A, force: false, startedAt: "2026-09-09T01:00:00.000Z" });
    assert.equal(bigTail.ok, false);
    if (!bigTail.ok) assert.equal(bigTail.code, "OVERSIZED");
    const nonFinite = await s.record({ ...k, namespace: NS_A, cmdDisplay: "echo x", exitCode: 0, durationMs: Number.NaN, logTail: null, runId: RUN_ID, stepId: STEP_A, force: false, startedAt: "2026-09-09T01:00:00.000Z" });
    assert.equal(nonFinite.ok, false);
    const negative = await s.record({ ...k, namespace: NS_A, cmdDisplay: "echo x", exitCode: 0, durationMs: -5, logTail: null, runId: RUN_ID, stepId: STEP_A, force: false, startedAt: "2026-09-09T01:00:00.000Z" });
    assert.equal(negative.ok, false);
    const nonInt = await s.record({ ...k, namespace: NS_A, cmdDisplay: "echo x", exitCode: 1.5, durationMs: 10, logTail: null, runId: RUN_ID, stepId: STEP_A, force: false, startedAt: "2026-09-09T01:00:00.000Z" });
    assert.equal(nonInt.ok, false);
    // exit codes outside the real [0, 255] range are refused (defense in depth:
    // the shim is the only producer today, but the boundary stays honest).
    const negCode = await s.record({ ...k, namespace: NS_A, cmdDisplay: "echo x", exitCode: -1, durationMs: 10, logTail: null, runId: RUN_ID, stepId: STEP_A, force: false, startedAt: "2026-09-09T01:00:00.000Z" });
    assert.equal(negCode.ok, false);
    if (!negCode.ok) assert.equal(negCode.code, "BAD_REQUEST");
    const overCode = await s.record({ ...k, namespace: NS_A, cmdDisplay: "echo x", exitCode: 256, durationMs: 10, logTail: null, runId: RUN_ID, stepId: STEP_A, force: false, startedAt: "2026-09-09T01:00:00.000Z" });
    assert.equal(overCode.ok, false);
    if (!overCode.ok) assert.equal(overCode.code, "BAD_REQUEST");
    assert.equal(s["store"].resultCount(), 0, "no rejected record was persisted");
  });

  it("forbidden suite events and owner-wide surfaces are denied", async () => {
    const s = svc();
    const ev = await s.emitEvent({ namespace: NS_A, event: "suite.owner_release", runId: RUN_ID, stepId: STEP_A });
    assert.equal(ev.ok, false);
    if (!ev.ok) assert.equal(ev.code, "UNSUPPORTED");
    // The six-op transport surface has NO owner-wide release / heartbeat / proxy.
    const surface = s as unknown as Record<string, unknown>;
    assert.equal(surface.releaseSuiteClaimsByOwner, undefined);
    assert.equal(surface.releaseClaimsByInvocation, undefined);
    assert.equal(surface.heartbeat, undefined);
    assert.equal(surface["fetch"], undefined);
  });

  it("an oversized namespace field is refused OVERSIZED without mutating the caller object", async () => {
    const s = svc();
    const badNs: GuestSuiteNamespace = { ...NS_A, compatibilityFingerprint: "y".repeat(65) };
    const claim = await s.claim({ ...keyOf(rig, "echo x"), namespace: badNs, ownerToken: "tok-1" });
    assert.equal(claim.ok, false);
    if (!claim.ok) assert.equal(claim.code, "OVERSIZED");
    assert.equal(badNs.compatibilityFingerprint, "y".repeat(65), "caller's namespace object is never trimmed/mutated");
  });

  it("event fields that are oversized are OVERSIZED; NON-serializable (circular) fields are BAD_REQUEST", async () => {
    const s = svc();
    const base = { namespace: NS_A, event: "suite.execute_started", runId: RUN_ID, stepId: STEP_A };
    // 64 KiB bound: a successful serialization that is too big is a size refusal.
    const oversized = await s.emitEvent({ ...base, fields: { blob: "x".repeat(70 * 1024) } });
    assert.equal(oversized.ok, false);
    if (!oversized.ok) assert.equal(oversized.code, "OVERSIZED");
    // JSON.stringify on a circular payload throws — a malformed request, not a
    // size problem: labeled honestly BAD_REQUEST (never a raw JS error).
    const circular: Record<string, unknown> = { self: undefined };
    circular.self = circular;
    const malformed = await s.emitEvent({ ...base, fields: circular });
    assert.equal(malformed.ok, false);
    if (!malformed.ok) {
      assert.equal(malformed.code, "BAD_REQUEST");
      assert.match(malformed.message, /cannot be serialized/);
    }
    assert.equal(s["store"].resultCount(), 0);
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("host-suite-service: host authority lifecycle (revocation / never-admitted)", () => {
  it("a never-admitted identity (even a PID-looking one) can never act", async () => {
    const rig = makeRig("neverbound");
    // INV_A is admitted+leased; a PID-looking identity is NOT.
    admitAndLease(rig.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    const pidLike = "98765";
    const svcPid = serviceFor(rig, bindingFor(rig, { invocationId: pidLike, stepRowId: ROW_B, stepId: STEP_B }));
    const claim = await svcPid.claim({ ...keyOf(rig, "echo x"), namespace: NS_A, ownerToken: "tok-pid" });
    assert.equal(claim.ok, false);
    if (!claim.ok) assert.match(claim.message, /never admitted/);
    assert.equal(svcPid["store"].claimCount(), 0);
  });

  it("an invocation revoked BEFORE its first request can never regain authority", async () => {
    const rig = makeRig("revoked-first");
    admitAndLease(rig.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    rig.registry.revokeInvocation(INV_A, "VM closed before first request");
    const svc = serviceFor(rig, bindingFor(rig, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A }));
    const claim = await svc.claim({ ...keyOf(rig, "echo x"), namespace: NS_A, ownerToken: "tok-1" });
    assert.equal(claim.ok, false);
    if (!claim.ok) assert.match(claim.message, /revoked/);
    assert.equal(svc["store"].claimCount(), 0, "no DB mutation happened");
    // Re-admitting the SAME identity is refused by the registry (terminal).
    const readmit = rig.registry.admitInvocation({ invocationId: INV_A, runId: RUN_ID, agentId: AGENT, jobId: JOB });
    assert.equal(readmit.ok, false);
  });

  it("revoking an invocation BETWEEN validation and commit refuses the mutation (revalidate after await)", async () => {
    const rig = makeRig("revoked-mid");
    admitAndLease(rig.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    const svc = serviceFor(rig, bindingFor(rig, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A }), { serviceDelayMs: 400 });
    const pending = svc.claim({ ...keyOf(rig, "echo x"), namespace: NS_A, ownerToken: "tok-1" });
    await sleep(120);
    rig.registry.revokeInvocation(INV_A, "cancel while claim in flight");
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /revoked/);
    assert.equal(svc["store"].claimCount(), 0, "the mutation was re-checked and refused before commit");
  });

  it("a live admission with NO step lease (idle-close/lease dropped) cannot act", async () => {
    const rig = makeRig("dropped-lease");
    admitAndLease(rig.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    // Host dropped/released the invocation's only step lease.
    rig.registry.releaseIfHeldBy(INV_A, ROW_A);
    const svc = serviceFor(rig, bindingFor(rig, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A }));
    const lookup = await svc.lookup({ ...keyOf(rig, "echo x"), namespace: NS_A });
    assert.equal(lookup.ok, false);
    if (!lookup.ok) assert.match(lookup.message, /no active lease/);
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("host-suite-service: exact record idempotency + release/promotion contention", () => {
  it("duplicate EXACT accepted records return the original acknowledgment; changed payloads are refused", async () => {
    const rig = makeRig("dup");
    admitAndLease(rig.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    const svc = serviceFor(rig, bindingFor(rig, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A }));
    const k = keyOf(rig, "echo dup");
    const startedAt = "2026-09-09T01:00:00.000Z";
    const rec = { ...k, namespace: NS_A, cmdDisplay: "echo dup", exitCode: 0, durationMs: 500, logTail: null, runId: RUN_ID, stepId: STEP_A, force: false, startedAt };
    const first = await svc.record(rec);
    assert.ok(first.ok);
    const second = await svc.record(rec);
    assert.ok(second.ok);
    if (first.ok && second.ok) {
      assert.equal(second.value.id, first.value.id, "duplicate exact record is acked with the ORIGINAL row id");
      assert.equal(second.value.created_at, first.value.created_at);
    }
    assert.equal(svc["store"].resultCount(), 1);
    const changed = await svc.record({ ...rec, exitCode: 9 });
    assert.equal(changed.ok, false);
    if (!changed.ok) assert.equal(changed.code, "DENIED");
    assert.equal(svc["store"].resultCount(), 1, "mismatched retry never creates a row");
  });

  it("two bound invocation services contend for the exact key; exact-token release promotes the waiter", async () => {
    const rig = makeRig("contend");
    admitAndLease(rig.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    admitAndLease(rig.registry, { invocationId: INV_B, stepRowId: ROW_B, stepId: STEP_B });
    const svcA = serviceFor(rig, bindingFor(rig, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A }));
    const svcB = serviceFor(rig, bindingFor(rig, { invocationId: INV_B, stepRowId: ROW_B, stepId: STEP_B }));
    const k = keyOf(rig, "echo contend");
    const claimA = await svcA.claim({ ...k, namespace: NS_A, ownerToken: "token-A", runId: RUN_ID, stepId: STEP_A });
    assert.ok(claimA.ok);
    if (!claimA.ok) return;
    assert.equal(claimA.value.action, "run");
    const claimB1 = await svcB.claim({ ...k, namespace: NS_A, ownerToken: "token-B", runId: RUN_ID, stepId: STEP_B });
    assert.ok(claimB1.ok);
    if (claimB1.ok) assert.equal(claimB1.value.action, "wait", "B cannot steal A's live claim");
    // B cannot release A's claim — even with A's token (foreign host invocation).
    const foreignRelease = await svcB.release({ ...k, namespace: NS_A, ownerToken: "token-A" });
    assert.equal(foreignRelease.ok, false);
    if (!foreignRelease.ok) assert.equal(foreignRelease.code, "DENIED");
    assert.equal(svcA["store"].claimCount(), 1, "owner's claim survives the foreign release attempt");
    // Exact-token release by the owner promotes the waiter.
    const released = await svcA.release({ ...k, namespace: NS_A, ownerToken: "token-A" });
    assert.ok(released.ok);
    if (released.ok) assert.equal(released.value.released, true);
    const claimB2 = await svcB.claim({ ...k, namespace: NS_A, ownerToken: "token-B", runId: RUN_ID, stepId: STEP_B });
    assert.ok(claimB2.ok);
    if (claimB2.ok) assert.equal(claimB2.value.action, "run", "waiter is promoted after the exact-token release");
    // Superseded A can no longer release B's promoted claim.
    const staleRelease = await svcA.release({ ...k, namespace: NS_A, ownerToken: "token-A" });
    assert.equal(staleRelease.ok, false);
    if (!staleRelease.ok) assert.equal(staleRelease.code, "DENIED");
    assert.equal(svcA["store"].claimCount(), 1);
  });

  it("an engine WAITER on a live foreign claim finishes its bounded poll and executes for real (no deadlock)", async () => {
    const rig = makeRig("waitpoll");
    admitAndLease(rig.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    admitAndLease(rig.registry, { invocationId: INV_B, stepRowId: ROW_B, stepId: STEP_B });
    const svcA = serviceFor(rig, bindingFor(rig, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A }));
    const svcB = serviceFor(rig, bindingFor(rig, { invocationId: INV_B, stepRowId: ROW_B, stepId: STEP_B }));
    const cmd = "echo waiter-executes";
    const k = keyOf(rig, cmd);
    // Owner A holds the claim and NEVER records/releases (a stuck owner is
    // bounded by host-clock claim expiry, never a guest PID check).
    const claimA = await svcA.claim({ ...k, namespace: NS_A, ownerToken: "token-A", runId: RUN_ID, stepId: STEP_A });
    assert.ok(claimA.ok);
    // B's engine claims → wait → polls; when the bounded poll completes it
    // MUST execute the real command and record its own row (no waiter deadlock).
    const waiter = await runEngine(rig, svcB, ["--repo", rig.repo, "--run", RUN_ID, "--step", STEP_B, "--", cmd], {
      singleflightPollIntervalMs: 10,
      claimTimeoutMs: 300,
    });
    assert.equal(waiter.exitCode, 0);
    assert.match(waiter.out, /waiter-executes/, "waiter executes for real after its bounded poll");
    assert.match(waiter.err, /single-flight claim poll timed out — executing/);
    assert.equal(svcA["store"].resultCount(), 1, "only B's real row was recorded");
    assert.equal(svcA["store"].claimCount(), 1, "A's un-released claim is swept only by host expiry/hook — never fabricated");
  });

  it("a fresh same-namespace recorded green is replayed by the engine (native TTL corridor), never duplicated", async () => {
    const rig = makeRig("greenseed");
    admitAndLease(rig.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    admitAndLease(rig.registry, { invocationId: INV_B, stepRowId: ROW_B, stepId: STEP_B });
    const svcA = serviceFor(rig, bindingFor(rig, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A }));
    const svcB = serviceFor(rig, bindingFor(rig, { invocationId: INV_B, stepRowId: ROW_B, stepId: STEP_B }));
    const cmd = "echo seeded-green";
    const k = keyOf(rig, cmd);
    // A records a fresh green execution under the SAME attested namespace.
    const rec = await svcA.record({ ...k, namespace: NS_A, cmdDisplay: cmd, exitCode: 0, durationMs: 900, logTail: "SEEDED TAIL", runId: RUN_ID, stepId: STEP_A, force: false, startedAt: "2026-09-09T01:00:00.000Z" });
    assert.ok(rec.ok);
    // B's engine (same attested namespace) replays it after tree/dirt
    // revalidation — native green-TTL corridor, no duplicate execution row.
    const run = await runEngine(rig, svcB, ["--repo", rig.repo, "--run", RUN_ID, "--step", STEP_B, "--", cmd], { ttlGreenMs: 60_000 });
    assert.equal(run.exitCode, 0);
    assert.match(run.out, /TAMANDUA-TEST CACHED/);
    assert.match(run.out, /SEEDED TAIL/, "the recorded output tail is replayed verbatim");
    assert.equal(svcA["store"].resultCount(), 1, "replay records no new row");
    assert.equal(svcA["store"].claimCount(), 0);
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("host-suite-service: durability, isolation, incomplete records", () => {
  it("persisted store reopen keeps namespace-bound records and ack identity; authority is NOT restored from rows", async () => {
    const rig = makeRig("reopen");
    admitAndLease(rig.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    const binding = bindingFor(rig, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    const store1 = openHostSuiteStore(rig.storeFile);
    const svc1 = new HostSuiteService({ store: store1, binding });
    const k = keyOf(rig, "echo durable");
    const startedAt = "2026-09-09T01:00:00.000Z";
    const rec1 = await svc1.record({ ...k, namespace: NS_A, cmdDisplay: "echo durable", exitCode: 0, durationMs: 600, logTail: "dur", runId: RUN_ID, stepId: STEP_A, force: false, startedAt });
    assert.ok(rec1.ok);
    const ackId = rec1.ok ? rec1.value.id : -1;
    svc1["store"].close();

    // A NEW registry/authority scope reopens the same explicit store file.
    // The new registry must re-admit the identity; the ADMITTED ORIGIN ROOTS
    // stay those of the original run (evidence keys are unchanged) and host
    // authority state is never restored from guest/row fields.
    const rig2 = makeRig("reopen2");
    admitAndLease(rig2.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    const store2 = openHostSuiteStore(rig.storeFile);
    const svc2 = new HostSuiteService({
      store: store2,
      binding: bindingFor(rig2, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A, admittedRoots: [rig.originRepo] }),
    });
    const lookup = await svc2.lookup({ ...k, namespace: NS_A });
    assert.ok(lookup.ok);
    if (lookup.ok) {
      assert.equal(lookup.value.latest?.id, ackId);
      assert.equal(lookup.value.latest?.namespace_id, NS_A_ID, "namespace axis is persisted on the row");
    }
    const dup = await svc2.record({ ...k, namespace: NS_A, cmdDisplay: "echo durable", exitCode: 0, durationMs: 600, logTail: "dur", runId: RUN_ID, stepId: STEP_A, force: false, startedAt });
    assert.ok(dup.ok);
    if (dup.ok && lookup.ok) assert.equal(dup.value.id, ackId, "reopen still acks the ORIGINAL row id");
    assert.equal(store2.resultCount(), 1);
    // Cross-namespace rows never contaminated the reopened store.
    assert.equal(store2.getNamespace(NS_B_ID), null);
    store2.close();
  });

  it("different environment namespaces on ONE store are isolated (no cross-image/helper/platform evidence)", async () => {
    const rig = makeRig("nsisolated");
    admitAndLease(rig.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    // Second service bound to a DIFFERENT host-admitted namespace (arm64) with
    // its own invocation + step lease on the same store.
    admitAndLease(rig.registry, { invocationId: INV_B, stepRowId: ROW_B, stepId: STEP_B });
    const svcA = serviceFor(rig, bindingFor(rig, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A }));
    const svcB = serviceFor(rig, bindingFor(rig, { invocationId: INV_B, stepRowId: ROW_B, stepId: STEP_B, namespace: NS_B }));
    const k = keyOf(rig, "echo env");
    const recA = await svcA.record({ ...k, namespace: NS_A, cmdDisplay: "echo env", exitCode: 0, durationMs: 100, logTail: null, runId: RUN_ID, stepId: STEP_A, force: false, startedAt: "2026-09-09T01:00:00.000Z" });
    assert.ok(recA.ok);
    const lookupB = await svcB.lookup({ ...k, namespace: NS_B });
    assert.ok(lookupB.ok);
    if (lookupB.ok) assert.equal(lookupB.value.latest, null, "arm64 namespace never sees amd64 evidence");
    const lookupA = await svcA.lookup({ ...k, namespace: NS_A });
    assert.ok(lookupA.ok);
    if (lookupA.ok) assert.equal(lookupA.value.latest?.exit_code, 0);
    // B's record under its own namespace stays invisible to A and vice versa:
    // evidence rows are namespaced by the separate host-chosen axis.
    const recB = await svcB.record({ ...k, namespace: NS_B, cmdDisplay: "echo env", exitCode: 3, durationMs: 100, logTail: null, runId: RUN_ID, stepId: STEP_B, force: false, startedAt: "2026-09-09T01:01:00.000Z" });
    assert.ok(recB.ok);
    const lookupA2 = await svcA.lookup({ ...k, namespace: NS_A });
    assert.ok(lookupA2.ok);
    if (lookupA2.ok) assert.equal(lookupA2.value.latest?.exit_code, 0, "A still sees only its own evidence");
    const lookupB2 = await svcB.lookup({ ...k, namespace: NS_B });
    assert.ok(lookupB2.ok);
    if (lookupB2.ok) assert.equal(lookupB2.value.latest?.exit_code, 3, "B sees only its own evidence");
    const durA = await svcA.durationHistory({ originRepo: rig.originRepo, cmdHash: k.cmdHash, namespace: NS_A });
    assert.ok(durA.ok);
    if (durA.ok) assert.deepEqual(durA.value.durations, [100]);
  });

  it("an engine run whose record is refused by host revocation produces REAL execution + NO green reuse", async () => {
    const rig = makeRig("refused-record");
    admitAndLease(rig.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    const svcA = serviceFor(rig, bindingFor(rig, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A }));
    const cmd = "sleep 0.3; echo REAL-RAN-REFUSED; exit 0";
    const runP = runEngine(rig, svcA, ["--repo", rig.repo, "--run", RUN_ID, "--step", STEP_A, "--", cmd]);
    await sleep(120);
    // Revoke the host invocation while the guest command is executing: the
    // record mutation is re-checked against the live host authority → refused.
    rig.registry.revokeInvocation(INV_A, "VM closed mid-suite");
    const run = await runP;
    assert.equal(run.exitCode, 0, "a refused record never fabricates a failure exit");
    assert.match(run.out, /REAL-RAN-REFUSED/, "the command really executed through the adapter");
    assert.match(run.err, /refused to record/, "refusal is explicit incomplete evidence");
    assert.equal(svcA["store"].resultCount(), 0, "NO row was recorded — nothing to replay as green");
    // A successor host invocation (fresh registry admission) reclaims the key:
    // the revoked owner's claim is swept via the registry owner-death predicate.
    admitAndLease(rig.registry, { invocationId: INV_C, stepRowId: ROW_C, stepId: STEP_C });
    const svcC = serviceFor(rig, bindingFor(rig, { invocationId: INV_C, stepRowId: ROW_C, stepId: STEP_C }));
    const claimC = await svcC.claim({ ...keyOf(rig, cmd), namespace: NS_A, ownerToken: "token-C", runId: RUN_ID, stepId: STEP_C });
    assert.ok(claimC.ok);
    if (claimC.ok) assert.equal(claimC.value.action, "run", "the successor acquires the swept claim");
    const lookupAfter = await svcC.lookup({ ...keyOf(rig, cmd), namespace: NS_A });
    assert.ok(lookupAfter.ok);
    if (lookupAfter.ok) {
      assert.equal(lookupAfter.value.latest, null, "no green was fabricated from the refused record");
      assert.equal(lookupAfter.value.passCount, 0);
    }
    svcC["store"].close();
  });
});

// ───────────────────────────────────────────────────────────────────────
// US-002 / finding 1 (bead tamandua-6sy.33.10.32): the suite transport admits
// a symlink-spelled origin_repo by REALPATH IDENTITY. The host policy records
// the exact host spelling (the spelling the guest sees as its cwd) and the
// canonical target separately, so admission must accept EITHER spelling for
// the same admitted root while the LEDGER KEY stays the guest-presented
// spelling (never canonicalized).
describe("host-suite-service: symlink-spelled admitted roots (realpath identity)", () => {
  function symlinkRig(name: string): { rig: Rig; canonical: string; link: string } {
    const rig = makeRig(name);
    const canonical = fs.realpathSync.native(rig.repo);
    const link = path.join(rig.root, "repo-link");
    fs.symlinkSync(canonical, link, "dir");
    assert.equal(fs.realpathSync.native(link), canonical, "fixture symlink resolves to the canonical repo");
    assert.notEqual(link, canonical);
    return { rig, canonical, link };
  }

  it("admits a symlink-spelled originRepo against a canonical admitted root and stores the requested spelling", async () => {
    const { rig, canonical, link } = symlinkRig("symlink-canonical-admitted");
    admitAndLease(rig.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    const svc = serviceFor(rig, bindingFor(rig, {
      invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A,
      admittedRoots: [canonical],
    }));
    const treeHash = committedTreeHash(rig.repo)!;
    const cmd = "echo symlink-admitted";
    const cmdHash = computeCmdHash(cmd);
    const claim = await svc.claim({ originRepo: link, treeHash, cmdHash, namespace: NS_A, ownerToken: "tok-symlink" });
    assert.ok(claim.ok, "symlink spelling is admitted against a canonical admitted root");
    const rec = await svc.record({
      originRepo: link, treeHash, cmdHash, namespace: NS_A,
      cmdDisplay: cmd, exitCode: 0, durationMs: 5, logTail: null,
      runId: RUN_ID, stepId: STEP_A, force: false, startedAt: "2026-09-16T00:00:00.000Z",
    });
    assert.ok(rec.ok, "record succeeds for the symlink-spelled origin");
    const lookup = await svc.lookup({ originRepo: link, treeHash, cmdHash, namespace: NS_A });
    assert.ok(lookup.ok);
    if (lookup.ok) {
      assert.equal(lookup.value.latest?.origin_repo, link, "the guest-presented spelling is the ledger key (never canonicalized)");
      assert.equal(lookup.value.latest?.exit_code, 0);
    }
    // Admission does not rewrite the key: the canonical spelling is a DIFFERENT
    // ledger row (the exact-spelling design intent), never merged with the link.
    const canonicalLookup = await svc.lookup({ originRepo: canonical, treeHash, cmdHash, namespace: NS_A });
    assert.ok(canonicalLookup.ok);
    if (canonicalLookup.ok) {
      assert.equal(canonicalLookup.value.latest, null, "the origin key is never canonicalized to merge the two spellings");
    }
    svc["store"].close();
  });

  it("admits the canonical spelling when only the symlink spelling is an admitted root", async () => {
    const { rig, canonical, link } = symlinkRig("symlink-spelling-admitted");
    admitAndLease(rig.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    const svc = serviceFor(rig, bindingFor(rig, {
      invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A,
      admittedRoots: [link],
    }));
    const treeHash = committedTreeHash(rig.repo)!;
    const cmd = "echo reverse-admission";
    const cmdHash = computeCmdHash(cmd);
    const claim = await svc.claim({ originRepo: canonical, treeHash, cmdHash, namespace: NS_A, ownerToken: "tok-reverse" });
    assert.ok(claim.ok, "canonical spelling is admitted against a symlink-spelled admitted root");
    const rec = await svc.record({
      originRepo: canonical, treeHash, cmdHash, namespace: NS_A,
      cmdDisplay: cmd, exitCode: 0, durationMs: 5, logTail: null,
      runId: RUN_ID, stepId: STEP_A, force: false, startedAt: "2026-09-16T00:00:00.000Z",
    });
    assert.ok(rec.ok);
    const lookup = await svc.lookup({ originRepo: canonical, treeHash, cmdHash, namespace: NS_A });
    assert.ok(lookup.ok);
    if (lookup.ok) assert.equal(lookup.value.latest?.origin_repo, canonical);
    svc["store"].close();
  });

  it("still refuses an unadmitted root and a mere string-prefix sibling with the exact DENIED message", async () => {
    const { rig, canonical } = symlinkRig("symlink-unadmitted");
    admitAndLease(rig.registry, { invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A });
    const svc = serviceFor(rig, bindingFor(rig, {
      invocationId: INV_A, stepRowId: ROW_A, stepId: STEP_A,
      admittedRoots: [canonical],
    }));
    const treeHash = committedTreeHash(rig.repo)!;
    const cmdHash = computeCmdHash("echo denied");
    const expected = "origin_repo is not one of this invocation's admitted repository roots";
    // A REAL sibling directory sharing the canonical root's string prefix.
    const prefixSibling = `${canonical}-sibling`;
    fs.mkdirSync(prefixSibling, { recursive: true });
    assert.equal(fs.realpathSync.native(prefixSibling).startsWith(canonical), true, "prefix-sibling shares the string prefix");
    for (const originRepo of ["/unadmitted/repo", prefixSibling]) {
      const claim = await svc.claim({ originRepo, treeHash, cmdHash, namespace: NS_A, ownerToken: "tok-deny" });
      assert.equal(claim.ok, false, `${originRepo} must stay refused`);
      if (!claim.ok && claim.reason === "refused") {
        assert.equal(claim.code, "DENIED");
        assert.equal(claim.message, expected);
      }
    }
    assert.equal(svc["store"].claimCount(), 0, "no refusal mutated the store");
    svc["store"].close();
  });
});
