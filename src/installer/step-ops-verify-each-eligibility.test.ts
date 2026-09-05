import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { getDb, closeDb } from "../../dist/db.js";
import { claimStep, autoCompleteConditionalStep } from "../../dist/installer/step-ops.js";
import { getRunEvents } from "../../dist/installer/events.js";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";

// ── Sticky isolation env ─────────────────────────────────────────────
// claimStep / autoCompleteConditionalStep fire emitEvent → fire-and-forget
// webhook continuations (fireWebhook → getDb) that resolve DB paths AFTER
// the triggering test's afterEach has run. Restoring the operator's real
// env there trips the guard at the REAL ~/.tamandua (ledger entries with
// testFile null, "(unknown)"). Keep HOME / TAMANDUA_STATE_DIR /
// TAMANDUA_DB_PATH pointed at a module-scoped temp dir for the whole file:
// every afterEach below restores to this sticky env (never the operator's),
// and the module after() drains pending setImmediates before restoring the
// originals (step-ops-conditional.test.ts pattern). The ambient control
// port is dropped too so controlRequest's early guard return fires instead
// of ever reaching a live daemon.
const stickyState = (() => {
  const root = tamanduaTempDir("tamandua-vedl-sticky-");
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
  // the fire-and-forget webhook continuations scheduled by the last test
  // land on the module-loader task queue and must resolve their
  // getDb/logger paths against the temp state, not the restored real env.
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

// ── Seeding helpers ──────────────────────────────────────────────────
// The fossil layout (torture-test/scenarios/w4.35 via run-retry-cell.mjs):
//   fix (type: loop, paused: status 'running' + current_story_id NULL,
//        loop_config verify_each/verify_step naming the verifier)
//   -> one or more waiting intermediates (e.g. deception_audit)
//   -> verify (pending, agent verifier)
// Claiming as the verifier agent must return the verify step; every waiting
// intermediate must stay exactly 'waiting'.

const LOOP_AGENT = "fixer";
const AUDITOR_AGENT = "auditor";
const VERIFIER_AGENT = "verifier";

interface StepSeed {
  /** Stable key used to derive the DB row id (assertions address it). */
  key: string;
  /** Workflow step id (what events carry). */
  stepId: string;
  agentId: string;
  stepIndex: number;
  status: string;
  type?: string;
  loopConfig?: Record<string, unknown> | null;
  currentStoryId?: string | null;
}

function dbIdOf(runId: string, key: string): string {
  return `${runId}::${key}`;
}

function seedRunAndSteps(
  steps: StepSeed[],
  opts: { runId?: string; runStatus?: string } = {},
): string {
  const db = getDb();
  const runId = opts.runId ?? crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'vedl-wf', 'vedl eligibility', ?, '{}', ?, ?)",
  ).run(runId, opts.runStatus ?? "running", now, now);
  const insertStep = db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, current_story_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', '', ?, 0, 4, ?, ?, ?, ?, ?)`,
  );
  for (const s of steps) {
    insertStep.run(
      dbIdOf(runId, s.key),
      runId,
      s.stepId,
      s.agentId,
      s.stepIndex,
      s.status,
      s.type ?? "single",
      s.loopConfig === undefined || s.loopConfig === null
        ? null
        : JSON.stringify(s.loopConfig),
      s.currentStoryId ?? null,
      now,
      now,
    );
  }
  return runId;
}

function stepRow(runId: string, key: string): {
  status: string;
  type: string;
  current_story_id: string | null;
} {
  const row = getDb()
    .prepare("SELECT status, type, current_story_id FROM steps WHERE id = ?")
    .get(dbIdOf(runId, key)) as {
    status: string;
    type: string;
    current_story_id: string | null;
  } | undefined;
  assert.ok(row, `step row ${key} must exist`);
  return row;
}

/** Loop config for the paused verify_each loop, in the requested spelling. */
function loopConfigOf(
  verifyEach: boolean,
  verifyStep: string,
  camelCase: boolean,
): Record<string, unknown> {
  return camelCase
    ? { verifyEach, verifyStep }
    : { verify_each: verifyEach, verify_step: verifyStep };
}

