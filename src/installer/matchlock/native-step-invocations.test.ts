/**
 * HostInvocationRegistry pure-logic tests (parallel lane; no step-ops, no DB,
 * no child processes). Proves the registry's two-layer host model:
 *
 *   1. INVOCATION ADMISSION/LIFETIME: the host admits a unique invocation
 *      identity before it may act; revocation is TERMINAL for that identity —
 *      a revoked invocation can never be re-admitted or re-registered by any
 *      guest-facing path, including revocation before its first claim.
 *   2. CLAIM LEASE: single-active-holder semantics keyed by invocation (jobId
 *      equality alone is never treated as claim identity), plus legitimate
 *      post-transition release distinct from terminal revocation.
 *
 * Also covers scope discard (clear() is permanent: it can never restore a
 * living revoked service) and bounded per-scope revocation records.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostInvocationRegistry, type InvocationLease } from "../../../dist/installer/matchlock/native-step-invocations.js";

const INV_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INV_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INV_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STEP_X = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const STEP_Y = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const RUN = "11111111-1111-4111-8111-111111111111";
const JOB = "job-stable";

function admission(invocationId: string, over: Partial<Parameters<HostInvocationRegistry["admitInvocation"]>[0]> = {}) {
  return { invocationId, runId: RUN, agentId: "dev", jobId: JOB, admittedAtMs: 1000, ...over };
}

function lease(invocationId = INV_A, over: Partial<InvocationLease> = {}): InvocationLease {
  return {
    stepRowId: STEP_X,
    stepId: "plan",
    runId: RUN,
    agentId: "dev",
    invocationId,
    jobId: JOB,
    claimId: `${invocationId}@${JOB}`,
    rowToken: "job-stable|1||t1",
    claimedAtMs: 1000,
    ...over,
  };
}

function admitted(reg: HostInvocationRegistry, invocationId = INV_A): void {
  const r = reg.admitInvocation(admission(invocationId));
  assert.equal(r.ok, true);
}

describe("HostInvocationRegistry", () => {
  it("admits an invocation then registers and retrieves a lease by step and by invocation", () => {
    const reg = new HostInvocationRegistry();
    admitted(reg, INV_A);
    assert.equal(reg.isInvocationActive(INV_A), true, "admission is independent of any held claim");
    assert.equal(reg.size, 0, "admission alone holds no lease");
    assert.equal(reg.register(lease()).ok, true);
    assert.equal(reg.size, 1);
    assert.equal(reg.getLeaseByStep(STEP_X)?.invocationId, INV_A);
    assert.equal(reg.getLeaseByInvocation(INV_A)?.stepRowId, STEP_X);
    assert.equal(reg.isInvocationActive(INV_A), true);
    assert.equal(reg.isInvocationActive(INV_B), false, "never-admitted invocation is not active");
  });

  it("refuses a lease for an invocation that was never admitted (no guest authority)", () => {
    const reg = new HostInvocationRegistry();
    const refused = reg.register(lease());
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.reason, /not a live host admission/);
    assert.equal(reg.size, 0);
  });

  it("refuses a second active invocation on the same step (single active holder)", () => {
    const reg = new HostInvocationRegistry();
    admitted(reg, INV_A);
    admitted(reg, INV_B);
    reg.register(lease(INV_A));
    const conflict = reg.register(lease(INV_B));
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.match(conflict.reason, /already actively claimed by invocation/);
    // The original lease is untouched.
    assert.equal(reg.getLeaseByStep(STEP_X)?.invocationId, INV_A);
  });

  it("an invocation cannot hold two steps at once", () => {
    const reg = new HostInvocationRegistry();
    admitted(reg, INV_A);
    reg.register(lease(INV_A));
    const conflict = reg.register(lease(INV_A, { stepRowId: STEP_Y, stepId: "verify" }));
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.match(conflict.reason, /already holds step/);
  });

  it("same-job successive invocations carry distinct leases (jobId alone is never identity)", () => {
    const reg = new HostInvocationRegistry();
    admitted(reg, INV_A);
    reg.register(lease(INV_A));
    // Invocation A is terminally revoked by the host (same stable job id) and
    // the host admits a FRESH successor identity B.
    assert.equal(reg.revokeInvocation(INV_A, "VM close"), 1);
    admitted(reg, INV_B);
    const adopted = reg.register(lease(INV_B));
    assert.equal(adopted.ok, true);
    assert.equal(reg.getLeaseByInvocation(INV_B)?.claimId, `${INV_B}@${JOB}`);
    assert.equal(reg.getLeaseByInvocation(INV_A), undefined);
    assert.equal(reg.getLeaseByStep(STEP_X)?.invocationId, INV_B);
  });

  it("revocation is TERMINAL: the revoked identity cannot register again (no resurrection)", () => {
    const reg = new HostInvocationRegistry();
    admitted(reg, INV_A);
    assert.equal(reg.revokeInvocation(INV_A, "canceled"), 0, "revocation before any lease still sticks");
    const reRegister = reg.register(lease(INV_A));
    assert.equal(reRegister.ok, false);
    if (!reRegister.ok) assert.match(reRegister.reason, /revoked or never admitted/);
    assert.equal(reg.revokeInvocation(INV_A), 0, "repeat revocation releases nothing new");
    assert.equal(reg.getAdmission(INV_A)?.state, "revoked");
    assert.equal(reg.isInvocationActive(INV_A), false);
  });

  it("revocation is TERMINAL: the revoked identity cannot be re-admitted by the host or anyone", () => {
    const reg = new HostInvocationRegistry();
    admitted(reg, INV_A);
    reg.revokeInvocation(INV_A, "close");
    const readmit = reg.admitInvocation(admission(INV_A));
    assert.equal(readmit.ok, false);
    if (!readmit.ok) assert.match(readmit.reason, /cannot be re-admitted/);
    assert.equal(reg.getAdmission(INV_A)?.revokeReason, "close");
    assert.equal(reg.admissionCount, 1);
    assert.equal(reg.revocationCount, 1);
  });

  it("revokeInvocation releases exactly that invocation's lease and keeps OTHER invocations untouched", () => {
    const reg = new HostInvocationRegistry();
    admitted(reg, INV_A);
    admitted(reg, INV_B);
    reg.register(lease(INV_A));
    // Revoking a lease-less admitted invocation releases nothing but still
    // terminally revokes THAT identity only.
    assert.equal(reg.revokeInvocation(INV_B), 0);
    assert.equal(reg.getAdmission(INV_B)?.state, "revoked");
    assert.equal(reg.revokeInvocation(INV_A), 1);
    assert.equal(reg.size, 0);
    assert.equal(reg.isInvocationActive(INV_A), false);
    // An unrelated live admission that was NOT revoked stays live.
    const reg2 = new HostInvocationRegistry();
    admitted(reg2, INV_A);
    admitted(reg2, INV_B);
    reg2.register(lease(INV_A));
    reg2.revokeInvocation(INV_A);
    assert.equal(reg2.isInvocationActive(INV_B), true, "an unrelated live admission is untouched");
    assert.equal(reg2.getLeaseByInvocation(INV_B), undefined);
  });

  it("revokeStep terminally supersedes the holder (returns the released lease)", () => {
    const reg = new HostInvocationRegistry();
    admitted(reg, INV_A);
    reg.register(lease(INV_A));
    const released = reg.revokeStep(STEP_X);
    assert.equal(released?.invocationId, INV_A);
    assert.equal(reg.size, 0);
    assert.equal(reg.revokeStep(STEP_X), undefined);
    // The superseded holder is terminally revoked: it cannot re-register.
    const resurrection = reg.register(lease(INV_A));
    assert.equal(resurrection.ok, false);
    if (!resurrection.ok) assert.match(resurrection.reason, /revoked or never admitted/);
    assert.equal(reg.getAdmission(INV_A)?.state, "revoked");
  });

  it("releaseIfHeldBy only releases when the invocation actually holds the step and keeps the invocation LIVE", () => {
    const reg = new HostInvocationRegistry();
    admitted(reg, INV_A);
    reg.register(lease(INV_A));
    assert.equal(reg.releaseIfHeldBy(INV_B, STEP_X), false);
    assert.equal(reg.releaseIfHeldBy(INV_A, STEP_Y), false);
    assert.equal(reg.releaseIfHeldBy(INV_A, STEP_X), true);
    assert.equal(reg.size, 0);
    assert.equal(reg.releaseIfHeldBy(INV_A, STEP_X), false);
    // Legitimate post-transition release is NOT a revocation: the invocation
    // stays admitted and may hold a different (fresh) claim.
    assert.equal(reg.isInvocationActive(INV_A), true);
    assert.equal(reg.getAdmission(INV_A)?.state, "admitted");
    admitted(reg, INV_A); // idempotent re-admit is fine for a live admission
    assert.equal(reg.admissionCount, 1, "re-admit of a live admission adds no record");
    assert.equal(reg.revocationCount, 0);
  });

  it("release after legit transition does not clear a revocation record (separate paths)", () => {
    const reg = new HostInvocationRegistry();
    admitted(reg, INV_A);
    reg.register(lease(INV_A));
    reg.revokeInvocation(INV_A, "terminal"); // revocation with a live lease
    // releaseIfHeldBy finds nothing (lease already dropped by revocation).
    assert.equal(reg.releaseIfHeldBy(INV_A, STEP_X), false);
    assert.equal(reg.getAdmission(INV_A)?.state, "revoked", "lease release never restores a revoked service");
  });

  it("clear discards the whole scope: no further admission or registration (no zombie restoration)", () => {
    const reg = new HostInvocationRegistry();
    admitted(reg, INV_A);
    reg.revokeInvocation(INV_A, "terminal");
    reg.register(lease(INV_B, { stepRowId: STEP_Y, stepId: "verify" })); // refused: B never admitted
    admitted(reg, INV_B);
    reg.register(lease(INV_B, { stepRowId: STEP_Y, stepId: "verify" }));
    assert.equal(reg.size, 1);
    reg.clear();
    assert.equal(reg.size, 0);
    assert.equal(reg.isInvocationActive(INV_A), false);
    assert.equal(reg.isInvocationActive(INV_B), false);
    // After scope discard the registry refuses everything — a revoked adapter
    // object that survives clear() can never resurrect its authority.
    const reg2 = new HostInvocationRegistry();
    admitted(reg2, INV_C);
    reg2.register(lease(INV_C));
    reg2.revokeInvocation(INV_C, "terminal");
    reg2.clear();
    const readmit = reg2.admitInvocation(admission(INV_C));
    assert.equal(readmit.ok, false);
    if (!readmit.ok) assert.match(readmit.reason, /scope was discarded/);
    const reregister = reg2.register(lease(INV_C));
    assert.equal(reregister.ok, false);
    if (!reregister.ok) assert.match(reregister.reason, /scope was discarded/);
  });

  it("admission/revocation records are bounded per scope and never counted as leases", () => {
    const reg = new HostInvocationRegistry();
    for (let i = 0; i < 10; i++) {
      const id = `f0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const a = reg.admitInvocation({ ...admission(id) });
      assert.equal(a.ok, true);
      reg.revokeInvocation(id, "round end");
    }
    assert.equal(reg.size, 0);
    assert.equal(reg.admissionCount, 10);
    assert.equal(reg.revocationCount, 10);
    // Every revoked id stays dead; fresh ids still work (bounded scope).
    const fresh = "f1111111-1111-4111-8111-111111111111";
    const a = reg.admitInvocation({ ...admission(fresh) });
    assert.equal(a.ok, true);
    const bad = reg.admitInvocation({ ...admission("f0000000-0000-4000-8000-000000000000") });
    assert.equal(bad.ok, false);
    // A fresh registry scope (per run/agent controller lifetime) starts empty.
    const next = new HostInvocationRegistry();
    assert.equal(next.admissionCount, 0);
    assert.equal(next.revocationCount, 0);
  });
});
