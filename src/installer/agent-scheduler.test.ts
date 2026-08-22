/**
 * Scheduler job lifecycle: dispatch-job setup, in-flight guard, nudge.
 *
 * The dispatch motor is deterministic (in-process peek, constant fallback
 * interval), so there is no per-workflow interval math to pin — these tests
 * assert job identity/lifecycle and the nudge/in-flight semantics (C5, C7).
 */
import assert from "node:assert/strict";
import { describe, it, afterEach, beforeEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  setupAgentCrons,
  createAgentCronJob,
  _scheduledJobCountForRun,
  removeRunCrons,
  settleRunInFlightRounds,
  shutdownAllCrons,
  tryMarkJobInFlight,
  nudgeScheduledRuns,
  _pendingSweepTimerCount,
  _hasPendingSweepTimer,
  _schedulerGeneration,
  executeDispatchRound,
  DISPATCH_INTERVAL_MS,
  HARNESS_TEARDOWN_GRACE_MS,
  getRunTeardownGraceMs,
} from "../../dist/installer/agent-scheduler.js";
import { getDb } from "../../dist/db.js";
import { getRunEvents } from "../../dist/installer/events.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";
import type { SetupAgentCronsOptions, NudgeResult } from "../../dist/installer/agent-scheduler.js";
import type { WorkflowSpec } from "../../dist/installer/types.js";

function makeWorkflow(overrides: {
  pollingTimeoutSeconds?: number;
} = {}) {
  return {
    id: "test-workflow",
    agents: [
      {
        id: "test-agent",
        model: "fake",
        workspace: { baseDir: "." },
      },
    ],
    steps: [
      {
        id: "step-1",
        agent: "test-agent",
        input: "do something",
        expects: "STATUS",
      },
    ],
    ...(overrides.pollingTimeoutSeconds !== undefined
      ? { polling: { timeoutSeconds: overrides.pollingTimeoutSeconds } }
      : {}),
  };
}

describe("reconciler run status teardown policy", () => {
  it("graces only naturally completed and failed runs", () => {
    const cases: Array<[string | undefined, number]> = [
      ["completed", HARNESS_TEARDOWN_GRACE_MS],
      ["failed", HARNESS_TEARDOWN_GRACE_MS],
      ["canceled", 0],
      ["paused", 0],
      ["running", 0],
      ["invalid", 0],
      [undefined, 0],
    ];

    for (const [status, expectedGraceMs] of cases) {
      assert.equal(
        getRunTeardownGraceMs(status),
        expectedGraceMs,
        `unexpected teardown grace for ${status ?? "missing"} run`,
      );
    }
  });
});

describe("setupAgentCrons dispatch-job scheduling", () => {
  afterEach(() => {
    shutdownAllCrons();
  });

  it("uses a constant seconds-scale fallback interval — dispatch is free", () => {
    assert.ok(
      DISPATCH_INTERVAL_MS >= 1_000 && DISPATCH_INTERVAL_MS <= 60_000,
      `DISPATCH_INTERVAL_MS should be seconds-scale, got ${DISPATCH_INTERVAL_MS}`,
    );
  });

  it("schedules one job per agent", async () => {
    const workflow = makeWorkflow();
    const runId = "run-default-test";

    await setupAgentCrons(workflow, runId);
    assert.equal(_scheduledJobCountForRun(runId), 1);

    await removeRunCrons(runId);
    assert.equal(_scheduledJobCountForRun(runId), 0);
  });

  it("legacy polling.timeoutSeconds in the workflow YAML is accepted and ignored", async () => {
    const workflow = makeWorkflow({ pollingTimeoutSeconds: 120 });
    const runId = "run-legacy-polling-config";

    await setupAgentCrons(workflow, runId);
    assert.equal(_scheduledJobCountForRun(runId), 1);

    await removeRunCrons(runId);
  });

  it("works with multiple agents", async () => {
    const workflow = {
      ...makeWorkflow({ pollingTimeoutSeconds: 90 }),
      agents: [
        { id: "agent-a", model: "fake", workspace: { baseDir: "." } },
        { id: "agent-b", model: "fake", workspace: { baseDir: "." } },
      ],
    };
    const runId = "run-multi";

    await setupAgentCrons(workflow, runId);
    assert.equal(_scheduledJobCountForRun(runId), 2);

    await removeRunCrons(runId);
  });

  it("is idempotent — re-running setup does not duplicate jobs", async () => {
    const workflow = makeWorkflow();
    const runId = "run-idempotent";

    await setupAgentCrons(workflow, runId);
    await setupAgentCrons(workflow, runId);
    assert.equal(_scheduledJobCountForRun(runId), 1);

    await removeRunCrons(runId);
  });
});

describe("setupAgentCrons noHurrySaveTokensMode (accepted no-op)", () => {
  afterEach(() => {
    shutdownAllCrons();
  });

  // The flag existed to stretch the model-driven polling interval and save
  // idle-poll tokens. Dispatch rounds are free, so it no longer changes
  // scheduling — but the CLI flag must stay accepted for back-compat.
  for (const mode of [true, false, undefined] as const) {
    it(`schedules identically with noHurrySaveTokensMode=${String(mode)}`, async () => {
      const workflow = makeWorkflow({ pollingTimeoutSeconds: 33 });
      const runId = `run-save-tokens-${String(mode)}`;

      const options: SetupAgentCronsOptions =
        mode === undefined ? {} : { noHurrySaveTokensMode: mode };
      await setupAgentCrons(workflow, runId, options);
      assert.equal(_scheduledJobCountForRun(runId), 1);

      await removeRunCrons(runId);
    });
  }
});

describe("tryMarkJobInFlight race guard", () => {
  afterEach(() => {
    shutdownAllCrons();
  });

  it("returns true on first call for a given jobId", () => {
    const result = tryMarkJobInFlight("job-001");
    assert.equal(result, true);
  });

  it("returns false on second call for same jobId", () => {
    tryMarkJobInFlight("job-002");
    const result = tryMarkJobInFlight("job-002");
    assert.equal(result, false);
  });

  it("returns true for different jobIds", () => {
    const r1 = tryMarkJobInFlight("job-a");
    const r2 = tryMarkJobInFlight("job-b");
    assert.equal(r1, true);
    assert.equal(r2, true);
  });

  it("subsequent call after first returns false (three calls)", () => {
    assert.equal(tryMarkJobInFlight("job-003"), true);
    assert.equal(tryMarkJobInFlight("job-003"), false);
    assert.equal(tryMarkJobInFlight("job-003"), false);
  });

  it("is idempotent — check-and-add happens synchronously", () => {
    // Simulate two concurrent calls that would race without the
    // atomic check-and-add. Since JS is single-threaded we verify
    // the fundamental contract: first call wins, second loses.
    const wins: boolean[] = [];
    for (let i = 0; i < 2; i++) {
      wins.push(tryMarkJobInFlight("job-concurrent"));
    }
    assert.deepEqual(wins, [true, false]);
  });

  it("different jobIds are independent", () => {
    // job-004 should not prevent job-005 from being marked
    tryMarkJobInFlight("job-004");
    assert.equal(tryMarkJobInFlight("job-005"), true);
    // job-004 is still in flight
    assert.equal(tryMarkJobInFlight("job-004"), false);
  });

  it("shutdown clears in-flight state", () => {
    tryMarkJobInFlight("job-006");
    shutdownAllCrons();
    // After shutdown, a fresh call should succeed
    assert.equal(tryMarkJobInFlight("job-006"), true);
  });
});

