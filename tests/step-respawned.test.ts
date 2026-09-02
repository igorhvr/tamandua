/**
 * RVOC US-002: step.respawned event vocabulary.
 *
 * When watchdog/dead-worker recovery (recoverOrphanedStepsForAgent)
 * re-dispatches a claimed step, the event stream must show a distinct
 * step.respawned event connecting the recovery event to the next
 * step.running — so operators can distinguish a respawn from an anomalous
 * duplicate claim. The event carries the recovered claim's worker identity
 * (priorPid = claim_pid, priorRound = claim_job_id) and the recovery class
 * as reason (worker_lost | timeout | ceiling_expiry | no_work_release).
 *
 * retry_count semantics, the existing recovery events, and the
 * recovered/failed/skipped counts must be unchanged.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { createTempHome } from "./helpers/test-env.ts";
import {
  recoverOrphanedStepsForAgent,
  claimStep,
} from "../dist/installer/step-ops.js";
import { getDb } from "../dist/db.js";
import { getRunEvents, type TamanduaEvent } from "../dist/installer/events.js";

describe("step-respawned (RVOC US-002)", () => {
  const th = createTempHome("tamandua-respawn-test-");
  const { tamanduaDir } = th;
  // HOME is required too: the recovery paths under test
  // (recoverOrphanedStepsForAgent / claimStep) fire fire-and-forget
  // teardown continuations (terminateRunWithDaemon → controlRequest) that
  // resolve the daemon secret at HOME/.tamandua/daemon-secret when
  // TAMANDUA_CONTROL_PORT is set — with the operator's real HOME that
  // tripped the guard. Point HOME at the temp home and drop the ambient
  // control port so controlRequest's early guard return fires instead of
  // ever reaching a live daemon.
  process.env.HOME = th.homeDir;
  process.env.TAMANDUA_STATE_DIR = tamanduaDir;
  process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");
  delete process.env.TAMANDUA_CONTROL_PORT;

  const AGENT = "test_respawn_agent";
  const PRIOR_PID = 4242;
  const PRIOR_ROUND = "job-claim-1";

  function ts(): string {
    return new Date().toISOString();
  }

  function seedRun(runId: string): void {
    const db = getDb();
    const now = ts();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'respawn test', 'running', '{}', ?, ?)"
    ).run(runId, now, now);
  }

  function seedStep(
    runId: string,
    opts: {
      stepId: string;
      status?: string;
      retryCount?: number;
      maxRetries?: number;
      type?: string;
      claimPid?: number | null;
      claimJobId?: string | null;
      currentStoryId?: string | null;
      loopConfig?: string | null;
    },
  ): string {
    const db = getDb();
    const now = ts();
    const rowId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, current_story_id, loop_config, claim_pid, claim_job_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      rowId,
      runId,
      opts.stepId,
      AGENT,
      opts.status ?? "pending",
      opts.retryCount ?? 0,
      opts.maxRetries ?? 3,
      opts.type ?? "single",
      opts.currentStoryId ?? null,
      opts.loopConfig ?? null,
      opts.claimPid ?? null,
      opts.claimJobId ?? null,
      now,
      now,
    );
    return rowId;
  }

  function seedStory(runId: string): string {
    const db = getDb();
    const now = ts();
    const storyId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, abandoned_count, created_at, updated_at) VALUES (?, ?, 0, 'US-200', 'S1', 'desc', '[]', 'pending', 0, 4, 0, ?, ?)"
    ).run(storyId, runId, now, now);
    return storyId;
  }

  function respawnedEvents(runId: string): TamanduaEvent[] {
    return getRunEvents(runId).filter((e) => e.event === "step.respawned");
  }

  it("emits exactly one step.respawned per recovered claimed step, with prior worker identity (full stream)", () => {
    const db = getDb();
    const runId = crypto.randomUUID();
    seedRun(runId);
    const rowId = seedStep(runId, {
      stepId: "dev-step",
      status: "pending",
      retryCount: 0,
      maxRetries: 3,
    });

    try {
      // First claim — emits the first step.running.
      const firstClaim = claimStep(AGENT, runId, { jobId: PRIOR_ROUND, pid: PRIOR_PID, pgid: 9001 });
      assert.equal(firstClaim.found, true, "first claim should find the pending step");

      // Recovery of the claimed (orphaned) step — worker_lost + respawned.
      const result = recoverOrphanedStepsForAgent(
        AGENT, runId, 0, undefined, undefined, PRIOR_ROUND, "worker_lost",
      );
      assert.equal(result.recovered, 1, "should recover 1 step");
      assert.equal(result.failed, 0, "should not fail any step");

      // retry_count increments exactly as before (semantics unchanged).
      const step = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(rowId) as {
        status: string; retry_count: number;
      };
      assert.equal(step.status, "pending", "step should be reset to pending");
      assert.equal(step.retry_count, 1, "retry_count must increment exactly as before");

      // Second claim — the re-dispatch, emits the second step.running.
      const secondClaim = claimStep(AGENT, runId, { jobId: "job-claim-2", pid: PRIOR_PID + 1, pgid: 9002 });
      assert.equal(secondClaim.found, true, "re-claim after recovery should find the re-pended step");

      // Full stream for this step: no second step.running without a
      // connecting step.respawned. (claimStep also emits
      // dispatch.render.validated telemetry — filter to step-lifecycle
      // events.)
      const stream = getRunEvents(runId)
        .filter((e) => e.stepId === "dev-step")
        .filter((e) => ["step.running", "step.worker_lost", "step.timeout", "step.ceiling_expiry", "step.respawned"].includes(e.event))
        .map((e) => e.event);
      assert.deepEqual(
        stream,
        ["step.running", "step.worker_lost", "step.respawned", "step.running"],
        "stream must read step.running → step.worker_lost → step.respawned → step.running",
      );

      // Exactly one step.respawned carrying the prior worker identity.
      const respawned = respawnedEvents(runId);
      assert.equal(respawned.length, 1, "exactly one step.respawned per recovered step");
      const evt = respawned[0];
      assert.equal(evt.runId, runId, "respawned event must carry runId");
      assert.equal(evt.stepId, "dev-step", "respawned event must carry stepId");
      assert.equal(evt.agentId, AGENT, "respawned event must carry agentId");
      assert.equal(evt.priorPid, PRIOR_PID, "priorPid must be the recovered claim_pid");
      assert.equal(evt.priorRound, PRIOR_ROUND, "priorRound must be the recovered claim_job_id");
      assert.equal(evt.reason, "worker_lost", "reason must be the recovery class");
      assert.equal(evt.retry, 1, "retry must be the new retry count");
      assert.ok((evt.detail ?? "").includes("worker_lost"), "detail must mention the recovery event");

      // Existing recovery event still emitted exactly once.
      const workerLost = getRunEvents(runId).filter((e) => e.event === "step.worker_lost");
      assert.equal(workerLost.length, 1, "exactly one step.worker_lost event");
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(rowId);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  it("a first-time claim emits no step.respawned", () => {
    const db = getDb();
    const runId = crypto.randomUUID();
    seedRun(runId);
    const rowId = seedStep(runId, { stepId: "dev-step", status: "pending" });

    try {
      const claim = claimStep(AGENT, runId, { jobId: "job-fresh", pid: 1111, pgid: 1112 });
      assert.equal(claim.found, true, "fresh claim should find the step");
      assert.equal(
        respawnedEvents(runId).length,
        0,
        "no step.respawned on a first-time claim (no recovery involved)",
      );
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(rowId);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  it("story-level recovery (loop step with current_story_id) also emits step.respawned", () => {
    const db = getDb();
    const runId = crypto.randomUUID();
    seedRun(runId);
    const storyId = seedStory(runId);
    const rowId = seedStep(runId, {
      stepId: "fix",
      type: "loop",
      status: "running",
      currentStoryId: storyId,
      loopConfig: JSON.stringify({ over: "stories" }),
      claimPid: PRIOR_PID,
      claimJobId: PRIOR_ROUND,
    });

    try {
      const result = recoverOrphanedStepsForAgent(
        AGENT, runId, 0, undefined, undefined, PRIOR_ROUND, "worker_lost",
      );
      assert.equal(result.recovered, 1, "story-level recovery should recover 1 step");
      assert.equal(result.failed, 0, "story-level recovery should not fail");

      const step = db.prepare(
        "SELECT status, current_story_id, retry_count FROM steps WHERE id = ?",
      ).get(rowId) as { status: string; current_story_id: string | null; retry_count: number };
      assert.equal(step.status, "pending", "loop step should be reset to pending");
      assert.equal(step.current_story_id, null, "current_story_id should be cleared");
      assert.equal(step.retry_count, 0, "story-level recovery must not bump the step retry counter");

      const respawned = respawnedEvents(runId);
      assert.equal(respawned.length, 1, "exactly one step.respawned for story-level recovery");
      const evt = respawned[0];
      assert.equal(evt.stepId, "fix");
      assert.equal(evt.priorPid, PRIOR_PID, "priorPid must be the recovered claim_pid");
      assert.equal(evt.priorRound, PRIOR_ROUND, "priorRound must be the recovered claim_job_id");
      assert.equal(evt.reason, "worker_lost", "reason must be the recovery class");
      assert.equal(evt.retry, 0, "retry must reflect the unchanged step retry_count");

      // Existing recovery + abandonment events still emitted exactly once.
      assert.equal(getRunEvents(runId).filter((e) => e.event === "step.worker_lost").length, 1);
      assert.equal(getRunEvents(runId).filter((e) => e.event === "story.abandoned").length, 1);
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(rowId);
      db.prepare("DELETE FROM stories WHERE id = ?").run(storyId);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  it("step.respawned reason reflects the recovery class (ceiling_expiry / timeout / no_work_release)", () => {
    const db = getDb();
    const runIds: string[] = [];
    const rowIds: string[] = [];

    try {
      // ceiling_expiry: workerJobId-scoped recovery with timedOut=true
      const runA = crypto.randomUUID();
      runIds.push(runA);
      seedRun(runA);
      rowIds.push(seedStep(runA, {
        stepId: "ceiling-step", status: "running", claimPid: 10, claimJobId: "job-ceiling",
      }));
      const resA = recoverOrphanedStepsForAgent(
        AGENT, runA, 0, undefined, undefined, "job-ceiling", "worker_lost",
        undefined, undefined, undefined, undefined, true, // timedOut
      );
      assert.equal(resA.recovered, 1);
      assert.equal(respawnedEvents(runA).length, 1);
      assert.equal(respawnedEvents(runA)[0].reason, "ceiling_expiry");
      assert.equal(getRunEvents(runA).filter((e) => e.event === "step.ceiling_expiry").length, 1);

      // timeout: no workerJobId (stale sweeper / control-plane release)
      const runB = crypto.randomUUID();
      runIds.push(runB);
      seedRun(runB);
      rowIds.push(seedStep(runB, {
        stepId: "timeout-step", status: "running", claimPid: null, claimJobId: null,
      }));
      const resB = recoverOrphanedStepsForAgent(AGENT, runB, 0);
      assert.equal(resB.recovered, 1);
      assert.equal(respawnedEvents(runB).length, 1);
      assert.equal(respawnedEvents(runB)[0].reason, "timeout");
      assert.equal(getRunEvents(runB).filter((e) => e.event === "step.timeout").length, 1);

      // no_work_release: dangling-claim release after a NO_WORK round
      const runC = crypto.randomUUID();
      runIds.push(runC);
      seedRun(runC);
      rowIds.push(seedStep(runC, {
        stepId: "nowork-step", status: "running", claimPid: 30, claimJobId: "job-nowork",
      }));
      const resC = recoverOrphanedStepsForAgent(
        AGENT, runC, 0, undefined, undefined, "job-nowork", "no_work_release",
      );
      assert.equal(resC.recovered, 1);
      assert.equal(respawnedEvents(runC).length, 1);
      assert.equal(respawnedEvents(runC)[0].reason, "no_work_release");
      // The recovery event itself is still worker_lost (no_work is a
      // subclass of worker loss for the existing event vocabulary).
      assert.equal(getRunEvents(runC).filter((e) => e.event === "step.worker_lost").length, 1);
    } finally {
      for (const rowId of rowIds) db.prepare("DELETE FROM steps WHERE id = ?").run(rowId);
      for (const runId of runIds) db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  it("does not emit step.respawned when retries are exhausted (step fails instead of re-dispatch)", () => {
    const db = getDb();
    const runId = crypto.randomUUID();
    seedRun(runId);
    const rowId = seedStep(runId, {
      stepId: "exhausted", status: "running", retryCount: 2, maxRetries: 2,
      claimPid: 55, claimJobId: "job-ex",
    });

    try {
      const result = recoverOrphanedStepsForAgent(AGENT, runId, 0);
      assert.equal(result.failed, 1, "exhausted retries should fail the step");
      assert.equal(result.recovered, 0);
      assert.equal(
        respawnedEvents(runId).length,
        0,
        "no step.respawned when the step fails instead of being re-pended",
      );
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(rowId);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });
});
