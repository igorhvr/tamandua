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
import { spawn, type ChildProcess } from "node:child_process";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  setupAgentCrons,
  createAgentCronJob,
  _scheduledJobCountForRun,
  removeRunCrons,
  runPostGraceSweep,
  settleRunInFlightRounds,
  shutdownAllCrons,
  tryMarkJobInFlight,
  nudgeScheduledRuns,
  _pendingSweepTimerCount,
  _hasPendingSweepTimer,
  _pendingSweepTarget,
  _schedulerGeneration,
  executeDispatchRound,
  DISPATCH_INTERVAL_MS,
  HARNESS_TEARDOWN_GRACE_MS,
  getRunTeardownGraceMs,
  _instantFailStreakFor,
  _resetInstantFailStreaks,
  _preclaimDeathStreakFor,
  _resetPreclaimDeathStreaks,
  isPreclaimDeathBackoffActive,
  _operatorPausedRoundIds,
  _scheduledJobGitIdentity,
} from "../../dist/installer/agent-scheduler.js";
import { getDb } from "../../dist/db.js";
import { getRunEvents } from "../../dist/installer/events.js";
import { emitRunTerminalEvent } from "../../dist/installer/step-ops.js";
import { getHarnessAdapter } from "../../dist/installer/harness-adapter.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";
import { monotonicNow } from "../../dist/lib/instant.js";
import type { SetupAgentCronsOptions, NudgeResult, CronJobInfo } from "../../dist/installer/agent-scheduler.js";
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

// ── Test-isolation state env ────────────────────────────────────────
// Scheduler code under test reads the run DB (getDb → TAMANDUA_DB_PATH,
// else ~/.tamandua/tamandua.db) and logs through lib/logger (STATE_DIR).
// Describes that don't set their own full env used to resolve the REAL
// ~/.tamandua, trip the test-isolation guard, and silently skip the DB
// reads/log writes (55 ledger violations). Isolate every test to a fresh
// temp HOME / STATE_DIR / DB_PATH; restore the previous env in afterEach.
let savedHome: string | undefined;
let savedStateDir: string | undefined;
let savedDbPath: string | undefined;
let isolationRoot: string | null = null;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedStateDir = process.env.TAMANDUA_STATE_DIR;
  savedDbPath = process.env.TAMANDUA_DB_PATH;
  isolationRoot = tamanduaTempDir("tamandua-test-agent-scheduler-state-");
  const stateDir = path.join(isolationRoot, ".tamandua");
  fs.mkdirSync(stateDir, { recursive: true });
  process.env.HOME = isolationRoot;
  process.env.TAMANDUA_STATE_DIR = stateDir;
  process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
});

afterEach(() => {
  if (isolationRoot) {
    try {
      fs.rmSync(isolationRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    isolationRoot = null;
  }
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
  else process.env.TAMANDUA_STATE_DIR = savedStateDir;
  if (savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
  else process.env.TAMANDUA_DB_PATH = savedDbPath;
});

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

// ── Post-grace sweep: direct-mode runs (DSWP part 2) ────────────────

describe("runPostGraceSweep direct-mode runs", () => {
  let children: ChildProcess[];
  let sweepDir: string;
  let outsideDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    children = [];
    sweepDir = tamanduaTempDir("tamandua-direct-sweep-");
    outsideDir = tamanduaTempDir("tamandua-direct-sweep-outside-");
    saved = {
      TAMANDUA_PI_BINARY: process.env.TAMANDUA_PI_BINARY,
      TAMANDUA_HARNESS_PROBE: process.env.TAMANDUA_HARNESS_PROBE,
      TAMANDUA_ROUND_MARKER: process.env.TAMANDUA_ROUND_MARKER,
    };
  });

  afterEach(() => {
    // Tear down scheduler/child state BEFORE restoring env so any late
    // round logging still lands in the isolated test state dir.
    shutdownAllCrons();
    for (const child of children) {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
    children.length = 0;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(sweepDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function waitForExit(child: ChildProcess, timeoutMs = 4000): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * Seed a direct-mode run (no run_worktrees row). When `claimPgid` is
   * given, a step row records it as this run's harness process group.
   */
  function seedDirectRun(
    runId: string,
    context: Record<string, unknown>,
    claimPgid?: number,
  ): void {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'direct sweep task', 'completed', ?, ?, ?)",
    ).run(runId, JSON.stringify(context), now, now);
    if (claimPgid !== undefined) {
      db.prepare(
        "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, claim_pid, claim_pgid, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'done', ?, ?, ?, ?)",
      ).run(crypto.randomUUID(), runId, claimPgid, claimPgid, now, now);
    }
  }

  it("sweeps a direct-mode run using the captured directory and pgids", async () => {
    const runId = "run-direct-captured";
    const ownedCwd = path.join(outsideDir, "owned");
    const unrelatedCwd = path.join(outsideDir, "unrelated");
    fs.mkdirSync(ownedCwd, { recursive: true });
    fs.mkdirSync(unrelatedCwd, { recursive: true });

    // cwd is OUTSIDE the sweep directory, so only the pgid channel can
    // match the owned child — proving the captured pgid is threaded through.
    const owned = spawn("sleep", ["30"], {
      cwd: ownedCwd,
      env: { PATH: process.env.PATH || "/usr/bin" },
      stdio: "ignore",
      detached: true,
    });
    const unrelated = spawn("sleep", ["30"], {
      cwd: unrelatedCwd,
      env: { PATH: process.env.PATH || "/usr/bin" },
      stdio: "ignore",
      detached: true,
    });
    children.push(owned, unrelated);

    await sleep(300);
    const ownedPid = owned.pid!;
    const unrelatedPid = unrelated.pid!;
    assert.ok(isAlive(ownedPid), "owned child should be alive before the sweep");
    assert.ok(isAlive(unrelatedPid), "unrelated child should be alive before the sweep");

    // Direct-mode run: no run_worktrees row. The captured target names the
    // working directory (for the event detail) and the owned pgid.
    seedDirectRun(runId, {});
    await runPostGraceSweep(runId, { workingDirectory: sweepDir, pgids: [ownedPid] });

    const cleanup = getRunEvents(runId).filter((e) => e.event === "run.process_cleanup");
    assert.equal(cleanup.length, 1, "exactly one run.process_cleanup event");
    const detail = JSON.parse(cleanup[0].detail!);
    assert.equal(detail.worktreePath, sweepDir);
    assert.ok(
      Array.isArray(detail.pgids) && detail.pgids.includes(ownedPid),
      `event detail should name the owned pgid: ${JSON.stringify(detail.pgids)}`,
    );
    assert.ok(
      detail.killedPids.includes(ownedPid),
      `owned child should be recorded as killed: ${JSON.stringify(detail.killedPids)}`,
    );
    assert.ok(
      !detail.killedPids.includes(unrelatedPid),
      "unrelated pid must not be recorded as killed",
    );

    const ownedExited = await waitForExit(owned, 2000);
    assert.ok(ownedExited, "owned child should have exited after SIGKILL");
    assert.ok(!isAlive(ownedPid), "owned child should be gone");
    assert.ok(isAlive(unrelatedPid), "unrelated child must survive the sweep");
  });

  it("resolves directory from run context and pgids from steps.claim_pgid (no worktree row)", async () => {
    const runId = "run-direct-db-resolved";
    const ownedCwd = path.join(outsideDir, "owned-db");
    fs.mkdirSync(ownedCwd, { recursive: true });

    const owned = spawn("sleep", ["30"], {
      cwd: ownedCwd,
      env: { PATH: process.env.PATH || "/usr/bin" },
      stdio: "ignore",
      detached: true,
    });
    children.push(owned);
    await sleep(300);
    const ownedPid = owned.pid!;

    seedDirectRun(
      runId,
      { workspace_mode: "direct", working_directory_for_harness: sweepDir },
      ownedPid,
    );

    // No captured target: the sweep must resolve both the directory (from
    // runs.context) and the pgid (from steps.claim_pgid).
    await runPostGraceSweep(runId);

    const cleanup = getRunEvents(runId).filter((e) => e.event === "run.process_cleanup");
    assert.equal(cleanup.length, 1);
    const detail = JSON.parse(cleanup[0].detail!);
    assert.equal(detail.worktreePath, sweepDir);
    assert.ok(
      detail.killedPids.includes(ownedPid),
      `child in the recorded claim_pgid should be reaped: ${JSON.stringify(detail.killedPids)}`,
    );

    const ownedExited = await waitForExit(owned, 2000);
    assert.ok(ownedExited, "owned child should have exited after SIGKILL");
    assert.ok(!isAlive(ownedPid), "owned child should be gone");
  });

  it("runs the marker sweep with a null path when no directory or pgid resolves", {
    skip: process.platform === "darwin" ? "environ evidence is unreadable on macOS" : false,
  }, async () => {
    const runId = "run-direct-marker-only";
    const ownedCwd = path.join(outsideDir, "marker-only");
    fs.mkdirSync(ownedCwd, { recursive: true });

    const owned = spawn("sleep", ["30"], {
      cwd: ownedCwd,
      env: { PATH: process.env.PATH || "/usr/bin", TAMANDUA_RUN_ID: runId },
      stdio: "ignore",
      detached: true,
    });
    children.push(owned);
    await sleep(300);
    const ownedPid = owned.pid!;

    // Empty context, no worktree row, no pgids: the sweep must still run
    // (no "no worktree found" early return) and match the run marker.
    seedDirectRun(runId, {});
    await runPostGraceSweep(runId);

    const cleanup = getRunEvents(runId).filter((e) => e.event === "run.process_cleanup");
    assert.equal(cleanup.length, 1);
    const detail = JSON.parse(cleanup[0].detail!);
    assert.equal(detail.worktreePath, null);
    assert.ok(
      detail.killedPids.includes(ownedPid),
      `TAMANDUA_RUN_ID child should be reaped with a null path: ${JSON.stringify(detail.killedPids)}`,
    );
    assert.ok(
      String(detail.evidence[ownedPid]).includes(`TAMANDUA_RUN_ID=${runId}`),
      `evidence should name the run marker: ${JSON.stringify(detail.evidence[ownedPid])}`,
    );

    const ownedExited = await waitForExit(owned, 2000);
    assert.ok(ownedExited, "owned child should have exited after SIGKILL");
    assert.ok(!isAlive(ownedPid), "owned child should be gone");
  });

  it("removeRunCrons captures the working directory and in-flight harness pgid", async () => {
    // No "run-" prefix: peekStep strips that prefix, and this round goes
    // through the real deterministic peek.
    const runId = "direct-capture-1";
    const workdir = path.join(outsideDir, "capture-work");
    fs.mkdirSync(workdir, { recursive: true });
    const now = new Date().toISOString();
    const db = getDb();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'capture task', 'running', ?, ?, ?)",
    ).run(runId, JSON.stringify({ working_directory_for_harness: workdir }), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-step`, runId, now, now);

    const marker = path.join(outsideDir, "capture-inflight.marker");
    const fakePi = path.join(outsideDir, "pi-capture-hang");
    // Deliberately does NOT claim the step: the round still registers the
    // harness pgid at spawn (what this test asserts), but the post-round
    // orphan recovery finds no running claim to release — avoiding a
    // fire-and-forget control-plane call that would outlive the test env.
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(process.env.TAMANDUA_ROUND_MARKER, "inflight");
await new Promise((resolve) => setTimeout(resolve, 30000));
`,
      { mode: 0o755 },
    );
    process.env.TAMANDUA_PI_BINARY = fakePi;
    process.env.TAMANDUA_HARNESS_PROBE = "0";
    process.env.TAMANDUA_ROUND_MARKER = marker;

    // workflowId "test-wf" so the setup job id matches the round below.
    const workflow = { ...makeWorkflow(), id: "test-wf" };
    await setupAgentCrons(workflow, runId, { workingDirectoryForHarness: workdir });

    const jobId = `tamandua-test-wf-${runId}-test-agent`;
    const round = executeDispatchRound(
      {
        id: jobId,
        workflowId: "test-wf",
        runId,
        agentId: "test-wf_test-agent",
        harnessType: "pi",
        workingDirectoryForHarness: workdir,
        createdAt: "",
      },
      { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 60 },
    );

    const startedAt = Date.now();
    while (!fs.existsSync(marker) && Date.now() - startedAt < 5000) {
      await sleep(20);
    }
    assert.ok(fs.existsSync(marker), "round never reached the in-flight state");

    await removeRunCrons(runId);

    const target = _pendingSweepTarget(runId);
    assert.ok(target, "removeRunCrons must capture a sweep target");
    assert.equal(
      target.workingDirectory,
      workdir,
      "the run's workingDirectoryForHarness must be captured before jobMetadata is wiped",
    );
    assert.ok(
      Array.isArray(target.pgids) && target.pgids.length >= 1,
      `the in-flight harness pgid must be captured: ${JSON.stringify(target?.pgids)}`,
    );
    assert.ok(
      target.pgids!.every((pgid) => Number.isInteger(pgid) && pgid > 0),
      `captured pgids must be positive integers: ${JSON.stringify(target.pgids)}`,
    );

    // Let the torn-down round settle inside the isolated test env (its child
    // was killed by removeRunCrons) before afterEach tears the env down.
    await round;
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
      // The canned fake-pi shims below never answer a launch-time harness
      // probe prompt (they claim/die per FAKE_PI_DIE), so the probe is
      // disabled for these rounds — exactly as TAMANDUA_PI_BINARY is
      // managed — keeping the WLST5 classification assertions unchanged.
      TAMANDUA_HARNESS_PROBE: process.env.TAMANDUA_HARNESS_PROBE,
    };
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    process.env.TAMANDUA_HARNESS_PROBE = "0";
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

// ── PKIL US-005: operator-pause round classification ─────────────────
// A NON-DRAIN `run pause` tears the round down with removeRunCrons, which
// aborts the round and SIGTERMs the harness pgid. That exit must classify as
// an operator pause (PKIL): step.paused_kill, no retry charge, never
// step.worker_lost / runs.worker_lost_count. removeRunCrons marks each
// in-flight round BEFORE the abort/kill; the settling round consumes the mark
// and threads `abandonReason: "paused_by_operator"` through BOTH recovery
// paths (clean-exit/empty-output and adapter-throw).

describe("PKIL US-005: operator-pause round classification", () => {
  let tempHome: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-pkil-us005-");
    const stateDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    saved = {
      HOME: process.env.HOME,
      TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
      TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
      TAMANDUA_PI_BINARY: process.env.TAMANDUA_PI_BINARY,
      TAMANDUA_HARNESS_PROBE: process.env.TAMANDUA_HARNESS_PROBE,
      TAMANDUA_ROUND_MARKER: process.env.TAMANDUA_ROUND_MARKER,
      TAMANDUA_HARNESS_INVOCATIONS: process.env.TAMANDUA_HARNESS_INVOCATIONS,
    };
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    process.env.TAMANDUA_HARNESS_PROBE = "0";
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(stateDir, "tamandua.db"), "agent-scheduler-pkil-us005"),
    );
  });

  afterEach(() => {
    shutdownAllCrons();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  function workflowSpec() {
    return { ...makeWorkflow(), id: "test-wf" };
  }

  function jobFor(runId: string, jobId: string, workdir: string) {
    return {
      id: jobId,
      workflowId: "test-wf",
      runId,
      agentId: "test-wf_test-agent",
      harnessType: "pi" as const,
      workingDirectoryForHarness: workdir,
      createdAt: "",
    };
  }

  function agentSpec() {
    return { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 60 };
  }

  /**
   * Seed a running run with one pending step plus a fake pi that claims the
   * step, records the invocation, and hangs. Invocation 1 hangs (the round to
   * be paused); invocation 2+ reports STATUS: done so a post-resume round can
   * auto-complete the step.
   */
  function setupPausingRound(): {
    runId: string;
    jobId: string;
    workdir: string;
    marker: string;
    invocations: string;
  } {
    const db = getDb();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });
    const marker = path.join(tempHome, "round.marker");
    const invocations = path.join(tempHome, "invocations");

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'pkil task', 'running', ?, ?, ?)",
    ).run(runId, JSON.stringify({ working_directory_for_harness: workdir }), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-step`, runId, now, now);

    const fakePi = path.join(tempHome, "pi-pkil");
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
const db = new DatabaseSync(process.env.TAMANDUA_DB_PATH);
db.exec("PRAGMA busy_timeout = 5000");
db.prepare("UPDATE steps SET status = 'running', claim_job_id = ? WHERE status = 'pending'").run(process.env.TAMANDUA_WORKER_JOB_ID);
let inv = 0;
try { inv = Number(fs.readFileSync(process.env.TAMANDUA_HARNESS_INVOCATIONS, "utf8")) || 0; } catch {}
inv += 1;
fs.writeFileSync(process.env.TAMANDUA_HARNESS_INVOCATIONS, String(inv));
if (inv === 1) {
  fs.writeFileSync(process.env.TAMANDUA_ROUND_MARKER, "inflight");
  await new Promise((resolve) => setTimeout(resolve, 30000));
  process.exit(143);
}
console.log("STATUS: done");
process.exit(0);
`,
      { mode: 0o755 },
    );
    process.env.TAMANDUA_PI_BINARY = fakePi;
    process.env.TAMANDUA_ROUND_MARKER = marker;
    process.env.TAMANDUA_HARNESS_INVOCATIONS = invocations;

    return { runId, jobId: `tamandua-test-wf-${runId}-test-agent`, workdir, marker, invocations };
  }

  async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
    const startedAt = Date.now();
    while (!fs.existsSync(file) && Date.now() - startedAt < timeoutMs) {
      await sleep(20);
    }
    assert.ok(fs.existsSync(file), `file never appeared: ${file}`);
  }

  it("marks the in-flight round and classifies the SIGTERM exit as paused_by_operator (AC1-AC4)", async () => {
    const { runId, jobId, workdir, marker } = setupPausingRound();
    const workflow = workflowSpec();
    await setupAgentCrons(workflow, runId, { workingDirectoryForHarness: workdir });

    const round = executeDispatchRound(jobFor(runId, jobId, workdir), agentSpec());
    await waitForFile(marker);

    // removeRunCrons runs synchronously through its teardown loop (graceMs 0),
    // so the mark is observable on the returned-but-unawaited promise.
    const removal = removeRunCrons(runId, { pausedByOperator: true });
    assert.deepEqual(
      _operatorPausedRoundIds(),
      [jobId],
      "a non-drain pause must mark the in-flight round before aborting/killing it",
    );
    await removal;
    await round;

    // The settling round consumed its own mark.
    assert.deepEqual(_operatorPausedRoundIds(), [], "the operator-pause mark must be consumed once the round settles");

    const db = getDb();
    const runRow = db
      .prepare("SELECT worker_lost_count, ceiling_expiry_count FROM runs WHERE id = ?")
      .get(runId) as { worker_lost_count: number; ceiling_expiry_count: number };
    assert.equal(runRow.worker_lost_count, 0, "an operator pause must NOT tick worker_lost_count");
    assert.equal(runRow.ceiling_expiry_count, 0, "an operator pause must NOT tick ceiling_expiry_count");

    const step = db
      .prepare("SELECT status, retry_count FROM steps WHERE id = ?")
      .get(`${runId}-step`) as { status: string; retry_count: number };
    assert.equal(step.status, "pending", "a paused step must reset to pending so resume re-dispatches it");
    assert.equal(step.retry_count, 0, "an operator pause must NOT charge a retry");

    const events = getRunEvents(runId);
    assert.equal(
      events.filter((e) => e.event === "step.worker_lost").length,
      0,
      "an operator pause must never emit step.worker_lost",
    );
    const paused = events.filter((e) => e.event === "step.paused_kill");
    assert.equal(paused.length, 1, "an operator pause must emit exactly one step.paused_kill");
    assert.equal(paused[0].signal, "SIGTERM");
    const respawned = events.filter((e) => e.event === "step.respawned");
    assert.equal(respawned.length, 1, "a paused recovery must emit step.respawned");
    assert.equal(respawned[0].reason, "paused_by_operator", "step.respawned must carry reason paused_by_operator");
  });

  it("does not mark the round for a non-pause teardown (AC1 negative)", async () => {
    const { runId, jobId, workdir, marker } = setupPausingRound();
    const workflow = workflowSpec();
    await setupAgentCrons(workflow, runId, { workingDirectoryForHarness: workdir });

    const round = executeDispatchRound(jobFor(runId, jobId, workdir), agentSpec());
    await waitForFile(marker);

    const removal = removeRunCrons(runId);
    assert.deepEqual(_operatorPausedRoundIds(), [], "a terminate/natural-completion teardown must not mark a round");
    await removal;
    await round;

    // Unchanged semantics for every other teardown caller: the round is
    // recovered as a genuine loss (here the SIGTERM-killed running child is
    // the existing ceiling-expiry classification) and a retry IS charged —
    // unlike the operator-pause path.
    const db = getDb();
    const runRow = db
      .prepare("SELECT worker_lost_count, ceiling_expiry_count FROM runs WHERE id = ?")
      .get(runId) as { worker_lost_count: number; ceiling_expiry_count: number };
    assert.equal(
      runRow.worker_lost_count + runRow.ceiling_expiry_count,
      1,
      "a non-pause teardown of a claimed worker must still book a genuine loss",
    );
    const step = db
      .prepare("SELECT status, retry_count FROM steps WHERE id = ?")
      .get(`${runId}-step`) as { status: string; retry_count: number };
    assert.equal(step.status, "pending");
    assert.equal(step.retry_count, 1, "a non-pause loss still charges one retry");
    const events = getRunEvents(runId);
    assert.equal(events.filter((e) => e.event === "step.paused_kill").length, 0);
    assert.equal(events.filter((e) => e.event === "step.respawned").length, 1);
    assert.notEqual(
      events.filter((e) => e.event === "step.respawned")[0].reason,
      "paused_by_operator",
      "a non-pause teardown must not use the paused_by_operator respawn reason",
    );
  });

  it("classifies an adapter-throw round as paused_by_operator (AC3 catch path)", async () => {
    const db = getDb();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workdir = path.join(tempHome, "work-throw");
    fs.mkdirSync(workdir, { recursive: true });
    const jobId = `tamandua-test-wf-${runId}-test-agent`;

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'pkil throw task', 'running', ?, ?, ?)",
    ).run(runId, JSON.stringify({ working_directory_for_harness: workdir }), now, now);
    // A pending step so the deterministic peek reports HAS_WORK.
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-pending', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-pending`, runId, now, now);
    // A step already claimed by this round's worker — the adapter then throws
    // before the worker can report, exercising the catch-block recovery.
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, claim_job_id, retry_count, created_at, updated_at) VALUES (?, ?, 'step-claimed', 'test-wf_test-agent', 1, 'do work', 'STATUS', 'running', ?, 0, ?, ?)",
    ).run(`${runId}-claimed`, runId, jobId, now, now);

    // Executable path that fails findBinary's X_OK check → adapter throw.
    const broken = path.join(tempHome, "pi-broken");
    fs.writeFileSync(broken, "not executable\n", { mode: 0o644 });
    process.env.TAMANDUA_PI_BINARY = broken;
    process.env.TAMANDUA_HARNESS_PROBE = "0";

    const workflow = workflowSpec();
    await setupAgentCrons(workflow, runId, { workingDirectoryForHarness: workdir });

    const round = executeDispatchRound(jobFor(runId, jobId, workdir), agentSpec());
    const removal = removeRunCrons(runId, { pausedByOperator: true });
    assert.deepEqual(_operatorPausedRoundIds(), [jobId], "the in-flight round must be marked before the abort");
    await removal;
    await round;

    assert.deepEqual(_operatorPausedRoundIds(), [], "the mark must be consumed by the settling round");

    const runRow = db
      .prepare("SELECT worker_lost_count FROM runs WHERE id = ?")
      .get(runId) as { worker_lost_count: number };
    assert.equal(runRow.worker_lost_count, 0, "the adapter-throw pause path must NOT tick worker_lost_count");
    const claimed = db
      .prepare("SELECT status, retry_count FROM steps WHERE id = ?")
      .get(`${runId}-claimed`) as { status: string; retry_count: number };
    assert.equal(claimed.status, "pending", "the claimed step must reset to pending");
    assert.equal(claimed.retry_count, 0, "the adapter-throw pause path must NOT charge a retry");

    const events = getRunEvents(runId);
    assert.equal(events.filter((e) => e.event === "step.worker_lost").length, 0);
    assert.equal(events.filter((e) => e.event === "step.paused_kill").length, 1);
    const respawned = events.filter((e) => e.event === "step.respawned");
    assert.equal(respawned.length, 1);
    assert.equal(respawned[0].reason, "paused_by_operator");
  });

  it("re-dispatches the reset step after resume and the run completes (AC5)", async () => {
    const { runId, jobId, workdir, marker } = setupPausingRound();
    const workflow = workflowSpec();
    await setupAgentCrons(workflow, runId, { workingDirectoryForHarness: workdir });

    const round = executeDispatchRound(jobFor(runId, jobId, workdir), agentSpec());
    await waitForFile(marker);
    const removal = removeRunCrons(runId, { pausedByOperator: true });
    await removal;
    await round;

    const db = getDb();
    let step = db
      .prepare("SELECT status, retry_count FROM steps WHERE id = ?")
      .get(`${runId}-step`) as { status: string; retry_count: number };
    assert.equal(step.status, "pending", "the paused step must be pending before resume");
    assert.equal(step.retry_count, 0);

    // Simulate resume: the control plane flips the run back to running and
    // re-creates the run's dispatch jobs.
    db.prepare(
      "UPDATE runs SET status = 'running', scheduling_status = 'active', updated_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), runId);
    await setupAgentCrons(workflow, runId, { workingDirectoryForHarness: workdir });

    // The resumed round's worker claims the pending step and reports done.
    await executeDispatchRound(jobFor(runId, jobId, workdir), agentSpec());

    step = db
      .prepare("SELECT status, retry_count FROM steps WHERE id = ?")
      .get(`${runId}-step`) as { status: string; retry_count: number };
    assert.equal(step.status, "done", "the resumed round must complete the previously-paused step");
    assert.equal(step.retry_count, 0, "the resumed completion must not charge a retry");

    const runRow = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(runRow.status, "completed", "the run must complete after the resumed step completes");
    const events = getRunEvents(runId);
    assert.equal(
      events.filter((e) => e.event === "run.completed").length,
      1,
      "resume after a paused kill must end in run.completed",
    );
    assert.equal(
      events.filter((e) => e.event === "step.worker_lost").length,
      0,
      "no worker_lost may be booked anywhere in the pause → resume flow",
    );
  });
});


