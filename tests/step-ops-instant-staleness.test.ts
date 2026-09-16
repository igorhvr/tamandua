/**
 * TIME-CLOCKS US-008 — step-ops durable staleness/lease age filters.
 *
 * The step claim/abandonment/recovery paths used to age rows with SQL
 * `julianday('now') - julianday(updated_at)` arithmetic and a wall-clock
 * throttle. This suite pins the replacement contract:
 *
 *   1. `recoverOrphanedStepsForAgent` ages `updated_at` via `instantAgeMs`
 *      against an INJECTED now, so a forward wall jump can make a fresh step
 *      look stale and a backward jump can make an old step look fresh — the
 *      numeric age is exactly what the injected clock says it is.
 *   2. The original `>= ?` threshold semantics are preserved
 *      (`staleThresholdMs = 0` still recovers every running step).
 *   3. Unparseable/missing instants are NEVER stale (no false recovery).
 *   4. `cleanupAbandonedSteps` routes step and story ages through
 *      `isOlderThan` and accepts an injected now.
 *   5. `checkRunningWorkersLiveness` ages `claim_updated_at` via
 *      `instantAgeMs` with an injected now.
 *   6. The cleanup throttle is a monotonic interval with a first-call
 *      guarantee, and the source no longer contains SQL julianday arithmetic.
 *
 * Serial-lane file: importing any export of dist/installer/step-ops.js reaches
 * its `node:child_process` dependency, so it is listed in tests/serial-files.txt.
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTempHome } from "./helpers/test-env.ts";
import {
  ABANDONED_THRESHOLD_MS,
  _resetCleanupThrottleForTest,
  _shouldRunCleanupForTest,
  checkRunningWorkersLiveness,
  cleanupAbandonedSteps,
  recoverOrphanedStepsForAgent,
} from "../dist/installer/step-ops.js";
import { getDb } from "../dist/db.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Fixed durable instants so the injected `now` fully determines the age. */
const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");
const BASE_ISO = new Date(BASE_MS).toISOString();
const MINUTE_MS = 60 * 1000;

