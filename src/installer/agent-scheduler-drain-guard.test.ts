/**
 * PAUSE-DRAIN (bead 6sy.83) — dispatch-guard regression net.
 *
 * `tamandua workflow pause <run> --drain` records a pending drain on the run
 * (`scheduling_status='draining_pause'` plus the durable `pause_drain`
 * run-context marker) and lets the in-flight work round finish before the run
 * pauses. The daemon re-admits every running run on each step completion
 * (POST /control/nudge → handleRegisterRun), which used to reset
 * `scheduling_status` back to 'active' and re-launch a round — so a
 * multi-step pipeline (implement → verify → test) kept advancing and never
 * reached paused.
 *
 * These tests drive the REAL `executeDispatchRound` / `nudgeScheduledRuns`:
 *
 *  AC1  scheduling_status='draining_pause' ⇒ no peek/claim/spawn.
 *  AC2  the nudge shape (scheduling_status clobbered to 'active' but the
 *       `pause_drain` marker still set) is gated too, so a completion/nudge
 *       triggered round cannot bypass a pending drain.
 *  AC3  a pending drain with an in-flight step finalizes to paused with
 *       exactly one run.paused when the in-flight session ends, charging no
 *       retry (retry_count unchanged, no step.worker_lost).
 *  AC4  the existing non-drain pause and normal dispatch behaviour is pinned
 *       in step-ops/control-server tests; here a control run with no drain
 *       still spawns normally.
 */
import assert from "node:assert/strict";
import { describe, it, afterEach, beforeEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  executeDispatchRound,
  nudgeScheduledRuns,
  setupAgentCrons,
  shutdownAllCrons,
  settleRunInFlightRounds,
} from "../../dist/installer/agent-scheduler.js";
import { getDb } from "../../dist/db.js";
import { getRunEvents } from "../../dist/installer/events.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";

interface DrainFixture {
  runId: string;
  jobId: string;
  workdir: string;
  marker: string;
}

const WORKFLOW_ID = "test-wf";
const MARKER_ENV = "DRAIN_SPAWN_MARKER";

