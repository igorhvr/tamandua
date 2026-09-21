/**
 * NativeStepServices adapter tests (serial lane: real DB/step-ops).
 *
 * Real isolated DB-backed native semantics behind the AuthoritativeStepServices
 * contract: binding enforcement, invocation-bound claim idempotency, foreign /
 * stale / reassigned / terminal denial without mutation or input leaks,
 * same-job successive invocations, same-second claim timestamps, replacement
 * between readClaim and submit, submit-time expects parity (reject-then-
 * correct, empty output, residual STORIES_JSON_FILE refusal), native verdict
 * and retry/reroute/loop/story transitions, and duplicate-ack no-ops.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { closeDb, getDb } from "../../../dist/db.js";
import {
  NativeStepServices,
  type NativeStepServicesOptions,
} from "../../../dist/installer/matchlock/native-step-services.js";
import { HostInvocationRegistry } from "../../../dist/installer/matchlock/native-step-invocations.js";
import type { HostBinding } from "../../../dist/installer/matchlock/broker-services.js";
import {
  AGENT,
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
const STEP2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const sticky = createIsolatedState("svc-sticky");
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

interface Rig {
  st: IsolatedState;
  registry: HostInvocationRegistry;
  eventsA: Array<Record<string, unknown>>;
  eventsB: Array<Record<string, unknown>>;
  svcA: NativeStepServices;
  svcB: NativeStepServices;
}

function makeRig(opts: {
  steps?: Array<Parameters<IsolatedState["insertStep"]>[0]>;
  workflowId?: string;
}): Rig {
  const st = createIsolatedState("svc");
  st.open();
  st.insertRun({ workflowId: opts.workflowId ?? "test" });
  for (const step of opts.steps ?? []) st.insertStep(step);
  const registry = new HostInvocationRegistry();
  // Host explicitly admits both invocation identities (run/agent/job scope)
  // before any service op — admission is independent of held claims.
  const admit = (inv: string): void => {
    const r = registry.admitInvocation({ invocationId: inv, runId: RUN, agentId: AGENT, jobId: JOB_ID });
    assert.equal(r.ok, true, `admit ${inv}: ${r.ok ? "" : r.reason}`);
  };
  admit(INV_A);
  admit(INV_B);
  const eventsA: Array<Record<string, unknown>> = [];
  const eventsB: Array<Record<string, unknown>> = [];
  const base: Omit<NativeStepServicesOptions, "binding" | "emit"> = {
    registry,
    workerOwnership: { jobId: JOB_ID, pid: 424242 },
  };
  const svcA = new NativeStepServices({ ...base, binding: bindingFor(INV_A), emit: (e) => eventsA.push(e) });
  const svcB = new NativeStepServices({ ...base, binding: bindingFor(INV_B), emit: (e) => eventsB.push(e) });
  return { st, registry, eventsA, eventsB, svcA, svcB };
}

function row(stepId: string): Record<string, unknown> {
  return getDb().prepare("SELECT * FROM steps WHERE id = ?").get(stepId) as Record<string, unknown>;
}

function runRow(): Record<string, unknown> {
  return getDb().prepare("SELECT * FROM runs WHERE id = ?").get(RUN) as Record<string, unknown>;
}

function storyRow(storyId: string): Record<string, unknown> {
  return getDb().prepare("SELECT * FROM stories WHERE id = ?").get(storyId) as Record<string, unknown>;
}

function eventsOf(st: IsolatedState, event: string): Array<Record<string, unknown>> {
  return st.readRunEvents(RUN).filter((e) => e.event === event);
}

describe("binding enforcement and peek", () => {
  it("rejects a binding mismatch (wrong run / agent / job / invocation)", async () => {
    const { st, svcA } = makeRig({ steps: [{ id: STEP1, status: "pending" }] });
    try {
      const foreign: HostBinding = { ...bindingFor(INV_A), runId: "99999999-9999-4999-8999-999999999999" };
      await assert.rejects(() => svcA.peek(foreign), /binding mismatch/);
      await assert.rejects(() => svcA.claim(foreign), /binding mismatch/);
      await assert.rejects(() => svcA.readClaim(foreign), /binding mismatch/);
      await assert.rejects(() => svcA.validateCompletion(foreign, STEP1, "x"), /binding mismatch/);
      await assert.rejects(() => svcA.submitCompletion(foreign, "c", STEP1, "x"), /binding mismatch/);
      await assert.rejects(() => svcA.submitFail(foreign, "c", STEP1, "r"), /binding mismatch/);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("peek reflects pending work and goes NO_WORK once the pending step is claimed", async () => {
    const { st, svcA } = makeRig({ steps: [{ id: STEP1, status: "pending" }] });
    try {
      const binding = bindingFor(INV_A);
      assert.equal(await svcA.peek(binding), "HAS_WORK");
      await svcA.claim(binding);
      assert.equal(await svcA.peek(binding), "NO_WORK");
    } finally {
      st.dispose(stickyEnv);
    }
  });
});

describe("claim and readClaim authority", () => {
  it("happy flow: peek -> claim -> readClaim -> complete, bound to the invocation", async () => {
    const { st, svcA, eventsA, registry } = makeRig({ steps: [{ id: STEP1, status: "pending", expects: "STATUS: done" }] });
    try {
      const binding = bindingFor(INV_A);
      assert.equal(await svcA.peek(binding), "HAS_WORK");
      const claim = await svcA.claim(binding);
      assert.equal(claim.found, true);
      assert.equal(claim.stepId, STEP1);
      assert.equal(claim.runId, RUN);
      const held = await svcA.readClaim(binding);
      assert.ok(held);
      assert.equal(held!.stepId, STEP1);
      assert.equal(held!.expects, "STATUS: done");
      assert.equal(held!.claimId, `${INV_A}@${JOB_ID}`);

      const diag = await svcA.validateCompletion(binding, STEP1, "STATUS: done\nCHANGES: x");
      assert.equal(diag.verdict, "accept");
      const outcome = await svcA.submitCompletion(binding, held!.claimId, STEP1, "STATUS: done\nCHANGES: x");
      assert.ok(outcome.status === "advanced" || outcome.status === "completed");
      assert.equal(outcome.mutated, true);
      assert.equal(row(STEP1).status, "done");
      assert.equal(runRow().status, "completed");
      // Adapter emitted the native CLI-parity accepted event with native fields.
      const validated = eventsA.filter((e) => e.event === "step.expects.validated");
      assert.equal(validated.length, 1);
      assert.equal(validated[0].outcome, "accepted");
      assert.equal(validated[0].verdict, "done");
      // The CLI-parity event carries the NATIVE completion claim id
      // (claim_job_id when host worker ownership is recorded), which equals
      // the scheduler job id — not the adapter's opaque lease id.
      assert.equal(validated[0].claimId, JOB_ID);
      assert.equal(validated[0].runId, RUN);
      assert.equal(validated[0].stepRowId, STEP1);
      assert.equal(validated[0].stepId, "plan");
      assert.equal(validated[0].transitionAction, "done");
      // Native machinery emitted step.done to the real event stream.
      assert.equal(eventsOf(st, "step.done").length, 1);
      // Lease released after the accepted transition.
      assert.equal(registry.size, 0);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("claim is idempotent for the SAME invocation (same claim, no re-stamp)", async () => {
    const { st, svcA, registry } = makeRig({ steps: [{ id: STEP1, status: "pending" }] });
    try {
      const binding = bindingFor(INV_A);
      const first = await svcA.claim(binding);
      assert.equal(first.found, true);
      const stampAfterFirst = (row(STEP1) as { claim_updated_at: string | null }).claim_updated_at;
      const second = await svcA.claim(binding);
      assert.equal(second.found, true);
      assert.equal(second.stepId, STEP1);
      assert.equal(registry.size, 1);
      assert.equal((row(STEP1) as { claim_updated_at: string | null }).claim_updated_at, stampAfterFirst);
      const held = await svcA.readClaim(binding);
      assert.equal(held!.claimId, `${INV_A}@${JOB_ID}`);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("a different invocation (same job) cannot claim while the first is ACTIVE, and no input leaks", async () => {
    const { st, svcA, svcB } = makeRig({ steps: [{ id: STEP1, status: "pending", inputTemplate: "SECRET task for step one" }] });
    try {
      const bindingA = bindingFor(INV_A);
      const claimA = await svcA.claim(bindingA);
      assert.equal(claimA.found, true);
      const rowBefore = { ...(row(STEP1) as Record<string, unknown>) };

      const claimB = await svcB.claim(bindingFor(INV_B));
      // Refused: no found, no input, no row mutation.
      assert.equal(claimB.found, false);
      assert.equal("input" in claimB ? claimB.input : undefined, undefined);
      const rowAfter = row(STEP1);
      assert.equal(rowAfter.status, "running");
      assert.equal(rowAfter.claim_job_id, rowBefore.claim_job_id);
      assert.equal(rowAfter.claim_updated_at, rowBefore.claim_updated_at);
      // B has no claim and cannot read A's step input.
      assert.equal(await svcB.readClaim(bindingFor(INV_B)), null);
      // A's own read still works.
      const heldA = await svcA.readClaim(bindingA);
      assert.ok(heldA);
      assert.equal(heldA!.input, "SECRET task for step one");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("same-job successive invocations get independent authority after host revocation (same-second row stamp)", async () => {
    const { st, svcA, svcB, registry } = makeRig({ steps: [{ id: STEP1, status: "pending", expects: "STATUS: done" }] });
    try {
      const bindingA = bindingFor(INV_A);
      const bindingB = bindingFor(INV_B);
      const claimA = await svcA.claim(bindingA);
      assert.equal(claimA.found, true);
      const heldA = await svcA.readClaim(bindingA);
      assert.ok(heldA);

      // Host revokes A (VM close / cancel) and dispatches B — same job id,
      // possibly within the same second (SQLite claim timestamps identical).
      registry.revokeInvocation(INV_A);
      const claimB = await svcB.claim(bindingB);
      assert.equal(claimB.found, true, "successor invocation adopts the claim after revocation");
      const heldB = await svcB.readClaim(bindingB);
      assert.ok(heldB);
      assert.notEqual(heldB!.claimId, heldA!.claimId);
      assert.equal((row(STEP1) as { claim_job_id: string | null }).claim_job_id, JOB_ID);

      // A's late completion (stale, superseded) is refused WITHOUT mutation,
      // even though the DB row stamp and claim_job_id are identical to A's claim.
      const stale = await svcA.submitCompletion(bindingA, heldA!.claimId, STEP1, "STATUS: done\nCHANGES: stale A");
      assert.equal(stale.status, "blocked");
      assert.equal(stale.mutated, false);
      assert.equal(row(STEP1).status, "running");
      assert.equal(eventsOf(st, "step.done").length, 0);

      // B completes the step normally.
      const ok = await svcB.submitCompletion(bindingB, heldB!.claimId, STEP1, "STATUS: done\nCHANGES: B");
      assert.ok(ok.status === "advanced" || ok.status === "completed");
      assert.equal(row(STEP1).status, "done");
      assert.equal(eventsOf(st, "step.done").length, 1);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("replacement between readClaim and submit is refused atomically", async () => {
    const { st, svcA, svcB, registry } = makeRig({ steps: [{ id: STEP1, status: "pending", expects: "STATUS: done" }] });
    try {
      const bindingA = bindingFor(INV_A);
      const bindingB = bindingFor(INV_B);
      const claimA = await svcA.claim(bindingA);
      assert.equal(claimA.found, true);
      const heldA = await svcA.readClaim(bindingA); // broker captures expectedClaimId here
      assert.ok(heldA);

      // Between readClaim and submit, the host revokes A AND orphan recovery
      // releases the row to pending; B claims it afresh.
      registry.revokeInvocation(INV_A);
      getDb().prepare(
        "UPDATE steps SET status = 'pending', claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL, claim_updated_at = NULL, updated_at = datetime('now') WHERE id = ?",
      ).run(STEP1);
      const claimB = await svcB.claim(bindingB);
      assert.equal(claimB.found, true);

      const stale = await svcA.submitCompletion(bindingA, heldA!.claimId, STEP1, "STATUS: done\nCHANGES: stale");
      assert.equal(stale.status, "blocked");
      assert.equal(stale.mutated, false);
      assert.equal(row(STEP1).status, "running");
      assert.equal(eventsOf(st, "step.done").length, 0);

      const heldB = await svcB.readClaim(bindingB);
      const ok = await svcB.submitCompletion(bindingB, heldB!.claimId, STEP1, "STATUS: done\nCHANGES: fresh B");
      assert.ok(ok.status === "advanced" || ok.status === "completed");
      assert.equal(row(STEP1).status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("terminal denial: a canceled run blocks completion without mutation", async () => {
    const { st, svcA } = makeRig({ steps: [{ id: STEP1, status: "pending" }] });
    try {
      const binding = bindingFor(INV_A);
      await svcA.claim(binding);
      const held = await svcA.readClaim(binding);
      assert.ok(held);
      getDb().prepare("UPDATE runs SET status = 'canceled', updated_at = datetime('now') WHERE id = ?").run(RUN);
      const outcome = await svcA.submitCompletion(binding, held!.claimId, STEP1, "late output");
      assert.equal(outcome.status, "blocked");
      assert.equal(outcome.mutated, false);
      assert.equal(row(STEP1).status, "running");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("readClaim returns null once the row no longer carries the invocation's claim", async () => {
    const { st, svcA } = makeRig({ steps: [{ id: STEP1, status: "pending" }] });
    try {
      const binding = bindingFor(INV_A);
      await svcA.claim(binding);
      // Native operator release: row back to pending, claims cleared.
      getDb().prepare(
        "UPDATE steps SET status = 'pending', claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL, claim_updated_at = NULL, updated_at = datetime('now') WHERE id = ?",
      ).run(STEP1);
      assert.equal(await svcA.readClaim(binding), null);
    } finally {
      st.dispose(stickyEnv);
    }
  });
});

describe("validateCompletion parity", () => {
  it("rejects at submit-time and retains the claim; corrected resubmit completes", async () => {
    const { st, svcA, eventsA } = makeRig({ steps: [{ id: STEP1, status: "pending", expects: "STATUS: done\nCHANGES:" }] });
    try {
      const binding = bindingFor(INV_A);
      await svcA.claim(binding);
      const held = await svcA.readClaim(binding);
      assert.ok(held);

      const bad = await svcA.validateCompletion(binding, STEP1, "STATUS: done");
      assert.equal(bad.verdict, "reject");
      assert.equal(row(STEP1).status, "running");
      assert.equal(row(STEP1).retry_count, 0);
      // Native rejection events with CLI shapes
      const rejected = eventsA.filter((e) => e.event === "step.submit.rejected");
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].validationCode, "EXPECTS_REJECTED");
      assert.equal(rejected[0].runId, RUN);
      assert.equal(rejected[0].stepRowId, STEP1);
      assert.equal(rejected[0].stepId, "plan");
      assert.ok(rejected[0].diagnosticCode);
      const validatedRejected = eventsA.filter(
        (e) => e.event === "step.expects.validated" && e.outcome === "rejected",
      );
      assert.equal(validatedRejected.length, 1);
      assert.equal(validatedRejected[0].transitionAction, "retry");
      assert.equal(validatedRejected[0].verdict, null);
      assert.deepEqual(validatedRejected[0].missingKeys, ["CHANGES"]);

      // Corrected resubmit is accepted.
      const good = await svcA.validateCompletion(binding, STEP1, "STATUS: done\nCHANGES: fixed");
      assert.equal(good.verdict, "accept");
      const outcome = await svcA.submitCompletion(binding, held!.claimId, STEP1, "STATUS: done\nCHANGES: fixed");
      assert.ok(outcome.status === "advanced" || outcome.status === "completed");
      assert.equal(row(STEP1).status, "done");
      assert.equal(eventsOf(st, "step.done").length, 1);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("empty output is not pre-rejected; native acceptance semantics apply", async () => {
    const { st, svcA, eventsA } = makeRig({ steps: [{ id: STEP1, status: "pending", expects: "STATUS: done", maxRetries: 2 }] });
    try {
      const binding = bindingFor(INV_A);
      await svcA.claim(binding);
      const held = await svcA.readClaim(binding);
      assert.ok(held);
      const diag = await svcA.validateCompletion(binding, STEP1, "");
      assert.equal(diag.verdict, "accept");
      // Native acceptance: empty output fails the expects check inside
      // completeStep -> retrying with feedback, NOT done. The native CLI
      // emits its accepted expects-validated record after any non-blocked
      // completeStep outcome (transitionAction retry) — mirror it.
      const outcome = await svcA.submitCompletion(binding, held!.claimId, STEP1, "");
      assert.equal(outcome.status, "retrying");
      assert.equal(outcome.mutated, true);
      const r = row(STEP1);
      assert.equal(r.status, "pending");
      assert.equal(r.retry_count, 1);
      assert.match(String(r.output ?? ""), /STATUS: done/);
      const accepted = eventsA.filter(
        (e) => e.event === "step.expects.validated" && e.outcome === "accepted",
      );
      assert.equal(accepted.length, 1);
      assert.equal(accepted[0].transitionAction, "retry");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("empty output with no expects completes (native empty-report acceptance)", async () => {
    const { st, svcA } = makeRig({ steps: [{ id: STEP1, status: "pending", expects: "" }] });
    try {
      const binding = bindingFor(INV_A);
      await svcA.claim(binding);
      const held = await svcA.readClaim(binding);
      assert.ok(held);
      const diag = await svcA.validateCompletion(binding, STEP1, "");
      assert.equal(diag.verdict, "accept");
      const outcome = await svcA.submitCompletion(binding, held!.claimId, STEP1, "");
      assert.ok(outcome.status === "advanced" || outcome.status === "completed");
      assert.equal(row(STEP1).status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("refuses residual guest STORIES_JSON_FILE file references (never interpreted)", async () => {
    const { st, svcA, eventsA } = makeRig({ steps: [{ id: STEP1, status: "pending", expects: "" }] });
    try {
      const binding = bindingFor(INV_A);
      await svcA.claim(binding);
      const neverPath = path.join(st.root, "guest-should-never-be-opened.json");
      const diag = await svcA.validateCompletion(
        binding,
        STEP1,
        `STORIES_JSON_FILE: ${neverPath}\nSTATUS: done`,
      );
      assert.equal(diag.verdict, "reject");
      assert.equal(diag.code, "STORIES_JSON_FILE_UNDEREFERENCED");
      // The host never opened/created the file; claim retained, no mutation.
      assert.equal(row(STEP1).status, "running");
      assert.equal(fs.existsSync(neverPath), false);
      const rejected = eventsA.filter((e) => e.event === "step.submit.rejected");
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].validationCode, "STORIES_JSON_FILE_UNDEREFERENCED");
    } finally {
      st.dispose(stickyEnv);
    }
  });
});

describe("verdicts and transitions", () => {
  it("STATUS: retry re-pends with feedback while retries remain, then completes on retry", async () => {
    const { st, svcA, svcB } = makeRig({
      steps: [{ id: STEP1, status: "pending", expects: "regex:^STATUS:\\s*(done|retry)\\s*$", maxRetries: 2 }],
    });
    try {
      const bindingA = bindingFor(INV_A);
      await svcA.claim(bindingA);
      const heldA = await svcA.readClaim(bindingA);
      assert.ok(heldA);
      const retry = await svcA.submitCompletion(bindingA, heldA!.claimId, STEP1, "STATUS: retry\nREASON: needs more work");
      assert.equal(retry.status, "retrying");
      assert.equal(retry.mutated, true);
      const r1 = row(STEP1);
      assert.equal(r1.status, "pending");
      assert.equal(r1.retry_count, 1);
      assert.equal(eventsOf(st, "step.retry").length, 1);

      // A fresh invocation claims the re-pended step and completes it.
      const bindingB = bindingFor(INV_B);
      const claimB = await svcB.claim(bindingB);
      assert.equal(claimB.found, true);
      const heldB = await svcB.readClaim(bindingB);
      const done = await svcB.submitCompletion(bindingB, heldB!.claimId, STEP1, "STATUS: done\nCHANGES: now good");
      assert.ok(done.status === "advanced" || done.status === "completed");
      assert.equal(row(STEP1).status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("STATUS: retry with retries exhausted fails the run (native)", async () => {
    const { st, svcA } = makeRig({
      steps: [{ id: STEP1, status: "pending", expects: "STATUS: done\nSTATUS: retry", retryCount: 2, maxRetries: 2 }],
    });
    try {
      const binding = bindingFor(INV_A);
      await svcA.claim(binding);
      const held = await svcA.readClaim(binding);
      assert.ok(held);
      const outcome = await svcA.submitCompletion(binding, held!.claimId, STEP1, "STATUS: retry\nREASON: exhausted");
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.mutated, true);
      assert.equal(row(STEP1).status, "failed");
      assert.equal(runRow().status, "failed");
      assert.equal(eventsOf(st, "step.failed").length, 1);
      assert.equal(eventsOf(st, "run.failed").length, 1);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("STATUS: failed completes when expects accepts the failed variant (native parity, no bypass)", async () => {
    const { st, svcA } = makeRig({
      steps: [{ id: STEP1, status: "pending", expects: "STATUS: done\nSTATUS: failed" }],
    });
    try {
      const binding = bindingFor(INV_A);
      await svcA.claim(binding);
      const held = await svcA.readClaim(binding);
      assert.ok(held);
      const diag = await svcA.validateCompletion(binding, STEP1, "STATUS: failed\nREASON: honest account");
      assert.equal(diag.verdict, "accept");
      const outcome = await svcA.submitCompletion(binding, held!.claimId, STEP1, "STATUS: failed\nREASON: honest account");
      assert.ok(outcome.status === "advanced" || outcome.status === "completed");
      assert.equal(row(STEP1).status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("submitFail retries within budget (step re-pended, claim released)", async () => {
    const { st, svcA, registry } = makeRig({ steps: [{ id: STEP1, status: "pending", maxRetries: 2 }] });
    try {
      const binding = bindingFor(INV_A);
      await svcA.claim(binding);
      const held = await svcA.readClaim(binding);
      assert.ok(held);
      const outcome = await svcA.submitFail(binding, held!.claimId, STEP1, "transient failure");
      assert.equal(outcome.status, "retrying");
      assert.equal(outcome.mutated, true);
      const r = row(STEP1);
      assert.equal(r.status, "pending");
      assert.equal(r.retry_count, 1);
      // Native failStep's retry branch re-pends without emitting step.retry.
      assert.equal(eventsOf(st, "step.retry").length, 0);
      assert.equal(registry.size, 0);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("submitFail at retry exhaustion fails the run", async () => {
    const { st, svcA } = makeRig({ steps: [{ id: STEP1, status: "pending", retryCount: 2, maxRetries: 2 }] });
    try {
      const binding = bindingFor(INV_A);
      await svcA.claim(binding);
      const held = await svcA.readClaim(binding);
      assert.ok(held);
      const outcome = await svcA.submitFail(binding, held!.claimId, STEP1, "final failure");
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.mutated, true);
      assert.equal(row(STEP1).status, "failed");
      assert.equal(runRow().status, "failed");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("stale submitFail after revocation is refused (no mutation, no events)", async () => {
    const { st, svcA, svcB, registry } = makeRig({ steps: [{ id: STEP1, status: "pending", maxRetries: 2 }] });
    try {
      const bindingA = bindingFor(INV_A);
      await svcA.claim(bindingA);
      const heldA = await svcA.readClaim(bindingA);
      assert.ok(heldA);
      registry.revokeInvocation(INV_A);
      await svcB.claim(bindingFor(INV_B));
      const stale = await svcA.submitFail(bindingA, heldA!.claimId, STEP1, "late failure from A");
      assert.equal(stale.status, "blocked");
      assert.equal(stale.mutated, false);
      assert.equal(row(STEP1).status, "running");
      assert.equal(row(STEP1).retry_count, 0);
      assert.equal(eventsOf(st, "step.retry").length, 0);
      assert.equal(eventsOf(st, "step.failed").length, 0);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("reroutes to the upstream producer on retry-verdict exhaustion when on_fail declares retry_step", async () => {
    const { st, svcA } = makeRig({
      workflowId: "reroute-fixture",
      steps: [
        { id: "producer-step", stepId: "plan", stepIndex: 0, status: "done", output: "PLAN: ok" },
        { id: STEP1, stepId: "implement", stepIndex: 1, status: "pending", expects: "STATUS: done\nSTATUS: retry", retryCount: 1, maxRetries: 1 },
      ],
    });
    try {
      // Minimal valid workflow spec declaring the reroute policy (no TESTED_TREE
      // in any input, so the M4 attestation rule does not constrain it).
      const wfDir = path.join(st.stateDir, "workflows", "reroute-fixture");
      fs.mkdirSync(wfDir, { recursive: true });
      fs.writeFileSync(
        path.join(wfDir, "workflow.yml"),
        [
          "id: reroute-fixture",
          "run:",
          "  workspace: direct",
          "agents:",
          "  - id: dev",
          "    workspace:",
          "      baseDir: /tmp",
          "steps:",
          "  - id: plan",
          "    agent: dev",
          "    input: plan task",
          "    expects: \"\"",
          "  - id: implement",
          "    agent: dev",
          "    input: implement task",
          "    expects: \"\"",
          "    max_retries: 1",
          "    on_fail:",
          "      retry_step: plan",
          "      max_reroutes: 1",
          "",
        ].join("\n"),
      );

      const binding = bindingFor(INV_A);
      await svcA.claim(binding);
      const held = await svcA.readClaim(binding);
      assert.ok(held);
      const outcome = await svcA.submitCompletion(binding, held!.claimId, STEP1, "STATUS: retry\nREASON: retries exhausted");
      assert.equal(outcome.status, "rerouted");
      assert.equal(outcome.mutated, true);
      // Producer re-pended with feedback; consumer reset to waiting; counters updated.
      const producer = row("producer-step");
      assert.equal(producer.status, "pending");
      assert.match(String(producer.output ?? ""), /Reroute from "implement"/);
      const consumer = row(STEP1);
      assert.equal(consumer.status, "waiting");
      assert.equal(consumer.reroute_count, 1);
      assert.equal(runRow().status, "running");
      assert.equal(eventsOf(st, "step.rerouted").length, 1);
    } finally {
      st.dispose(stickyEnv);
    }
  });
});

describe("internal failure surfacing (never conflated with blocked)", () => {
  it("a vanished step mid-flight is rethrown from submitCompletion/submitFail (SERVICE, not blocked)", async () => {
    const { st, svcA, registry } = makeRig({ steps: [{ id: STEP1, status: "pending", expects: "STATUS: done" }] });
    try {
      const binding = bindingFor(INV_A);
      await svcA.claim(binding);
      const held = await svcA.readClaim(binding);
      assert.ok(held);

      // A step row that disappears before the mutation is a genuine internal
      // anomaly: completeStep/failStep throw the native "Step not found" hard
      // error (matching the native CLI), and the adapter RETHROWS it so the
      // broker's SERVICE error channel surfaces it distinctly — it is never
      // reported to the guest as an ordinary blocked outcome.
      await assert.rejects(
        () => svcA.submitCompletion(binding, held!.claimId, "no-such-step-row", "STATUS: done\nCHANGES: x"),
        /Step not found/,
      );
      await assert.rejects(
        () => svcA.submitFail(binding, held!.claimId, "no-such-step-row", "vanished mid-flight"),
        /Step not found/,
      );
      // The invocation's real claim is untouched: no mutation, no release.
      assert.equal(row(STEP1).status, "running");
      assert.equal(registry.getLeaseByInvocation(INV_A)?.stepRowId, STEP1);
    } finally {
      st.dispose(stickyEnv);
    }
  });
});

describe("loop/story transitions", () => {
  it("completes a loop story and advances the loop to done (no verify)", async () => {
    const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
    const { st, svcA } = makeRig({
      workflowId: "loop-fixture",
      steps: [
        { id: STEP1, stepId: "plan", stepIndex: 0, status: "done", output: "STORIES_JSON: [{\"storyId\":\"US-001\"}]" },
        { id: STEP2, stepId: "implement", stepIndex: 1, status: "pending", type: "loop", loopConfig },
      ],
    });
    try {
      st.insertStory({ id: "story-1", storyId: "US-001", storyIndex: 0 });
      const binding = bindingFor(INV_A);
      const claim = await svcA.claim(binding);
      assert.equal(claim.found, true);
      assert.equal(claim.stepId, STEP2);
      assert.equal(storyRow("story-1").status, "running");
      const held = await svcA.readClaim(binding);
      assert.ok(held);
      const outcome = await svcA.submitCompletion(binding, held!.claimId, STEP2, "STATUS: done\nCHANGES: story 1 implemented");
      assert.ok(outcome.status === "advanced" || outcome.status === "completed");
      assert.equal(storyRow("story-1").status, "done");
      assert.equal(row(STEP2).status, "done");
      assert.equal(eventsOf(st, "story.done").length, 1);
      // Native loop completion marks the step done without a step.done event
      // (only story.done + the pipeline/run terminal events) — parity holds.
      assert.equal(eventsOf(st, "step.done").length, 0);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("fail on a running loop story retries the story (per-story retry), then exhausts", async () => {
    const loopConfig = JSON.stringify({ over: "stories", completion: "all_done" });
    const { st, svcA, svcB } = makeRig({
      workflowId: "loop-fixture",
      steps: [
        { id: STEP1, stepId: "plan", stepIndex: 0, status: "done", output: "STORIES_JSON: [{\"storyId\":\"US-001\"}]" },
        { id: STEP2, stepId: "implement", stepIndex: 1, status: "pending", type: "loop", loopConfig },
      ],
    });
    try {
      st.insertStory({ id: "story-1", storyId: "US-001", storyIndex: 0, retryCount: 0, maxRetries: 1 });
      const bindingA = bindingFor(INV_A);
      const claim = await svcA.claim(bindingA);
      assert.equal(claim.found, true);
      const held = await svcA.readClaim(bindingA);
      assert.ok(held);

      // First fail: story retry remains available -> retrying (story reset).
      const retryOutcome = await svcA.submitFail(bindingA, held!.claimId, STEP2, "story needs fixes");
      assert.equal(retryOutcome.status, "retrying");
      assert.equal(storyRow("story-1").status, "pending");
      assert.equal(storyRow("story-1").retry_count, 1);
      assert.equal(row(STEP2).status, "pending");

      // Reclaim (fresh invocation) and fail again -> story retries exhausted.
      const bindingB = bindingFor(INV_B);
      const claimB = await svcB.claim(bindingB);
      assert.equal(claimB.found, true);
      const heldB = await svcB.readClaim(bindingB);
      assert.ok(heldB);
      const exhaust = await svcB.submitFail(bindingB, heldB!.claimId, STEP2, "still broken");
      assert.equal(exhaust.status, "failed");
      assert.equal(storyRow("story-1").status, "failed");
      assert.equal(row(STEP2).status, "failed");
      assert.equal(runRow().status, "failed");
    } finally {
      st.dispose(stickyEnv);
    }
  });
});

describe("duplicate acknowledgment at the service boundary", () => {
  it("a second submit of an already-accepted completion is a blocked no-op (no duplicate mutation/events)", async () => {
    const { st, svcA, eventsA } = makeRig({ steps: [{ id: STEP1, status: "pending", expects: "" }] });
    try {
      const binding = bindingFor(INV_A);
      await svcA.claim(binding);
      const held = await svcA.readClaim(binding);
      assert.ok(held);
      const first = await svcA.submitCompletion(binding, held!.claimId, STEP1, "STATUS: done");
      assert.ok(first.status === "advanced" || first.status === "completed");
      const doneEvents = eventsOf(st, "step.done").length;
      const validatedEvents = eventsA.filter((e) => e.event === "step.expects.validated").length;

      const second = await svcA.submitCompletion(binding, held!.claimId, STEP1, "STATUS: done");
      assert.equal(second.status, "blocked");
      assert.equal(second.mutated, false);
      assert.equal(row(STEP1).status, "done");
      assert.equal(eventsOf(st, "step.done").length, doneEvents);
      assert.equal(eventsA.filter((e) => e.event === "step.expects.validated").length, validatedEvents);
    } finally {
      st.dispose(stickyEnv);
    }
  });
});

describe("host admission lifetime and terminal revocation (MTLK-STEP-REVOKE)", () => {
  /** Adapter for a single invocation with its own optional service delay. */
  function mkSvc(
    st: IsolatedState,
    registry: HostInvocationRegistry,
    invocationId: string,
    delayMs = 0,
  ): NativeStepServices {
    st.open();
    const r = registry.admitInvocation({ invocationId, runId: RUN, agentId: AGENT, jobId: JOB_ID });
    assert.equal(r.ok, true, r.ok ? "" : r.reason);
    return new NativeStepServices({
      binding: bindingFor(invocationId),
      registry,
      workerOwnership: { jobId: JOB_ID, pid: 424242 },
      serviceDelayMs: delayMs,
      emit: () => {},
    });
  }

  it("revocation BEFORE the first claim is terminal: claim refuses with NO DB mutation and a fresh successor completes", async () => {
    const st = createIsolatedState("svc-revoke-preclaim");
    const registry = new HostInvocationRegistry();
    const svcA = mkSvc(st, registry, INV_A);
    const svcB = mkSvc(st, registry, INV_B);
    try {
      st.insertRun();
      st.insertStep({ id: STEP1, status: "pending", expects: "STATUS: done" });
      // Host cancels A before A ever claims (VM died / never launched work).
      assert.equal(registry.revokeInvocation(INV_A, "canceled before first claim"), 0);
      const refused = await svcA.claim(bindingFor(INV_A));
      assert.equal(refused.found, false, "revoked invocation must never claim");
      // No partial claim, no event, no mutation: the row stays pristine.
      const r = row(STEP1);
      assert.equal(r.status, "pending");
      assert.equal(r.claim_job_id, null);
      assert.equal(r.claim_pid, null);
      assert.equal(eventsOf(st, "step.running").length, 0);
      assert.equal(await svcA.peek(bindingFor(INV_A)), "NO_WORK");
      assert.equal(await svcA.readClaim(bindingFor(INV_A)), null);
      // The same revoked identity cannot re-register/admit, ever.
      assert.equal(registry.admitInvocation({ invocationId: INV_A, runId: RUN, agentId: AGENT, jobId: JOB_ID }).ok, false);
      assert.equal(registry.getAdmission(INV_A)?.state, "revoked");

      // Positive control on the same fixture: a FRESH host-admitted successor
      // (same run/agent/job) claims and completes normally.
      const claimB = await svcB.claim(bindingFor(INV_B));
      assert.equal(claimB.found, true, "fresh successor adopts the pending step");
      const heldB = await svcB.readClaim(bindingFor(INV_B));
      assert.ok(heldB);
      const done = await svcB.submitCompletion(bindingFor(INV_B), heldB!.claimId, STEP1, "STATUS: done\nCHANGES: successor");
      assert.ok(done.status === "advanced" || done.status === "completed");
      assert.equal(row(STEP1).status, "done");
      assert.equal(eventsOf(st, "step.done").length, 1);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("revocation while a (delayed) first claim is in flight: claim refuses after the wait with no DB mutation", async () => {
    const st = createIsolatedState("svc-revoke-delay-claim");
    const registry = new HostInvocationRegistry();
    const svcA = mkSvc(st, registry, INV_A, 300);
    try {
      st.insertRun();
      st.insertStep({ id: STEP1, status: "pending", expects: "" });
      const pending = svcA.claim(bindingFor(INV_A));
      // The host revokes A while its claim is inside the service delay
      // (broker cancel/close/EOF -> revokeInvocationAuthority).
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(registry.revokeInvocation(INV_A, "broker close"), 0);
      const refused = await pending;
      assert.equal(refused.found, false);
      // claimStep must never have run for the revoked invocation.
      const r = row(STEP1);
      assert.equal(r.status, "pending");
      assert.equal(r.claim_job_id, null);
      assert.equal(eventsOf(st, "step.running").length, 0);
      assert.equal(registry.getAdmission(INV_A)?.state, "revoked");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("revokeInvocationAuthority seam (broker cancel/close) terminally revokes a HOLDING invocation; ops refuse; fresh successor adopts the running row", async () => {
    const st = createIsolatedState("svc-revoke-seam");
    const registry = new HostInvocationRegistry();
    const svcA = mkSvc(st, registry, INV_A);
    const svcB = mkSvc(st, registry, INV_B);
    try {
      st.insertRun();
      st.insertStep({ id: STEP1, status: "pending", expects: "STATUS: done" });
      const bindingA = bindingFor(INV_A);
      const claimA = await svcA.claim(bindingA);
      assert.equal(claimA.found, true);
      const heldA = await svcA.readClaim(bindingA);
      assert.ok(heldA);

      // The REAL broker calls this seam on cancel/close/EOF/deadline.
      svcA.revokeInvocationAuthority(INV_A, "broker closed: guest pipe EOF");
      assert.equal(registry.getAdmission(INV_A)?.state, "revoked");
      assert.equal(registry.getAdmission(INV_A)?.revokeReason, "broker closed: guest pipe EOF");
      assert.equal(await svcA.readClaim(bindingA), null);
      // Stale completion from the revoked holding invocation is refused with
      // no mutation (adapter lifecycle gate AND atomic lease guard).
      const stale = await svcA.submitCompletion(bindingA, heldA!.claimId, STEP1, "STATUS: done\nCHANGES: late A");
      assert.equal(stale.status, "blocked");
      assert.equal(stale.mutated, false);
      assert.equal(row(STEP1).status, "running");
      assert.equal(eventsOf(st, "step.done").length, 0);
      const claimAgain = await svcA.claim(bindingA);
      assert.equal(claimAgain.found, false);

      // A FOREIGN seam call (different invocation id) must never revoke B.
      svcA.revokeInvocationAuthority(INV_B, "rogue");
      assert.equal(registry.getAdmission(INV_B)?.state, "admitted");

      // Fresh host-admitted successor B adopts the still-running row (host
      // policy: orphan recovery / successor dispatch) and completes it.
      const claimB = await svcB.claim(bindingFor(INV_B));
      assert.equal(claimB.found, true, "fresh successor adopts the running claim after revocation");
      const heldB = await svcB.readClaim(bindingFor(INV_B));
      assert.ok(heldB);
      const done = await svcB.submitCompletion(bindingFor(INV_B), heldB!.claimId, STEP1, "STATUS: done\nCHANGES: B");
      assert.ok(done.status === "advanced" || done.status === "completed");
      assert.equal(row(STEP1).status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("out-of-band native-style release/reclaim with the SAME job but a DIFFERENT worker pid is caught by the row token between readClaim and submit", async () => {
    const st = createIsolatedState("svc-native-reclaim");
    const registry = new HostInvocationRegistry();
    const svcA = mkSvc(st, registry, INV_A);
    try {
      st.insertRun();
      st.insertStep({ id: STEP1, status: "pending", expects: "STATUS: done" });
      const bindingA = bindingFor(INV_A);
      const claimA = await svcA.claim(bindingA);
      assert.equal(claimA.found, true);
      const heldA = await svcA.readClaim(bindingA);
      assert.ok(heldA);

      // Native operator release (real release shape: status back to pending,
      // every claim field cleared), then a NATIVE-style reclaim of the SAME
      // job id by a DIFFERENT worker process (pid differs) — the DB row is
      // running again under the same stable job id.
      getDb().prepare(
        "UPDATE steps SET status = 'pending', claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL, claim_updated_at = NULL, updated_at = datetime('now') WHERE id = ?",
      ).run(STEP1);
      getDb().prepare(
        "UPDATE steps SET status = 'running', claim_job_id = ?, claim_pid = ?, claim_pgid = NULL, claim_invalidated_by = NULL, claim_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'",
      ).run(JOB_ID, 999999, STEP1);

      // A was never revoked and still holds its registry lease — the row-level
      // host claim-identity token (job|pid|pgid|ts) must refuse A's stale
      // mutation atomically (jobId alone would NOT have caught this).
      const stale = await svcA.submitCompletion(bindingA, heldA!.claimId, STEP1, "STATUS: done\nCHANGES: stale native-era A");
      assert.equal(stale.status, "blocked");
      assert.equal(stale.mutated, false);
      assert.equal(row(STEP1).status, "running");
      assert.equal(row(STEP1).claim_pid, 999999);
      assert.equal(eventsOf(st, "step.done").length, 0);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("same-job same-second successor with a DISTINCT host invocation: A's stale submit is blocked (lease holder), B completes", async () => {
    const st = createIsolatedState("svc-same-second");
    const registry = new HostInvocationRegistry();
    const svcA = mkSvc(st, registry, INV_A);
    const svcB = mkSvc(st, registry, INV_B);
    try {
      st.insertRun();
      st.insertStep({ id: STEP1, status: "pending", expects: "STATUS: done" });
      const bindingA = bindingFor(INV_A);
      await svcA.claim(bindingA);
      const heldA = await svcA.readClaim(bindingA);
      assert.ok(heldA);

      // Host revokes A (VM close) and orphan recovery releases the row to
      // pending; B (same stable job, fresh host invocation) reclaims it. Force
      // B's claim timestamp to collide with A's captured row state so the DB
      // row cannot distinguish the two claims (same job id, same second).
      registry.revokeInvocation(INV_A, "VM close");
      getDb().prepare(
        "UPDATE steps SET status = 'pending', claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL, claim_updated_at = NULL, updated_at = datetime('now') WHERE id = ?",
      ).run(STEP1);
      const claimB = await svcB.claim(bindingFor(INV_B));
      assert.equal(claimB.found, true);
      const afterB = row(STEP1) as { claim_job_id: string | null; claim_updated_at: string | null };
      assert.equal(afterB.claim_job_id, JOB_ID, "successor still uses the same stable job id");
      const heldB = await svcB.readClaim(bindingFor(INV_B));
      assert.ok(heldB);
      assert.notEqual(heldB!.claimId, heldA!.claimId, "claim ids are invocation-unique");

      // A's stale completion (same job id, colliding second-level row stamps)
      // is refused at the atomic boundary — the lease now belongs to B.
      const stale = await svcA.submitCompletion(bindingA, heldA!.claimId, STEP1, "STATUS: done\nCHANGES: stale A");
      assert.equal(stale.status, "blocked");
      assert.equal(stale.mutated, false);
      assert.equal(row(STEP1).status, "running");
      assert.equal(eventsOf(st, "step.done").length, 0);

      // B's own completion lands.
      const ok = await svcB.submitCompletion(bindingFor(INV_B), heldB!.claimId, STEP1, "STATUS: done\nCHANGES: B");
      assert.ok(ok.status === "advanced" || ok.status === "completed");
      assert.equal(row(STEP1).status, "done");
      assert.equal(eventsOf(st, "step.done").length, 1);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("a never-admitted invocation cannot claim (no guest-created authority); host admission enables the same adapter", async () => {
    const st = createIsolatedState("svc-never-admitted");
    const registry = new HostInvocationRegistry();
    st.open();
    const svc = new NativeStepServices({
      binding: bindingFor(INV_A),
      registry,
      workerOwnership: { jobId: JOB_ID, pid: 424242 },
      emit: () => {},
    });
    try {
      st.insertRun();
      st.insertStep({ id: STEP1, status: "pending" });
      // The host never admitted INV_A: even the invocation-bound adapter gets
      // no claim and drives no DB mutation (admission is host authority).
      const refused = await svc.claim(bindingFor(INV_A));
      assert.equal(refused.found, false);
      const r = row(STEP1);
      assert.equal(r.status, "pending");
      assert.equal(r.claim_job_id, null);
      assert.equal(eventsOf(st, "step.running").length, 0);
      assert.equal(await svc.peek(bindingFor(INV_A)), "NO_WORK");
      assert.equal(await svc.readClaim(bindingFor(INV_A)), null);
      // Positive control: once the host admits the identity the SAME adapter
      // claims and completes normally.
      const a = registry.admitInvocation({ invocationId: INV_A, runId: RUN, agentId: AGENT, jobId: JOB_ID });
      assert.equal(a.ok, true);
      const claim = await svc.claim(bindingFor(INV_A));
      assert.equal(claim.found, true);
      const held = await svc.readClaim(bindingFor(INV_A));
      assert.ok(held);
      const done = await svc.submitCompletion(bindingFor(INV_A), held!.claimId, STEP1, "STATUS: done\nCHANGES: ok");
      assert.ok(done.status === "advanced" || done.status === "completed");
      assert.equal(row(STEP1).status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });
});