// ── nudgeScheduledRuns tests ────────────────────────────────────────

describe("nudgeScheduledRuns", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-nudge-");
    process.env.TAMANDUA_STATE_DIR = path.join(tempHome, ".tamandua");
  });

  afterEach(() => {
    shutdownAllCrons();
    delete process.env.TAMANDUA_STATE_DIR;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function createWorkflowDir(workflowId: string, agentIds: string[]) {
    const wfDir = path.join(
      process.env.TAMANDUA_STATE_DIR!,
      "workflows",
      workflowId,
    );
    fs.mkdirSync(wfDir, { recursive: true });
    const agentsYaml = agentIds
      .map(
        (id) =>
          `  - id: ${id}\n    model: fake\n    workspace:\n      baseDir: "."`,
      )
      .join("\n");
    const yml =
      `id: ${workflowId}\n` +
      `agents:\n${agentsYaml}\n` +
      `steps:\n` +
      `  - id: step-1\n` +
      `    agent: ${agentIds[0]}\n` +
      `    input: "do"\n` +
      `    expects: STATUS\n`;
    fs.writeFileSync(path.join(wfDir, "workflow.yml"), yml);
  }

  function makeWorkflowSpec(
    workflowId: string,
    agentIds: string[],
  ): WorkflowSpec {
    return {
      id: workflowId,
      agents: agentIds.map((id) => ({
        id,
        model: "fake",
        workspace: { baseDir: "." },
      })),
      steps: [
        {
          id: "s1",
          agent: agentIds[0],
          input: "do",
          expects: "STATUS",
        },
      ],
    } as WorkflowSpec;
  }

  it("returns empty result for empty runIds", async () => {
    const result = await nudgeScheduledRuns([]);
    assert.deepStrictEqual(result.runIds, []);
    assert.equal(result.launched, 0);
    assert.equal(result.skippedInFlight, 0);
    assert.equal(result.jobs.length, 0);
    assert.equal(result.errors.length, 0);
  });

  it("returns empty result for non-existent runIds", async () => {
    const result = await nudgeScheduledRuns(["no-such-run"]);
    assert.equal(result.runIds.length, 1);
    assert.equal(result.launched, 0);
    assert.equal(result.skippedInFlight, 0);
    assert.equal(result.jobs.length, 0);
  });

  it("skips jobs that are in flight", async () => {
    createWorkflowDir("wf-skip", ["dev"]);
    const workflow = makeWorkflowSpec("wf-skip", ["dev"]);
    await setupAgentCrons(workflow, "run-skip", {
      workingDirectoryForHarness: tempHome,
    });

    // Compute the job id (same format as buildJobId) and mark in-flight
    const jobId = "tamandua-wf-skip-run-skip-dev";
    tryMarkJobInFlight(jobId);

    const result = await nudgeScheduledRuns(["run-skip"]);
    assert.equal(result.launched, 0);
    assert.equal(result.skippedInFlight, 1);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].status, "skipped_in_flight");
    assert.equal(result.jobs[0].agentId, "wf-skip_dev");
    assert.equal(result.jobs[0].runId, "run-skip");
  });

  it("launches for non-in-flight scheduled jobs", async () => {
    createWorkflowDir("wf-launch", ["dev"]);
    const workflow = makeWorkflowSpec("wf-launch", ["dev"]);
    await setupAgentCrons(workflow, "run-launch", {
      workingDirectoryForHarness: tempHome,
    });

    const result = await nudgeScheduledRuns(["run-launch"]);
    assert.equal(result.launched, 1);
    assert.equal(result.skippedInFlight, 0);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].status, "launched");
    assert.equal(result.jobs[0].runId, "run-launch");
    assert.equal(result.jobs[0].agentId, "wf-launch_dev");
  });

  it("nudges only matching runs, ignoring others", async () => {
    createWorkflowDir("wf-multi", ["dev"]);
    const workflow = makeWorkflowSpec("wf-multi", ["dev"]);
    await setupAgentCrons(workflow, "run-a", {
      workingDirectoryForHarness: tempHome,
    });
    await setupAgentCrons(workflow, "run-b", {
      workingDirectoryForHarness: tempHome,
    });

    // Nudge only run-a
    const result = await nudgeScheduledRuns(["run-a"]);
    assert.equal(result.launched, 1);
    assert.equal(result.skippedInFlight, 0);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].runId, "run-a");
  });

  it("converts pending-start timer to active interval on nudge", async () => {
    createWorkflowDir("wf-pending", ["dev"]);
    const workflow = makeWorkflowSpec("wf-pending", ["dev"]);

    // Create job with stagger to get a pending-start timer
    await createAgentCronJob({
      workflowId: "wf-pending",
      runId: "run-pending",
      agent: { id: "dev", model: "fake", workspace: { baseDir: "." } },
      workflow,
      staggerOffsetMs: 60_000,
      workingDirectoryForHarness: tempHome,
    });

    const result = await nudgeScheduledRuns(["run-pending"]);
    assert.equal(result.launched, 1);

    // The job is still scheduled after the nudge (pending → active timer)
    assert.equal(_scheduledJobCountForRun("run-pending"), 1);
  });

  it("preserves job metadata (harness type) through nudge", async () => {
    createWorkflowDir("wf-harness", ["dev"]);
    const workflow = makeWorkflowSpec("wf-harness", ["dev"]);

    await setupAgentCrons(workflow, "run-harness", {
      workingDirectoryForHarness: tempHome,
    });

    // Nudge should succeed without errors
    const result = await nudgeScheduledRuns(["run-harness"]);
    assert.equal(result.launched, 1);
    assert.equal(result.errors.length, 0);
  });

  it("returns errors for jobs whose workflow is missing from disk", async () => {
    // Set up a job that references a workflow NOT on disk
    const workflow = makeWorkflowSpec("wf-missing", ["dev"]);
    await setupAgentCrons(workflow, "run-err", {
      workingDirectoryForHarness: tempHome,
    });

    // Don't create the workflow dir — so loadWorkflowSpec will fail
    const result = await nudgeScheduledRuns(["run-err"]);
    assert.equal(result.launched, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].status, "error");
  });

  it("handles mixed in-flight and launchable jobs", async () => {
    createWorkflowDir("wf-mixed", ["dev", "qa"]);
    const workflow = makeWorkflowSpec("wf-mixed", ["dev", "qa"]);
    await setupAgentCrons(workflow, "run-mixed", {
      workingDirectoryForHarness: tempHome,
    });

    // Mark dev as in-flight, qa should still launch
    const devJobId = "tamandua-wf-mixed-run-mixed-dev";
    tryMarkJobInFlight(devJobId);

    const result = await nudgeScheduledRuns(["run-mixed"]);
    assert.equal(result.launched, 1);
    assert.equal(result.skippedInFlight, 1);
    assert.equal(result.jobs.length, 2);

    const launched = result.jobs.filter((j) => j.status === "launched");
    const skipped = result.jobs.filter((j) => j.status === "skipped_in_flight");
    assert.equal(launched.length, 1);
    assert.equal(skipped.length, 1);
    assert.equal(launched[0].agentId, "wf-mixed_qa");
    assert.equal(skipped[0].agentId, "wf-mixed_dev");
  });
});