// A harness that exits nonzero with zero output before claiming any step
// is an instant-fail round: no step is ever claimed, so clean-exit
// recovery finds nothing, no WLST5 counter ticks, and the fixed dispatch
// tick would relaunch the broken harness forever. The motor must classify
// such rounds (fast + zero output + nonzero exit), track the consecutive
// streak per job, back off the relaunch after K, and force-fail the run
// after N with a precise reason plus a distinct alert event. Regression
// net for campaign #8 attempt-3 (W3.23-token-saver): a broken worker
// binary was relaunched ~40 times at ~15s intervals until an external
// wall cap killed the run.

describe("executeDispatchRound instant-fail classification and escalation (RSPN)", () => {
  let tempHome: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-instant-fail-");
    const stateDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    saved = {
      HOME: process.env.HOME,
      TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
      TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
      TAMANDUA_PI_BINARY: process.env.TAMANDUA_PI_BINARY,
      TAMANDUA_INSTANT_FAIL_WALL_MS: process.env.TAMANDUA_INSTANT_FAIL_WALL_MS,
      TAMANDUA_INSTANT_FAIL_BACKOFF_K: process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K,
      TAMANDUA_INSTANT_FAIL_ESCALATION_N: process.env.TAMANDUA_INSTANT_FAIL_ESCALATION_N,
      TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS: process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS,
      // The canned fake-pi shims never answer a launch-time harness probe
      // prompt (they exit 1 / print lone '\n' / SIGKILL themselves per
      // FAKE_PI_MODE), so the probe is disabled for these rounds — exactly
      // as TAMANDUA_PI_BINARY is managed — keeping every RSPN assertion
      // unchanged (the run's instant-fail loop is the behavior under test).
      TAMANDUA_HARNESS_PROBE: process.env.TAMANDUA_HARNESS_PROBE,
      // Debug lines (the backoff/in-flight skip reasons are logged at
      // debug level); flipped on inside the regression tests that assert
      // on skip-reason log output.
      TAMANDUA_DEBUG: process.env.TAMANDUA_DEBUG,
    };
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    process.env.TAMANDUA_HARNESS_PROBE = "0";
    // Generous wall threshold: the fake harness's process startup (~tens
    // of ms) must reliably fall below it even on loaded CI machines.
    process.env.TAMANDUA_INSTANT_FAIL_WALL_MS = "10000";
    // Guard awareness (test-isolation-guard): this suite emits events and
    // reads the run DB through the same isolated temp state dir it creates.
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(stateDir, "tamandua.db"), "agent-scheduler-rspn-instant-fail"),
    );
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    shutdownAllCrons();
    _resetInstantFailStreaks();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /**
   * Seed a running run with a pending step and a fake pi harness that
   * dies per `mode`:
   *  - "instant": exit 1 immediately with zero output (the broken-binary
   *    shape from the campaign #8 evidence — 3ms, exit 1, no output).
   *  - "newline": print ONLY a lone "\n" then exit 1 (the dsh
   *    MISSING_CREDENTIAL shape — 1 untrimmed output byte that trims to
   *    0, so it must classify like a zero-output round).
   *  - "signal": SIGKILL itself immediately with zero output (signal-death
   *    shape: exitCode null, signal SIGKILL, output "" — the SIGKILL/OOM
   *    loop class that the exitCode-null guard used to exclude).
   *  - "output": exit 1 immediately after printing output (NOT an
   *    instant fail — output bytes > 0 → resets the streak).
   *  - "clean": exit 0 with a STATUS: done (legitimate round → resets).
   */
  function setupInstantFailRound(mode: "instant" | "newline" | "signal" | "output" | "clean"): { runId: string; jobId: string; workdir: string } {
    const db = getDb();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'instant fail task', 'running', ?, ?, ?)",
    ).run(runId, JSON.stringify({ working_directory_for_harness: workdir }), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-step`, runId, now, now);

    // Same job-id shape as buildJobId("test-wf", runId, "test-agent").
    const jobId = `tamandua-test-wf-${runId}-test-agent`;

    const fakePi = path.join(tempHome, "pi-mock");
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node
if (process.env.FAKE_PI_MODE === "output") {
  console.log("STATUS: failed");
  console.log("some diagnostic output");
}
if (process.env.FAKE_PI_MODE === "clean") {
  console.log("STATUS: done");
  process.exit(0);
}
if (process.env.FAKE_PI_MODE === "newline") {
  process.stdout.write("\\n"); // lone trailing newline, then die — the dsh MISSING_CREDENTIAL shape
  process.exit(1);
}
if (process.env.FAKE_PI_MODE === "signal") {
  process.kill(process.pid, "SIGKILL"); // signal-death shape: no exit code, zero output
}
process.exit(1);
`,
      { mode: 0o755 },
    );
    process.env.TAMANDUA_PI_BINARY = fakePi;
    process.env.FAKE_PI_MODE = mode;

    return { runId, jobId, workdir };
  }

  /** Read this test's isolated scheduler log (skip reasons are debug lines). */
  function readStateLog(): string {
    const logPath = path.join(tempHome, ".tamandua", "tamandua.log");
    return fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
  }

  /**
   * Real-tick driver: advance time until any armed instant-fail backoff
   * window for `jobId` has elapsed (past `nextAllowedDispatchAt`), so the
   * next executeDispatchRound tick relaunches instead of being gated. No-op
   * when no window is armed (streak below K or already escalated).
   */
  async function waitPastInstantFailBackoff(jobId: string): Promise<void> {
    const streak = _instantFailStreakFor(jobId);
    const untilMs = streak?.nextAllowedDispatchAt ?? 0;
    // US-002: the armed backoff is a MONOTONIC deadline, so the wait must
    // read the same clock (mixing with Date.now() would compute a
    // nonsensical wait and never actually cross the window).
    const waitMs = Math.max(0, untilMs - monotonicNow()) + 150;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  it("classifies instant-fail rounds: ticks instant_fail_count and never touches WLST5 counters", async () => {
    const { runId, jobId, workdir } = setupInstantFailRound("instant");

    await executeDispatchRound(
      { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" },
      { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 },
    );

    const db = getDb();
    const row = db.prepare("SELECT instant_fail_count, worker_lost_count, ceiling_expiry_count FROM runs WHERE id = ?").get(runId) as { instant_fail_count: number; worker_lost_count: number; ceiling_expiry_count: number };
    assert.equal(row.instant_fail_count, 1, "an instant-fail round must tick instant_fail_count");
    // WLST5 counters stay untouched — instant-fail is a third, distinct class.
    assert.equal(row.worker_lost_count, 0, "an unclaimed instant-fail must NOT tick worker_lost_count");
    assert.equal(row.ceiling_expiry_count, 0, "an instant-fail must NOT tick ceiling_expiry_count");

    const streak = _instantFailStreakFor(jobId);
    assert.equal(streak?.consecutive, 1, "the per-job streak must be 1 after one instant-fail round");
    // The step was never claimed and must still be pending.
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(`${runId}-step`) as { status: string };
    assert.equal(step.status, "pending", "an instant-fail round claims no step — it must stay pending");
  });

  it("backs off the relaunch after K consecutive instant-fail rounds", async () => {
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K = "2";
    process.env.TAMANDUA_INSTANT_FAIL_ESCALATION_N = "100";
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS = "60000";
    const { runId, jobId, workdir } = setupInstantFailRound("instant");
    const job = { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" };
    const agent = { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 };

    // Rounds 1-2: instant fails, streak climbs to K.
    await executeDispatchRound(job, agent);
    await executeDispatchRound(job, agent);
    let streak = _instantFailStreakFor(jobId);
    assert.equal(streak?.consecutive, 2, "streak must reach K after K instant-fail rounds");
    assert.ok(
      (streak?.nextAllowedDispatchAt ?? 0) > monotonicNow(),
      "after K consecutive instant-fails the next relaunch must be delayed (backoff)",
    );

    // Round 3: the backoff gate must skip it — no new spawn, streak and
    // counter unchanged.
    await executeDispatchRound(job, agent);
    streak = _instantFailStreakFor(jobId);
    assert.equal(streak?.consecutive, 2, "the backoff-gated round must not increment the streak");
    const db = getDb();
    const row = db.prepare("SELECT instant_fail_count, status FROM runs WHERE id = ?").get(runId) as { instant_fail_count: number; status: string };
    assert.equal(row.instant_fail_count, 2, "the backoff-gated round must not spawn a harness");
    assert.equal(row.status, "running", "backoff alone must not fail the run");
  });

  it("relaunches the harness once the backoff window elapses — a backoff-gated tick must not leak the in-flight mark", async () => {
    // IFLB-mid regression (US-001): executeDispatchRound used to mark the
    // job in-flight BEFORE evaluating the instant-fail backoff gate. The
    // gate's early return precedes the round try, whose `finally` is the
    // only place the mark is released, so a tick inside the backoff window
    // leaked the mark and every later tick was skipped as
    // previous_round_in_flight — no relaunch after the window, N
    // unreachable, run idle with a pending step. The gate must run before
    // the mark: a gated tick leaves the job absent from the in-flight set,
    // and the first tick past nextAllowedDispatchAt MUST spawn again.
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K = "2";
    process.env.TAMANDUA_INSTANT_FAIL_ESCALATION_N = "100";
    // Short window so the test can advance past it in real time; round 3
    // runs synchronously up to the gate right after round 2 resolves, so
    // it deterministically lands inside the window.
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS = "1500";
    process.env.TAMANDUA_DEBUG = "1"; // the skip reasons are debug-level log lines
    const { runId, jobId, workdir } = setupInstantFailRound("instant");
    const job = { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" };
    const agent = { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 };
    const db = getDb();
    const counter = () => (db.prepare("SELECT instant_fail_count FROM runs WHERE id = ?").get(runId) as { instant_fail_count: number }).instant_fail_count;

    // Rounds 1-2: instant fails, the streak climbs to K=2 and the next
    // relaunch is delayed (backoff armed).
    await executeDispatchRound(job, agent);
    await executeDispatchRound(job, agent);
    let streak = _instantFailStreakFor(jobId);
    assert.equal(streak?.consecutive, 2, "streak must reach K after K instant-fail rounds");
    const backoffUntilMs = streak?.nextAllowedDispatchAt ?? 0;
    assert.ok(backoffUntilMs > monotonicNow(), "after K consecutive instant-fails the next relaunch must be delayed (backoff armed)");

    // Tick 3 inside the backoff window: skipped at the gate — no spawn, no
    // streak change, and (the regression) no in-flight mark leaked.
    await executeDispatchRound(job, agent);
    streak = _instantFailStreakFor(jobId);
    assert.equal(streak?.consecutive, 2, "an in-window tick must not increment the streak");
    assert.equal(counter(), 2, "an in-window tick must not spawn a harness");

    // Advance past nextAllowedDispatchAt, then tick: the relaunch MUST
    // happen (counter 2 → 3). On the pre-fix code this tick was skipped as
    // previous_round_in_flight and the counter stayed 2 forever.
    const waitMs = Math.max(0, backoffUntilMs - monotonicNow()) + 500;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    await executeDispatchRound(job, agent);

    const row = db.prepare("SELECT instant_fail_count, status FROM runs WHERE id = ?").get(runId) as { instant_fail_count: number; status: string };
    assert.equal(row.instant_fail_count, 3, "once the backoff window elapses the next tick must relaunch the harness (counter must tick)");
    assert.equal(row.status, "running", "the run must not be force-failed below the escalation threshold");
    streak = _instantFailStreakFor(jobId);
    assert.equal(streak?.consecutive, 3, "the relaunched round is another instant fail — the streak must advance");

    // No tick in this sequence may have been skipped as
    // previous_round_in_flight: a backoff-gated tick must not leak the
    // mark (pre-fix, tick 3 leaked it and every later tick skipped here).
    const log = readStateLog();
    assert.match(log, /Dispatch round skipped — instant-fail backoff/, "the in-window tick must log the instant_fail_backoff skip reason");
    assert.doesNotMatch(log, /previous round still in flight/, "no tick may be skipped as previous_round_in_flight after a backoff-gated tick");
    // Direct membership probe: tryMarkJobInFlight returns true only when
    // the job is NOT already in flight (pre-fix the leaked mark made it
    // return false). The probe marks the job; afterEach's shutdownAllCrons
    // clears it.
    assert.equal(tryMarkJobInFlight(jobId), true, "after the relaunch round the job must not be in the in-flight set");
  });

  it("never marks a job in-flight when the backoff gate skips the tick", async () => {
    // Same leaked-mark regression, asserted directly at the skip site with
    // a long backoff window so the gated tick deterministically lands
    // inside it: after the tick, tryMarkJobInFlight must still succeed —
    // the gate returned BEFORE the mark, so nothing is in flight.
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K = "2";
    process.env.TAMANDUA_INSTANT_FAIL_ESCALATION_N = "100";
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS = "60000"; // window far in the future
    process.env.TAMANDUA_DEBUG = "1";
    const { runId, jobId, workdir } = setupInstantFailRound("instant");
    const job = { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" };
    const agent = { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 };
    const db = getDb();
    const counter = () => (db.prepare("SELECT instant_fail_count FROM runs WHERE id = ?").get(runId) as { instant_fail_count: number }).instant_fail_count;

    await executeDispatchRound(job, agent);
    await executeDispatchRound(job, agent);
    let streak = _instantFailStreakFor(jobId);
    assert.equal(streak?.consecutive, 2, "streak must reach K after K instant-fail rounds");
    assert.ok(
      (streak?.nextAllowedDispatchAt ?? 0) > monotonicNow(),
      "after K consecutive instant-fails the next relaunch must be delayed (backoff armed)",
    );

    // Tick 3 inside the window: skipped at the gate, no spawn, no streak
    // change — and afterwards the job must NOT be in the in-flight set.
    await executeDispatchRound(job, agent);
    streak = _instantFailStreakFor(jobId);
    assert.equal(streak?.consecutive, 2, "the backoff-gated round must not increment the streak");
    assert.equal(counter(), 2, "the backoff-gated round must not spawn a harness");
    const log = readStateLog();
    assert.match(log, /Dispatch round skipped — instant-fail backoff/, "the in-window tick must log the instant_fail_backoff skip reason");
    // tryMarkJobInFlight returns false only when the job is already marked
    // in flight. Pre-fix, the gate ran after the mark and its early return
    // leaked the mark, so this probe returned false.
    assert.equal(tryMarkJobInFlight(jobId), true, "a backoff-gated tick must leave the job absent from the in-flight set");
  });

  it("force-fails the run at N consecutive instant-fail rounds with the precise reason and alert event", async () => {
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K = "3";
    process.env.TAMANDUA_INSTANT_FAIL_ESCALATION_N = "3";
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS = "0"; // no backoff delay so the loop can reach N quickly
    const { runId, jobId, workdir } = setupInstantFailRound("instant");
    const job = { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" };
    const agent = { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 };

    for (let i = 0; i < 3; i++) {
      await executeDispatchRound(job, agent);
    }

    const db = getDb();
    const row = db.prepare("SELECT instant_fail_count, status FROM runs WHERE id = ?").get(runId) as { instant_fail_count: number; status: string };
    assert.equal(row.status, "failed", "the run must be force-failed at the escalation threshold");
    assert.equal(row.instant_fail_count, 3, "instant_fail_count must equal the consecutive round count");

    const events = getRunEvents(runId);
    const loopAlerts = events.filter((e) => e.event === "run.instant_fail_loop");
    assert.equal(loopAlerts.length, 1, "escalation must emit exactly one run.instant_fail_loop alert");
    assert.equal(loopAlerts[0].consecutiveInstantFails, 3, "the alert must carry the consecutive count");

    const forceFailures = events.filter((e) => e.event === "run.force_failed");
    assert.equal(forceFailures.length, 1, "escalation must force-fail through the sanctioned path");
    assert.match(
      forceFailures[0].reason ?? "",
      /^worker instant-fail loop: 3 consecutive sub-\d+s exit-1 rounds; last command: /,
      "the force-fail reason must be precise about the loop shape",
    );

    const streak = _instantFailStreakFor(jobId);
    assert.equal(streak?.consecutive, 3, "the streak must persist at N for surfacing");
  });

  it("reaches the escalation force-fail through REAL widening backoff windows (K=2, N=4)", async () => {
    // US-002: the RSPN escalation path must be reachable through real
    // successive dispatch ticks that pass through the widening backoff
    // windows — the direct N-round test above bypasses the backoff with
    // base=0, which is exactly the coverage gap this closes (US-001 proved
    // the relaunch happens once, this proves the loop keeps relaunching
    // through every window until N escalates). K=2: rounds 1-2 arm the
    // first window (1×base); an in-window tick is gated; after the window
    // elapses round 3 spawns and widens the window (2×base); after that
    // window round 4 is the N-th consecutive instant fail → escalate.
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K = "2";
    process.env.TAMANDUA_INSTANT_FAIL_ESCALATION_N = "4";
    // 600ms base: the first window (1×base) is comfortably larger than any
    // event-loop stall between the K-th round and the in-window gated tick,
    // while both windows stay short enough to cross in real time.
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS = "600";
    process.env.TAMANDUA_DEBUG = "1"; // the backoff-gated skip is a debug-level log line
    const { runId, jobId, workdir } = setupInstantFailRound("instant");
    const job = { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" };
    const agent = { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 };
    const db = getDb();
    const count = () => (db.prepare("SELECT instant_fail_count FROM runs WHERE id = ?").get(runId) as { instant_fail_count: number }).instant_fail_count;

    // Rounds 1-2: consecutive instant fails climb to K=2 and arm the first
    // backoff window (1×base = 600ms).
    await executeDispatchRound(job, agent);
    await executeDispatchRound(job, agent);
    let streak = _instantFailStreakFor(jobId);
    assert.equal(streak?.consecutive, 2, "two instant-fail rounds must reach K=2");
    assert.ok((streak?.nextAllowedDispatchAt ?? 0) > monotonicNow(), "the relaunch must be backed off after the K-th round");
    assert.equal(count(), 2);

    // A real tick inside the first window is gated at the backoff gate —
    // no spawn, streak and counter unchanged.
    await executeDispatchRound(job, agent);
    streak = _instantFailStreakFor(jobId);
    assert.equal(streak?.consecutive, 2, "an in-window tick must not increment the streak");
    assert.equal(count(), 2, "an in-window tick must not spawn a harness");

    // Advance past the first window, then tick: round 3 relaunches, climbs
    // to streak 3, and widens the window to 2×base (1200ms).
    await waitPastInstantFailBackoff(jobId);
    await executeDispatchRound(job, agent);
    streak = _instantFailStreakFor(jobId);
    assert.equal(streak?.consecutive, 3, "the relaunched round must advance the streak to 3");
    assert.ok((streak?.nextAllowedDispatchAt ?? 0) > monotonicNow(), "the relaunch must be backed off again (widened window)");
    assert.equal(count(), 3);

    // Advance past the widened window, then tick: round 4 is the N=4th
    // consecutive instant fail → escalation (run.instant_fail_loop + the
    // sanctioned force-fail path).
    await waitPastInstantFailBackoff(jobId);
    await executeDispatchRound(job, agent);
    const row = db.prepare("SELECT instant_fail_count, status FROM runs WHERE id = ?").get(runId) as { instant_fail_count: number; status: string };
    assert.equal(row.status, "failed", "the N-th consecutive instant fail must force-fail the run");
    assert.equal(row.instant_fail_count, 4, "instant_fail_count must equal the consecutive round count");

    const events = getRunEvents(runId);
    const loopAlerts = events.filter((e) => e.event === "run.instant_fail_loop");
    assert.equal(loopAlerts.length, 1, "escalation must emit exactly one run.instant_fail_loop alert");
    assert.equal(loopAlerts[0].consecutiveInstantFails, 4, "the alert must carry the consecutive count N");
    const forceFailures = events.filter((e) => e.event === "run.force_failed");
    assert.equal(forceFailures.length, 1, "escalation must force-fail through the sanctioned path");
    assert.match(
      forceFailures[0].reason ?? "",
      /^worker instant-fail loop: 4 consecutive sub-\d+s exit-1 rounds; last command: /,
      "the force-fail reason must be precise about the loop shape (consecutive count + command preview)",
    );

    // Dispatch stops for this run: a further tick spawns no harness (the
    // run is terminal — the tick is torn down at the run-status check) and
    // the streak persists at N for surfacing.
    await executeDispatchRound(job, agent);
    assert.equal(count(), 4, "a post-escalation tick must not spawn a harness");
    const streakAtN = _instantFailStreakFor(jobId);
    assert.equal(streakAtN?.consecutive, 4, "the streak must persist at N for surfacing");
    assert.equal(
      getRunEvents(runId).filter((e) => e.event === "run.instant_fail_loop").length,
      1,
      "no second run.instant_fail_loop alert after a post-escalation tick",
    );

    // The windows really widened (1×base then 2×base) and every real gated
    // tick went through the backoff gate — none leaked into the in-flight
    // guard (the US-001 leaked-mark regression shape).
    const log = readStateLog();
    assert.match(log, /Dispatch round skipped — instant-fail backoff/, "a real tick inside the backoff window must log the instant_fail_backoff skip");
    assert.match(log, /"backoffDelayMs":600/, "the first window must be 1×base");
    assert.match(log, /"backoffDelayMs":1200/, "the second window must be widened to 2×base");
    assert.doesNotMatch(log, /previous round still in flight/, "no tick may be skipped as previous_round_in_flight");
  });

  it("resets the streak on any non-instant-fail round (output round and clean round)", async () => {
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K = "3";
    process.env.TAMANDUA_INSTANT_FAIL_ESCALATION_N = "100";
    const { runId, jobId, workdir } = setupInstantFailRound("instant");
    const job = { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" };
    const agent = { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 };

    // One instant fail → streak 1.
    await executeDispatchRound(job, agent);
    assert.equal(_instantFailStreakFor(jobId)?.consecutive, 1);

    // An exit-1 round that produced output is NOT an instant fail → reset.
    process.env.FAKE_PI_MODE = "output";
    await executeDispatchRound(job, agent);
    assert.equal(_instantFailStreakFor(jobId), undefined, "an output-producing round must reset the streak");

    // A clean STATUS: done round also resets (already undefined).
    process.env.FAKE_PI_MODE = "clean";
    await executeDispatchRound(job, agent);
    assert.equal(_instantFailStreakFor(jobId), undefined, "a clean round must keep the streak reset");

    // The reset rounds must not tick the counter.
    const db = getDb();
    const row = db.prepare("SELECT instant_fail_count, status FROM runs WHERE id = ?").get(runId) as { instant_fail_count: number; status: string };
    assert.equal(row.instant_fail_count, 1, "only classified instant-fail rounds tick instant_fail_count");
    assert.equal(row.status, "running", "the run must still be running after reset rounds");
  });

  it("resets the streak on a successful round between instant fails — the real-tick driver restarts counting from 1 (K=2)", async () => {
    // US-002: through the same real-tick driver, a successful (non-instant)
    // round between instant fails must reset the per-job streak — backoff
    // and escalation count CONSECUTIVE instant-fail rounds only. Drive
    // K-1 = 1 instant fail (below K, so no backoff), one output-producing
    // round (reset), then fail again: the streak restarts from 1 (no
    // backoff armed) and only re-arms after K consecutive instant fails
    // from the restart — proving the pre-reset count did not carry over.
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K = "2";
    process.env.TAMANDUA_INSTANT_FAIL_ESCALATION_N = "100";
    const { runId, jobId, workdir } = setupInstantFailRound("instant");
    const job = { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" };
    const agent = { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 };
    const db = getDb();
    const count = () => (db.prepare("SELECT instant_fail_count FROM runs WHERE id = ?").get(runId) as { instant_fail_count: number }).instant_fail_count;

    // K-1 = 1 instant fail → streak 1, still below the backoff threshold.
    await executeDispatchRound(job, agent);
    assert.equal(_instantFailStreakFor(jobId)?.consecutive, 1, "one instant-fail round must set the streak to 1");
    assert.equal(count(), 1);

    // An exit-1 round that produced output is NOT an instant fail → reset.
    process.env.FAKE_PI_MODE = "output";
    await executeDispatchRound(job, agent);
    assert.equal(_instantFailStreakFor(jobId), undefined, "an output-producing round must reset the streak");
    assert.equal(count(), 1, "the reset round must not tick instant_fail_count");

    // Fail again through the same tick driver: counting restarts from 1 —
    // the streak does not accumulate across the reset, so no backoff is
    // armed at streak 1.
    process.env.FAKE_PI_MODE = "instant";
    await executeDispatchRound(job, agent);
    let streak = _instantFailStreakFor(jobId);
    assert.equal(streak?.consecutive, 1, "after a reset the streak must restart from 1 (not accumulate across the reset)");
    assert.ok((streak?.nextAllowedDispatchAt ?? 0) <= monotonicNow(), "below K the relaunch must not be backed off");
    assert.equal(count(), 2);

    // One more instant fail reaches K=2 from the restart and re-arms the
    // backoff — had the reset not happened, this round would have been the
    // 3rd consecutive fail, not the K-th from a fresh count.
    await executeDispatchRound(job, agent);
    streak = _instantFailStreakFor(jobId);
    assert.equal(streak?.consecutive, 2, "K consecutive instant fails from the restart must re-arm the backoff");
    assert.ok((streak?.nextAllowedDispatchAt ?? 0) > monotonicNow(), "the relaunch must be backed off at K from the restart");
    assert.equal(count(), 3);

    const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(row.status, "running", "the run must not be force-failed below N");
    assert.equal(getRunEvents(runId).filter((e) => e.event === "run.instant_fail_loop").length, 0, "no escalation before N consecutive instant fails");
  });

  it("surfaces the instant-fail loop through the status data layer (workflow status / runs)", async () => {
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K = "3";
    process.env.TAMANDUA_INSTANT_FAIL_ESCALATION_N = "100";
    const { runId, jobId, workdir } = setupInstantFailRound("instant");
    const job = { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" };
    const agent = { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 };

    for (let i = 0; i < 3; i++) {
      await executeDispatchRound(job, agent);
    }

    const { getWorkflowStatus, listRuns } = await import("../../dist/installer/status.js");
    const detail = getWorkflowStatus(runId);
    assert.equal(detail.instantFailCount, 3, "workflow status must surface the instant-fail count");
    const listed = listRuns().find((r) => r.id === runId);
    assert.equal(listed?.instantFailCount, 3, "the runs list must surface the instant-fail count");
  });

  it("classifies the dsh MISSING_CREDENTIAL shape: '\n'-only exit-1 round ticks count, increments streak, and K backoff engages", async () => {
    // The dsh MISSING_CREDENTIAL round prints only a lone trailing newline
    // (1 untrimmed byte) then exits 1 sub-threshold. Whitespace-only stdout
    // cannot carry a STATUS marker, so the classifier must treat it as a
    // zero-output round: instant_fail_count ticks, the per-job streak
    // increments, and at K consecutive rounds the relaunch backs off.
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K = "2";
    process.env.TAMANDUA_INSTANT_FAIL_ESCALATION_N = "100";
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS = "60000";
    const { runId, jobId, workdir } = setupInstantFailRound("newline");
    const job = { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" };
    const agent = { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 };

    // Round 1: classified — count and streak tick.
    await executeDispatchRound(job, agent);
    let row = getDb().prepare("SELECT instant_fail_count, worker_lost_count, ceiling_expiry_count FROM runs WHERE id = ?").get(runId) as { instant_fail_count: number; worker_lost_count: number; ceiling_expiry_count: number };
    assert.equal(row.instant_fail_count, 1, "the '\n'-only exit-1 round must tick instant_fail_count");
    assert.equal(row.worker_lost_count, 0, "an unclaimed instant-fail must NOT tick worker_lost_count");
    assert.equal(row.ceiling_expiry_count, 0, "an instant-fail must NOT tick ceiling_expiry_count");
    assert.equal(_instantFailStreakFor(jobId)?.consecutive, 1, "the streak must increment for the '\n'-only round");

    // Round 2: streak reaches K=2 — the next relaunch must be delayed.
    await executeDispatchRound(job, agent);
    let streak = _instantFailStreakFor(jobId);
    assert.equal(streak?.consecutive, 2, "streak must reach K after two '\n'-only rounds");
    assert.ok(
      (streak?.nextAllowedDispatchAt ?? 0) > monotonicNow(),
      "K backoff must engage for the '\n'-only shape (next relaunch delayed)",
    );

    // Round 3: the backoff gate must skip it — no new spawn, streak and
    // counter unchanged.
    await executeDispatchRound(job, agent);
    streak = _instantFailStreakFor(jobId);
    assert.equal(streak?.consecutive, 2, "the backoff-gated round must not increment the streak");
    row = getDb().prepare("SELECT instant_fail_count, status FROM runs WHERE id = ?").get(runId) as { instant_fail_count: number; status: string };
    assert.equal(row.instant_fail_count, 2, "the backoff-gated round must not spawn a harness");
    assert.equal(row.status, "running", "backoff alone must not fail the run");
  });

  it("force-fails the run at N consecutive '\n'-only exit-1 rounds (dsh shape) with the precise reason and alert event", async () => {
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K = "3";
    process.env.TAMANDUA_INSTANT_FAIL_ESCALATION_N = "3";
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS = "0"; // no backoff delay so the loop can reach N quickly
    const { runId, jobId, workdir } = setupInstantFailRound("newline");
    const job = { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" };
    const agent = { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 };

    for (let i = 0; i < 3; i++) {
      await executeDispatchRound(job, agent);
    }

    const db = getDb();
    const row = db.prepare("SELECT instant_fail_count, status FROM runs WHERE id = ?").get(runId) as { instant_fail_count: number; status: string };
    assert.equal(row.status, "failed", "the run must be force-failed at the escalation threshold");
    assert.equal(row.instant_fail_count, 3, "instant_fail_count must equal the consecutive round count");

    const events = getRunEvents(runId);
    const loopAlerts = events.filter((e) => e.event === "run.instant_fail_loop");
    assert.equal(loopAlerts.length, 1, "escalation must emit exactly one run.instant_fail_loop alert");
    assert.equal(loopAlerts[0].consecutiveInstantFails, 3, "the alert must carry the consecutive count");

    const forceFailures = events.filter((e) => e.event === "run.force_failed");
    assert.equal(forceFailures.length, 1, "escalation must force-fail through the sanctioned path");
    assert.match(
      forceFailures[0].reason ?? "",
      /^worker instant-fail loop: 3 consecutive sub-\d+s exit-1 rounds; last command: /,
      "the force-fail reason must be precise about the loop shape",
    );
  });

  it("classifies SIGKILL signal-death rounds (exitCode null, signal SIGKILL, no output) as instant-fail", async () => {
    // A worker killed by a signal (SIGKILL/OOM loop) carries no exit code
    // — the old exitCode-null guard excluded this shape entirely. With
    // zero output and sub-threshold wall it is an instant fail: count
    // ticks, streak increments, WLST5 counters untouched, no step claimed.
    const { runId, jobId, workdir } = setupInstantFailRound("signal");
    const job = { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" };
    const agent = { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 };

    await executeDispatchRound(job, agent);

    const db = getDb();
    const row = db.prepare("SELECT instant_fail_count, worker_lost_count, ceiling_expiry_count FROM runs WHERE id = ?").get(runId) as { instant_fail_count: number; worker_lost_count: number; ceiling_expiry_count: number };
    assert.equal(row.instant_fail_count, 1, "a SIGKILL signal-death round must tick instant_fail_count");
    assert.equal(row.worker_lost_count, 0, "an unclaimed signal-death round must NOT tick worker_lost_count");
    assert.equal(row.ceiling_expiry_count, 0, "a signal-death round must NOT tick ceiling_expiry_count");

    assert.equal(_instantFailStreakFor(jobId)?.consecutive, 1, "the streak must increment for the signal-death round");
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(`${runId}-step`) as { status: string };
    assert.equal(step.status, "pending", "an instant-fail round claims no step — it must stay pending");
  });

  // ── US-002: the instant-fail gate and round durations are monotonic ──
  it("US-002: arms the backoff on the monotonic clock — a wall-clock jump cannot release the gate", async () => {
    // TIME-CLOCKS rule 1: nextAllowedDispatchAt is an in-process deadline,
    // so it must be armed/gated on the monotonic clock. A gate that read
    // Date.now() would be released (or held open) by an NTP step or a
    // suspend/resume, which is exactly the class of bug this pins.
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K = "2";
    process.env.TAMANDUA_INSTANT_FAIL_ESCALATION_N = "100";
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS = "60000"; // 60s window — far beyond this test
    process.env.TAMANDUA_DEBUG = "1";
    const { runId, jobId, workdir } = setupInstantFailRound("instant");
    const job = { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" };
    const agent = { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 };
    const db = getDb();
    const count = () => (db.prepare("SELECT instant_fail_count FROM runs WHERE id = ?").get(runId) as { instant_fail_count: number }).instant_fail_count;

    await executeDispatchRound(job, agent);
    await executeDispatchRound(job, agent);
    const streak = _instantFailStreakFor(jobId);
    assert.equal(streak?.consecutive, 2, "two instant-fail rounds must reach K=2");

    const armedAt = streak?.nextAllowedDispatchAt ?? 0;
    // The armed deadline is a process-relative monotonic count, NOT an
    // epoch instant: it must sit in the future per monotonicNow() and be
    // orders of magnitude below Date.now().
    assert.ok(armedAt > monotonicNow(), "the backoff deadline must be in the future on the monotonic clock");
    assert.ok(
      armedAt < Date.now() / 2,
      "the backoff deadline must be monotonic time, not an epoch-ms wall instant",
    );

    // Hostile wall jump FORWARD: a gate reading Date.now() would see the
    // window as long elapsed and relaunch the broken harness; the monotonic
    // gate must keep skipping.
    const realDateNow = Date.now;
    try {
      Date.now = () => realDateNow() + 24 * 60 * 60 * 1000;
      await executeDispatchRound(job, agent);
    } finally {
      Date.now = realDateNow;
    }
    assert.equal(count(), 2, "a forward wall-clock jump must NOT release the monotonic backoff gate");

    // Hostile wall jump BACKWARD: likewise must not release (or extend) the
    // gate — the window is measured on the monotonic clock.
    try {
      Date.now = () => realDateNow() - 24 * 60 * 60 * 1000;
      await executeDispatchRound(job, agent);
    } finally {
      Date.now = realDateNow;
    }
    assert.equal(count(), 2, "a backward wall-clock jump must NOT release the monotonic backoff gate");
    assert.match(
      readStateLog(),
      /Dispatch round skipped — instant-fail backoff/,
      "both wall jumps must be gated at the monotonic backoff gate",
    );
  });

  it("US-002: adapter-throw round duration is monotonic — a wall jump cannot distort the wallMs classification", async () => {
    // The adapter-throw fallback is the one round duration the scheduler
    // computes itself (findBinary/spawn failure carries no result). It must
    // come from the monotonic round-start Stopwatch: an epoch-based
    // `Date.now() - roundStartMs` would log a wildly wrong (or negative)
    // wallMs under a wall jump and flip the instant-fail classification.
    const { runId, jobId, workdir } = setupInstantFailRound("instant");
    // A nonexistent executable makes adapter.findBinary throw — the
    // adapter-throw path — after the round-start watch is created.
    process.env.TAMANDUA_PI_BINARY = path.join(tempHome, "does-not-exist-harness");
    process.env.TAMANDUA_INSTANT_FAIL_WALL_MS = "10000";
    const job = { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" };
    const agent = { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 };
    const db = getDb();

    // Every wall-clock read during the round steps +1 day, so a
    // Date.now()-based duration would be epoch-sized and never classify.
    const realDateNow = Date.now;
    let wallReads = 0;
    try {
      Date.now = () => realDateNow() + (++wallReads) * 24 * 60 * 60 * 1000;
      await executeDispatchRound(job, agent);
    } finally {
      Date.now = realDateNow;
    }

    const row = db.prepare("SELECT instant_fail_count FROM runs WHERE id = ?").get(runId) as { instant_fail_count: number };
    assert.equal(
      row.instant_fail_count,
      1,
      "an adapter-throw round must still classify as an instant fail despite the wall jump",
    );

    const log = readStateLog();
    const wallValues = [...log.matchAll(/"wallMs":(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    assert.ok(wallValues.length >= 1, "the instant-fail classification must log the round wallMs");
    for (const wallMs of wallValues) {
      assert.ok(Number.isFinite(wallMs), `wallMs must be finite, got ${wallMs}`);
      assert.ok(wallMs >= 0, `a monotonic round duration can never be negative (got ${wallMs})`);
      assert.ok(
        wallMs < 10000,
        `the monotonic round duration must stay sub-threshold under a wall jump (got ${wallMs})`,
      );
    }
  });
});

// ── OUTAGE-ROUNDS SCLS US-004: pre-claim deaths ─────────────────────
// A round that passed the launch probe, ran LONGER than the instant-fail
// wall threshold, and exited/died WITHOUT claiming a pending step is a
// pre-claim death: the slow complement of the fast instant-fail shape
// (vaivm evidence: a verifier dying 8 times with STREAM_CLOSED before
// claiming, invisible for two hours). It must increment the per-step
// preclaim_death_count and emit step.preclaim_round_died with NO retry
// charge and NO step status transition; any successful claim resets the
// counter (pinned in tests/step-ops.test.ts). Detection is exit code /
// signal / timing / claim state only — never provider-error text.

describe("executeDispatchRound pre-claim death detection (OUTAGE-ROUNDS SCLS US-004)", () => {
  let tempHome: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-preclaim-death-");
    const stateDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    saved = {
      HOME: process.env.HOME,
      TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
      TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
      TAMANDUA_PI_BINARY: process.env.TAMANDUA_PI_BINARY,
      TAMANDUA_INSTANT_FAIL_WALL_MS: process.env.TAMANDUA_INSTANT_FAIL_WALL_MS,
      TAMANDUA_INSTANT_FAIL_BACKOFF_K: process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K,
      TAMANDUA_INSTANT_FAIL_ESCALATION_N: process.env.TAMANDUA_INSTANT_FAIL_ESCALATION_N,
      TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS: process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS,
      TAMANDUA_HARNESS_PROBE: process.env.TAMANDUA_HARNESS_PROBE,
      TAMANDUA_DEBUG: process.env.TAMANDUA_DEBUG,
      FAKE_PI_MODE: process.env.FAKE_PI_MODE,
      FAKE_PI_SLEEP_MS: process.env.FAKE_PI_SLEEP_MS,
    };
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    // The canned fake-pi shims never answer a launch-time harness probe.
    process.env.TAMANDUA_HARNESS_PROBE = "0";
    // Small threshold so a ~400ms fake harness round lands ABOVE it: a
    // pre-claim death is the SLOW complement of a fast instant fail.
    process.env.TAMANDUA_INSTANT_FAIL_WALL_MS = "50";
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(stateDir, "tamandua.db"), "agent-scheduler-preclaim-death"),
    );
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    shutdownAllCrons();
    _resetInstantFailStreaks();
    _resetPreclaimDeathStreaks();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /**
   * Seed a running run with one pending unclaimed step and a fake pi that
   * busy-waits FAKE_PI_SLEEP_MS, then:
   *  - "long-exit": exits 1 with empty stdout (the pre-claim death shape);
   *  - "long-clean": prints STATUS: done and exits 0 (a legitimate round);
   *  - "claim": runs the REAL step-ops claimStep for this agent/run, then
   *    prints STATUS: done and exits 0 — a SUCCESSFUL claim that must reset
   *    both the persisted counter (step-ops claim UPDATE) and the in-memory
   *    consecutive streak / armed backoff deadline (non-matching round).
   */
  function setupPreclaimRound(mode: "long-exit" | "long-clean" | "claim"): {
    runId: string;
    jobId: string;
    workdir: string;
    stepRowId: string;
  } {
    const db = getDb();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'pre-claim death task', 'running', ?, ?, ?)",
    ).run(runId, JSON.stringify({ working_directory_for_harness: workdir }), now, now);
    const stepRowId = `${runId}-step`;
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'pending', 0, ?, ?)",
    ).run(stepRowId, runId, now, now);

    // Absolute URL of the compiled step-ops module, so the fake harness can
    // perform a REAL successful claim (persisted counter reset via claimStep).
    const stepOpsUrl = new URL("../../dist/installer/step-ops.js", import.meta.url).href;

    const fakePi = path.join(tempHome, "pi-preclaim-mock");
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node
const mode = process.env.FAKE_PI_MODE;
const sleepMs = Number(process.env.FAKE_PI_SLEEP_MS || "0");
const start = Date.now();
while (Date.now() - start < sleepMs) { /* busy-wait above the wall threshold */ }
if (mode === "long-clean") {
  process.stdout.write("STATUS: done\\n");
  process.exit(0);
}
if (mode === "claim") {
  // A REAL successful claim (not a simulation): the step-ops claim UPDATE
  // resets steps.preclaim_death_count, and the resulting non-matching round
  // resets the in-memory streak + deadline.
  const { claimStep } = await import(${JSON.stringify(stepOpsUrl)});
  claimStep("test-wf_test-agent", process.env.TAMANDUA_RUN_ID);
  process.stdout.write("STATUS: done\\n");
  process.exit(0);
}
process.exit(1);
`,
      { mode: 0o755 },
    );
    process.env.TAMANDUA_PI_BINARY = fakePi;
    process.env.FAKE_PI_MODE = mode;
    process.env.FAKE_PI_SLEEP_MS = "400";

    // Same job-id shape as buildJobId("test-wf", runId, "test-agent").
    const jobId = `tamandua-test-wf-${runId}-test-agent`;
    return { runId, jobId, workdir, stepRowId };
  }

  function jobFor(runId: string, jobId: string, workdir: string) {
    return { id: jobId, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi" as const, workingDirectoryForHarness: workdir, createdAt: "" };
  }

  /** Read this test's isolated scheduler log (skip reasons are debug lines). */
  function readStateLog(): string {
    const logPath = path.join(tempHome, ".tamandua", "tamandua.log");
    return fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
  }

  /**
   * Real-tick driver: advance real time until any armed pre-claim-death
   * backoff window for `jobId` has elapsed (past `nextAllowedDispatchAt`), so
   * the next executeDispatchRound tick relaunches instead of being gated. No-op
   * when no window is armed. Reads the MONOTONIC deadline with the same clock
   * it was armed on (TIME-CLOCKS rule 1).
   */
  async function waitPastPreclaimBackoff(jobId: string): Promise<void> {
    const streak = _preclaimDeathStreakFor(jobId);
    const untilMs = streak?.nextAllowedDispatchAt ?? 0;
    const waitMs = Math.max(0, untilMs - monotonicNow()) + 150;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const agent = { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 };

  it("increments the per-step counter and emits one step.preclaim_round_died with no retry charge", async () => {
    const { runId, jobId, workdir, stepRowId } = setupPreclaimRound("long-exit");

    await executeDispatchRound(jobFor(runId, jobId, workdir), agent);

    const db = getDb();
    const step = db.prepare("SELECT status, retry_count, preclaim_death_count FROM steps WHERE id = ?").get(stepRowId) as {
      status: string;
      retry_count: number;
      preclaim_death_count: number;
    };
    assert.equal(step.preclaim_death_count, 1, "a pre-claim death must increment steps.preclaim_death_count");
    assert.equal(step.status, "pending", "a pre-claim death must not transition the step");
    assert.equal(step.retry_count, 0, "a pre-claim death must not charge a retry");

    const run = db.prepare("SELECT instant_fail_count, worker_lost_count, ceiling_expiry_count FROM runs WHERE id = ?").get(runId) as {
      instant_fail_count: number;
      worker_lost_count: number;
      ceiling_expiry_count: number;
    };
    assert.equal(run.instant_fail_count, 0, "a slow (>= threshold) round is NOT an instant fail");
    assert.equal(run.worker_lost_count, 0, "an unclaimed death must not tick worker_lost_count");
    assert.equal(run.ceiling_expiry_count, 0, "a pre-claim death must not tick ceiling_expiry_count");

    assert.equal(_preclaimDeathStreakFor(jobId)?.consecutive, 1, "the pre-claim death streak must be 1");
    assert.equal(_instantFailStreakFor(jobId), undefined, "the instant-fail streak must be untouched");

    const deaths = getRunEvents(runId).filter((e) => e.event === "step.preclaim_round_died");
    assert.equal(deaths.length, 1, "exactly one step.preclaim_round_died per pre-claim death");
    assert.equal(deaths[0].stepId, "step-1", "the event must carry the pending step's stepId");
    assert.equal(deaths[0].stepRowId, stepRowId, "the event must carry the pending step's row id");
    assert.equal(deaths[0].exitCode, 1, "the event must carry the nonzero exit code");
    assert.equal(deaths[0].consecutivePreclaimDeaths, 1, "the event must carry the consecutive count");
    assert.ok(
      typeof deaths[0].harnessWallMs === "number" && deaths[0].harnessWallMs >= 50,
      `the event must carry the harness wall time above the threshold (got ${deaths[0].harnessWallMs})`,
    );
    assert.equal(typeof deaths[0].stderrTail, "string", "the event must carry a bounded stderr tail");
  });

  it("does NOT emit or increment on a long clean (exit 0) round", async () => {
    const { runId, jobId, workdir, stepRowId } = setupPreclaimRound("long-clean");

    await executeDispatchRound(jobFor(runId, jobId, workdir), agent);

    const db = getDb();
    const step = db.prepare("SELECT status, preclaim_death_count FROM steps WHERE id = ?").get(stepRowId) as {
      status: string;
      preclaim_death_count: number;
    };
    assert.equal(step.preclaim_death_count, 0, "a clean exit is not a pre-claim death");
    assert.equal(
      getRunEvents(runId).filter((e) => e.event === "step.preclaim_round_died").length,
      0,
      "a clean exit must not emit step.preclaim_round_died",
    );
    assert.equal(_preclaimDeathStreakFor(jobId), undefined, "a non-matching round resets the streak");
  });

  it("resets the in-memory streak on a non-matching round but keeps the persisted counter until a claim", async () => {
    const { runId, jobId, workdir, stepRowId } = setupPreclaimRound("long-exit");

    await executeDispatchRound(jobFor(runId, jobId, workdir), agent);
    assert.equal(_preclaimDeathStreakFor(jobId)?.consecutive, 1);

    // A long clean round breaks the streak but does NOT reset the persisted
    // counter (only a successful claim does that — pinned in step-ops tests).
    process.env.FAKE_PI_MODE = "long-clean";
    await executeDispatchRound(jobFor(runId, jobId, workdir), agent);
    assert.equal(_preclaimDeathStreakFor(jobId), undefined, "a clean round resets the consecutive streak");

    // Back to the death shape: the streak restarts at 1 (consecutive) while
    // the persisted counter advances to 2.
    process.env.FAKE_PI_MODE = "long-exit";
    await executeDispatchRound(jobFor(runId, jobId, workdir), agent);
    const db = getDb();
    const step = db.prepare("SELECT preclaim_death_count FROM steps WHERE id = ?").get(stepRowId) as {
      preclaim_death_count: number;
    };
    assert.equal(step.preclaim_death_count, 2, "the persisted counter accumulates across non-consecutive deaths");
    assert.equal(_preclaimDeathStreakFor(jobId)?.consecutive, 1, "the in-memory streak restarted after the reset");
  });

  // ── OUTAGE-ROUNDS SCLS US-005: escalating backoff and run cap ──────

  it("arms a monotonic preclaim-death backoff after K consecutive deaths and gates the tick", async () => {
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K = "2";
    process.env.TAMANDUA_INSTANT_FAIL_ESCALATION_N = "100";
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS = "60000"; // window far in the future
    process.env.TAMANDUA_DEBUG = "1"; // the skip reasons are debug-level log lines
    const { runId, jobId, workdir, stepRowId } = setupPreclaimRound("long-exit");
    const job = jobFor(runId, jobId, workdir);
    const db = getDb();
    const stepCounter = () =>
      (db.prepare("SELECT preclaim_death_count FROM steps WHERE id = ?").get(stepRowId) as {
        preclaim_death_count: number;
      }).preclaim_death_count;

    // Rounds 1-2: pre-claim deaths; the K-th arms the escalating window.
    await executeDispatchRound(job, agent);
    await executeDispatchRound(job, agent);
    let streak = _preclaimDeathStreakFor(jobId);
    assert.equal(streak?.consecutive, 2, "streak must reach K after K pre-claim deaths");
    assert.ok(
      (streak?.nextAllowedDispatchAt ?? 0) > monotonicNow(),
      "after K consecutive pre-claim deaths the next relaunch must be delayed (backoff armed)",
    );
    assert.equal(
      isPreclaimDeathBackoffActive(streak, monotonicNow()),
      true,
      "the exported gate must report the armed window as active",
    );

    // Tick 3 inside the window: gated — no spawn, no event, no counter bump,
    // and (the IFLB-mid regression) no leaked in-flight mark.
    await executeDispatchRound(job, agent);
    streak = _preclaimDeathStreakFor(jobId);
    assert.equal(streak?.consecutive, 2, "an in-window tick must not increment the streak");
    assert.equal(stepCounter(), 2, "an in-window tick must not spawn a harness / emit a death record");
    assert.equal(
      getRunEvents(runId).filter((e) => e.event === "step.preclaim_round_died").length,
      2,
      "an in-window tick must not emit another step.preclaim_round_died",
    );
    assert.equal(
      getRunEvents(runId).filter((e) => e.event === "run.preclaim_death_loop").length,
      0,
      "no escalation below N",
    );

    const log = readStateLog();
    assert.match(log, /Dispatch round skipped — preclaim-death backoff/, "the in-window tick must log the preclaim-death skip");
    assert.match(log, /preclaim_death_backoff/, "the skip record must carry reason preclaim_death_backoff");
    assert.equal(tryMarkJobInFlight(jobId), true, "a backoff-gated tick must leave the job absent from the in-flight set");
  });

  it("relaunches after the preclaim-death backoff window elapses", async () => {
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K = "2";
    process.env.TAMANDUA_INSTANT_FAIL_ESCALATION_N = "100";
    // Short window so the test can cross it in real time; the round takes
    // ~400ms, so the immediately-following tick deterministically lands inside.
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS = "900";
    process.env.TAMANDUA_DEBUG = "1";
    const { runId, jobId, workdir, stepRowId } = setupPreclaimRound("long-exit");
    const job = jobFor(runId, jobId, workdir);
    const db = getDb();
    const stepCounter = () =>
      (db.prepare("SELECT preclaim_death_count FROM steps WHERE id = ?").get(stepRowId) as {
        preclaim_death_count: number;
      }).preclaim_death_count;

    await executeDispatchRound(job, agent);
    await executeDispatchRound(job, agent);
    let streak = _preclaimDeathStreakFor(jobId);
    assert.equal(streak?.consecutive, 2, "streak must reach K after K pre-claim deaths");
    const backoffUntilMs = streak?.nextAllowedDispatchAt ?? 0;
    assert.ok(backoffUntilMs > monotonicNow(), "the backoff window must be armed");

    // In-window tick: gated, no new death.
    await executeDispatchRound(job, agent);
    assert.equal(stepCounter(), 2, "an in-window tick must not relaunch");

    // Past the window: the relaunch MUST happen — a gated tick never leaked the
    // in-flight mark (the IFLB-mid regression).
    await waitPastPreclaimBackoff(jobId);
    await executeDispatchRound(job, agent);
    assert.equal(stepCounter(), 3, "once the window elapses the next tick must relaunch the harness");
    streak = _preclaimDeathStreakFor(jobId);
    assert.equal(streak?.consecutive, 3, "the relaunched round is another pre-claim death — the streak advances");
    assert.equal(
      (db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status,
      "running",
      "the run must not be force-failed below the escalation threshold",
    );
  });

  it("force-fails at N consecutive pre-claim deaths with exactly one run.preclaim_death_loop before run.force_failed", async () => {
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K = "3";
    process.env.TAMANDUA_INSTANT_FAIL_ESCALATION_N = "3";
    const { runId, jobId, workdir, stepRowId } = setupPreclaimRound("long-exit");
    const job = jobFor(runId, jobId, workdir);

    for (let i = 0; i < 3; i++) {
      await executeDispatchRound(job, agent);
    }

    const db = getDb();
    const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(row.status, "failed", "the N-th consecutive pre-claim death must force-fail the run");

    const step = db.prepare("SELECT status, retry_count, preclaim_death_count, claim_pid FROM steps WHERE id = ?").get(stepRowId) as {
      status: string;
      retry_count: number;
      preclaim_death_count: number;
      claim_pid: number | null;
    };
    assert.equal(step.preclaim_death_count, 3, "the persisted per-step counter must equal the consecutive count");
    assert.equal(step.retry_count, 0, "the cap must consume no retry budget");
    assert.equal(step.claim_pid, null, "no pre-claim death round may claim the step");
    // The step is never advanced by the deaths themselves; the only status
    // change is the run-terminal teardown's cancellation of pending steps.
    assert.equal(step.status, "canceled", "force-fail teardown cancels the still-pending step");

    const events = getRunEvents(runId);
    const alerts = events.filter((e) => e.event === "run.preclaim_death_loop");
    assert.equal(alerts.length, 1, "escalation must emit exactly one run.preclaim_death_loop alert");
    assert.equal(alerts[0].consecutivePreclaimDeaths, 3, "the alert must carry the consecutive count");
    assert.match(
      alerts[0].reason ?? "",
      /^worker pre-claim death loop: 3 consecutive >=\d+s rounds that exited\/died without claiming a step; last command: /,
      "the alert reason must be the distinct pre-claim shape",
    );

    const forceFailures = events.filter((e) => e.event === "run.force_failed");
    assert.equal(forceFailures.length, 1, "escalation must force-fail through the sanctioned path");
    assert.match(
      forceFailures[0].reason ?? "",
      /^worker pre-claim death loop: 3 consecutive >=\d+s rounds that exited\/died without claiming a step/,
      "the terminal reason must name the pre-claim death loop",
    );
    // The alert must precede the terminal event.
    assert.ok(
      events.findIndex((e) => e.event === "run.preclaim_death_loop") <
        events.findIndex((e) => e.event === "run.force_failed"),
      "run.preclaim_death_loop must be emitted immediately before run.force_failed",
    );
    assert.equal(
      events.filter((e) => e.event === "run.instant_fail_loop").length,
      0,
      "the fast instant-fail alert must not fire for a slow pre-claim death loop",
    );
    assert.equal(_preclaimDeathStreakFor(jobId)?.consecutive, 3, "the streak must persist at N for surfacing");
  });

  it("a successful claim resets the streak and clears the armed backoff deadline", async () => {
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K = "2";
    process.env.TAMANDUA_INSTANT_FAIL_ESCALATION_N = "100";
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS = "400";
    const { runId, jobId, workdir, stepRowId } = setupPreclaimRound("long-exit");
    const job = jobFor(runId, jobId, workdir);
    const db = getDb();

    // K consecutive deaths arm the window.
    await executeDispatchRound(job, agent);
    await executeDispatchRound(job, agent);
    const armed = _preclaimDeathStreakFor(jobId);
    assert.equal(armed?.consecutive, 2);
    assert.equal(isPreclaimDeathBackoffActive(armed, monotonicNow()), true);
    assert.equal(
      (db.prepare("SELECT preclaim_death_count FROM steps WHERE id = ?").get(stepRowId) as {
        preclaim_death_count: number;
      }).preclaim_death_count,
      2,
      "the persisted counter reflects the two deaths before the claim",
    );

    // Wait past the window so the harness actually runs, then have it perform a
    // REAL successful claim (step-ops claimStep) and exit cleanly.
    await waitPastPreclaimBackoff(jobId);
    process.env.FAKE_PI_MODE = "claim";
    await executeDispatchRound(job, agent);

    assert.equal(
      _preclaimDeathStreakFor(jobId),
      undefined,
      "a successful claim round must reset the streak and drop the deadline",
    );
    assert.equal(
      isPreclaimDeathBackoffActive(_preclaimDeathStreakFor(jobId), monotonicNow()),
      false,
      "the armed backoff gate must be open after a successful claim",
    );
    const step = db.prepare("SELECT status, preclaim_death_count FROM steps WHERE id = ?").get(stepRowId) as {
      status: string;
      preclaim_death_count: number;
    };
    assert.equal(step.preclaim_death_count, 0, "the real claim UPDATE must reset the persisted counter");
    assert.notEqual(step.status, "pending", "the real claimStep must have claimed the step");
    assert.equal(
      getRunEvents(runId).filter((e) => e.event === "step.preclaim_round_died").length,
      2,
      "the successful claim round must not emit another pre-claim death record",
    );
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
      // CPID2: the scheduler now exports the DAEMON pid as
      // TAMANDUA_DAEMON_PID; the harness launch wrapper exports the WORKER
      // pid as TAMANDUA_WORKER_PID. Save/restore both so ambient bleed from
      // the (possibly agent-hosted) test process cannot skew the assertions.
      TAMANDUA_WORKER_PID: process.env.TAMANDUA_WORKER_PID,
      TAMANDUA_DAEMON_PID: process.env.TAMANDUA_DAEMON_PID,
      TAMANDUA_WORKER_PGID: process.env.TAMANDUA_WORKER_PGID,
      // The canned fake-pi shim never answers a launch-time harness probe
      // prompt (it claims the step and prints STATUS: done regardless of
      // the prompt), so the probe is disabled for these rounds — exactly as
      // TAMANDUA_PI_BINARY is managed — keeping the run-identity
      // assertions unchanged.
      TAMANDUA_HARNESS_PROBE: process.env.TAMANDUA_HARNESS_PROBE,
    };
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    process.env.TAMANDUA_HARNESS_PROBE = "0";
    // Drop any ambient TAMANDUA_RUN_ID so the child-env observation can
    // only come from the scheduler's harnessEnv (not process-env bleed).
    delete process.env.TAMANDUA_RUN_ID;
    // Same for the worker/daemon pid vars: the wrapper (not ambient env)
    // must be the source of TAMANDUA_WORKER_PID.
    delete process.env.TAMANDUA_WORKER_PID;
    delete process.env.TAMANDUA_DAEMON_PID;
    delete process.env.TAMANDUA_WORKER_PGID;
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

  it("passes TAMANDUA_RUN_ID (and daemon/worker pid identity) into the worker subprocess env", async () => {
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
  TAMANDUA_DAEMON_PID: process.env.TAMANDUA_DAEMON_PID ?? null,
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
      TAMANDUA_DAEMON_PID: string | null;
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
    // CPID2: the scheduler exports the DAEMON pid under TAMANDUA_DAEMON_PID;
    // the launch wrapper exports the WORKER pid (`$$`) under
    // TAMANDUA_WORKER_PID. `step claim` records the latter as claim_pid.
    assert.equal(
      observed.TAMANDUA_DAEMON_PID,
      String(process.pid),
      "TAMANDUA_DAEMON_PID must carry the scheduling daemon pid",
    );
    assert.ok(observed.TAMANDUA_WORKER_PID !== null, "the launch wrapper must export TAMANDUA_WORKER_PID");
    const observedWorkerPid = Number(observed.TAMANDUA_WORKER_PID);
    assert.ok(
      Number.isInteger(observedWorkerPid) && observedWorkerPid > 0,
      `TAMANDUA_WORKER_PID must be a real worker pid, got ${observed.TAMANDUA_WORKER_PID}`,
    );
    assert.notEqual(
      String(observedWorkerPid),
      String(process.pid),
      "TAMANDUA_WORKER_PID must NOT be the daemon pid (CPID2)",
    );

    // The round completed cleanly: the claimed step was auto-completed.
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(`${runId}-step`) as { status: string };
    assert.equal(step.status, "done", "a clean STATUS: done round must auto-complete the claimed step");
  });
});

// ── GIDN US-003: the resolved identity reaches every harness round ──
// The identity resolved once at launch (US-002) is stored on the run context
// as git_identity_name/git_identity_email. createAgentCronJob captures it
// into the dispatch job, and buildHarnessChildEnv — shared by the work round
// and the launch-time harness probe round — turns it into the four
// GIT_AUTHOR_*/GIT_COMMITTER_* variables so no agent commit can fall back to
// an improvised or daemon-ambient identity.

describe("executeDispatchRound harness env git identity (GIDN US-003)", () => {
  let tempHome: string;
  let saved: Record<string, string | undefined>;

  const IDENTITY = { name: "Ada Lovelace", email: "ada@example.com" };

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-gitid-");
    const stateDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    saved = {
      HOME: process.env.HOME,
      TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
      TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
      TAMANDUA_PI_BINARY: process.env.TAMANDUA_PI_BINARY,
      TAMANDUA_RUN_ID: process.env.TAMANDUA_RUN_ID,
      TAMANDUA_HARNESS_PROBE: process.env.TAMANDUA_HARNESS_PROBE,
      TAMANDUA_ENV_DUMP: process.env.TAMANDUA_ENV_DUMP,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
    };
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    // The canned shims never answer a probe prompt in the work-round cases,
    // so the probe is disabled there; the probe case re-enables it.
    process.env.TAMANDUA_HARNESS_PROBE = "0";
    delete process.env.TAMANDUA_RUN_ID;
    // Drop any ambient identity so a child observation can only come from the
    // scheduler's harnessEnv (individual cases set impostor values as needed).
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_NAME;
    delete process.env.GIT_COMMITTER_EMAIL;
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(stateDir, "tamandua.db"), "agent-scheduler-gidn-us003"),
    );
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    shutdownAllCrons();
    _resetInstantFailStreaks();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function seedRun(context: Record<string, unknown>): { runId: string; workdir: string } {
    const db = getDb();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'git identity task', 'running', ?, ?, ?)",
    ).run(runId, JSON.stringify({ working_directory_for_harness: workdir, ...context }), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-step`, runId, now, now);
    return { runId, workdir };
  }

  const jobFor = (
    runId: string,
    workdir: string,
    gitIdentity?: { name: string; email: string },
  ): CronJobInfo => ({
    id: `tamandua-test-wf-${runId}-test-agent`,
    workflowId: "test-wf",
    runId,
    agentId: "test-wf_test-agent",
    harnessType: "pi",
    workingDirectoryForHarness: workdir,
    gitIdentity,
    createdAt: "",
  });

  const agentFor = () => ({
    id: "test-agent",
    model: "fake",
    workspace: { baseDir: "." },
    timeoutSeconds: 10,
  });

  /** Minimal fake pi: records the four identity vars, claims the step via the DB, reports done. */
  function writeIdentityDumpFakePi(): string {
    const fakePi = path.join(tempHome, "pi-identity-mock");
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
fs.writeFileSync(process.env.TAMANDUA_ENV_DUMP, JSON.stringify({
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? null,
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? null,
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? null,
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? null,
}));
const db = new DatabaseSync(process.env.TAMANDUA_DB_PATH);
db.exec("PRAGMA busy_timeout = 5000");
db.prepare("UPDATE steps SET status = 'running', claim_job_id = ? WHERE status = 'pending'").run(process.env.TAMANDUA_WORKER_JOB_ID);
console.log("STATUS: done");
process.exit(0);
`,
      { mode: 0o755 },
    );
    return fakePi;
  }

  /** Probe-aware fake pi: records the probe child env then answers the probe with a nonzero exit. */
  function writeProbeEnvDumpFakePi(): string {
    const fakePi = path.join(tempHome, "pi-probe-env-mock");
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(process.env.TAMANDUA_ENV_DUMP + ".probe", JSON.stringify({
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? null,
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? null,
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? null,
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? null,
}));
process.exit(1);
`,
      { mode: 0o755 },
    );
    return fakePi;
  }

  it("createAgentCronJob captures the resolved identity from the run context", async () => {
    const withIdentity = seedRun({
      git_identity_name: IDENTITY.name,
      git_identity_email: IDENTITY.email,
      git_identity_source: "env",
    }).runId;
    const withoutIdentity = seedRun({}).runId;

    await createAgentCronJob({
      workflowId: "test-wf",
      runId: withIdentity,
      agent: { id: "test-agent", model: "fake", workspace: { baseDir: "." } },
      workingDirectoryForHarness: path.join(tempHome, "work"),
    });
    await createAgentCronJob({
      workflowId: "test-wf",
      runId: withoutIdentity,
      agent: { id: "test-agent", model: "fake", workspace: { baseDir: "." } },
      workingDirectoryForHarness: path.join(tempHome, "work"),
    });

    assert.deepEqual(
      _scheduledJobGitIdentity(withIdentity),
      { name: IDENTITY.name, email: IDENTITY.email },
      "the dispatch job must carry the identity persisted on the run context",
    );
    assert.equal(
      _scheduledJobGitIdentity(withoutIdentity),
      undefined,
      "a context without identity keys must leave the job identity undefined (never fabricated)",
    );
  });

  it("work round carries the identity and overrides inherited daemon identity vars", async () => {
    const { runId, workdir } = seedRun({
      git_identity_name: IDENTITY.name,
      git_identity_email: IDENTITY.email,
      git_identity_source: "env",
    });
    // Impostor values in the daemon's own environment: the round env must win.
    process.env.GIT_AUTHOR_NAME = "Daemon Impostor";
    process.env.GIT_AUTHOR_EMAIL = "impostor@daemon.local";
    process.env.GIT_COMMITTER_NAME = "Daemon Impostor";
    process.env.GIT_COMMITTER_EMAIL = "impostor@daemon.local";
    const envDump = path.join(tempHome, "env-dump.json");
    process.env.TAMANDUA_ENV_DUMP = envDump;
    process.env.TAMANDUA_PI_BINARY = writeIdentityDumpFakePi();

    await executeDispatchRound(jobFor(runId, workdir, IDENTITY), agentFor());

    const observed = JSON.parse(fs.readFileSync(envDump, "utf8")) as Record<string, string | null>;
    assert.deepEqual(observed, {
      GIT_AUTHOR_NAME: IDENTITY.name,
      GIT_AUTHOR_EMAIL: IDENTITY.email,
      GIT_COMMITTER_NAME: IDENTITY.name,
      GIT_COMMITTER_EMAIL: IDENTITY.email,
    });

    const step = getDb().prepare("SELECT status FROM steps WHERE id = ?").get(`${runId}-step`) as { status: string };
    assert.equal(step.status, "done", "the work round must complete normally");
  });

  it("launch-time harness probe round receives the same four identity variables", async () => {
    const { runId, workdir } = seedRun({
      git_identity_name: IDENTITY.name,
      git_identity_email: IDENTITY.email,
      git_identity_source: "repo-local",
    });
    delete process.env.TAMANDUA_HARNESS_PROBE; // probe ENABLED
    const envDump = path.join(tempHome, "probe-env-dump.json");
    process.env.TAMANDUA_ENV_DUMP = envDump;
    process.env.TAMANDUA_PI_BINARY = writeProbeEnvDumpFakePi();

    await executeDispatchRound(jobFor(runId, workdir, IDENTITY), agentFor());

    const observed = JSON.parse(fs.readFileSync(`${envDump}.probe`, "utf8")) as Record<string, string | null>;
    assert.deepEqual(observed, {
      GIT_AUTHOR_NAME: IDENTITY.name,
      GIT_AUTHOR_EMAIL: IDENTITY.email,
      GIT_COMMITTER_NAME: IDENTITY.name,
      GIT_COMMITTER_EMAIL: IDENTITY.email,
    }, "the probe round shares buildHarnessChildEnv and must carry the identity too");
  });

  it("leaves the four identity variables unset when the job has no identity (defensive)", async () => {
    const { runId, workdir } = seedRun({});
    const envDump = path.join(tempHome, "env-dump-null.json");
    process.env.TAMANDUA_ENV_DUMP = envDump;
    process.env.TAMANDUA_PI_BINARY = writeIdentityDumpFakePi();

    await executeDispatchRound(jobFor(runId, workdir, undefined), agentFor());

    const observed = JSON.parse(fs.readFileSync(envDump, "utf8")) as Record<string, string | null>;
    assert.deepEqual(observed, {
      GIT_AUTHOR_NAME: null,
      GIT_AUTHOR_EMAIL: null,
      GIT_COMMITTER_NAME: null,
      GIT_COMMITTER_EMAIL: null,
    }, "no resolved identity means no fabricated GIT_AUTHOR_*/GIT_COMMITTER_* variables");
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
      // The canned fake-pi shims never answer a launch-time harness probe
      // prompt, so the probe is disabled for these rounds — exactly as
      // TAMANDUA_PI_BINARY is managed — keeping the settle semantics
      // unchanged.
      TAMANDUA_HARNESS_PROBE: process.env.TAMANDUA_HARNESS_PROBE,
    };
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    process.env.TAMANDUA_HARNESS_PROBE = "0";
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
      // The canned fake-pi shims never answer a launch-time harness probe
      // prompt, so the probe is disabled for these rounds — exactly as
      // TAMANDUA_PI_BINARY is managed — keeping the post-terminal flush
      // semantics unchanged.
      TAMANDUA_HARNESS_PROBE: process.env.TAMANDUA_HARNESS_PROBE,
    };
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    process.env.TAMANDUA_HARNESS_PROBE = "0";
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
      // The canned fake-pi shims never answer a launch-time harness probe
      // prompt, so the probe is disabled for these rounds — exactly as
      // TAMANDUA_PI_BINARY is managed — keeping the dispatch-run
      // attribution identity assertions unchanged.
      TAMANDUA_HARNESS_PROBE: process.env.TAMANDUA_HARNESS_PROBE,
    };
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    process.env.TAMANDUA_HARNESS_PROBE = "0";
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

// ── IFLB US-003: launch-time harness probe gate ─────────────────────
// At a run's FIRST real dispatch (after the deterministic peek confirms
// HAS_WORK and before any step is claimed), the dispatch motor runs the
// run's harness through the probe prompt and force-fails the run
// immediately and legibly when the harness cannot work (a launch-broken
// harness — pi with invalidated credentials, dsh boot failure — used to
// strand the run in consecutive instant-fail backoff rounds that never
// escalated). These tests drive the gate at the scheduler level: (a) a
// failing harness force-fails with the keyline block and zero steps
// started; (b/c) a probe-aware harness is probed exactly once (probe ok
// precedes the first step.running), records 'ok' so the second dispatch
// never re-probes, and attributes probe tokens exactly once.

describe("executeDispatchRound launch-time harness probe (IFLB US-003)", () => {
  let tempHome: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-harness-probe-");
    const stateDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    saved = {
      HOME: process.env.HOME,
      TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
      TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
      TAMANDUA_PI_BINARY: process.env.TAMANDUA_PI_BINARY,
      TAMANDUA_RUN_ID: process.env.TAMANDUA_RUN_ID,
      // The probe is ENABLED (default) in this suite: the fixtures below
      // are probe-aware. Restore whatever the previous suite left behind.
      TAMANDUA_HARNESS_PROBE: process.env.TAMANDUA_HARNESS_PROBE,
    };
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    delete process.env.TAMANDUA_HARNESS_PROBE;
    // Drop any ambient TAMANDUA_RUN_ID so run identity only comes from the
    // scheduler's harnessEnv.
    delete process.env.TAMANDUA_RUN_ID;
    // Guard awareness (test-isolation-guard): this suite emits events and
    // reads the run DB through the same isolated temp state dir it creates.
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(stateDir, "tamandua.db"), "agent-scheduler-iflb-probe"),
    );
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    shutdownAllCrons();
    _resetInstantFailStreaks();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /** Seed a running run with `count` pending steps so the peek says HAS_WORK. */
  function seedProbeRun(count: number): { runId: string; jobId: string; workdir: string } {
    const db = getDb();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'probe task', 'running', ?, ?, ?)",
    ).run(runId, JSON.stringify({ working_directory_for_harness: workdir }), now, now);
    for (let i = 0; i < count; i++) {
      db.prepare(
        "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, ?, 'test-wf_test-agent', ?, 'do work', 'STATUS', 'pending', ?, ?)",
      ).run(`${runId}-step-${i}`, runId, `step-${i}`, i, now, now);
    }
    // Same job-id shape as buildJobId("test-wf", runId, "test-agent").
    const jobId = `tamandua-test-wf-${runId}-test-agent`;
    return { runId, jobId, workdir };
  }

  const jobFor = (runId: string, jobId: string, workdir: string): CronJobInfo => ({
    id: jobId,
    workflowId: "test-wf",
    runId,
    agentId: "test-wf_test-agent",
    harnessType: "pi",
    workingDirectoryForHarness: workdir,
    createdAt: "",
  });

  const agentFor = (timeoutSeconds = 30) => ({
    id: "test-agent",
    model: "fake",
    workspace: { baseDir: "." },
    timeoutSeconds,
  });

  /**
   * Probe-aware fake pi: when the last argv starts with the probe marker it
   * executes the quoted `<launcher> skill-path` command for real, journals
   * the probe invocation, and replies with the PATH (plus a message_end
   * usage line so probe tokens attribute exactly once). Otherwise it runs
   * the REAL work protocol — step claim / step complete through the
   * tamandua CLI — so step.running fires and the pipeline advances.
   */
  function writeProbeAwareFakePi(probeJournal: string, reportDir: string): string {
    const launcher = path.resolve(import.meta.dirname, "..", "..", "bin", "tamandua");
    const fakePi = path.join(tempHome, "pi-probe-mock");
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const prompt = process.argv[process.argv.length - 1] ?? "";
const isProbe = typeof prompt === "string" && prompt.startsWith("TAMANDUA_HARNESS_PROBE: skill-path");

if (isProbe) {
  fs.appendFileSync(process.env.TAMANDUA_PROBE_JOURNAL, "probe\\n");
  const m = prompt.match(/"([^"\\n]+)"/);
  const raw = m ? m[1] : "";
  const space = raw.indexOf(" ");
  const cmd = space === -1 ? raw : raw.slice(0, space);
  const rest = space === -1 ? [] : [raw.slice(space + 1)];
  if (!cmd) process.exit(1);
  const res = spawnSync(cmd, rest, { encoding: "utf-8" });
  const stdout = (res.stdout ?? "").trim();
  if (res.status !== 0 || stdout.length === 0) process.exit(res.status ?? 1);
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: stdout, usage: { totalTokens: 42 } } }));
  process.exit(0);
}

const agent = ${JSON.stringify("test-wf_test-agent")};
const launcher = ${JSON.stringify(launcher)};
const reportDir = process.env.TAMANDUA_PROBE_REPORT_DIR;
const claim = spawnSync(launcher, ["step", "claim", agent, "--run-id", process.env.TAMANDUA_RUN_ID], { encoding: "utf-8" });
if (claim.status !== 0) process.exit(claim.status ?? 1);
let stepId = null;
try { stepId = JSON.parse(claim.stdout).stepId; } catch { stepId = null; }
if (!stepId) process.exit(1);
const report = path.join(reportDir, "report-" + stepId + ".txt");
fs.writeFileSync(report, "STATUS: done\\nCHANGES: probe passed\\nTESTS: n/a");
const done = spawnSync(launcher, ["step", "complete", stepId, "--file", report], { encoding: "utf-8" });
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "STATUS: done", usage: { totalTokens: 137 } } }));
console.log("STATUS: done");
process.exit(done.status ?? 0);
`,
      { mode: 0o755 },
    );
    return fakePi;
  }

  it("(a) a pi shim that exits 1 with empty output force-fails the run with the keyline block; zero steps start", async () => {
    const { runId, jobId, workdir } = seedProbeRun(1);
    const deadPi = path.join(tempHome, "pi-dead-mock");
    fs.writeFileSync(deadPi, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    process.env.TAMANDUA_PI_BINARY = deadPi;

    await executeDispatchRound(jobFor(runId, jobId, workdir), agentFor());

    const db = getDb();
    const row = db.prepare(
      "SELECT status, harness_probe_status, instant_fail_count, worker_lost_count, ceiling_expiry_count FROM runs WHERE id = ?",
    ).get(runId) as {
      status: string;
      harness_probe_status: string | null;
      instant_fail_count: number;
      worker_lost_count: number;
      ceiling_expiry_count: number;
    };
    assert.equal(row.status, "failed", "a failed harness probe must force-fail the run within the round");
    assert.equal(row.harness_probe_status, "failed", "the probe outcome must be persisted as 'failed'");
    // The probe round is NOT an instant-fail (RSPN) round and never ticks
    // worker_lost / ceiling_expiry counters.
    assert.equal(row.instant_fail_count, 0, "a failed probe must not tick instant_fail_count");
    assert.equal(row.worker_lost_count, 0, "a failed probe must not tick worker_lost_count");
    assert.equal(row.ceiling_expiry_count, 0, "a failed probe must not tick ceiling_expiry_count");

    const events = getRunEvents(runId);
    const failed = events.filter((e) => e.event === "run.harness_probe_failed");
    assert.equal(failed.length, 1, "exactly one run.harness_probe_failed must be emitted");
    const reason = failed[0].reason ?? "";
    assert.match(reason, /^FAILURE_CLASS: harness_unavailable\n/, "reason must open with the mechanical keyline block");
    assert.match(reason, /\nHARNESS: pi\n/, "reason must name the harness");
    assert.match(reason, /\nPROBE_CMD: .* skill-path\n/, "reason must quote the probe command");
    assert.match(reason, /\nEXIT_CODE: 1\n/, "reason must carry the harness exit code");
    assert.ok(
      reason.trimEnd().endsWith("STDERR_TAIL:"),
      "STDERR_TAIL must be the LAST key of the block, got: " + reason,
    );
    assert.equal(failed[0].harness, "pi");
    assert.equal(failed[0].exitCode, 1);
    assert.ok(typeof failed[0].durationMs === "number", "the failed event must carry DURATION_MS");
    // IFLB US-004: pin the full mechanical keyline-block payload on the
    // failed event — every block field must round-trip on the event.
    assert.equal(
      failed[0].reason,
      failed[0].detail,
      "reason and detail must both carry the keyline block verbatim",
    );
    assert.match(failed[0].probeCmd ?? "", / skill-path$/, "probeCmd must quote the <launcher> skill-path command");
    assert.ok(
      typeof failed[0].expected === "string" && (failed[0].expected as string).length > 0,
      "the failed event must carry the daemon-computed EXPECTED path",
    );
    assert.ok(typeof failed[0].observed === "string", "the failed event must carry the normalized OBSERVED message");
    assert.ok(typeof failed[0].stderrTail === "string", "the failed event must carry the STDERR_TAIL string");
    // A plain exit-1 shim dies with no signal: SIGNAL stays absent/null.
    if ("signal" in failed[0]) {
      assert.equal(failed[0].signal, null);
    }

    const forceFailures = events.filter((e) => e.event === "run.force_failed");
    assert.equal(forceFailures.length, 1, "the run must be force-failed through the sanctioned path");
    // F3: the scheduler teardown may append a closing run.tokens.final after
    // the terminal event, so run.force_failed must be the run's final
    // lifecycle event (ignoring an optional trailing token finalization).
    const lifecycleEvents = events.filter((e) => e.event !== "run.tokens.final");
    assert.equal(
      lifecycleEvents[lifecycleEvents.length - 1].event,
      "run.force_failed",
      "run.force_failed must be the run's final lifecycle event",
    );

    // Zero steps started: the step was never claimed (no step.running, no
    // claim events) — force-fail merely canceled the pending step.
    const stepRunning = events.filter((e) => e.event === "step.running");
    assert.equal(stepRunning.length, 0, "a failed probe must never start a step");
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(`${runId}-step-0`) as { status: string };
    assert.equal(step.status, "canceled", "the unclaimed pending step must be canceled by the force-fail");
  });

  it("(b+c) a probe-aware harness passes the probe once, proceeds, and is never re-probed on the next dispatch", async () => {
    // Two pending steps: round 1 probes + works step 0; round 2 must NOT
    // re-probe ('ok' persisted) and works step 1 to completion.
    const { runId, jobId, workdir } = seedProbeRun(2);
    const probeJournal = path.join(tempHome, "probe-invocations.log");
    const reportDir = path.join(tempHome, "reports");
    fs.mkdirSync(reportDir, { recursive: true });
    process.env.TAMANDUA_PI_BINARY = writeProbeAwareFakePi(probeJournal, reportDir);
    process.env.TAMANDUA_PROBE_JOURNAL = probeJournal;
    process.env.TAMANDUA_PROBE_REPORT_DIR = reportDir;

    await executeDispatchRound(jobFor(runId, jobId, workdir), agentFor());

    // Round 1: the probe ran, passed, and recorded 'ok' BEFORE the work
    // round claimed step 0.
    let db = getDb();
    let row = db.prepare("SELECT harness_probe_status, tokens_spent, instant_fail_count, worker_lost_count, ceiling_expiry_count FROM runs WHERE id = ?").get(runId) as {
      harness_probe_status: string | null;
      tokens_spent: number;
      instant_fail_count: number;
      worker_lost_count: number;
      ceiling_expiry_count: number;
    };
    assert.equal(row.harness_probe_status, "ok", "a passing probe must persist 'ok'");
    assert.equal(
      fs.readFileSync(probeJournal, "utf-8").split("\n").filter(Boolean).length,
      1,
      "exactly one probe invocation may run",
    );

    let events = getRunEvents(runId);
    const okEvents = events.filter((e) => e.event === "run.harness_probe_ok");
    assert.equal(okEvents.length, 1, "exactly one run.harness_probe_ok must be emitted");
    assert.equal(okEvents[0].harness, "pi", "the ok event must name the harness");
    assert.equal(okEvents[0].tokens, 42, "the ok event must carry the probe round's attributed tokens");
    assert.ok(typeof okEvents[0].durationMs === "number", "the ok event must carry DURATION_MS");
    assert.ok(!("probeCmd" in okEvents[0]), "the ok event must not carry failure-only payload fields");
    assert.ok(!("exitCode" in okEvents[0]), "the ok event must not carry failure-only payload fields");
    assert.ok(!("stderrTail" in okEvents[0]), "the ok event must not carry failure-only payload fields");

    const firstRunningIdx = events.findIndex((e) => e.event === "step.running");
    const okIdx = events.findIndex((e) => e.event === "run.harness_probe_ok");
    assert.notEqual(firstRunningIdx, -1, "the work round must claim a step (step.running)");
    assert.ok(
      okIdx !== -1 && okIdx < firstRunningIdx,
      "run.harness_probe_ok must precede the first step.running",
    );

    // Probe tokens (42) + step-0 work tokens (137) land exactly once.
    const probeTokenEvents = events.filter(
      (e) => e.event === "run.tokens.updated" && e.tokenDelta === 42,
    );
    assert.equal(probeTokenEvents.length, 1, "probe tokens must be attributed exactly once");
    assert.equal(row.tokens_spent, 42 + 137, "probe + first work tokens must land on runs.tokens_spent");
    assert.equal(row.instant_fail_count, 0, "the probe round must not tick instant_fail_count");
    assert.equal(row.worker_lost_count, 0, "the probe round must not tick worker_lost_count");
    assert.equal(row.ceiling_expiry_count, 0, "the probe round must not tick ceiling_expiry_count");

    // Round 2: 'ok' is persisted → the gate skips the probe entirely and the
    // round dispatches work for step 1.
    await executeDispatchRound(jobFor(runId, jobId, workdir), agentFor());

    db = getDb();
    row = db.prepare("SELECT status, harness_probe_status, tokens_spent FROM runs WHERE id = ?").get(runId) as {
      status: string;
      harness_probe_status: string | null;
      tokens_spent: number;
    };
    assert.equal(row.status, "completed", "the run must reach its normal terminal state after step 1");
    assert.equal(row.harness_probe_status, "ok", "the 'ok' probe status must persist through the run");
    assert.equal(
      fs.readFileSync(probeJournal, "utf-8").split("\n").filter(Boolean).length,
      1,
      "the second dispatch must NOT re-probe (no second probe spawn)",
    );

    events = getRunEvents(runId);
    assert.equal(
      events.filter((e) => e.event === "run.harness_probe_ok").length,
      1,
      "the second dispatch must NOT emit a second run.harness_probe_ok",
    );
    assert.equal(
      events.filter((e) => e.event === "run.harness_probe_failed").length,
      0,
      "no probe failure event may ever fire on the passing path",
    );
    // No double counting: 42 (probe) + 137 (step 0) + 137 (step 1).
    assert.equal(row.tokens_spent, 42 + 137 + 137, "tokens must be attributed exactly once per round");
  });

  it("TAMANDUA_HARNESS_PROBE=0 skips the probe entirely and rounds dispatch exactly as before", async () => {
    const { runId, jobId, workdir } = seedProbeRun(1);
    process.env.TAMANDUA_HARNESS_PROBE = "0";

    // A canned fake pi that ignores the prompt entirely (claims the step via
    // the DB and prints STATUS: done) — with the probe disabled it must never
    // be probed, and the work round must complete the step exactly as before.
    const fakePi = path.join(tempHome, "pi-mock");
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.TAMANDUA_DB_PATH);
db.exec("PRAGMA busy_timeout = 5000");
db.prepare("UPDATE steps SET status = 'running', claim_job_id = ? WHERE status = 'pending'").run(process.env.TAMANDUA_WORKER_JOB_ID);
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "STATUS: done", usage: { totalTokens: 7 } } }));
console.log("STATUS: done");
process.exit(0);
`,
      { mode: 0o755 },
    );
    process.env.TAMANDUA_PI_BINARY = fakePi;

    await executeDispatchRound(jobFor(runId, jobId, workdir), agentFor());

    const db = getDb();
    const row = db.prepare("SELECT status, harness_probe_status, tokens_spent FROM runs WHERE id = ?").get(runId) as {
      status: string;
      harness_probe_status: string | null;
      tokens_spent: number;
    };
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(`${runId}-step-0`) as { status: string };
    assert.equal(row.status, "completed", "with the probe disabled the round must dispatch work exactly as before");
    assert.equal(row.harness_probe_status, null, "with the probe disabled the run is never probed (status stays NULL)");
    assert.equal(row.tokens_spent, 7, "the work round's tokens must attribute normally");
    assert.equal(step.status, "done", "the claimed step must auto-complete as before");

    const events = getRunEvents(runId);
    assert.equal(
      events.filter((e) => e.event === "run.harness_probe_ok" || e.event === "run.harness_probe_failed").length,
      0,
      "no probe events may fire when the probe is disabled",
    );
  });
});

