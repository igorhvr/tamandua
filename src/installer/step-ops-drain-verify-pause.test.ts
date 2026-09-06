import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { getDb, closeDb } from "../../dist/db.js";
import { completeStep, claimStep, finalizeDrainingPause, setRunContextKey, removeRunContextKey } from "../../dist/installer/step-ops.js";
import { getRunEvents } from "../../dist/installer/events.js";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";

// ── DRVP (US-003) drain-verify-pause regressions ─────────────────────
// R4a (2026-09-05): a drain requested while the FINAL verify_each round was
// in flight left the run running/draining_pause with zero running steps and
// a downstream pending step the drain never dispatched. Routing evidence
// (/home/igorhvr/idm/tamandua/torture-test/var/review-logs/
//   drain-verify-pause.wdEWpm/actual-routing-evidence.jsonl) shows the
// successful final-verify chain (handleVerifyEachCompletion →
// checkLoopContinuation → advancePipeline) returns without the missing
// finalization call when a downstream waiting step exists, while the
// terminal pipeline-routing control DOES call it. These tests drive the
// BUILT product (dist) — completeStep on the verify step of a real
// verify_each layout, finalizeDrainingPause, claimStep, and the real
// resume drain-cancel DB section — and assert:
//   1) draining run + final verify completes + downstream waiting step →
//      run.status/scheduling_status 'paused', exactly one run.paused event,
//      final verification report retained on the verify step row, downstream
//      step still pending (no claim while paused);
//   2) non-draining run, same completion → stays running, no run.paused;
//   3) still-in-flight (a running story step remains) → not finalized;
//   4) resume-cancels-drain → the cancelled drain never pauses the run and
//      the downstream pending step is claimable (dispatches normally);
//   5) terminal-state controls → completed/failed/canceled runs are never
//      flipped to paused by any drain-finalization call.

// ── Sticky isolation env ─────────────────────────────────────────────
// completeStep / claimStep fire fire-and-forget continuations (emitEvent →
// fireWebhook → getDb; nudgeDispatch → controlRequest; scheduleRunCronTeardown
// → import() → removeRunCrons) that resolve DB paths AFTER the triggering
// test's afterEach has run. Keep HOME / TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH
// pointed at a module-scoped temp dir for the whole file: every afterEach
// restores to this sticky env (never the operator's), and the module after()
// drains pending setImmediates before restoring the originals
// (step-ops-verify-each-eligibility.test.ts pattern). The ambient control
// port is dropped too so controlRequest's early guard return fires instead
// of ever reaching a live daemon.
const stickyState = (() => {
  const root = tamanduaTempDir("tamandua-drvp-sticky-");
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, homeDir, stateDir, dbPath: path.join(stateDir, "tamandua.db") };
})();
const originalHome = process.env.HOME;
const originalStateDir = process.env.TAMANDUA_STATE_DIR;
const originalDbPath = process.env.TAMANDUA_DB_PATH;
const originalControlPort = process.env.TAMANDUA_CONTROL_PORT;

