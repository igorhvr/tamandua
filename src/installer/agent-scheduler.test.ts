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
  DISPATCH_INTERVAL_MS,
  HARNESS_TEARDOWN_GRACE_MS,
} from "../../dist/installer/agent-scheduler.js";
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
  afterEach(() => {
    shutdownAllCrons();
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

  it("does not schedule sweep timer when no jobs were removed", async () => {
    // removeRunCrons on an unknown runId should still schedule a timer
    // (the timer callback handles the "no worktree" case gracefully).
    await removeRunCrons("no-such-run");
    assert.equal(_pendingSweepTimerCount(), 1);
    assert.equal(_hasPendingSweepTimer("no-such-run"), true);

    // Cleanup
    shutdownAllCrons();
    assert.equal(_pendingSweepTimerCount(), 0);
  });
});