describe("PAUSE-DRAIN dispatch guard (6sy.83)", () => {
  let tempHome: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-drain-guard-");
    const stateDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    saved = {
      HOME: process.env.HOME,
      TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
      TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
      TAMANDUA_PI_BINARY: process.env.TAMANDUA_PI_BINARY,
      TAMANDUA_HARNESS_PROBE: process.env.TAMANDUA_HARNESS_PROBE,
      [MARKER_ENV]: process.env[MARKER_ENV],
    };
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    // The fake harness never answers a launch-time probe prompt; disable the
    // probe exactly as the other scheduler tests do.
    process.env.TAMANDUA_HARNESS_PROBE = "0";
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(stateDir, "tamandua.db"), "agent-scheduler-drain-guard"),
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

  /**
   * Seed a running run with the requested scheduling status/context, an
   * in-flight (running) step and/or a pending step, and a fake pi harness
   * that writes a marker if the scheduler ever spawns it.
   */
  function seedRun(opts: {
    schedulingStatus: string | null;
    pauseDrainMarker?: boolean;
    contextExtra?: Record<string, string>;
    runningStep?: boolean;
    pendingStep?: boolean;
  }): DrainFixture {
    const db = getDb();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });
    const marker = path.join(tempHome, `spawn-${runId}.marker`);

    const context: Record<string, string> = {
      working_directory_for_harness: workdir,
      ...(opts.contextExtra ?? {}),
    };
    if (opts.pauseDrainMarker) context.pause_drain = "true";

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-guard task', 'running', ?, 0, ?, ?, ?)",
    ).run(runId, WORKFLOW_ID, JSON.stringify(context), opts.schedulingStatus, now, now);

    if (opts.runningStep) {
      db.prepare(
        "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 'implement', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'running', 0, 3, ?, ?)",
      ).run(`${runId}-running`, runId, now, now);
    }
    if (opts.pendingStep) {
      db.prepare(
        "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 'verify', 'test-wf_test-agent', 1, 'do work', 'STATUS', 'pending', 0, 3, ?, ?)",
      ).run(`${runId}-pending`, runId, now, now);
    }

    // Fake pi harness: proves a spawn happened.
    const fakePi = path.join(tempHome, `pi-${runId}`);
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(process.env.${MARKER_ENV}, "spawned");
process.exit(0);
`,
      { mode: 0o755 },
    );
    process.env.TAMANDUA_PI_BINARY = fakePi;
    process.env[MARKER_ENV] = marker;

    return { runId, jobId: `tamandua-${WORKFLOW_ID}-${runId}-test-agent`, workdir, marker };
  }

  function makeAgent() {
    return { id: "test-agent", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 5 };
  }

  function makeJob(f: DrainFixture) {
    return {
      id: f.jobId,
      workflowId: WORKFLOW_ID,
      runId: f.runId,
      agentId: "test-wf_test-agent",
      harnessType: "pi" as const,
      workingDirectoryForHarness: f.workdir,
      createdAt: "",
    };
  }

  function stepRow(runId: string, stepId: string) {
    return getDb()
      .prepare("SELECT status, claim_job_id, retry_count FROM steps WHERE run_id = ? AND step_id = ?")
      .get(runId, stepId) as
      | { status: string; claim_job_id: string | null; retry_count: number }
      | undefined;
  }

  function pauseEvents(runId: string): number {
    return getRunEvents(runId).filter((e) => e.event === "run.paused").length;
  }

  it("AC1: executeDispatchRound does not peek/claim/spawn on a draining_pause run", async () => {
    const f = seedRun({
      schedulingStatus: "draining_pause",
      pauseDrainMarker: true,
      runningStep: true,
      pendingStep: true,
    });

    await executeDispatchRound(makeJob(f), makeAgent());

    assert.ok(!fs.existsSync(f.marker), "no harness may be spawned while a drain is pending");
    assert.equal(stepRow(f.runId, "verify")!.status, "pending", "the downstream step must stay unclaimed");
    assert.equal(stepRow(f.runId, "verify")!.claim_job_id, null, "no claim may be taken");
    const run = getDb()
      .prepare("SELECT status, scheduling_status FROM runs WHERE id = ?")
      .get(f.runId) as { status: string; scheduling_status: string };
    assert.equal(run.status, "running", "the in-flight step keeps the run running");
    assert.equal(run.scheduling_status, "draining_pause", "the drain stays pending");
    assert.equal(pauseEvents(f.runId), 0, "no pause while a step is in flight");
  });

  it("AC2: a nudge-shaped round (scheduling_status clobbered to active, marker still set) is gated", async () => {
    const f = seedRun({
      // Exactly the state the old /control/nudge → handleRegisterRun path left
      // behind: status reset to active while the drain marker persists.
      schedulingStatus: "active",
      pauseDrainMarker: true,
      runningStep: true,
      pendingStep: true,
    });

    await executeDispatchRound(makeJob(f), makeAgent());

    assert.ok(!fs.existsSync(f.marker), "a nudge-triggered round must honor the pending drain marker");
    assert.equal(stepRow(f.runId, "verify")!.status, "pending", "pipeline must not advance");
  });

  it("AC2b: nudgeScheduledRuns does not advance a pending-drain run", async () => {
    const f = seedRun({
      schedulingStatus: "active",
      pauseDrainMarker: true,
      runningStep: true,
      pendingStep: true,
    });
    const workflow = {
      id: WORKFLOW_ID,
      agents: [{ id: "test-agent", model: "fake", workspace: { baseDir: "." } }],
      steps: [{ id: "verify", agent: "test-agent", input: "do work", expects: "STATUS" }],
    };
    await setupAgentCrons(workflow as never, f.runId, { workingDirectoryForHarness: f.workdir });

    await nudgeScheduledRuns([f.runId], {
      loadWorkflowSpec: async () => workflow as never,
    });
    // Let the fire-and-forget round register its in-flight mark, then settle.
    await sleep(100);
    await settleRunInFlightRounds(f.runId, { graceMs: 1_000 });
    await sleep(50);

    assert.ok(!fs.existsSync(f.marker), "nudge-launched round must honor the pending drain marker");
    assert.equal(stepRow(f.runId, "verify")!.status, "pending", "pipeline must not advance");
  });

  it("AC3: a pending drain with an in-flight step finalizes to paused when the session ends, charging no retry", async () => {
    const f = seedRun({
      schedulingStatus: "draining_pause",
      pauseDrainMarker: true,
      runningStep: true,
      pendingStep: true,
    });

    // Drain pending + in-flight step: the guard must NOT finalize yet.
    await executeDispatchRound(makeJob(f), makeAgent());
    let run = getDb()
      .prepare("SELECT status, scheduling_status FROM runs WHERE id = ?")
      .get(f.runId) as { status: string; scheduling_status: string };
    assert.equal(run.status, "running", "the in-flight session is allowed to finish");
    assert.equal(run.scheduling_status, "draining_pause", "drain still pending");
    assert.equal(pauseEvents(f.runId), 0, "no run.paused while the step is in flight");
    assert.equal(stepRow(f.runId, "implement")!.retry_count, 0, "retry_count starts at 0");

    // The in-flight session ends (the step completes as a normal CLI
    // completion would, without charging a retry).
    getDb()
      .prepare("UPDATE steps SET status = 'done', updated_at = ? WHERE run_id = ? AND step_id = 'implement'")
      .run(new Date().toISOString(), f.runId);

    // Any subsequent dispatch entry (timer tick or completion nudge) finalizes.
    await executeDispatchRound(makeJob(f), makeAgent());

    run = getDb()
      .prepare("SELECT status, scheduling_status FROM runs WHERE id = ?")
      .get(f.runId) as { status: string; scheduling_status: string };
    assert.equal(run.status, "paused", "the run finalizes to paused once the last session ends");
    assert.equal(run.scheduling_status, "paused", "scheduling_status follows the pause");
    assert.equal(pauseEvents(f.runId), 1, "exactly one run.paused is emitted");

    const implement = stepRow(f.runId, "implement")!;
    assert.equal(implement.status, "done", "the completed step is untouched");
    assert.equal(implement.retry_count, 0, "a drain pause must never charge a retry");
    const events = getRunEvents(f.runId).map((e) => e.event);
    assert.ok(!events.includes("step.worker_lost"), "a drain pause is not a worker loss");

    // Idempotency: a second finalization attempt emits nothing more.
    await executeDispatchRound(makeJob(f), makeAgent());
    assert.equal(pauseEvents(f.runId), 1, "finalization is idempotent");
  });

  it("AC4 control: without a drain a pending step dispatches normally", async () => {
    const f = seedRun({
      schedulingStatus: "active",
      pendingStep: true,
    });

    await executeDispatchRound(makeJob(f), makeAgent());

    // The fake harness ran (proving the guard only fires on a pending drain)
    // and the run was not flipped to paused.
    assert.ok(fs.existsSync(f.marker), "a normal run still spawns its harness");
    const run = getDb()
      .prepare("SELECT status, scheduling_status FROM runs WHERE id = ?")
      .get(f.runId) as { status: string; scheduling_status: string };
    assert.notEqual(run.status, "paused", "a non-drain run is never paused by dispatch");
    assert.equal(pauseEvents(f.runId), 0, "no run.paused for a non-drain run");
  });
});