describe("step-ops instant staleness (TIME-CLOCKS US-008)", () => {
  const th = createTempHome("tamandua-us008-");
  const saved = {
    HOME: process.env.HOME,
    TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
    TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
    TAMANDUA_CONTROL_PORT: process.env.TAMANDUA_CONTROL_PORT,
  };

  // Recovery paths fire fire-and-forget continuations (event emission, suite
  // claim release, cron teardown) that resolve the state dir AFTER a test's
  // hooks run. Keep the process pointed at the module temp home for the whole
  // file (dead-worker-recovery.test.ts sticky-env pattern).
  function applyStickyEnv(): void {
    process.env.HOME = th.homeDir;
    process.env.TAMANDUA_STATE_DIR = th.tamanduaDir;
    process.env.TAMANDUA_DB_PATH = path.join(th.tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_CONTROL_PORT = "1"; // dead control plane — nudges no-op
  }

  beforeEach(applyStickyEnv);
  afterEach(applyStickyEnv);

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { fs.rmSync(th.root, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  function seedRun(status = "running"): string {
    const db = getDb();
    const runId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-us008', 'task', ?, '{}', 0, ?, ?)",
    ).run(runId, status, BASE_ISO, BASE_ISO);
    return runId;
  }

  function seedStep(opts: {
    runId: string;
    agentId: string;
    updatedAt: string;
    claimUpdatedAt?: string | null;
    claimPgid?: number | null;
    claimJobId?: string | null;
    type?: string;
    status?: string;
  }): string {
    const db = getDb();
    const stepId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
         retry_count, max_retries, type, claim_pid, claim_pgid, claim_job_id, claim_updated_at, created_at, updated_at)
       VALUES (?, ?, 'work', ?, 0, 'work', '', ?, 0, 4, ?, NULL, ?, ?, ?, ?, ?)`,
    ).run(
      stepId,
      opts.runId,
      opts.agentId,
      opts.status ?? "running",
      opts.type ?? "single",
      opts.claimPgid ?? null,
      opts.claimJobId ?? null,
      opts.claimUpdatedAt ?? null,
      BASE_ISO,
      opts.updatedAt,
    );
    return stepId;
  }

  function seedStory(runId: string, updatedAt: string, status = "running"): string {
    const db = getDb();
    const storyRowId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at)
       VALUES (?, ?, 0, 'US-001', 't', 'd', '[]', ?, 0, 4, ?, ?)`,
    ).run(storyRowId, runId, status, BASE_ISO, updatedAt);
    return storyRowId;
  }

  function stepRow(stepId: string): { status: string; retry_count: number } {
    return getDb().prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(stepId) as {
      status: string;
      retry_count: number;
    };
  }

  function storyRow(storyRowId: string): { status: string } {
    return getDb().prepare("SELECT status FROM stories WHERE id = ?").get(storyRowId) as {
      status: string;
    };
  }

  /** Call the 13-parameter recovery entry point with only the fields this test needs. */
  function recoverAt(
    agentId: string,
    runId: string,
    staleThresholdMs: number | undefined,
    nowMs: number,
  ): { recovered: number; failed: number; skipped: number } {
    return recoverOrphanedStepsForAgent(
      agentId,
      runId,
      staleThresholdMs,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      nowMs,
    );
  }

  // ── recoverOrphanedStepsForAgent: injected wall jumps ────────────────

  it("forward wall jump makes a step cross the stale threshold (injected now)", () => {
    const runId = seedRun();
    const stepId = seedStep({ runId, agentId: "us008_fwd", updatedAt: BASE_ISO });

    // At BASE the step is brand new: not stale.
    const atBase = recoverAt("us008_fwd", runId, 5 * MINUTE_MS, BASE_MS);
    assert.equal(atBase.recovered, 0, "a just-created step must not be stale at its own instant");
    assert.equal(stepRow(stepId).status, "running");

    // A +10 minute forward wall jump ages the same stored instant past 5 min.
    const forward = recoverAt("us008_fwd", runId, 5 * MINUTE_MS, BASE_MS + 10 * MINUTE_MS);
    assert.equal(forward.recovered, 1, "forward jump must make the step stale");
    assert.equal(stepRow(stepId).status, "pending", "stale step is requeued");
    assert.equal(stepRow(stepId).retry_count, 1, "requeue bumps retry_count exactly once");
  });

  it("backward wall jump cannot make a genuinely old step stale (injected now)", () => {
    const runId = seedRun();
    const realOldIso = new Date(BASE_MS - 60 * MINUTE_MS).toISOString();
    const stepId = seedStep({ runId, agentId: "us008_back", updatedAt: realOldIso });

    // Injected now is BEFORE the stored instant => negative age => not stale.
    // The old julianday SQL would have used real wall time and recovered this.
    const backward = recoverAt("us008_back", runId, 5 * MINUTE_MS, BASE_MS - 120 * MINUTE_MS);
    assert.equal(backward.recovered, 0, "backward jump must not make an instant look older");
    assert.equal(backward.failed, 0);
    assert.equal(stepRow(stepId).status, "running", "step must be untouched");
    assert.equal(stepRow(stepId).retry_count, 0);
  });

  it("staleThresholdMs = 0 still recovers at age 0 (>= semantics preserved)", () => {
    const runId = seedRun();
    const stepId = seedStep({ runId, agentId: "us008_zero", updatedAt: BASE_ISO });

    const result = recoverAt("us008_zero", runId, 0, BASE_MS);
    assert.equal(result.recovered, 1, "threshold 0 must recover even an age-0 step");
    assert.equal(stepRow(stepId).status, "pending");
  });

  it("unparseable updated_at is never stale (no false recovery)", () => {
    const runId = seedRun();
    const stepId = seedStep({ runId, agentId: "us008_bad", updatedAt: "not-a-timestamp" });

    const result = recoverAt("us008_bad", runId, 5 * MINUTE_MS, BASE_MS + 24 * 60 * MINUTE_MS);
    assert.equal(result.recovered, 0, "unparseable instant must be skipped, not assumed old");
    assert.equal(stepRow(stepId).status, "running");
  });

  it("missing/empty updated_at is never stale (no false recovery)", () => {
    const runId = seedRun();
    const stepId = seedStep({ runId, agentId: "us008_missing", updatedAt: "" });

    const result = recoverAt("us008_missing", runId, 0, BASE_MS + 24 * 60 * MINUTE_MS);
    assert.equal(result.recovered, 0, "empty instant must be skipped even with threshold 0");
    assert.equal(stepRow(stepId).status, "running");
  });

  // ── checkRunningWorkersLiveness: injected claim-age clock ────────────

  it("liveness watchdog uses the injected now for the 30s claim grace", () => {
    let pgidSeq = 700000;
    const nextDeadPgid = (): number => pgidSeq++;

    // Fresh claim: injected now only 10s after the claim => inside the grace.
    const freshRun = seedRun();
    const freshStep = seedStep({
      runId: freshRun,
      agentId: "us008_live",
      updatedAt: BASE_ISO,
      claimUpdatedAt: BASE_ISO,
      claimPgid: nextDeadPgid(),
      claimJobId: "job-fresh",
    });
    checkRunningWorkersLiveness(undefined, BASE_MS + 10 * 1000);
    assert.equal(stepRow(freshStep).status, "running", "fresh claim stays inside the grace window");

    // Backward jump: now before the claim => negative age => still inside grace.
    const backRun = seedRun();
    const backStep = seedStep({
      runId: backRun,
      agentId: "us008_live",
      updatedAt: BASE_ISO,
      claimUpdatedAt: BASE_ISO,
      claimPgid: nextDeadPgid(),
      claimJobId: "job-back",
    });
    checkRunningWorkersLiveness(undefined, BASE_MS - 60 * 1000);
    assert.equal(stepRow(backStep).status, "running", "backward jump must not bypass the grace window");

    // Forward jump: now 60s after the claim => grace expired => recover.
    const oldRun = seedRun();
    const oldStep = seedStep({
      runId: oldRun,
      agentId: "us008_live",
      updatedAt: BASE_ISO,
      claimUpdatedAt: BASE_ISO,
      claimPgid: nextDeadPgid(),
      claimJobId: "job-old",
    });
    const result = checkRunningWorkersLiveness(undefined, BASE_MS + 60 * 1000);
    assert.ok(result.recovered >= 1, "expired claim must be recovered");
    assert.equal(stepRow(oldStep).status, "pending", "dead-worker claim is requeued");
  });

  it("liveness watchdog conservatively skips an unparseable claim timestamp", () => {
    const runId = seedRun();
    const stepId = seedStep({
      runId,
      agentId: "us008_live_bad",
      updatedAt: BASE_ISO,
      claimUpdatedAt: "",
      claimPgid: 799999,
      claimJobId: "job-bad",
    });

    const result = checkRunningWorkersLiveness(undefined, BASE_MS + 24 * 60 * MINUTE_MS);
    assert.equal(result.recovered, 0, "unknown claim age must not be recovered");
    assert.equal(stepRow(stepId).status, "running");
  });

  // ── cleanupAbandonedSteps: injected now for steps and stories ────────

  it("cleanupAbandonedSteps ages steps with the injected now", () => {
    const forwardRun = seedRun();
    const forwardStep = seedStep({
      runId: forwardRun,
      agentId: "us008_cleanup",
      updatedAt: BASE_ISO,
    });
    // Well past ABANDONED_THRESHOLD_MS => the step-level reset path runs.
    cleanupAbandonedSteps(BASE_MS + ABANDONED_THRESHOLD_MS + 60 * MINUTE_MS);
    assert.equal(stepRow(forwardStep).status, "pending", "old step reset to pending");
    assert.equal(stepRow(forwardStep).retry_count, 0, "abandonment uses abandoned_count, not retry_count");

    const backRun = seedRun();
    const backStep = seedStep({
      runId: backRun,
      agentId: "us008_cleanup",
      updatedAt: BASE_ISO,
    });
    cleanupAbandonedSteps(BASE_MS - 60 * MINUTE_MS);
    assert.equal(stepRow(backStep).status, "running", "backward jump must not abandon a fresh step");

    const badRun = seedRun();
    const badStep = seedStep({
      runId: badRun,
      agentId: "us008_cleanup",
      updatedAt: "garbage",
    });
    cleanupAbandonedSteps(BASE_MS + 24 * 60 * MINUTE_MS);
    assert.equal(stepRow(badStep).status, "running", "unparseable step instant is never abandoned");
  });

  it("cleanupAbandonedSteps ages running stories with the injected now", () => {
    const forwardRun = seedRun();
    const forwardStory = seedStory(forwardRun, BASE_ISO);
    cleanupAbandonedSteps(BASE_MS + ABANDONED_THRESHOLD_MS + 60 * MINUTE_MS);
    assert.equal(storyRow(forwardStory).status, "pending", "old running story reset to pending");

    const backRun = seedRun();
    const backStory = seedStory(backRun, BASE_ISO);
    cleanupAbandonedSteps(BASE_MS - 60 * MINUTE_MS);
    assert.equal(storyRow(backStory).status, "running", "backward jump must not reset a fresh story");

    const badRun = seedRun();
    const badStory = seedStory(badRun, "not-a-date");
    cleanupAbandonedSteps(BASE_MS + 24 * 60 * MINUTE_MS);
    assert.equal(storyRow(badStory).status, "running", "unparseable story instant is never reset");
  });

  // ── Cleanup throttle: monotonic, not a wall instant ──────────────────

  it("cleanup throttle is a monotonic interval with a first-call guarantee", () => {
    _resetCleanupThrottleForTest();
    assert.equal(_shouldRunCleanupForTest(1_000), true, "first call always cleans up");
    assert.equal(
      _shouldRunCleanupForTest(1_000 + 5 * 60 * 1000 - 1),
      false,
      "inside the window is throttled",
    );
    assert.equal(
      _shouldRunCleanupForTest(1_000 + 5 * 60 * 1000),
      true,
      "at the window boundary cleanup is due again",
    );
    _resetCleanupThrottleForTest();
    // A monotonic reading is process-relative; starting near zero must still
    // trigger the very first cleanup (the old `Date.now() - 0` behavior).
    assert.equal(_shouldRunCleanupForTest(0), true);
    assert.equal(_shouldRunCleanupForTest(1), false);
    _resetCleanupThrottleForTest();
  });

  it("step-ops source has no SQL julianday age arithmetic and throttles monotonically", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, "src", "installer", "step-ops.ts"), "utf-8");
    assert.ok(
      !source.includes("julianday("),
      "step-ops must not age durable instants with SQL julianday arithmetic",
    );
    assert.ok(
      source.includes("_shouldRunCleanupForTest(monotonicNow())"),
      "the cleanup throttle must read the monotonic clock",
    );
    assert.ok(
      !source.includes("Date.now() - lastCleanupTime"),
      "the cleanup throttle must not compare wall-clock readings",
    );
  });
});