/**
 * Default fossil-layout steps: paused verify_each loop at index 0, the given
 * intermediates at 1..n, then the pending verify step last.
 */
function fossilSteps(opts: {
  loopConfig?: Record<string, unknown>;
  loopStatus?: string;
  loopCurrentStoryId?: string | null;
  intermediates?: Array<{ key: string; stepId: string; agentId: string; status: string }>;
  verifyStepId?: string;
  verifyStatus?: string;
}): StepSeed[] {
  const lc = opts.loopConfig ?? loopConfigOf(true, "verify", false);
  const intermediates = opts.intermediates ?? [
    { key: "audit", stepId: "deception_audit", agentId: AUDITOR_AGENT, status: "waiting" },
  ];
  const steps: StepSeed[] = [
    {
      key: "loop",
      stepId: "fix",
      agentId: LOOP_AGENT,
      stepIndex: 0,
      status: opts.loopStatus ?? "running",
      type: "loop",
      loopConfig: lc,
      currentStoryId: opts.loopCurrentStoryId ?? null,
    },
  ];
  for (const [i, m] of intermediates.entries()) {
    steps.push({
      key: m.key,
      stepId: m.stepId,
      agentId: m.agentId,
      stepIndex: i + 1,
      status: m.status,
    });
  }
  steps.push({
    key: "verify",
    stepId: opts.verifyStepId ?? "verify",
    agentId: VERIFIER_AGENT,
    stepIndex: intermediates.length + 1,
    status: opts.verifyStatus ?? "pending",
  });
  return steps;
}

/**
 * Every intermediate stays exactly 'waiting' and no lifecycle event (claim /
 * step.pending / step.auto_completed / ...) may reference its workflow step
 * id — the waiting intermediates are never dispatched, skipped, or advanced.
 */
function assertWaitingAndEventless(
  runId: string,
  audits: Array<{ key: string; stepId: string }>,
  label: string,
): void {
  const events = getRunEvents(runId);
  const auditStepIds = new Set(audits.map((a) => a.stepId));
  const touching = events.filter((e) => auditStepIds.has(e.stepId as string));
  assert.equal(
    touching.length,
    0,
    `${label}: no lifecycle event may fire for the waiting intermediate(s), got ${JSON.stringify(touching)}`,
  );
  for (const a of audits) {
    assert.equal(stepRow(runId, a.key).status, "waiting", `${label}: ${a.key} stays waiting`);
  }
}

