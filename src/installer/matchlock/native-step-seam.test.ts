/**
 * MTLK-STEP guarded-seam tests (serial lane: imports real step-ops).
 *
 * Exercises the opt-in authority seam on completeStep/failStep against the
 * REAL isolated DB: pass-through when the guard authorizes, refusal with
 * zero mutation/events when it does not, and the failStep post-await
 * re-check (authority lost across the getOnFailPolicy async boundary).
 * Unguarded native entry points are asserted unchanged (no options === no
 * seam).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { closeDb, getDb } from "../../../dist/db.js";
import { completeStep, failStep, type StepClaimEvidence } from "../../../dist/installer/step-ops.js";
import {
  applyEnv,
  createIsolatedState,
  RUN,
  snapshotEnv,
} from "../../../dist/installer/matchlock/native-step-test-utils.js";

// Sticky isolation env (module-scoped temp) so fire-and-forget teardown
// continuations (scheduleRunCronTeardown -> dynamic imports, rugpull
// detection) resolve against a temp state dir — never the operator's real
// state — even AFTER the last test's afterEach (step-ops-complete.test.ts
// pattern). The process env deliberately stays pointed at the temp state for
// the whole test-file process; node --test runs each file in its own child,
// so sibling files and the parent are unaffected.
const sticky = createIsolatedState("seam-sticky");
sticky.open();
const stickyEnv = snapshotEnv();

after(() => {
  // Never restore the operator's env inside this process: pending
  // fire-and-forget continuations must not resolve /root/.tamandua. Close the
  // sticky DB and drop the fixture tree while env still points at it (any
  // straggler then touches only temp state, which is guard-safe).
  try {
    closeDb();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(sticky.root, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup of our own fixture tree */
  }
});

afterEach(() => {
  applyEnv(stickyEnv);
});

function stepState(stepId: string): Record<string, unknown> {
  return getDb().prepare("SELECT * FROM steps WHERE id = ?").get(stepId) as Record<string, unknown>;
}

function runState(): Record<string, unknown> {
  return getDb().prepare("SELECT * FROM runs WHERE id = ?").get(RUN) as Record<string, unknown>;
}