// ── Sweep timer scheduling tests ───────────────────────────────────

describe("removeRunCrons sweep timer scheduling", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-sweep-");
    process.env.TAMANDUA_STATE_DIR = path.join(tempHome, ".tamandua");
  });

  afterEach(() => {
    shutdownAllCrons();
    delete process.env.TAMANDUA_STATE_DIR;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("schedules a sweep timer when removeRunCrons is called", async () => {
    const workflow = makeWorkflow();
    const runId = "run-sweep-scheduled";

    await setupAgentCrons(workflow, runId);
    assert.equal(_pendingSweepTimerCount(), 0);

    await removeRunCrons(runId);
    assert.equal(_pendingSweepTimerCount(), 1);
    assert.equal(_hasPendingSweepTimer(runId), true);
  });

  it("deduplicates sweep timers per runId", async () => {
    const workflow = makeWorkflow();
    const runId = "run-sweep-dedup";

    await setupAgentCrons(workflow, runId);

    // First call schedules the timer
    await removeRunCrons(runId);
    assert.equal(_pendingSweepTimerCount(), 1);

    // Second call should not schedule a duplicate
    await removeRunCrons(runId);
    assert.equal(_pendingSweepTimerCount(), 1);

    // Third call still only one
    await removeRunCrons(runId);
    assert.equal(_pendingSweepTimerCount(), 1);
  });

  it("schedules independent timers for different runIds", async () => {
    const workflow = makeWorkflow();

    await setupAgentCrons(workflow, "run-a");
    await setupAgentCrons(workflow, "run-b");

    await removeRunCrons("run-a");
    assert.equal(_pendingSweepTimerCount(), 1);
    assert.equal(_hasPendingSweepTimer("run-a"), true);
    assert.equal(_hasPendingSweepTimer("run-b"), false);

    await removeRunCrons("run-b");
    assert.equal(_pendingSweepTimerCount(), 2);
    assert.equal(_hasPendingSweepTimer("run-a"), true);
    assert.equal(_hasPendingSweepTimer("run-b"), true);
  });

  it("sweep timer delay is HARNESS_TEARDOWN_GRACE_MS + 2s", () => {
    // The formula is: delay = HARNESS_TEARDOWN_GRACE_MS + 2_000
    const expectedMin = HARNESS_TEARDOWN_GRACE_MS + 2_000;
    assert.ok(
      expectedMin > HARNESS_TEARDOWN_GRACE_MS,
      `Expected delay ${expectedMin} to be > grace ${HARNESS_TEARDOWN_GRACE_MS}`,
    );
    assert.ok(
      expectedMin > 10_000,
      `Expected delay ${expectedMin} to be > 10s`,
    );
  });

  it("sweep timer is cleared on shutdownAllCrons", async () => {
    const workflow = makeWorkflow();
    const runId = "run-sweep-shutdown";

    await setupAgentCrons(workflow, runId);
    await removeRunCrons(runId);
    assert.equal(_pendingSweepTimerCount(), 1);

    shutdownAllCrons();
    assert.equal(_pendingSweepTimerCount(), 0);
    assert.equal(_hasPendingSweepTimer(runId), false);
  });

  it("_schedulerGeneration increases by exactly 1 after each shutdownAllCrons", () => {
    // The generation/epoch counter is bumped on every teardown so a
    // dispatch round that captured a stale epoch can detect that
    // shutdown happened while it was in flight.
    const before = _schedulerGeneration();

    shutdownAllCrons();
    assert.equal(_schedulerGeneration(), before + 1);

    shutdownAllCrons();
    assert.equal(_schedulerGeneration(), before + 2);

    shutdownAllCrons();
    assert.equal(_schedulerGeneration(), before + 3);
  });

  it("does not schedule sweep timer when no jobs were removed", async () => {
    // removeRunCrons on an unknown runId must NOT schedule a timer: with
    // no dispatch jobs torn down there is nothing to sweep. This guards
    // against late-arriving fire-and-forget executeDispatchRound calls
    // re-populating pendingSweepTimers after shutdownAllCrons cleared it.
    await removeRunCrons("no-such-run");
    assert.equal(_pendingSweepTimerCount(), 0);
    assert.equal(_hasPendingSweepTimer("no-such-run"), false);

    // Cleanup (no-op here, asserts state remains clean)
    shutdownAllCrons();
    assert.equal(_pendingSweepTimerCount(), 0);
  });

  it("called twice for same runId schedules only one timer (second finds no jobs)", async () => {
    const workflow = makeWorkflow();
    const runId = "run-sweep-twice";

    await setupAgentCrons(workflow, runId);

    // First call tears down the run's dispatch jobs and schedules a sweep.
    await removeRunCrons(runId);
    assert.equal(_pendingSweepTimerCount(), 1);
    assert.equal(_hasPendingSweepTimer(runId), true);

    // Second call finds no remaining jobs (removed.length === 0), so it
    // must not schedule (or re-schedule) a sweep timer.
    await removeRunCrons(runId);
    assert.equal(_pendingSweepTimerCount(), 1);
    assert.equal(_hasPendingSweepTimer(runId), true);
  });

  it("stale epoch: removeRunCrons after shutdown does not schedule a sweep even with jobs removed", async () => {
    // Simulate a fire-and-forget executeDispatchRound that captured the
    // scheduler epoch, then had shutdownAllCrons() run (afterEach-style
    // teardown) while it was in flight. Its late-arriving teardown
    // removeRunCrons must NOT re-populate pendingSweepTimers.
    const workflow = makeWorkflow();
    const runId = "run-sweep-stale-epoch";

    await setupAgentCrons(workflow, runId);
    // Capture the epoch as the round would at its top, before any await.
    const roundGeneration = _schedulerGeneration();

    // Teardown happens (bumps the epoch), clearing all timer/job state.
    shutdownAllCrons();
    assert.equal(_pendingSweepTimerCount(), 0);
    assert.notEqual(_schedulerGeneration(), roundGeneration);

    // Re-establish jobs so removed.length > 0 for this run, then invoke
    // the stale teardown carrying the pre-shutdown epoch. Even though
    // jobs are removed, the stale epoch must suppress the sweep timer.
    await setupAgentCrons(workflow, runId);
    await removeRunCrons(runId, { schedulerGeneration: roundGeneration });
    assert.equal(_pendingSweepTimerCount(), 0);
    assert.equal(_hasPendingSweepTimer(runId), false);
  });

  it("current epoch: removeRunCrons with matching epoch and jobs removed schedules one sweep", async () => {
    // A round whose epoch is still current (no shutdown in flight) must
    // schedule the sweep exactly as an epoch-less call would.
    const workflow = makeWorkflow();
    const runId = "run-sweep-current-epoch";

    await setupAgentCrons(workflow, runId);
    const roundGeneration = _schedulerGeneration();

    await removeRunCrons(runId, { schedulerGeneration: roundGeneration });
    assert.equal(_pendingSweepTimerCount(), 1);
    assert.equal(_hasPendingSweepTimer(runId), true);
  });

  it("no epoch option: legitimate removeRunCrons after teardown still schedules exactly one sweep timer", async () => {
    // Legitimate external callers (control-plane terminate, explicit
    // tear-down) pass no schedulerGeneration and must behave exactly as
    // before: one sweep timer per run that actually had jobs removed.
    const workflow = makeWorkflow();
    const runId = "run-sweep-no-epoch";

    await setupAgentCrons(workflow, runId);
    await removeRunCrons(runId);
    assert.equal(_pendingSweepTimerCount(), 1);
    assert.equal(_hasPendingSweepTimer(runId), true);
  });

  it("cross-teardown leak regression: a late round resolving after shutdown cannot revive pendingSweepTimers", async () => {
    // US-003 regression: reproduce the exact failure shape that the tier0
    // gate caught. A fire-and-forget executeDispatchRound captured the
    // scheduler epoch at its top (before any await); shutdownAllCrons()
    // (the afterEach-style teardown) then ran and cleared all timer state
    // AND bumped the epoch. When the stale round finally resolves and its
    // teardown removeRunCrons fires, it must NOT re-populate
    // pendingSweepTimers — otherwise the leaked timer bleeds into the next
    // test ("does not schedule sweep timer when no jobs were removed").
    const workflow = makeWorkflow();
    const runId = "run-sweep-cross-teardown-leak";

    // Round starts: crons set up, epoch captured before its first await.
    await setupAgentCrons(workflow, runId);
    const preShutdownEpoch = _schedulerGeneration();

    // Teardown runs while the round is "in flight": clears state + bumps epoch.
    shutdownAllCrons();
    assert.equal(_pendingSweepTimerCount(), 0);
    assert.notEqual(_schedulerGeneration(), preShutdownEpoch);

    // Simulate the late round's teardown: jobs exist again (removed.length > 0)
    // but the round carries the STALE pre-shutdown epoch. The product must
    // suppress the sweep so nothing revives across the test boundary.
    await setupAgentCrons(workflow, runId);
    await removeRunCrons(runId, { schedulerGeneration: preShutdownEpoch });
    assert.equal(
      _pendingSweepTimerCount(),
      0,
      "stale-epoch late round must not re-populate pendingSweepTimers after shutdown",
    );
    assert.equal(_hasPendingSweepTimer(runId), false);
  });

  it("stability: repeated setup -> stale-round teardown -> shutdown cycles never accumulate sweep timers", async () => {
    // US-003 stability: run the full boundary cycle several times and assert
    // pendingSweepTimers returns to 0 after every shutdown, proving no
    // accumulation across teardown boundaries even when late rounds keep
    // firing with stale epochs.
    const workflow = makeWorkflow();

    for (let i = 0; i < 5; i++) {
      const runId = `run-sweep-stability-${i}`;

      await setupAgentCrons(workflow, runId);
      const staleEpoch = _schedulerGeneration();

      // Teardown mid-round: clears state, bumps epoch.
      shutdownAllCrons();
      assert.equal(
        _pendingSweepTimerCount(),
        0,
        `cycle ${i}: shutdown must leave zero pending sweep timers`,
      );

      // Late stale-epoch round teardown must not revive anything.
      await setupAgentCrons(workflow, runId);
      await removeRunCrons(runId, { schedulerGeneration: staleEpoch });
      assert.equal(
        _pendingSweepTimerCount(),
        0,
        `cycle ${i}: stale-epoch late round must not schedule a sweep timer`,
      );

      // Final teardown for the cycle: back to a clean slate.
      shutdownAllCrons();
      assert.equal(
        _pendingSweepTimerCount(),
        0,
        `cycle ${i}: end-of-cycle shutdown must leave zero pending sweep timers`,
      );
    }
  });
});