describe("VEDL: claimStep eligibility for a paused verify_each loop's designated verifier", () => {
  let tempHome: string;
  let stateDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-vedl-");
    stateDir = path.join(tempHome, ".tamandua");
    dbPath = path.join(stateDir, "tamandua.db");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = tempHome;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = dbPath;
    // Guard awareness (test-isolation-guard): claim/auto-complete emit
    // events and read the run DB through the same isolated temp state dir
    // this suite creates.
    assert.doesNotThrow(() =>
      assertStatePathIsolation(dbPath, "step-ops-verify-each-eligibility"),
    );
  });

  afterEach(() => {
    // Restore to the module-scoped sticky temp env (NOT the operator's real
    // env): claim/auto-complete fire fire-and-forget continuations
    // (emitEvent → fireWebhook → getDb) that resolve DB paths after this
    // hook; pointing them at the real ~/.tamandua trips the test-isolation
    // guard with testFile null ("(unknown)" ledger entries).
    applyStickyEnv();
    try {
      closeDb();
    } catch {
      // best-effort
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe("positive: the paused loop's designated verifier claims past waiting intermediates", () => {
    it("claims verify past ONE waiting intermediate (snake_case loop_config); audit untouched", () => {
      const steps = fossilSteps({});
      const runId = seedRunAndSteps(steps);

      const claim = claimStep(VERIFIER_AGENT, runId);
      assert.equal(claim.found, true, "designated verifier must be claimable in the deadlock layout");
      assert.equal(claim.stepId, dbIdOf(runId, "verify"));

      const audit = stepRow(runId, "audit");
      assert.equal(audit.status, "waiting", "the intermediate audit stays waiting");
      const loop = stepRow(runId, "loop");
      assert.equal(loop.status, "running");
      assert.equal(loop.current_story_id, null, "the loop stays paused");
      assert.equal(stepRow(runId, "verify").status, "running", "claimed verify transitions to running");

      assertWaitingAndEventless(runId, [{ key: "audit", stepId: "deception_audit" }], "single waiting intermediate");
      const events = getRunEvents(runId);
      const verifyRunning = events.filter((e) => e.event === "step.running" && e.stepId === "verify");
      assert.equal(verifyRunning.length, 1, "verify claim emits exactly one step.running");
      assert.equal(verifyRunning[0]!.agentId, VERIFIER_AGENT);
    });

    it("claims verify past MULTIPLE waiting intermediates; every intermediate stays waiting", () => {
      const steps = fossilSteps({
        intermediates: [
          { key: "audit1", stepId: "deception_audit", agentId: AUDITOR_AGENT, status: "waiting" },
          { key: "audit2", stepId: "second_audit", agentId: AUDITOR_AGENT, status: "waiting" },
          { key: "audit3", stepId: "third_audit", agentId: AUDITOR_AGENT, status: "waiting" },
        ],
      });
      const runId = seedRunAndSteps(steps);

      const claim = claimStep(VERIFIER_AGENT, runId);
      assert.equal(claim.found, true);
      assert.equal(claim.stepId, dbIdOf(runId, "verify"));
      assert.equal(stepRow(runId, "verify").status, "running");

      assertWaitingAndEventless(
        runId,
        [
          { key: "audit1", stepId: "deception_audit" },
          { key: "audit2", stepId: "second_audit" },
          { key: "audit3", stepId: "third_audit" },
        ],
        "multiple waiting intermediates",
      );
    });

    it("claims verify with camelCase loop_config (verifyEach/verifyStep)", () => {
      const steps = fossilSteps({ loopConfig: loopConfigOf(true, "verify", true) });
      const runId = seedRunAndSteps(steps);

      const claim = claimStep(VERIFIER_AGENT, runId);
      assert.equal(claim.found, true, "camelCase loop_config must be honored");
      assert.equal(claim.stepId, dbIdOf(runId, "verify"));
      assertWaitingAndEventless(runId, [{ key: "audit", stepId: "deception_audit" }], "camelCase config");
    });

    it("claims an ordinary ADJACENT verify exactly as before (no intermediate)", () => {
      // fix(loop, paused) -> verify(pending): no waiting step in between.
      // Pre-existing behavior — regression control.
      const steps = fossilSteps({ intermediates: [] });
      const runId = seedRunAndSteps(steps);

      const claim = claimStep(VERIFIER_AGENT, runId);
      assert.equal(claim.found, true, "adjacent verify must remain claimable");
      assert.equal(claim.stepId, dbIdOf(runId, "verify"));
      assert.equal(stepRow(runId, "verify").status, "running");
    });

    it("claims verify after a COMPLETED intermediate as ordinary serial behavior", () => {
      // loop paused naming verify, audit already done -> verify pending is
      // claimable through the ordinary done/skipped exemption.
      const steps = fossilSteps({
        intermediates: [
          { key: "audit", stepId: "deception_audit", agentId: AUDITOR_AGENT, status: "done" },
        ],
      });
      const runId = seedRunAndSteps(steps);

      const claim = claimStep(VERIFIER_AGENT, runId);
      assert.equal(claim.found, true, "completed intermediate must not block (ordinary serial behavior)");
      assert.equal(claim.stepId, dbIdOf(runId, "verify"));
      assert.equal(stepRow(runId, "audit").status, "done");
    });
  });

  describe("negative: only the paused loop's explicitly designated verifier bypasses waiting intermediates", () => {
    it("does NOT claim when the loop is running with a current story (not paused)", () => {
      const steps = fossilSteps({ loopCurrentStoryId: "story-1" });
      const runId = seedRunAndSteps(steps);

      const claim = claimStep(VERIFIER_AGENT, runId);
      assert.equal(claim.found, false, "a loop mid-story is not paused: no bypass");
      assert.equal(stepRow(runId, "audit").status, "waiting");
      assert.equal(stepRow(runId, "verify").status, "pending");
    });

    it("does NOT claim when the loop is not running (done/pending/failed)", () => {
      for (const loopStatus of ["done", "pending", "failed"]) {
        const steps = fossilSteps({ loopStatus });
        const runId = seedRunAndSteps(steps);
        const claim = claimStep(VERIFIER_AGENT, runId);
        assert.equal(
          claim.found,
          false,
          `loop status ${loopStatus} must not unlock the bypass`,
        );
        assert.equal(stepRow(runId, "audit").status, "waiting", loopStatus);
        assert.equal(stepRow(runId, "verify").status, "pending", loopStatus);
      }
    });

    it("does NOT claim when verify_each is disabled or the verifier is unnamed", () => {
      const configs: Array<Record<string, unknown>> = [
        loopConfigOf(false, "verify", false),
        loopConfigOf(false, "verify", true),
        { verify_step: "verify" }, // no verify_each key
        { verify_each: true }, // no verify_step key
        {}, // neither key
      ];
      for (const lc of configs) {
        const steps = fossilSteps({ loopConfig: lc });
        const runId = seedRunAndSteps(steps);
        const claim = claimStep(VERIFIER_AGENT, runId);
        assert.equal(
          claim.found,
          false,
          `loop_config ${JSON.stringify(lc)} must not unlock the bypass`,
        );
        assert.equal(stepRow(runId, "audit").status, "waiting", JSON.stringify(lc));
        assert.equal(stepRow(runId, "verify").status, "pending", JSON.stringify(lc));
      }
    });

    it("does NOT claim a pending step the loop does NOT designate as its verifier", () => {
      // Loop designates "verify" (verify_each on), but the pending step is
      // "final_review": a non-designated pending step stays blocked.
      const steps = fossilSteps({ verifyStepId: "final_review" });
      const runId = seedRunAndSteps(steps);

      const claim = claimStep(VERIFIER_AGENT, runId);
      assert.equal(claim.found, false, "a non-designated pending step must stay blocked");
      assert.equal(stepRow(runId, "audit").status, "waiting");
      assert.equal(stepRow(runId, "verify").status, "pending");
    });

    it("does NOT let an identical eligible layout in ANOTHER run authorize this run's claim", () => {
      // run1: loop without a qualifying designation + waiting audit + pending
      // verify -> blocked. run2: identical step layout but with a qualifying
      // paused verify_each loop -> eligible. run2's loop must not leak across
      // the run boundary.
      const run1 = seedRunAndSteps(
        fossilSteps({ loopConfig: loopConfigOf(true, "verify2", false) }),
      );
      const run2 = seedRunAndSteps(fossilSteps({}));

      const claim1 = claimStep(VERIFIER_AGENT, run1);
      assert.equal(claim1.found, false, "another run's paused loop must not unlock this run");

      const claim2 = claimStep(VERIFIER_AGENT, run2);
      assert.equal(claim2.found, true, "control: the eligible run itself still claims");
      assert.equal(claim2.stepId, dbIdOf(run2, "verify"));
    });

    it("does NOT claim when an earlier unfinished prerequisite sits before the loop", () => {
      const steps: StepSeed[] = [
        {
          key: "prep",
          stepId: "prep",
          agentId: "planner",
          stepIndex: 0,
          status: "running",
        },
        ...fossilSteps({}).map((s) => ({ ...s, stepIndex: s.stepIndex + 1 })),
      ];
      const runId = seedRunAndSteps(steps);

      const claim = claimStep(VERIFIER_AGENT, runId);
      assert.equal(claim.found, false, "an earlier unfinished prerequisite must still block");
      assert.equal(stepRow(runId, "prep").status, "running");
      assert.equal(stepRow(runId, "audit").status, "waiting");
      assert.equal(stepRow(runId, "verify").status, "pending");
    });

    it("does NOT let unrelated pending work piggyback on the bypass", () => {
      // The loop's designated verifier exists but is not pending; the only
      // pending step (unrelated, downstream) must stay blocked behind the
      // waiting intermediate + waiting verifier.
      const steps = fossilSteps({ verifyStatus: "waiting" });
      steps.push({
        key: "unrelated",
        stepId: "unrelated_work",
        agentId: VERIFIER_AGENT,
        stepIndex: 3,
        status: "pending",
      });
      const runId = seedRunAndSteps(steps);

      const claim = claimStep(VERIFIER_AGENT, runId);
      assert.equal(claim.found, false, "unrelated pending work must not get the bypass");
      assert.equal(stepRow(runId, "unrelated").status, "pending");
      assert.equal(stepRow(runId, "audit").status, "waiting");
      assert.equal(stepRow(runId, "verify").status, "waiting");
    });

    it("does NOT claim when the intermediate is a non-waiting unfinished status", () => {
      // Each non-waiting unfinished intermediate status must keep blocking:
      // the bypass applies ONLY to exactly-'waiting' intermediates.
      for (const auditStatus of ["running", "pending", "failed", "canceled"]) {
        const steps = fossilSteps({
          intermediates: [
            { key: "audit", stepId: "deception_audit", agentId: AUDITOR_AGENT, status: auditStatus },
          ],
        });
        const runId = seedRunAndSteps(steps);
        const claim = claimStep(VERIFIER_AGENT, runId);
        assert.equal(
          claim.found,
          false,
          `intermediate ${auditStatus} must still block the verifier`,
        );
        assert.equal(stepRow(runId, "audit").status, auditStatus);
        assert.equal(stepRow(runId, "verify").status, "pending", auditStatus);
      }
    });
  });

  describe("autoCompleteConditionalStep stays fail-closed and unchanged", () => {
    it("never auto-completes a conditional step behind a waiting intermediate in the VEDL layout", () => {
      // paused verify_each loop -> waiting deception_audit -> conditional
      // step with an unset condition. The waiting intermediate must keep the
      // conditional step ineligible for the zero-token sweep.
      const steps = fossilSteps({});
      steps.pop(); // drop the plain verify row
      steps.push({
        key: "review",
        stepId: "test_cmd_review",
        agentId: VERIFIER_AGENT,
        stepIndex: 2,
        status: "pending",
        type: "conditional",
      });
      const runId = seedRunAndSteps(steps);
      // conditional_condition is set via direct update (seeding helper does
      // not carry the column).
      const db = getDb();
      db.prepare("UPDATE steps SET conditional_condition = ? WHERE id = ?").run(
        "test_cmd_review_required",
        dbIdOf(runId, "review"),
      );

      const outcome = autoCompleteConditionalStep(runId, VERIFIER_AGENT);
      assert.equal(outcome, "none", "a waiting intermediate must keep the sweep away");
      const row = db
        .prepare("SELECT status, auto_completed FROM steps WHERE id = ?")
        .get(dbIdOf(runId, "review")) as { status: string; auto_completed: number };
      assert.equal(row.status, "pending");
      assert.equal(row.auto_completed, 0);

      const events = getRunEvents(runId);
      assert.equal(
        events.filter((e) => e.event === "step.auto_completed").length,
        0,
        "no auto-completion event may fire",
      );
      assert.equal(stepRow(runId, "audit").status, "waiting", "the intermediate stays waiting");
    });

    it("unchanged control: an adjacent conditional step behind a paused loop still auto-completes", () => {
      // paused verify_each loop -> conditional step (no intermediate): the
      // pre-existing paused-loop exemption applies, so the unset-condition
      // sweep auto-completes exactly as before the VEDL change.
      const steps = fossilSteps({ intermediates: [] });
      steps.pop(); // drop the plain verify row
      steps.push({
        key: "review",
        stepId: "test_cmd_review",
        agentId: VERIFIER_AGENT,
        stepIndex: 1,
        status: "pending",
        type: "conditional",
      });
      const runId = seedRunAndSteps(steps);
      const db = getDb();
      db.prepare("UPDATE steps SET conditional_condition = ? WHERE id = ?").run(
        "some_flag",
        dbIdOf(runId, "review"),
      );

      const outcome = autoCompleteConditionalStep(runId, VERIFIER_AGENT);
      assert.equal(outcome, "auto_completed", "adjacent behavior must be unchanged");
      const row = db
        .prepare("SELECT status FROM steps WHERE id = ?")
        .get(dbIdOf(runId, "review")) as { status: string };
      assert.equal(row.status, "done");
    });
  });
});