describe("completeStep authority seam", () => {
  it("passes through unchanged when no options are given (native parity)", () => {
    const st = createIsolatedState("seam-native");
    st.open();
    try {
      st.insertRun();
      st.insertStep({ id: "s1", expects: "STATUS: done", status: "running" });
      const plain = completeStep("s1", "STATUS: done");
      assert.ok(plain.status === "advanced" || plain.status === "completed");
      const row = stepState("s1");
      assert.equal(row.status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("passes through when the authority guard authorizes (null)", () => {
    const st = createIsolatedState("seam-pass");
    st.open();
    try {
      st.insertRun();
      st.insertStep({ id: "s2", expects: "STATUS: done", status: "running" });
      let calls = 0;
      const result = completeStep("s2", "STATUS: done", {
        authority: (evidence: StepClaimEvidence) => {
          calls += 1;
          assert.equal(evidence.stepRowId, "s2");
          assert.equal(evidence.status, "running");
          return null;
        },
      });
      assert.ok(result.status === "advanced" || result.status === "completed");
      assert.equal(calls, 1);
      const row = stepState("s2");
      assert.equal(row.status, "done");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("refuses with blocked + no mutation + no events when the guard refuses", () => {
    const st = createIsolatedState("seam-refuse");
    st.open();
    try {
      st.insertRun();
      st.insertStep({ id: "s3", expects: "STATUS: done", status: "running", retryCount: 0, maxRetries: 2 });
      const eventsBefore = st.readRunEvents(RUN).length;
      const result = completeStep("s3", "STATUS: done", {
        authority: () => "stale claim: expected claim replaced",
      });
      assert.equal(result.status, "blocked");
      assert.equal(result.detail, "stale claim: expected claim replaced");
      const row = stepState("s3");
      assert.equal(row.status, "running");
      assert.equal(row.retry_count, 0);
      assert.equal(row.output, null);
      assert.equal(st.readRunEvents(RUN).length, eventsBefore);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("authority refusal precedes terminal reroute_noop event emission", () => {
    const st = createIsolatedState("seam-reroute-noop");
    st.open();
    try {
      st.insertRun();
      st.insertStep({ id: "s4", status: "pending" });
      // Simulate a rerouted pending row (claim_invalidated_by='reroute',
      // claim_updated_at NULL): the unguarded native path would emit a
      // reroute_noop event and block; an authority refusal must win first
      // with zero events.
      getDb().prepare(
        "UPDATE steps SET claim_invalidated_by = 'reroute', claim_updated_at = NULL, updated_at = datetime('now') WHERE id = ?",
      ).run("s4");
      const eventsBefore = st.readRunEvents(RUN).filter((e) => e.event === "step.reroute_noop").length;
      const result = completeStep("s4", "STATUS: done", {
        authority: () => "no active invocation claim",
      });
      assert.equal(result.status, "blocked");
      const noopsAfter = st.readRunEvents(RUN).filter((e) => e.event === "step.reroute_noop").length;
      assert.equal(noopsAfter, eventsBefore);
    } finally {
      st.dispose(stickyEnv);
    }
  });
});

describe("failStep authority seam", () => {
  it("refuses at entry with no mutation when the guard refuses (retry budget untouched)", async () => {
    const st = createIsolatedState("seam-fail-entry");
    st.open();
    try {
      st.insertRun();
      st.insertStep({ id: "f1", status: "running", retryCount: 0, maxRetries: 2 });
      const eventsBefore = st.readRunEvents(RUN).length;
      const result = await failStep("f1", "boom", {
        authority: () => "foreign invocation",
      });
      assert.equal(result.status, "blocked");
      const row = stepState("f1");
      assert.equal(row.status, "running");
      assert.equal(row.retry_count, 0);
      assert.equal(st.readRunEvents(RUN).length, eventsBefore);
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("re-checks authority AFTER the getOnFailPolicy await and refuses there (no mutation)", async () => {
    const st = createIsolatedState("seam-fail-async");
    st.open();
    try {
      // retry_count == max_retries forces the terminal branch, whose
      // getOnFailPolicy lookup is awaited BEFORE the transition.
      st.insertRun();
      st.insertStep({ id: "f2", status: "running", retryCount: 2, maxRetries: 2 });
      let calls = 0;
      const result = await failStep("f2", "boom", {
        authority: () => {
          calls += 1;
          // Entry call authorizes; authority is lost before the awaited
          // policy lookup resolves, so the post-await re-check refuses —
          // simulating loss of authority across the async boundary.
          return calls === 1 ? null : "invocation revoked while fail policy resolved";
        },
      });
      assert.equal(calls, 2);
      assert.equal(result.status, "blocked");
      const row = stepState("f2");
      assert.equal(row.status, "running");
      assert.equal(row.retry_count, 2);
      assert.equal(runState().status, "running");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("applies the terminal transition when the post-await re-check still authorizes", async () => {
    const st = createIsolatedState("seam-fail-async-pass");
    st.open();
    try {
      st.insertRun();
      st.insertStep({ id: "f3", status: "running", retryCount: 2, maxRetries: 2 });
      const result = await failStep("f3", "boom", {
        authority: () => null,
      });
      assert.equal(result.status, "failed");
      const row = stepState("f3");
      assert.equal(row.status, "failed");
      assert.equal(runState().status, "failed");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("re-checks authority AFTER the policy await and BEFORE the on_fail.retry_step reroute; refusal blocks the reroute with zero mutation/events", async () => {
    const st = createIsolatedState("seam-fail-reroute-revoke");
    st.open();
    try {
      // Real workflow spec declaring on_fail.retry_step so the retry-exhausted
      // branch takes the REROUTE path (rerouteWithPolicy re-pends the producer,
      // resets the consumer, updates counters, emits step.rerouted).
      const wfDir = path.join(st.stateDir, "workflows", "reroute-auth-fixture");
      fs.mkdirSync(wfDir, { recursive: true });
      fs.writeFileSync(
        path.join(wfDir, "workflow.yml"),
        [
          "id: reroute-auth-fixture",
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
      st.insertRun({ workflowId: "reroute-auth-fixture" });
      st.insertStep({ id: "producer", stepId: "plan", stepIndex: 0, status: "done", output: "PLAN: ok" });
      st.insertStep({ id: "consumer", stepId: "implement", stepIndex: 1, status: "running", retryCount: 1, maxRetries: 1 });

      const eventsBefore = st.readRunEvents(RUN).length;
      let calls = 0;
      let revoked = false;
      const result = await failStep("consumer", "boom", {
        authority: () => {
          calls += 1;
          if (calls === 1) {
            // Simulate the host revoking this invocation WHILE the awaited
            // getOnFailPolicy lookup is in flight: the microtask runs during
            // the await suspension (before the post-await re-check), exactly
            // like a real registry.revoke/supersede from the host lifecycle.
            queueMicrotask(() => {
              revoked = true;
            });
            return null;
          }
          return revoked ? "invocation revoked while reroute policy resolved" : null;
        },
      });

      // The guard ran at entry AND at the post-await re-check immediately
      // before the reroute mutation: a revoked invocation must not drive a
      // reroute. (Without the re-check, calls would stay 1 and the reroute
      // would mutate.)
      assert.equal(calls, 2);
      assert.equal(result.status, "blocked");

      // No producer re-pend: plan untouched.
      const producer = stepState("producer");
      assert.equal(producer.status, "done");
      assert.equal(producer.output, "PLAN: ok");
      // No consumer reset: implement still running with its retry/claim state.
      const consumer = stepState("consumer");
      assert.equal(consumer.status, "running");
      assert.equal(consumer.retry_count, 1);
      assert.equal(consumer.reroute_count, 0);
      // No step.rerouted (or any other) event; run untouched.
      assert.equal(st.readRunEvents(RUN).filter((e) => e.event === "step.rerouted").length, 0);
      assert.equal(st.readRunEvents(RUN).length, eventsBefore);
      assert.equal(runState().status, "running");
    } finally {
      st.dispose(stickyEnv);
    }
  });

  it("control: on the same retry_step workflow an authorized invocation DOES reroute (fixture sanity)", async () => {
    const st = createIsolatedState("seam-fail-reroute-control");
    st.open();
    try {
      const wfDir = path.join(st.stateDir, "workflows", "reroute-auth-fixture");
      fs.mkdirSync(wfDir, { recursive: true });
      fs.writeFileSync(
        path.join(wfDir, "workflow.yml"),
        [
          "id: reroute-auth-fixture",
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
      st.insertRun({ workflowId: "reroute-auth-fixture" });
      st.insertStep({ id: "producer", stepId: "plan", stepIndex: 0, status: "done", output: "PLAN: ok" });
      st.insertStep({ id: "consumer", stepId: "implement", stepIndex: 1, status: "running", retryCount: 1, maxRetries: 1 });

      const result = await failStep("consumer", "boom", { authority: () => null });
      assert.equal(result.status, "rerouted");
      assert.equal(stepState("producer").status, "pending");
      assert.equal(stepState("consumer").status, "waiting");
      assert.equal(stepState("consumer").reroute_count, 1);
      assert.equal(st.readRunEvents(RUN).filter((e) => e.event === "step.rerouted").length, 1);
    } finally {
      st.dispose(stickyEnv);
    }
  });
});