// ── KHYG US-002: real registered-round teardown aborts a parked launch ──
//
// Coordinator-reproduced wiring gap (23:12/23:28 UTC): removeRunCrons and
// shutdownAllCrons aborted a round's launch-cancellation controller ONLY
// when the round had already published a child in inFlightChildren. A
// registered dispatch round that is still awaiting binary resolution (no
// child yet) therefore kept an un-aborted controller: after teardown the
// round proceeded to launch the harness once. These tests drive the REAL
// registered executeDispatchRound (job registered via createAgentCronJob),
// park it at adapter.findBinary via a thin adapter-prototype override, run
// REAL removeRunCrons / shutdownAllCrons, then release the round — and
// assert zero harness executions, zero spawned handles and an aborted
// signal observed at runRound.

// ── KHYG US-002: real registered-round teardown cancels a parked launch ──
//
// Coordinator-reproduced wiring gap (23:12/23:28 UTC): removeRunCrons and
// shutdownAllCrons aborted a round's launch-cancellation controller ONLY
// when the round had already published a child in inFlightChildren. A
// registered dispatch round that is still awaiting binary resolution (no
// child yet) therefore kept an un-aborted controller: after teardown the
// round proceeded to launch the harness once. These tests drive the REAL
// registered executeDispatchRound (job registered via createAgentCronJob),
// park it at adapter.findBinary via a thin adapter-prototype override, run
// REAL removeRunCrons / shutdownAllCrons, then release the round — and
// assert zero harness executions, zero spawned handles and an aborted
// signal observed at runRound. The replacement case additionally pins the
// identity-safe finally: an old round's cleanup must not erase a
// replacement round's controller registered under the same job id.
describe("KHYG US-002 real registered-round teardown cancels a parked dispatch launch", () => {
  let tempHome: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-sched-cancel-");
    const stateDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    saved = {
      HOME: process.env.HOME,
      TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
      TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
      TAMANDUA_PI_BINARY: process.env.TAMANDUA_PI_BINARY,
      TAMANDUA_HARNESS_PROBE: process.env.TAMANDUA_HARNESS_PROBE,
    };
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    // These rounds must reach the WORK spawn (binary resolution) directly;
    // the launch-time probe round would resolve the binary first.
    process.env.TAMANDUA_HARNESS_PROBE = "0";
    // Guard awareness (test-isolation-guard): this suite emits events and
    // reads the run DB through the same isolated temp state dir it creates.
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(stateDir, "tamandua.db"), "agent-scheduler-khyg-cancel"),
    );
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    shutdownAllCrons();
    _resetInstantFailStreaks();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /** Seed a running run with one pending step and a counter harness. */
  function seedCancellationRun(): { runId: string; workdir: string; counter: string; jobId: string } {
    const db = getDb();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'cancel task', 'running', ?, ?, ?)",
    ).run(runId, JSON.stringify({ working_directory_for_harness: workdir }), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-step`, runId, now, now);

    // The counter harness appends one 'x' per REAL harness execution.
    const counter = path.join(tempHome, "target-starts");
    const target = path.join(tempHome, "owned-harness");
    fs.writeFileSync(target, `#!/bin/sh\nprintf 'x\\n' >> "${counter}"\nprintf 'NO_WORK_AVAILABLE\\n'\n`, {
      mode: 0o755,
    });
    process.env.TAMANDUA_PI_BINARY = target;

    // Same job-id shape as buildJobId("test-wf", runId, "test-agent").
    const jobId = `tamandua-test-wf-${runId}-test-agent`;
    return { runId, workdir, counter, jobId };
  }

  /**
   * Drive a REAL registered dispatch round (or two overlapping rounds with
   * the same job id, `replacement`), parking it at binary resolution
   * (adapter.findBinary — no child published yet), then tear the run down
   * with the REAL removeRunCrons or shutdownAllCrons and release the
   * parked round(s). `forceFallback` routes the adapter's launch through
   * the forced-unavailable fallback seam so a leaked post-teardown launch
   * would run unprotected (and would be counted). Returns the observed
   * signal-aborted state at each runRound entry, spawned onSpawn handles,
   * and real harness executions.
   */
  async function runCancellationScenario(opts: {
    action: "remove" | "shutdown";
    forceFallback?: boolean;
    replacement?: boolean;
  }): Promise<{
    signalsAtRun: Array<boolean | null>;
    spawned: number;
    executions: number;
  }> {
    const { runId, workdir, counter, jobId } = seedCancellationRun();
    const agent = {
      id: "test-agent",
      model: "fake",
      timeoutSeconds: 30,
      workspace: { baseDir: "." },
    };
    const workflow = {
      id: "test-wf",
      agents: [agent],
      steps: [{ id: "step-1", agent: "test-agent", input: "do work", expects: "STATUS" }],
    };

    // Register the dispatch round (jobMetadata entry) WITHOUT letting its
    // stagger timer fire: 60s keeps the timer dormant for the test.
    const registerRound = async (): Promise<string> => {
      const created = await createAgentCronJob({
        workflowId: "test-wf",
        runId,
        agent,
        workflow,
        workingDirectoryForHarness: workdir,
        staggerOffsetMs: 60_000,
      });
      assert.ok(created.ok && created.id, `createAgentCronJob failed: ${created.error ?? "?"}`);
      return created.id!;
    };

    // Park each real per-round adapter instance at its first findBinary
    // (pi resolves once in the scheduler and again inside runRound; only
    // the first per-instance call is held). Gates[0..1] cover round A and
    // (replacement) round B.
    const proto = Object.getPrototypeOf(getHarnessAdapter("pi")) as unknown as {
      findBinary: (o?: { preferTokenSaver?: boolean }) => Promise<string>;
      runRound: (prompt: string, options?: Record<string, unknown>) => Promise<unknown>;
    };
    const oldFind = proto.findBinary;
    const oldRun = proto.runRound;
    const signalsAtRun: Array<boolean | null> = [];
    let spawned = 0;
    const heldInstances = new WeakSet<object>();
    const releaseGate: Array<() => void> = [];
    const gates: Array<Promise<void>> = [];
    const markParked: Array<() => void> = [];
    const parked: Array<Promise<void>> = [];
    for (let i = 0; i < 2; i++) {
      gates.push(
        new Promise<void>((resolve) => {
          releaseGate[i] = resolve;
        }),
      );
      parked.push(
        new Promise<void>((resolve) => {
          markParked[i] = resolve;
        }),
      );
    }
    let findIndex = 0;
    proto.findBinary = async function (this: object) {
      if (heldInstances.has(this)) return oldFind.call(this);
      heldInstances.add(this);
      const idx = findIndex++;
      markParked[idx](); // announce: this round reached binary resolution
      await gates[idx]; // park until the test tears the run down + releases
      return oldFind.call(this);
    };
    proto.runRound = function (
      this: object,
      prompt: string,
      options?: Record<string, unknown>,
    ) {
      signalsAtRun.push((options?.signal as AbortSignal | undefined)?.aborted ?? null);
      const onSpawn = options?.onSpawn as ((h: { pid: number; pgid: number }) => void) | undefined;
      const wrappedOptions: Record<string, unknown> = {
        ...(options ?? {}),
        onSpawn: (h: { pid: number; pgid: number }) => {
          spawned++;
          onSpawn?.(h);
        },
      };
      if (opts.forceFallback) {
        wrappedOptions.launch = {
          ...((options?.launch as Record<string, unknown> | undefined) ?? {}),
          forceFallbackReason: "owned scheduler diagnostic",
        };
      }
      return oldRun.call(this, prompt, wrappedOptions);
    };

    const releaseAll = (): void => {
      for (const r of releaseGate) r();
    };
    const jobFor = (id: string): CronJobInfo => ({
      id,
      workflowId: "test-wf",
      runId,
      agentId: "test-wf_test-agent",
      harnessType: "pi",
      workingDirectoryForHarness: workdir,
      createdAt: new Date().toISOString(),
    });

    // Fire-and-forget rounds are captured so an early rejection (before the
    // await below) is never an unhandled rejection; errors are re-thrown
    // after the scenario completes.
    const roundErrors: unknown[] = [];
    const track = (p: Promise<void>): Promise<void> => {
      p.catch((err: unknown) => {
        roundErrors.push(err);
      });
      return p;
    };
    const throwIfRoundFailed = (): void => {
      if (roundErrors.length > 0) {
        throw roundErrors[0];
      }
    };

    const withTimeout = async (p: Promise<void>, what: string): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 10_000);
      });
      try {
        await Promise.race([p, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    try {
      // Round A: register + park at binary resolution.
      const idA = await registerRound();
      const roundA = track(executeDispatchRound(jobFor(idA), agent, workflow));
      await withTimeout(parked[0], "round A binary resolution");

      if (opts.replacement) {
        // Pause (teardown round A's bookkeeping while it is parked), then
        // register a REPLACEMENT round under the SAME job id (pause/resume
        // shape) and park it too.
        await removeRunCrons(runId);
        const idB = await registerRound();
        const roundB = track(executeDispatchRound(jobFor(idB), agent, workflow));
        await withTimeout(parked[1], "replacement round B binary resolution");
        // Let the OLD round A finish first: its finally must delete only
        // its OWN controller, not replacement round B's (identity-safe).
        releaseGate[0]();
        await roundA;
        throwIfRoundFailed();
        // Now the teardown under test: it must abort round B's controller.
        if (opts.action === "remove") {
          await removeRunCrons(runId);
        } else {
          shutdownAllCrons();
        }
        releaseGate[1]();
        await roundB;
        throwIfRoundFailed();
      } else {
        // Teardown the REAL run while round A is parked (no child yet).
        if (opts.action === "remove") {
          await removeRunCrons(runId);
        } else {
          shutdownAllCrons();
        }
        releaseGate[0]();
        await roundA;
        throwIfRoundFailed();
      }

      const executions = fs.existsSync(counter)
        ? fs.readFileSync(counter, "utf8").split("\n").filter((l) => l.trim() === "x").length
        : 0;
      return { signalsAtRun, spawned, executions };
    } finally {
      releaseAll();
      proto.findBinary = oldFind;
      proto.runRound = oldRun;
      await removeRunCrons(runId).catch(() => {});
    }
  }

  it("removeRunCrons during a parked binary resolution aborts the round: zero executions, zero spawns, signal aborted", async () => {
    const outcome = await runCancellationScenario({ action: "remove" });
    assert.equal(outcome.signalsAtRun.length, 1, "exactly one round must reach runRound");
    assert.equal(outcome.signalsAtRun[0], true, "the round's signal must be aborted at runRound entry");
    assert.equal(outcome.spawned, 0, "no launcher child may be spawned after teardown");
    assert.equal(outcome.executions, 0, "the harness must never execute after teardown");
  });

  it("shutdownAllCrons during a parked binary resolution aborts the round: zero executions, zero spawns, signal aborted", async () => {
    const outcome = await runCancellationScenario({ action: "shutdown" });
    assert.equal(outcome.signalsAtRun.length, 1, "exactly one round must reach runRound");
    assert.equal(outcome.signalsAtRun[0], true, "the round's signal must be aborted at runRound entry");
    assert.equal(outcome.spawned, 0, "no launcher child may be spawned after teardown");
    assert.equal(outcome.executions, 0, "the harness must never execute after teardown");
  });

  it("a forced-fallback launch after removeRunCrons is vetoed: zero executions (no unprotected replay)", async () => {
    const outcome = await runCancellationScenario({ action: "remove", forceFallback: true });
    assert.equal(outcome.signalsAtRun.length, 1, "exactly one round must reach runRound");
    assert.equal(outcome.signalsAtRun[0], true, "the round's signal must be aborted at runRound entry");
    assert.equal(outcome.spawned, 0, "no fallback child may be spawned after teardown");
    assert.equal(outcome.executions, 0, "a canceled round must never fall back to an unprotected run");
  });

  it("a forced-fallback launch after shutdownAllCrons is vetoed: zero executions (no unprotected replay)", async () => {
    const outcome = await runCancellationScenario({ action: "shutdown", forceFallback: true });
    assert.equal(outcome.signalsAtRun.length, 1, "exactly one round must reach runRound");
    assert.equal(outcome.signalsAtRun[0], true, "the round's signal must be aborted at runRound entry");
    assert.equal(outcome.spawned, 0, "no fallback child may be spawned after teardown");
    assert.equal(outcome.executions, 0, "a canceled round must never fall back to an unprotected run");
  });

  it("replacement round under the same job id survives the old round's finally: teardown aborts it too (removeRunCrons)", async () => {
    const outcome = await runCancellationScenario({ action: "remove", replacement: true });
    assert.equal(outcome.signalsAtRun.length, 2, "both the old and the replacement round must reach runRound");
    assert.deepEqual(
      outcome.signalsAtRun,
      [true, true],
      "both rounds must observe an aborted signal (old round's finally must not erase the replacement's controller)",
    );
    assert.equal(outcome.spawned, 0, "no launcher child may be spawned after teardown");
    assert.equal(outcome.executions, 0, "neither round may execute the harness after teardown");
  });

  it("replacement round under the same job id survives the old round's finally: teardown aborts it too (shutdownAllCrons)", async () => {
    const outcome = await runCancellationScenario({ action: "shutdown", replacement: true });
    assert.equal(outcome.signalsAtRun.length, 2, "both the old and the replacement round must reach runRound");
    assert.deepEqual(
      outcome.signalsAtRun,
      [true, true],
      "both rounds must observe an aborted signal (old round's finally must not erase the replacement's controller)",
    );
    assert.equal(outcome.spawned, 0, "no launcher child may be spawned after teardown");
    assert.equal(outcome.executions, 0, "neither round may execute the harness after teardown");
  });
});