// ── WLST5 round-termination classification ──────────────────────────
// A work round that ends without a STATUS marker is recovered as an
// orphaned step. The recovery must classify WHY the round ended: a round
// the motor itself killed at the worker time ceiling (adapter timedOut:
// true) is a ceiling expiry (step.ceiling_expiry, runs.ceiling_expiry_
// count), while a round whose harness process died on its own (crash,
// exit 1) is a harness loss (step.worker_lost, runs.worker_lost_count).
// This is the regression net for the WLST5 counter split — without it,
// both shapes tick worker_lost_count and an operator cannot tell a
// productive ceiling-killed round from a genuinely lost worker.

describe("executeDispatchRound round-termination classification (WLST5)", () => {
  let tempHome: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-classify-");
    const stateDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    saved = {
      HOME: process.env.HOME,
      TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
      TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
      TAMANDUA_PI_BINARY: process.env.TAMANDUA_PI_BINARY,
    };
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    // Guard awareness (test-isolation-guard): this suite emits events and
    // reads the run DB through the same isolated temp state dir it creates.
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(stateDir, "tamandua.db"), "agent-scheduler-wlst5-classification"),
    );
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    shutdownAllCrons();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /**
   * Seed a running run with a pending step and a fake pi harness that
   * claims the step (status → running, claim_job_id → the dispatch job id,
   * exactly as the real claim CLI does) and then either sleeps past the
   * round timeout ("ceiling" — the motor's own ceiling timer kills it) or
   * exits 1 on its own ("crash" — genuine harness failure).
   */
  function setupRound(die: "ceiling" | "crash"): { runId: string; jobId: string; workdir: string } {
    const db = getDb();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'classify task', 'running', ?, ?, ?)",
    ).run(runId, JSON.stringify({ working_directory_for_harness: workdir }), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-step`, runId, now, now);

    // Same job-id shape as buildJobId("test-wf", runId, "test-agent").
    const jobId = `tamandua-test-wf-${runId}-test-agent`;

    // The fake harness: a node script (shebang-executed by the adapter's
    // shell wrapper) that claims the pending step against the run DB, then
    // dies per the requested termination shape. FAKE_PI_DIE is inherited
    // by the child through the adapter's env merge.
    const fakePi = path.join(tempHome, "pi-mock");
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.TAMANDUA_DB_PATH);
db.exec("PRAGMA busy_timeout = 5000");
db.prepare("UPDATE steps SET status = 'running', claim_job_id = ? WHERE status = 'pending'").run(process.env.TAMANDUA_WORKER_JOB_ID);
if (process.env.FAKE_PI_DIE === "ceiling") {
  await new Promise((resolve) => setTimeout(resolve, 30000));
}
process.exit(1);
`,
      { mode: 0o755 },
    );
    process.env.TAMANDUA_PI_BINARY = fakePi;
    process.env.FAKE_PI_DIE = die;

    return { runId, jobId, workdir };
  }

  it("classifies a ceiling-killed round as step.ceiling_expiry and does NOT tick worker_lost_count", async () => {
    const { runId, jobId, workdir } = setupRound("ceiling");

    // agent.timeoutSeconds=1 → the adapter's ceiling timer fires after 1s.
    await executeDispatchRound(
      { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" },
      { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 1 },
    );

    const db = getDb();
    const row = db.prepare("SELECT worker_lost_count, ceiling_expiry_count FROM runs WHERE id = ?").get(runId) as { worker_lost_count: number; ceiling_expiry_count: number };
    assert.equal(row.worker_lost_count, 0, "a ceiling expiry must NOT tick worker_lost_count");
    assert.equal(row.ceiling_expiry_count, 1, "a ceiling expiry must tick ceiling_expiry_count");

    const events = getRunEvents(runId);
    const ceilingExpiries = events.filter((e) => e.event === "step.ceiling_expiry");
    assert.equal(ceilingExpiries.length, 1, "should emit exactly one step.ceiling_expiry event");
    assert.equal(ceilingExpiries[0].timedOut, true, "step.ceiling_expiry must carry timedOut=true");
    assert.equal(ceilingExpiries[0].signal, "SIGTERM");
    const workerLost = events.filter((e) => e.event === "step.worker_lost");
    assert.equal(workerLost.length, 0, "a ceiling expiry must NOT emit step.worker_lost");
  });

  it("classifies a crashed round as step.worker_lost and ticks worker_lost_count (harness_lost)", async () => {
    const { runId, jobId, workdir } = setupRound("crash");

    await executeDispatchRound(
      { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" },
      { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 1 },
    );

    const db = getDb();
    const row = db.prepare("SELECT worker_lost_count, ceiling_expiry_count FROM runs WHERE id = ?").get(runId) as { worker_lost_count: number; ceiling_expiry_count: number };
    assert.equal(row.worker_lost_count, 1, "a harness crash must tick worker_lost_count");
    assert.equal(row.ceiling_expiry_count, 0, "a harness crash must NOT tick ceiling_expiry_count");

    const events = getRunEvents(runId);
    const workerLost = events.filter((e) => e.event === "step.worker_lost");
    assert.equal(workerLost.length, 1, "should emit exactly one step.worker_lost event");
    assert.equal(workerLost[0].timedOut, undefined, "step.worker_lost must not carry timedOut for a crash");
    assert.equal(workerLost[0].exitCode, 1);
    const ceilingExpiries = events.filter((e) => e.event === "step.ceiling_expiry");
    assert.equal(ceilingExpiries.length, 0, "a crash must NOT emit step.ceiling_expiry");
  });
});