function restoreOrDelete(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function applyStickyEnv(): void {
  process.env.HOME = stickyState.homeDir;
  process.env.TAMANDUA_STATE_DIR = stickyState.stateDir;
  process.env.TAMANDUA_DB_PATH = stickyState.dbPath;
  // Drop the ambient control port (3339 when the suite runs inside a
  // tamandua run): with HOME temp but TAMANDUA_CONTROL_PORT still set,
  // controlRequest would resolve the daemon secret from the temp HOME, pass
  // the guard, and reach a live daemon on that port.
  delete process.env.TAMANDUA_CONTROL_PORT;
}

after(async () => {
  // Drain a few event-loop turns while the sticky temp env is still active:
  // the fire-and-forget continuations scheduled by the last test must
  // resolve their getDb/logger paths against the temp state, not the real
  // ~/.tamandua.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  restoreOrDelete("HOME", originalHome);
  restoreOrDelete("TAMANDUA_STATE_DIR", originalStateDir);
  restoreOrDelete("TAMANDUA_DB_PATH", originalDbPath);
  restoreOrDelete("TAMANDUA_CONTROL_PORT", originalControlPort);
  try {
    closeDb();
  } catch {
    // best-effort
  }
  try {
    fs.rmSync(stickyState.root, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ── Fixtures ─────────────────────────────────────────────────────────
const VERIFY_EACH_EXPECTS = "regex:^STATUS:\\s*(done|retry)\\s*$";

const DEV_AGENT = "fdmw_developer";
const VERIFIER_AGENT = "fdmw_verifier";
const TESTER_AGENT = "fdmw_tester";

const WORKFLOW_ID = "feature-dev-merge-worktree";

function ts(): string {
  return new Date().toISOString();
}

interface SeededDrainRun {
  runId: string;
  loopStepId: string;
  verifyStepId: string;
  testStepId: string;
  storyId: string;
}

/**
 * Seed the R4a hang shape in the isolated DB: a run whose final verify_each
 * round is in flight when the drain was requested.
 *
 *   runs:    status 'running', scheduling_status 'draining_pause',
 *            context carries the pause_drain marker (control-server
 *            handlePauseRun attribution keys).
 *   steps:   implement loop (idx 3) parked 'running' (current_story NULL,
 *            verify_each → its verify is the designated verifier),
 *            verify (idx 4) 'running' (the in-flight round that completes),
 *            test (idx 5) 'waiting' (downstream of the loop).
 *   stories: US-001 'done' (implementation done; the running verify is
 *            verifying it — the FINAL story, so no story stays pending).
 *
 * When the verify completes with STATUS: done, checkLoopContinuation marks
 * the loop+verify done and advancePipeline promotes the downstream test step
 * to pending — with no running step left, the drain must finalize to paused
 * (this was the missing call — R4a).
 */
function seedDrainVerifyRun(opts: {
  schedulingStatus?: string | null;
  runStatus?: string;
  drainMarker?: boolean;
  loopStatus?: string;
  verifyStatus?: string;
  testStatus?: string;
  testStepPresent?: boolean;
} = {}): SeededDrainRun {
  const db = getDb();
  const runId = crypto.randomUUID();
  const loopStepId = crypto.randomUUID();
  const verifyStepId = crypto.randomUUID();
  const testStepId = crypto.randomUUID();
  const storyId = crypto.randomUUID();
  const now = ts();

  const runStatus = opts.runStatus ?? "running";
  const schedulingStatus = opts.schedulingStatus === undefined ? "draining_pause" : opts.schedulingStatus;
  const drainMarker = opts.drainMarker ?? true;
  const context = JSON.stringify({
    task: "DRVP drain-verify-pause",
    ...(drainMarker
      ? {
          pause_drain: "true",
          paused_by: "drain-operator@host",
          paused_at: now,
        }
      : {}),
  });

  db.prepare(
    "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, 1, ?, 'DRVP drain-verify-pause', ?, ?, 0, ?, ?, ?)",
  ).run(runId, WORKFLOW_ID, runStatus, context, schedulingStatus, now, now);

  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, current_story_id, created_at, updated_at)
     VALUES (?, ?, 'implement', ?, 3, '{{task}}\\n{{verify_feedback}}\\n{{retry_feedback}}', '', ?, 0, 4, 'loop', ?, NULL, ?, ?)`,
  ).run(
    loopStepId,
    runId,
    DEV_AGENT,
    opts.loopStatus ?? "running",
    JSON.stringify({ verify_each: true, verify_step: "verify", over: "stories" }),
    now,
    now,
  );

  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at)
     VALUES (?, ?, 'verify', ?, 4, 'Verify the developer work.\\n{{retry_feedback}}', ?, ?, 0, 4, 'single', ?, ?)`,
  ).run(
    verifyStepId,
    runId,
    VERIFIER_AGENT,
    VERIFY_EACH_EXPECTS,
    opts.verifyStatus ?? "running",
    now,
    now,
  );

  if (opts.testStepPresent ?? true) {
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'test', ?, 5, 'Run the test command.', '', ?, 0, 4, 'single', ?, ?)`,
    ).run(testStepId, runId, TESTER_AGENT, opts.testStatus ?? "waiting", now, now);
  }

  db.prepare(
    "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 0, 'US-001', 'Drain story', 'desc', '[]', 'done', 0, 3, ?, ?)",
  ).run(storyId, runId, now, now);

  return { runId, loopStepId, verifyStepId, testStepId, storyId };
}

function runRow(runId: string): { status: string; scheduling_status: string | null; context: string } {
  const row = getDb()
    .prepare("SELECT status, scheduling_status, context FROM runs WHERE id = ?")
    .get(runId) as { status: string; scheduling_status: string | null; context: string } | undefined;
  assert.ok(row, `run row ${runId} must exist`);
  return row;
}

function stepRow(runId: string, stepIdCol: string, id: string): { status: string; output: string | null } {
  const row = getDb()
    .prepare("SELECT status, output FROM steps WHERE id = ?")
    .get(id) as { status: string; output: string | null } | undefined;
  assert.ok(row, `step row ${stepIdCol} must exist`);
  return row;
}

function runPausedEvents(runId: string): Array<{ event: string; runId: string; workflowId: string }> {
  return getRunEvents(runId).filter((e) => e.event === "run.paused");
}

describe("DRVP: finalize drain pause on successful final-verify completion", () => {
  let tempHome: string;
  let stateDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-drvp-");
    stateDir = path.join(tempHome, ".tamandua");
    dbPath = path.join(stateDir, "tamandua.db");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = dbPath;
    assert.doesNotThrow(() =>
      assertStatePathIsolation(dbPath, "step-ops-drain-verify-pause"),
    );
  });

  afterEach(() => {
    // Restore to the module-scoped sticky temp env (NOT the operator's real
    // env): terminal/failure/advanced completions fire fire-and-forget
    // continuations (scheduleRunCronTeardown → import() → removeRunCrons;
    // emitEvent → fireWebhook → getDb; nudgeDispatch → controlRequest) that
    // resolve DB paths after this hook; pointing them at the real
    // ~/.tamandua trips the test-isolation guard.
    applyStickyEnv();
    try {
      closeDb();
    } catch {
      // best-effort
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("final verify completing during a drain finalizes the pause (R4a hang shape)", () => {
    const ids = seedDrainVerifyRun({});
    const { runId, verifyStepId, loopStepId, testStepId } = ids;

    // Control A — still-in-flight: while the verify round is running (the
    // drain was requested with the verifier harness in flight), the drain is
    // NOT finalized (the running verify is in-flight work). This mirrors the
    // immediate finalizeDrainingPause call control-server handlePauseRun
    // makes at drain-request time.
    finalizeDrainingPause(runId);
    let row = runRow(runId);
    assert.equal(row.status, "running", "drain must wait for the in-flight verify");
    assert.equal(row.scheduling_status, "draining_pause", "drain stays pending while in-flight");
    assert.equal(runPausedEvents(runId).length, 0, "no run.paused while in-flight");

    // The final verify completes: story verified, loop done, verify done, the
    // downstream test step promoted to pending. With zero running steps left,
    // the verify_each completion path must now finalize the drain.
    const result = completeStep(verifyStepId, "STATUS: done");
    assert.equal(result.status, "advanced");

    // Run finalized: status + scheduling_status paused.
    row = runRow(runId);
    assert.equal(row.status, "paused", "run must finalize to paused after the final verify");
    assert.equal(row.scheduling_status, "paused", "scheduling_status must be paused");

    // Exactly one run.paused event carrying the run/workflow identity.
    const paused = runPausedEvents(runId);
    assert.equal(paused.length, 1, "exactly one run.paused event");
    assert.equal(paused[0]!.runId, runId);
    assert.equal(paused[0]!.workflowId, WORKFLOW_ID);

    // Exactly one story.verified for the final story (normal done progression).
    const verified = getRunEvents(runId).filter((e) => e.event === "story.verified" && e.stepId === "verify");
    assert.equal(verified.length, 1, "the final story verifies exactly once");

    // Loop done; verify done with the RAW final report retained.
    assert.equal(stepRow(runId, "implement", loopStepId).status, "done");
    const verify = stepRow(runId, "verify", verifyStepId);
    assert.equal(verify.status, "done", "verify step reaches done");
    assert.equal(verify.output, "STATUS: done", "final verification report retained on the verify row");

    // Downstream step promoted to pending but NEVER dispatched under the
    // drain/pause — claimStep finds nothing while the run is paused.
    const test = stepRow(runId, "test", testStepId);
    assert.equal(test.status, "pending", "downstream step is pending (no dispatch under drain)");
    const claim = claimStep(TESTER_AGENT, runId);
    assert.equal(claim.found, false, "no downstream dispatch while paused");
    assert.equal(stepRow(runId, "test", testStepId).status, "pending", "downstream stays pending");

    // The pause_drain attribution marker is preserved on the paused run so
    // operators can see how the pause came about.
    const ctx = JSON.parse(row.context) as Record<string, string>;
    assert.equal(ctx.pause_drain, "true");
  });

  it("same completion on a non-draining run keeps the run running with no run.paused", () => {
    const ids = seedDrainVerifyRun({ schedulingStatus: null, drainMarker: false });
    const { runId, verifyStepId, testStepId } = ids;

    const result = completeStep(verifyStepId, "STATUS: done");
    assert.equal(result.status, "advanced");

    const row = runRow(runId);
    assert.equal(row.status, "running", "non-draining run stays running");
    assert.equal(runPausedEvents(runId).length, 0, "no run.paused for a non-draining run");

    // The pipeline advanced normally: the downstream step is pending and — the
    // run being running — IS claimable (dispatches normally).
    const test = stepRow(runId, "test", testStepId);
    assert.equal(test.status, "pending", "downstream step promoted to pending");
    const claim = claimStep(TESTER_AGENT, runId);
    assert.equal(claim.found, true, "downstream step dispatches normally in a running run");
    assert.equal(claim.stepId, testStepId);
    assert.equal(stepRow(runId, "test", testStepId).status, "running", "claim moves the downstream step to running");
  });

  it("still-in-flight: a running story step keeps the drain from finalizing", () => {
    // Drain requested while a STORY is being implemented: the loop step is
    // running WITH a current story (the in-flight implementation harness).
    const ids = seedDrainVerifyRun({
      verifyStatus: "pending",
      testStatus: "waiting",
    });
    const { runId, loopStepId, storyId } = ids;
    const db = getDb();
    db.prepare("UPDATE steps SET current_story_id = ? WHERE id = ?").run(storyId, loopStepId);
    db.prepare("UPDATE stories SET status = 'running' WHERE id = ?").run(storyId);

    // Mirror the immediate finalizeDrainingPause call handlePauseRun makes at
    // drain-request time: the running story step is in-flight → no finalize.
    finalizeDrainingPause(runId);
    const row = runRow(runId);
    assert.equal(row.status, "running", "run stays running while a story step is in flight");
    assert.equal(row.scheduling_status, "draining_pause", "drain stays pending while in flight");
    assert.equal(runPausedEvents(runId).length, 0, "no run.paused while a story step is in flight");
  });

  it("resume-cancels-drain: a cancelled drain never pauses the run; the downstream step dispatches", () => {
    const ids = seedDrainVerifyRun({});
    const { runId, verifyStepId, testStepId } = ids;

    // A plain resume lands while the drain is still pending (verify in
    // flight). handleResumeRun's drain-cancel path synchronously flips the
    // run out of draining_pause and clears the pause_drain marker before
    // admission — reproduce those two product statements verbatim (the
    // UPDATE + removeRunContextKey from src/server/control-server.ts
    // handleResumeRun; full admission needs the daemon, which the US-004
    // scripted e2e covers through the real motor).
    const now = ts();
    getDb()
      .prepare(
        "UPDATE runs SET status = 'running', scheduling_status = 'pending_register', scheduling_requested_at = ?, scheduling_error = NULL, updated_at = datetime('now') WHERE id = ?",
      )
      .run(now, runId);
    removeRunContextKey(runId, "pause_drain");
    assert.notEqual(runRow(runId).scheduling_status, "draining_pause", "resume cancels the pending drain");
    const ctx = JSON.parse(runRow(runId).context) as Record<string, string>;
    assert.ok(!("pause_drain" in ctx), "pause_drain marker cleared by resume");

    // The verify then completes: the drain is gone, so the completion must NOT
    // pause the run — the downstream pending step dispatches normally.
    const result = completeStep(verifyStepId, "STATUS: done");
    assert.equal(result.status, "advanced");
    const row = runRow(runId);
    assert.equal(row.status, "running", "a cancelled drain must never pause the run on completion");
    assert.notEqual(row.scheduling_status, "paused");
    assert.equal(runPausedEvents(runId).length, 0, "no run.paused after resume cancelled the drain");

    const test = stepRow(runId, "test", testStepId);
    assert.equal(test.status, "pending", "downstream step promoted to pending");
    const claim = claimStep(TESTER_AGENT, runId);
    assert.equal(claim.found, true, "downstream step dispatches normally after resume");
    assert.equal(stepRow(runId, "test", testStepId).status, "running");
  });

  it("terminal-state controls: completed/failed/canceled runs are never flipped to paused", () => {
    // Even a defensive state where a terminal run still carries a leftover
    // draining_pause scheduling_status (worst-case call ordering) must never
    // be flipped to paused by finalizeDrainingPause — with NO in-flight step
    // left, only the terminal-status guard can stop the flip.
    for (const terminalStatus of ["completed", "failed", "canceled"]) {
      const ids = seedDrainVerifyRun({
        runStatus: terminalStatus,
        schedulingStatus: "draining_pause",
        drainMarker: false,
        loopStatus: "done",
        verifyStatus: "waiting",
        testStatus: "waiting",
      });
      const { runId } = ids;

      finalizeDrainingPause(runId);

      const row = runRow(runId);
      assert.equal(
        row.status,
        terminalStatus,
        `${terminalStatus} run must stay ${terminalStatus} — never paused`,
      );
      assert.equal(runPausedEvents(runId).length, 0, `no run.paused for a ${terminalStatus} run`);
    }

    // Completion-path terminal control: a draining run whose FINAL verify
    // completes with NO downstream step left completes the pipeline — the run
    // reaches 'completed' (a terminal outcome) and is never flipped to paused
    // by any drain-finalization call.
    const completingIds = seedDrainVerifyRun({ testStepPresent: false });
    const completingResult = completeStep(completingIds.verifyStepId, "STATUS: done");
    assert.equal(completingResult.status, "completed", "pipeline completes with no downstream step");
    const completingRow = runRow(completingIds.runId);
    assert.equal(completingRow.status, "completed", "run reaches completed — never paused");
    assert.notEqual(completingRow.scheduling_status, "paused");
    assert.equal(runPausedEvents(completingIds.runId).length, 0, "no run.paused for the completed run");

    // Completion-path control: completeStep on a failed run is blocked before
    // any routing/finalization runs, so a terminal run can never be advanced
    // or paused by a completion either.
    const failedIds = seedDrainVerifyRun({
      runStatus: "failed",
      schedulingStatus: "draining_pause",
      drainMarker: false,
      verifyStatus: "running",
    });
    const result = completeStep(failedIds.verifyStepId, "STATUS: done");
    assert.equal(result.status, "blocked", "completion on a failed run is blocked");
    assert.equal(runRow(failedIds.runId).status, "failed", "run stays failed");
    assert.equal(runPausedEvents(failedIds.runId).length, 0, "no run.paused from a blocked completion");
  });
});
