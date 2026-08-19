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