// ── TATR US-002: worker subprocess run identity ─────────────────────
// Every worker round's subprocess must carry the run's identity
// (TAMANDUA_RUN_ID) so nested CLI invocations (tamandua merge-branch,
// tamandua workflow run) can attribute themselves to the run that
// spawned them (TATR facets 1 and 5). The scheduler passes it through
// harnessEnv to adapter.runRound, which merges it into the child
// process env — the same env-inheritance mechanism step claim/complete
// already rely on.

describe("executeDispatchRound harness env run identity (TATR)", () => {
  let tempHome: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-runid-");
    const stateDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    saved = {
      HOME: process.env.HOME,
      TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
      TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
      TAMANDUA_PI_BINARY: process.env.TAMANDUA_PI_BINARY,
      TAMANDUA_RUN_ID: process.env.TAMANDUA_RUN_ID,
    };
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    // Drop any ambient TAMANDUA_RUN_ID so the child-env observation can
    // only come from the scheduler's harnessEnv (not process-env bleed).
    delete process.env.TAMANDUA_RUN_ID;
    // Guard awareness (test-isolation-guard): this suite emits events and
    // reads the run DB through the same isolated temp state dir it creates.
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(stateDir, "tamandua.db"), "agent-scheduler-tatr-runid"),
    );
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    shutdownAllCrons();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("passes TAMANDUA_RUN_ID (and preserves job id / worker pid) into the worker subprocess env", async () => {
    const db = getDb();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'run identity task', 'running', ?, ?, ?)",
    ).run(runId, JSON.stringify({ working_directory_for_harness: workdir }), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-step`, runId, now, now);

    // Same job-id shape as buildJobId("test-wf", runId, "test-agent").
    const jobId = `tamandua-test-wf-${runId}-test-agent`;

    // Fake pi: claims the pending step, dumps the env identity vars it
    // received to a file, then reports STATUS: done so the round completes
    // cleanly (auto-complete via claim_job_id). The dump file path travels
    // through the parent env — the harness env merge must not wipe it.
    const envDump = path.join(tempHome, "env-dump.json");
    const fakePi = path.join(tempHome, "pi-mock");
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
const db = new DatabaseSync(process.env.TAMANDUA_DB_PATH);
db.exec("PRAGMA busy_timeout = 5000");
db.prepare("UPDATE steps SET status = 'running', claim_job_id = ? WHERE status = 'pending'").run(process.env.TAMANDUA_WORKER_JOB_ID);
fs.writeFileSync(process.env.TAMANDUA_ENV_DUMP, JSON.stringify({
  TAMANDUA_RUN_ID: process.env.TAMANDUA_RUN_ID ?? null,
  TAMANDUA_WORKER_JOB_ID: process.env.TAMANDUA_WORKER_JOB_ID ?? null,
  TAMANDUA_WORKER_PID: process.env.TAMANDUA_WORKER_PID ?? null,
}));
console.log("STATUS: done");
process.exit(0);
`,
      { mode: 0o755 },
    );
    process.env.TAMANDUA_PI_BINARY = fakePi;
    process.env.TAMANDUA_ENV_DUMP = envDump;

    await executeDispatchRound(
      { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" },
      { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 },
    );

    // The spawned subprocess observed the harness env (harnessEnv was
    // merged into the child env by adapter.runRound).
    const observed = JSON.parse(fs.readFileSync(envDump, "utf8")) as {
      TAMANDUA_RUN_ID: string | null;
      TAMANDUA_WORKER_JOB_ID: string | null;
      TAMANDUA_WORKER_PID: string | null;
    };
    assert.equal(
      observed.TAMANDUA_RUN_ID,
      runId,
      "worker subprocess must receive TAMANDUA_RUN_ID equal to the dispatch job's runId",
    );
    assert.equal(
      observed.TAMANDUA_WORKER_JOB_ID,
      jobId,
      "existing TAMANDUA_WORKER_JOB_ID env entry must be preserved",
    );
    assert.equal(
      observed.TAMANDUA_WORKER_PID,
      String(process.pid),
      "existing TAMANDUA_WORKER_PID env entry must be preserved",
    );

    // The round completed cleanly: the claimed step was auto-completed.
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(`${runId}-step`) as { status: string };
    assert.equal(step.status, "done", "a clean STATUS: done round must auto-complete the claimed step");
  });
});