// ── F3: run.tokens.final closing token total (US-002) ───────────────
// step-ops emits run.completed/run.failed with tokensSpent read at that
// instant, but the harness that reported the final step emits its
// message_end usage AFTER the step-complete tool call. The scheduler keeps
// that round alive for the teardown grace window so the usage lands as a
// post-terminal run.tokens.updated; run.tokens.final is then the
// authoritative closing figure, emitted exactly once per terminal run
// without delaying or reordering the terminal event.

describe("run.tokens.final closing token total (F3)", () => {
  let tempHome: string;
  let stateDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-tokens-final-");
    stateDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    saved = {
      HOME: process.env.HOME,
      TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
      TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
      TAMANDUA_PI_BINARY: process.env.TAMANDUA_PI_BINARY,
      TAMANDUA_ROUND_MARKER: process.env.TAMANDUA_ROUND_MARKER,
      TAMANDUA_HARNESS_PROBE: process.env.TAMANDUA_HARNESS_PROBE,
    };
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    process.env.TAMANDUA_HARNESS_PROBE = "0";
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(stateDir, "tamandua.db"), "agent-scheduler-tokens-final"),
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

  /** Seed a run + pending step and return the matching dispatch job id. */
  function seedRun(
    status: string,
    tokensSpent = 0,
  ): { runId: string; jobId: string; workdir: string } {
    const db = getDb();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'test-workflow', 'tokens final task', ?, ?, ?, ?, ?)",
    ).run(runId, status, JSON.stringify({ working_directory_for_harness: workdir }), tokensSpent, now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-workflow_test-agent', 0, 'do work', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-step`, runId, now, now);

    const jobId = `tamandua-test-workflow-${runId}-test-agent`;
    return { runId, jobId, workdir };
  }

  /**
   * Fake pi reproducing the real timeline: claims the pending step and
   * writes the in-flight marker, sleeps 300ms (so the test can mark the run
   * terminal and tear down first), then emits a pi-shaped message_end with
   * usage.totalTokens = 137 followed by STATUS: done — exactly the
   * report-BEFORE-usage ordering that under-reports the terminal event.
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

  async function waitForFinalEvent(runId: string, timeoutMs = 5000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (getRunEvents(runId).some((e) => e.event === "run.tokens.final")) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("run.tokens.final was never emitted");
  }

  function startRound(runId: string, jobId: string, workdir: string): Promise<void> {
    return executeDispatchRound(
      { id: jobId, workflowId: "test-workflow", runId, agentId: "test-workflow_test-agent", harnessType: "pi", workingDirectoryForHarness: workdir, createdAt: "" },
      { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 },
    );
  }

  it("emits run.tokens.final after the terminal event with the full row total and last delta", async () => {
    const { runId, jobId, workdir } = seedRun("running");
    const marker = path.join(tempHome, "round-final-usage.marker");
    process.env.TAMANDUA_ROUND_MARKER = marker;
    process.env.TAMANDUA_PI_BINARY = writeFakePi();

    // Register the run's dispatch job exactly as admission does, so
    // removeRunCrons has real bookkeeping to tear down (and therefore
    // schedules the closing final).
    await setupAgentCrons(makeWorkflow(), runId, { workingDirectoryForHarness: workdir });

    const round = startRound(runId, jobId, workdir);
    await waitForMarker(marker);

    // The run reaches completed and the terminal event is emitted BEFORE
    // this round's usage parses — the exact under-report defect.
    getDb()
      .prepare("UPDATE runs SET status = 'completed', updated_at = datetime('now') WHERE id = ?")
      .run(runId);
    emitRunTerminalEvent({ event: "run.completed", runId, workflowId: "test-workflow" });

    // Teardown with the production grace: waits for the in-flight round's
    // attribution to settle before emitting the closing figure.
    await removeRunCrons(runId, { graceMs: 2000 });
    await round;
    await waitForFinalEvent(runId);

    const events = getRunEvents(runId);
    const names = events.map((e) => e.event);
    const completedIdx = names.indexOf("run.completed");
    const updatedIdx = names.indexOf("run.tokens.updated");
    const finalIdx = names.lastIndexOf("run.tokens.final");

    assert.notEqual(completedIdx, -1, "the terminal run.completed must be present");
    assert.notEqual(updatedIdx, -1, "the post-terminal usage flush must be present");
    assert.notEqual(finalIdx, -1, "run.tokens.final must be emitted");
    assert.ok(finalIdx > completedIdx, "run.tokens.final must follow the terminal event");
    assert.ok(finalIdx > updatedIdx, "run.tokens.final must follow the post-terminal flush");

    const finalEvent = events[finalIdx];
    assert.equal(finalEvent.tokensSpent, 137, "run.tokens.final must carry the full row total");
    assert.equal(finalEvent.tokenDelta, 137, "run.tokens.final must carry the last settled round's delta");
    assert.equal(finalEvent.workflowId, "test-workflow");

    const row = getDb().prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId) as { tokens_spent: number };
    assert.equal(finalEvent.tokensSpent, row.tokens_spent, "the closing figure must equal the runs row");

    assert.equal(
      events.filter((e) => e.event === "run.tokens.final").length,
      1,
      "exactly one run.tokens.final must be emitted",
    );
  });

  it("emits run.tokens.final with the row total and no tokenDelta when the grace expires with no usage", async () => {
    const { runId, workdir } = seedRun("completed", 500);
    await setupAgentCrons(makeWorkflow(), runId, { workingDirectoryForHarness: workdir });

    await removeRunCrons(runId, { graceMs: 25 });
    await waitForFinalEvent(runId);

    const finals = getRunEvents(runId).filter((e) => e.event === "run.tokens.final");
    assert.equal(finals.length, 1, "exactly one run.tokens.final must be emitted");
    assert.equal(finals[0].tokensSpent, 500, "the row total must be emitted");
    assert.equal(finals[0].tokenDelta, undefined, "no tokenDelta may be fabricated when no usage landed");
  });

  it("emits at most one run.tokens.final across repeated teardown and settle calls", async () => {
    const { runId, workdir } = seedRun("failed", 77);
    await setupAgentCrons(makeWorkflow(), runId, { workingDirectoryForHarness: workdir });

    await removeRunCrons(runId, { graceMs: 25 });
    await removeRunCrons(runId, { graceMs: 25 });
    await settleRunInFlightRounds(runId, { graceMs: 25 });
    await waitForFinalEvent(runId);

    // A late repeated teardown after the closing event must not add another.
    await removeRunCrons(runId, { graceMs: 25 });
    await new Promise((resolve) => setTimeout(resolve, 80));

    const finals = getRunEvents(runId).filter((e) => e.event === "run.tokens.final");
    assert.equal(finals.length, 1, "at most one run.tokens.final may exist per run");
  });

  it("does not emit run.tokens.final for a canceled run", async () => {
    const { runId, workdir } = seedRun("canceled", 999);
    await setupAgentCrons(makeWorkflow(), runId, { workingDirectoryForHarness: workdir });

    await removeRunCrons(runId, { graceMs: 25 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(
      getRunEvents(runId).filter((e) => e.event === "run.tokens.final").length,
      0,
      "canceled runs settle before run.canceled and must get no final",
    );
  });

  it("does not emit run.tokens.final on a post-terminal attribution without a grace teardown", async () => {
    const { runId, jobId, workdir } = seedRun("running");
    const marker = path.join(tempHome, "round-no-teardown.marker");
    process.env.TAMANDUA_ROUND_MARKER = marker;
    process.env.TAMANDUA_PI_BINARY = writeFakePi();

    const round = startRound(runId, jobId, workdir);
    await waitForMarker(marker);

    // Flip terminal mid-round and let the round's post-terminal attribution
    // land WITHOUT any removeRunCrons grace teardown (cancel-race shape).
    getDb()
      .prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?")
      .run(runId);
    await round;

    const events = getRunEvents(runId);
    assert.equal(
      events.filter((e) => e.event === "run.tokens.updated" && e.postTerminal === true).length,
      1,
      "the post-terminal flush must land",
    );
    assert.equal(
      events.filter((e) => e.event === "run.tokens.final").length,
      0,
      "a post-terminal attribution without a grace teardown must not finalize",
    );
  });
});