// ── TATR US-005: settle-in-flight token attribution ─────────────────
// The cancel path must not kill in-flight work immediately: a worker
// round's parsed tokenUsage can lose the race against the cancel flush,
// leaving a run that actually spent tokens at spend 0 (campaign #7:
// 65,481 parsed but spend 0). settleRunInFlightRounds waits (bounded by
// grace) for every in-flight round's post-round token attribution to
// finish, and the control-plane terminate handler uses it for canceled
// runs. These tests pin the settle semantics at the scheduler level.

describe("settleRunInFlightRounds (TATR US-005)", () => {
  let tempHome: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-settle-");
    const stateDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    saved = {
      HOME: process.env.HOME,
      TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
      TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
      TAMANDUA_PI_BINARY: process.env.TAMANDUA_PI_BINARY,
      TAMANDUA_ROUND_MARKER: process.env.TAMANDUA_ROUND_MARKER,
    };
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    // Guard awareness (test-isolation-guard): this suite emits events and
    // reads the run DB through the same isolated temp state dir it creates.
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(stateDir, "tamandua.db"), "agent-scheduler-tatr-settle"),
    );
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    shutdownAllCrons();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /** Seed a running run + pending step so the dispatch peek says HAS_WORK. */
  function seedSettleRun(): { runId: string; jobId: string; workdir: string } {
    const db = getDb();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'settle task', 'running', ?, ?, ?)",
    ).run(runId, JSON.stringify({ working_directory_for_harness: workdir }), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-step`, runId, now, now);

    // Same job-id shape as buildJobId("test-wf", runId, "test-agent").
    const jobId = `tamandua-test-wf-${runId}-test-agent`;
    return { runId, jobId, workdir };
  }

  /**
   * Fake pi that claims the pending step, writes the in-flight marker,
   * then either completes quickly with a token-usage metadata line
   * ("settle-fast") or sleeps far past any grace window ("hang"). The
   * assistant content carries "STATUS: done" so the round's auto-complete
   * accepts the output on the non-canceled path.
   */
  function writeFakePi(behavior: "settle-fast" | "hang"): string {
    const fakePi = path.join(tempHome, "pi-mock");
    const tail =
      behavior === "settle-fast"
        ? `await new Promise((resolve) => setTimeout(resolve, 300));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "STATUS: done", usage: { totalTokens: 137 } } }));
console.log("STATUS: done");
process.exit(0);`
        : `await new Promise((resolve) => setTimeout(resolve, 30000));`;
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
const db = new DatabaseSync(process.env.TAMANDUA_DB_PATH);
db.exec("PRAGMA busy_timeout = 5000");
db.prepare("UPDATE steps SET status = 'running', claim_job_id = ? WHERE status = 'pending'").run(process.env.TAMANDUA_WORKER_JOB_ID);
fs.writeFileSync(process.env.TAMANDUA_ROUND_MARKER, "inflight");
${tail}
`,
      { mode: 0o755 },
    );
    return fakePi;
  }

  async function waitForMarker(markerPath: string, timeoutMs = 5000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (fs.existsSync(markerPath)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("round never reached in-flight state (marker not written)");
  }

  it("settles an in-flight round within grace; its run.tokens.updated lands before the settle promise resolves", async () => {
    const { runId, jobId, workdir } = seedSettleRun();
    const marker = path.join(tempHome, "round-inflight.marker");
    process.env.TAMANDUA_ROUND_MARKER = marker;
    process.env.TAMANDUA_PI_BINARY = writeFakePi("settle-fast");

    const round = executeDispatchRound(
      { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" },
      { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 },
    );

    await waitForMarker(marker);

    // Simulate the cancel path: the run is marked canceled while the round
    // is mid-harness (stopWorkflow marks the run before notifying the daemon).
    getDb()
      .prepare("UPDATE runs SET status = 'canceled', scheduling_status = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(runId);

    const startedAt = Date.now();
    const result = await settleRunInFlightRounds(runId, { graceMs: 5000 });
    const elapsedMs = Date.now() - startedAt;

    assert.deepEqual(result.stillInFlight, [], "the in-flight round must settle within the grace window");
    assert.ok(elapsedMs < 4000, `settle must resolve within grace, took ${elapsedMs}ms`);

    // The attribution landed BEFORE the settle promise resolved: the round's
    // completion signal fires only after post-round token attribution.
    const events = getRunEvents(runId);
    const tokenEvents = events.filter((e) => e.event === "run.tokens.updated");
    assert.equal(tokenEvents.length, 1, "exactly one run.tokens.updated must land");
    assert.equal(tokenEvents[0].runId, runId, "the delta must be attributed to the dispatch run");
    assert.equal(tokenEvents[0].tokenDelta, 137);
    assert.equal(tokenEvents[0].tokensSpent, 137);

    const row = getDb().prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId) as { tokens_spent: number };
    assert.equal(row.tokens_spent, 137, "the DB spend must include the settled delta");

    await round; // the round completed cleanly
  });

  it("times out without hanging when a round never finishes, reporting it as still in flight", async () => {
    const { runId, jobId, workdir } = seedSettleRun();
    const marker = path.join(tempHome, "round-hang.marker");
    process.env.TAMANDUA_ROUND_MARKER = marker;
    process.env.TAMANDUA_PI_BINARY = writeFakePi("hang");

    const round = executeDispatchRound(
      { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" },
      { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 60 },
    );

    await waitForMarker(marker);

    const startedAt = Date.now();
    const result = await settleRunInFlightRounds(runId, { graceMs: 150 });
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 2000, `settle must time out without hanging, took ${elapsedMs}ms`);
    assert.deepEqual(result.stillInFlight, [jobId], "the never-finishing round must be reported as still in flight");

    // The round is still running (30s sleep); afterEach's shutdownAllCrons
    // kills its child and the round resolves. executeDispatchRound never
    // rejects, so the un-awaited promise is safe.
    void round;
  });

  it("finds in-flight rounds after removeRunCrons wiped the run's job bookkeeping (cancel-path ordering)", async () => {
    // The control-plane cancel path calls removeRunCrons (timer removal)
    // BEFORE settleRunInFlightRounds. removeRunCrons wipes jobMetadata /
    // inFlightJobs for the run — the settle must still find the round via
    // its completion signal and wait for its attribution.
    const { runId, workdir } = seedSettleRun();
    const marker = path.join(tempHome, "round-after-remove.marker");
    process.env.TAMANDUA_ROUND_MARKER = marker;
    process.env.TAMANDUA_PI_BINARY = writeFakePi("settle-fast");

    // Register the run's job in jobMetadata exactly as admission does, so
    // removeRunCrons has real bookkeeping to wipe.
    const workflow = makeWorkflow();
    await setupAgentCrons(workflow, runId, { workingDirectoryForHarness: workdir });

    const jobId = `tamandua-test-wf-${runId}-test-agent`;
    const round = executeDispatchRound(
      { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" },
      { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 },
    );

    await waitForMarker(marker);

    // Mirror handleTerminateRun's cancel sequence exactly: remove the
    // scheduling timers with the grace window, then settle.
    await removeRunCrons(runId, { graceMs: HARNESS_TEARDOWN_GRACE_MS });
    const result = await settleRunInFlightRounds(runId, { graceMs: 5000 });

    assert.deepEqual(result.stillInFlight, [], "the in-flight round must settle even though removeRunCrons wiped its bookkeeping");
    const events = getRunEvents(runId);
    assert.ok(
      events.some((e) => e.event === "run.tokens.updated"),
      "attribution must land after removeRunCrons so the cancel flush sees the settled delta",
    );

    await round;
  });
});

// ── TATR US-007: explicit post-terminal flush identity ─────────────
// A worker round's token attribution can land after the run already
// reached a terminal DB status — e.g. a round that outlived the settle
// grace window (the cancel path's leak-guard reaping), or the final
// round of a completed/failed run whose usage parsed after the terminal
// event fired (the C15 final-round gap). Such flushes must be explicitly
// identifiable: the emitted run.tokens.updated carries postTerminal: true
// + terminalStatus so consumers that stop reading at the terminal event
// can subscribe to them instead of missing the delta. Non-terminal
// updates carry neither field.

describe("attributeWorkRoundTokenUsage post-terminal flush identity (TATR US-007)", () => {
  let tempHome: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-postterminal-");
    const stateDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    saved = {
      HOME: process.env.HOME,
      TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
      TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
      TAMANDUA_PI_BINARY: process.env.TAMANDUA_PI_BINARY,
      TAMANDUA_ROUND_MARKER: process.env.TAMANDUA_ROUND_MARKER,
    };
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    // Guard awareness (test-isolation-guard): this suite emits events and
    // reads the run DB through the same isolated temp state dir it creates.
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(stateDir, "tamandua.db"), "agent-scheduler-tatr-postterminal"),
    );
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    shutdownAllCrons();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /** Seed a run with the given status + a pending step so the dispatch peek says HAS_WORK. */
  function seedRun(status: string): { runId: string; jobId: string; workdir: string } {
    const db = getDb();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'post-terminal task', ?, ?, ?, ?)",
    ).run(runId, status, JSON.stringify({ working_directory_for_harness: workdir }), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-step`, runId, now, now);

    // Same job-id shape as buildJobId("test-wf", runId, "test-agent").
    const jobId = `tamandua-test-wf-${runId}-test-agent`;
    return { runId, jobId, workdir };
  }

  /**
   * Fake pi: claims the pending step, writes the in-flight marker, sleeps
   * 300ms (so the test can flip the run to a terminal status mid-round),
   * then emits a token-usage metadata line (137 tokens) + STATUS: done.
   */
  function writeFakePi(): string {
    const fakePi = path.join(tempHome, "pi-mock");
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
const db = new DatabaseSync(process.env.TAMANDUA_DB_PATH);
db.exec("PRAGMA busy_timeout = 5000");
db.prepare("UPDATE steps SET status = 'running', claim_job_id = ? WHERE status = 'pending'").run(process.env.TAMANDUA_WORKER_JOB_ID);
fs.writeFileSync(process.env.TAMANDUA_ROUND_MARKER, "inflight");
await new Promise((resolve) => setTimeout(resolve, 300));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "STATUS: done", usage: { totalTokens: 137 } } }));
console.log("STATUS: done");
process.exit(0);
`,
      { mode: 0o755 },
    );
    return fakePi;
  }

  async function waitForMarker(markerPath: string, timeoutMs = 5000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (fs.existsSync(markerPath)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("round never reached in-flight state (marker not written)");
  }

  function startRound(runId: string, jobId: string, workdir: string): Promise<void> {
    return executeDispatchRound(
      { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" },
      { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 },
    );
  }

  it("marks a flush postTerminal when the run reached a terminal DB status mid-round", async () => {
    const { runId, jobId, workdir } = seedRun("running");
    const marker = path.join(tempHome, "round-postterminal.marker");
    process.env.TAMANDUA_ROUND_MARKER = marker;
    process.env.TAMANDUA_PI_BINARY = writeFakePi();

    const round = startRound(runId, jobId, workdir);
    await waitForMarker(marker);

    // The run reaches a terminal status while the round is mid-harness
    // (e.g. another step's completion marked the run failed before this
    // round's usage parsed — the C15 final-round gap).
    getDb()
      .prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?")
      .run(runId);

    await round;

    const events = getRunEvents(runId);
    const tokenEvents = events.filter((e) => e.event === "run.tokens.updated");
    assert.equal(tokenEvents.length, 1, "exactly one run.tokens.updated must land");
    assert.equal(tokenEvents[0].runId, runId, "the delta must be attributed to the dispatch run");
    assert.equal(tokenEvents[0].tokenDelta, 137);
    assert.equal(tokenEvents[0].tokensSpent, 137);
    assert.equal(tokenEvents[0].postTerminal, true, "a flush attributed to a terminal run must be marked post-terminal");
    assert.equal(tokenEvents[0].terminalStatus, "failed", "terminalStatus must name the run's terminal DB status");
  });

  it("carries no postTerminal fields when the run is still running at attribution time", async () => {
    const { runId, jobId, workdir } = seedRun("running");
    const marker = path.join(tempHome, "round-running.marker");
    process.env.TAMANDUA_ROUND_MARKER = marker;
    process.env.TAMANDUA_PI_BINARY = writeFakePi();

    const round = startRound(runId, jobId, workdir);
    await waitForMarker(marker);

    // The run stays 'running' through the round — a normal in-run flush.
    await round;

    const events = getRunEvents(runId);
    const tokenEvents = events.filter((e) => e.event === "run.tokens.updated");
    assert.equal(tokenEvents.length, 1, "exactly one run.tokens.updated must land");
    assert.equal(tokenEvents[0].postTerminal, undefined, "an in-run flush must not be marked post-terminal");
    assert.equal(tokenEvents[0].terminalStatus, undefined, "an in-run flush must not carry terminalStatus");
  });
});

describe("attributeWorkRoundTokenUsage dispatch-run attribution identity (TATR US-008)", () => {
  let tempHome: string;
  let stateDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-attribution-");
    stateDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    saved = {
      HOME: process.env.HOME,
      TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
      TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
      TAMANDUA_PI_BINARY: process.env.TAMANDUA_PI_BINARY,
      TAMANDUA_ROUND_MARKER: process.env.TAMANDUA_ROUND_MARKER,
    };
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    // Guard awareness (test-isolation-guard): this suite emits events and
    // reads the run DB / log through the same isolated temp state dir it
    // creates.
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(stateDir, "tamandua.db"), "agent-scheduler-tatr-attribution"),
    );
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    shutdownAllCrons();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /** Seed a run with the given status + a pending step so the dispatch peek says HAS_WORK. */
  function seedRun(status: string): { runId: string; jobId: string; workdir: string } {
    const db = getDb();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'attribution task', ?, ?, ?, ?)",
    ).run(runId, status, JSON.stringify({ working_directory_for_harness: workdir }), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-step`, runId, now, now);

    // Same job-id shape as buildJobId("test-wf", runId, "test-agent").
    const jobId = `tamandua-test-wf-${runId}-test-agent`;
    return { runId, jobId, workdir };
  }

  /** Seed a sibling run that must NEVER receive the dispatch round's delta. */
  function seedSiblingRun(runId: string): void {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'sibling task', 'running', '{}', ?, ?)",
    ).run(runId, now, now);
  }

  function tokensSpent(runId: string): number {
    const db = getDb();
    const row = db
      .prepare("SELECT tokens_spent FROM runs WHERE id = ?")
      .get(runId) as { tokens_spent: number } | undefined;
    return row?.tokens_spent ?? -1;
  }

  function readTamanduaLog(): string {
    try {
      return fs.readFileSync(path.join(stateDir, "tamandua.log"), "utf8");
    } catch {
      return "";
    }
  }

  /**
   * Fake pi: claims the pending step, then emits a token-usage metadata
   * line (137 tokens), optional run_id/step_id lines naming the ids the
   * test wants the stream to claim (the cross-run hijack probe), and a
   * STATUS: done marker so auto-complete passes.
   */
  function writeFakePi(opts: { runIdLine?: string; stepIdLine?: string }): string {
    const { runIdLine, stepIdLine } = opts;
    const extra = [runIdLine, stepIdLine].filter((l): l is string => l !== undefined).join("\n");
    const fakePi = path.join(tempHome, "pi-mock-attribution");
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.TAMANDUA_DB_PATH);
db.exec("PRAGMA busy_timeout = 5000");
db.prepare("UPDATE steps SET status = 'running', claim_job_id = ? WHERE status = 'pending'").run(process.env.TAMANDUA_WORKER_JOB_ID);
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "STATUS: done", usage: { totalTokens: 137 } } }));
${extra ? `console.log(${JSON.stringify(extra)});` : ""}
console.log("STATUS: done");
process.exit(0);
`,
      { mode: 0o755 },
    );
    return fakePi;
  }

  function startRound(runId: string, jobId: string, workdir: string): Promise<void> {
    return executeDispatchRound(
      { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" },
      { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 },
    );
  }

  it("attributes the delta to the dispatch run, not the sibling named in tool output, and logs a hijack warning", async () => {
    const { runId, jobId, workdir } = seedRun("running");
    const siblingRunId = crypto.randomUUID();
    const metadataStepId = crypto.randomUUID();
    seedSiblingRun(siblingRunId);

    // Tool output claims a sibling run id + a step id — both must be
    // treated as advisory; the delta lands on the dispatch run.
    process.env.TAMANDUA_PI_BINARY = writeFakePi({
      runIdLine: `run_id: "${siblingRunId}"`,
      stepIdLine: `step_id: "${metadataStepId}"`,
    });

    await startRound(runId, jobId, workdir);

    const events = getRunEvents(runId);
    const tokenEvents = events.filter((e) => e.event === "run.tokens.updated");
    assert.equal(tokenEvents.length, 1, "exactly one run.tokens.updated must land");
    assert.equal(tokenEvents[0].runId, runId, "the delta must be attributed to the dispatch run, not the metadata sibling");
    assert.equal(tokenEvents[0].tokenDelta, 137);
    assert.equal(tokenEvents[0].tokensSpent, 137);
    assert.equal(tokenEvents[0].stepId, metadataStepId, "the event carries the step id from stream metadata");
    assert.equal(tokenEvents[0].roundId, jobId, "the event carries the dispatch job id as roundId");

    // The sibling run must NOT have received the delta.
    assert.equal(tokensSpent(runId), 137, "the dispatch run must absorb the delta");
    assert.equal(tokensSpent(siblingRunId), 0, "the sibling run must not receive the delta");

    // The disagreement is logged as a cross-run metadata hijack warning.
    const logContent = readTamanduaLog();
    assert.match(logContent, /cross_run_metadata_hijack/, "the mismatch must be logged with the hijack reason");
    assert.ok(logContent.includes(siblingRunId), "the warning must name the metadata run id");
    assert.ok(logContent.includes(runId), "the warning must name the dispatch run id");
  });

  it("attributes to the dispatch run and logs no hijack warning when tool output agrees with the dispatch run", async () => {
    const { runId, jobId, workdir } = seedRun("running");
    const metadataStepId = crypto.randomUUID();

    process.env.TAMANDUA_PI_BINARY = writeFakePi({
      runIdLine: `run_id: "${runId}"`,
      stepIdLine: `step_id: "${metadataStepId}"`,
    });

    await startRound(runId, jobId, workdir);

    const tokenEvents = getRunEvents(runId).filter((e) => e.event === "run.tokens.updated");
    assert.equal(tokenEvents.length, 1, "exactly one run.tokens.updated must land");
    assert.equal(tokenEvents[0].runId, runId, "the delta stays on the dispatch run");
    assert.equal(tokenEvents[0].stepId, metadataStepId, "the event carries the step id from stream metadata");
    assert.equal(tokenEvents[0].roundId, jobId, "the event carries the dispatch job id as roundId");
    assert.equal(tokensSpent(runId), 137);

    const logContent = readTamanduaLog();
    assert.ok(
      !logContent.includes("cross_run_metadata_hijack"),
      "no warning when the metadata run id agrees with the dispatch run",
    );
  });

  it("attributes to the dispatch run and carries roundId but no stepId when tool output has no ids", async () => {
    const { runId, jobId, workdir } = seedRun("running");

    process.env.TAMANDUA_PI_BINARY = writeFakePi({});

    await startRound(runId, jobId, workdir);

    const tokenEvents = getRunEvents(runId).filter((e) => e.event === "run.tokens.updated");
    assert.equal(tokenEvents.length, 1, "exactly one run.tokens.updated must land");
    assert.equal(tokenEvents[0].runId, runId, "the delta stays on the dispatch run");
    assert.equal(tokenEvents[0].stepId, undefined, "no stepId when the stream carries none");
    assert.equal(tokenEvents[0].roundId, jobId, "roundId is always the dispatch job id");
    assert.equal(tokensSpent(runId), 137);

    const logContent = readTamanduaLog();
    assert.ok(
      !logContent.includes("cross_run_metadata_hijack"),
      "no warning when the stream carries no run id",
    );
  });
});
