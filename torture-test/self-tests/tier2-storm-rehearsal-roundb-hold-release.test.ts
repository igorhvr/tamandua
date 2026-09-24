// Tier-2 STORM-REHEARSAL FIX-4 US-008 — Round B derived schedule, hold
// predicates, and release-after-fire (SF-8 / requirements 1a/1d).
//
// Attempt 4's Round B rounded every chaos phase `run_terminal`: the zero-model
// scripted runs completed in ~6 minutes while the real phases are due at
// 5400s+, so no chaos action was ever exercised against a live target and the
// B5 stop/delete/relaunch lineage was never produced.
//
// US-008 consumes the DERIVED SCRIPTED_REHEARSAL schedule recorded at prepare
// (`state.plan.roundBPhases`; offsets derived from the hold schedule), gates a
// derived phase on a real HOLD predicate (every target run has a confirmed
// hold file and is still non-terminal; a `.missed` file is `hold_missed`), and
// releases each target only AFTER its LAST structurally-dependent phase
// resolves (fired / missed / not_run), so later predicates still observe live
// held targets. The real-storm path (no state.plan.roundBPhases, no
// release_targets) is unchanged.
//
// In-process only: real temp dirs for the campaign + hold dirs, an injected
// advancing fake clock, injected dispatch/probe adapters and synthetic state.
// No daemon, scheduler, harness, model token or production port is touched.
//
// Coverage:
//   H1 the derived schedule is consumed (derived offsets, not the real 900s+
//      clock) and the real ROUND_B_PHASES fallback is preserved;
//   H2 a hold predicate is satisfied only when every target has a confirmed
//      hold file and is non-terminal; a missed file yields `hold_missed` with
//      the runtime's reason (surfaced immediately, never after the bound);
//   H3 each derived phase's release_targets are released after it fires and
//      NO target is released before its last dependent phase fires;
//   H4 a missed / not_run derived phase releases its targets fail-closed.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { newCampaignState } from "../bin/tt-storm-shared.mjs";
import {
  ROUND_B_PHASES,
  dispatchPhaseSchedule,
  holdPredicateVerdict,
  waitForPhaseEvidence,
} from "../bin/tt-storm-engine.mjs";
import {
  HOLD_ID,
  deriveScriptedHoldSchedule,
  scriptedRoundBPhases,
} from "../bin/tt-storm-rehearsal.mjs";

const RUNS: Record<string, string> = {
  B1: "run-b1aaaaaa-0000-4000-8000-000000000001",
  B2: "run-b2aaaaaa-0000-4000-8000-000000000002",
  B3: "run-b3aaaaaa-0000-4000-8000-000000000003",
  B4: "run-b4aaaaaa-0000-4000-8000-000000000004",
  B5: "run-b5aaaaaa-0000-4000-8000-000000000005",
};

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // diagnostics-only cleanup
    }
  }
});

// A derived schedule that is cheap on the fake clock: 1s phase steps from the
// round start, so a real offset (B-cc1 = 900_000ms) can never be mistaken for
// the derived one.
const FAST_SCHEDULE = { phaseStepMs: 1_000, startOffsetMs: 0 };
function derivedPhases(): any[] {
  return scriptedRoundBPhases(FAST_SCHEDULE);
}

function makeClock(startMs = 0) {
  let ms = startMs;
  const sleeps: Array<{ n: number; reason?: string }> = [];
  return {
    sleeps,
    nowMs: () => ms,
    nowUtc: () => new Date(ms).toISOString(),
    sleep: async (n: number, reason?: string) => { sleeps.push({ n, reason }); ms += n; },
    advance: (n: number) => { ms += n; },
  };
}

// The fake clock records every sleep; summing the slices whose reason names a
// phase reconstructs the elapsed offset the engine waited for that phase.
function elapsedForPhase(clock: any, id: string): number {
  return clock.sleeps
    .filter((s: any) => String(s.reason ?? "").startsWith(`phase ${id} earliest offset`))
    .reduce((acc: number, s: any) => acc + s.n, 0);
}

function makeOps() {
  const entries: any[] = [];
  return {
    entries,
    record(kind: string, detail: any = {}) {
      if (typeof kind !== "string" || kind.length === 0) throw new Error("bad op kind");
      entries.push({ kind, ...detail });
      return kind;
    },
    ofKind(kind: string) {
      return entries.filter((e) => e.kind === kind);
    },
  };
}

function makeState(phases: any[] | null, clock: any) {
  const state: any = newCampaignState({
    campaignId: "camp-us008-roundb-hold-release",
    clock,
    source: { repo: "/var/repo", branch: "test", commit: "0".repeat(40), tree: "0".repeat(40) },
    fixture: { name: "tt-poly", basis: "US-008 roundb-hold-release self-test" },
  });
  state.plan = {
    launches: [],
    ...(phases ? { roundBPhases: phases } : {}),
    fixtureIdentity: {
      originRepo: "/var/fixtures/origin",
      colleagueRepo: "/var/fixtures/colleague",
      parkRepo: "/var/fixtures/park",
      cc1File: "docs/cc1.md",
      cc2File: "client-store.ts",
    },
  };
  state.rehearsal = {
    hold_schedule: { hold_id: HOLD_ID, ...(phases ? { round_b: { phases } } : {}) },
    scripted_runtime: { state_dir: null },
  };
  state.rounds.B.runs = {
    B1: { rosterId: "B1", run: "storm-b1", workflow: "feature-dev-merge-worktree", runId: RUNS.B1, status: "registered" },
    B2: { rosterId: "B2", run: "storm-b2", workflow: "feature-dev-merge-worktree", runId: RUNS.B2, status: "registered" },
    B3: { rosterId: "B3", run: "storm-b3", workflow: "bug-fix-merge-worktree", runId: RUNS.B3, status: "registered" },
    B4: { rosterId: "B4", run: "storm-b4", workflow: "bug-fix-merge-worktree", runId: RUNS.B4, status: "registered" },
    B5: { rosterId: "B5", run: "storm-b5", workflow: "do-now", runId: RUNS.B5, status: "registered" },
  };
  state.rounds.B.phases = {};
  // Pounding ACTIVE so the derived B-pounding control phase can fire (its
  // actionPlan refuses a not-enabled pounding). poundIfDue itself is a no-op
  // because no ctx.opts.pounding config / transport adapter is injected.
  state.rounds.B.pounding = {
    active: true, notRunReason: null, cadenceMs: 30_000, latencyBoundMs: 2_000,
    lastPoundMs: null, rounds: 0, probes: 0, assertionFailures: 0, maxLatencyMs: 0,
  };
  return state;
}

function confirmHold(holdDir: string, runId: string) {
  fs.writeFileSync(path.join(holdDir, `${runId}.confirmed`), JSON.stringify({ runId, holdId: HOLD_ID, ts: 0 }) + "\n");
}

function missHold(holdDir: string, runId: string, reason: string) {
  fs.writeFileSync(path.join(holdDir, `${runId}.missed`), JSON.stringify({ runId, holdId: HOLD_ID, reason, ts: 0 }) + "\n");
}

function releasedFor(holdDir: string): string[] {
  return fs.readdirSync(holdDir).filter((f) => f.endsWith(".release")).sort();
}

function makeCtx({ holdDir, clock, campaignDir, probe, dispatch }: any) {
  return {
    fs,
    clock,
    varRoot: "/var",
    campaignDir,
    opts: {
      holdDir,
      // SF-12 (fix-6): the fail-closed task-file resolver needs an absolute
      // campaign tasks root for the derived B-stopdel relaunch argv.
      taskFileRoot: "/var/tt-owned/inputs/tasks",
      ...(probe ? { probePhaseMarker: probe } : {}),
      ...(dispatch ? { dispatchPhaseAction: dispatch } : {}),
    },
  };
}

describe("tier2-storm-rehearsal-roundb-hold-release (US-008, SF-8)", () => {
  it("H1a: dispatchPhaseSchedule consumes the derived offsets/predicates", async () => {
    const clock = makeClock(0);
    const campaignDir = makeTempDir("storm-rb-h1a-camp-");
    const holdDir = makeTempDir("storm-rb-h1a-hold-");
    const phases = derivedPhases();
    // Every target is genuinely parked on its campaign hold.
    for (const runId of Object.values(RUNS)) confirmHold(holdDir, runId);

    const fired: string[] = [];
    const ctx = makeCtx({
      holdDir, clock, campaignDir,
      dispatch: (_c: any, _s: any, _action: any, ph: any) => { fired.push(ph.id); return { ok: true, detail: { phase: ph.id } }; },
    });
    const state = makeState(phases, clock);
    const ops = makeOps();

    await dispatchPhaseSchedule(ctx, state, ops, campaignDir, 0);

    assert.equal(fired.length, 11, "every derived phase fired");
    assert.deepEqual(fired, phases.map((p: any) => p.id), "fired in derived order");
    for (const ph of phases) {
      assert.equal(state.rounds.B.phases[ph.id].status, "fired", `${ph.id} is fired`);
      assert.equal(state.rounds.B.phases[ph.id].waitOutcome.outcome, "marker_satisfied");
    }
    // The DERIVED offset was consumed, not the real 900s B-cc1 clock.
    assert.equal(elapsedForPhase(clock, "B-cc1"), 1_000, "B-cc1 waits the derived 1s offset, never the real 900s");
    assert.equal(
      ROUND_B_PHASES.find((p: any) => p.id === "B-cc1")!.earliestOffsetMs,
      15 * 60_000,
      "the real B-cc1 offset is 900s (must not be what the derived run waited)",
    );
    assert.equal(elapsedForPhase(clock, "B-bounce"), 1_000, "each derived phase waits one 1s step after the previous");
    assert.equal(clock.nowMs(), 10_000, "the whole derived schedule spans the last derived offset (start + 10*step)");
  });

  it("H1b: without state.plan.roundBPhases the engine falls back to ROUND_B_PHASES", async () => {
    const clock = makeClock(0);
    const campaignDir = makeTempDir("storm-rb-h1b-camp-");
    const holdDir = makeTempDir("storm-rb-h1b-hold-");
    const realIds = ROUND_B_PHASES.map((p: any) => p.id);
    // An always-satisfied injected probe keeps the real predicates out of the
    // way; this case only pins that the REAL table (ids + offsets) is used.
    const ctx = makeCtx({
      holdDir, clock, campaignDir,
      probe: () => ({ satisfied: true, outcome: "marker_satisfied" }),
      dispatch: () => ({ ok: true, detail: {} }),
    });
    const state = makeState(null, clock);
    const ops = makeOps();

    await dispatchPhaseSchedule(ctx, state, ops, campaignDir, 0);

    assert.deepEqual(Object.keys(state.rounds.B.phases).sort(), [...realIds].sort(), "all real phase ids recorded");
    assert.equal(
      elapsedForPhase(clock, "B-cc1"),
      15 * 60_000,
      "the real 900s B-cc1 offset is consumed when no derived schedule exists",
    );
  });

  it("H2: a hold predicate is satisfied only when every target has a confirmed hold and is non-terminal", async () => {
    const clock = makeClock(0);
    const holdDir = makeTempDir("storm-rb-h2-hold-");
    const campaignDir = makeTempDir("storm-rb-h2-camp-");
    const state = makeState(derivedPhases(), clock);
    const stopdel = derivedPhases().find((p: any) => p.id === "B-stopdel");
    const ctx = makeCtx({ holdDir, clock, campaignDir });

    // Nothing parked yet: not satisfied, and NOT a missed hold.
    let v = holdPredicateVerdict(ctx, state, stopdel);
    assert.equal(v.satisfied, false);
    assert.equal(v.outcome, "not_yet");
    assert.deepEqual(v.targets.map((t: any) => t.rosterId).sort(), ["B1", "B2", "B3", "B4"]);

    // A partial park is still not satisfied.
    confirmHold(holdDir, RUNS.B1);
    confirmHold(holdDir, RUNS.B2);
    v = holdPredicateVerdict(ctx, state, stopdel);
    assert.equal(v.satisfied, false);
    assert.equal(v.outcome, "not_yet");

    // Every target confirmed + live -> satisfied.
    confirmHold(holdDir, RUNS.B3);
    confirmHold(holdDir, RUNS.B4);
    v = holdPredicateVerdict(ctx, state, stopdel);
    assert.equal(v.satisfied, true);
    assert.equal(v.outcome, "marker_satisfied");
    assert.ok(v.targets.every((t: any) => t.confirmed && !t.terminal));

    // A terminal target is not a live hold (even with a confirmed file).
    state.rounds.B.runs.B3.status = "terminal";
    v = holdPredicateVerdict(ctx, state, stopdel);
    assert.equal(v.satisfied, false);
    assert.equal(v.outcome, "not_yet");
    state.rounds.B.runs.B3.status = "registered";

    // A runtime-reported MISSED hold is terminal for the phase, with the reason.
    missHold(holdDir, RUNS.B2, "runtime hold timeout after 1800000ms");
    v = holdPredicateVerdict(ctx, state, stopdel);
    assert.equal(v.satisfied, false);
    assert.equal(v.outcome, "hold_missed");
    assert.match(String(v.reason), new RegExp(RUNS.B2));
    assert.match(String(v.reason), /1800000ms/);

    // waitForPhaseEvidence surfaces hold_missed immediately (not after a bound).
    const ev = await waitForPhaseEvidence(ctx, state, stopdel);
    assert.equal(ev.outcome, "hold_missed");
    assert.match(String(ev.reason), new RegExp(RUNS.B2));
    assert.equal(clock.nowMs(), 0, "hold_missed never burns the phase wait bound");

    // A zero-target control-only phase is vacuously satisfied.
    const pounding = derivedPhases().find((p: any) => p.id === "B-pounding");
    const pv = holdPredicateVerdict(ctx, state, pounding);
    assert.equal(pv.satisfied, true);
    assert.equal(pv.outcome, "marker_satisfied");
  });

  it("H3: release_targets release only AFTER their last dependent phase fires", async () => {
    const clock = makeClock(0);
    const campaignDir = makeTempDir("storm-rb-h3-camp-");
    const holdDir = makeTempDir("storm-rb-h3-hold-");
    for (const runId of Object.values(RUNS)) confirmHold(holdDir, runId);

    // Snapshot the release files present at the moment each phase FIRES (the
    // engine writes the releases only after the dispatch adapter returns).
    const atFire: Record<string, string[]> = {};
    const ctx = makeCtx({
      holdDir, clock, campaignDir,
      dispatch: (_c: any, _s: any, _action: any, ph: any) => { atFire[ph.id] = releasedFor(holdDir); return { ok: true, detail: {} }; },
    });
    const state = makeState(derivedPhases(), clock);
    const ops = makeOps();

    await dispatchPhaseSchedule(ctx, state, ops, campaignDir, 0);

    // B5's last dependent phase is B-stopdel: its own fire snapshot has no B5
    // release (the engine writes it only after the dispatch adapter returns).
    assert.ok(!atFire["B-stopdel"].includes(`${RUNS.B5}.release`), "B5 not released before B-stopdel fires");
    // B1..B4's last dependent phase is B-bounce: still unreleased at every
    // earlier phase, including the rugpull that consumes them.
    for (const rid of ["B1", "B2", "B3", "B4"]) {
      assert.ok(!atFire["B-rugpull"].includes(`${RUNS[rid]}.release`), `${rid} not released before B-bounce (at B-rugpull)`);
    }
    // At B-bounce's own fire B5 is already released (B-stopdel ran earlier),
    // but B1..B4 are not yet.
    assert.ok(atFire["B-bounce"].includes(`${RUNS.B5}.release`), "B5 released by the earlier B-stopdel");
    for (const rid of ["B1", "B2", "B3", "B4"]) {
      assert.ok(!atFire["B-bounce"].includes(`${RUNS[rid]}.release`), `${rid} not released before B-bounce fires`);
    }

    // After the full schedule, every hold is released with the fire reason.
    assert.deepEqual(
      releasedFor(holdDir),
      Object.values(RUNS).map((r) => `${r}.release`).sort(),
      "every target released after its last dependent phase",
    );
    assert.equal(JSON.parse(fs.readFileSync(path.join(holdDir, `${RUNS.B5}.release`), "utf-8")).reason, "phase_fired:B-stopdel");
    assert.equal(JSON.parse(fs.readFileSync(path.join(holdDir, `${RUNS.B4}.release`), "utf-8")).reason, "phase_fired:B-bounce");
    assert.ok(
      ops.ofKind("hold.released_for_phase").some((e: any) => e.id === "B-bounce" && Array.isArray(e.targets) && e.targets.includes("B4")),
      "the per-phase release is recorded",
    );
  });

  it("H4: a missed derived phase releases its targets fail-closed with the reason", async () => {
    const clock = makeClock(0);
    const campaignDir = makeTempDir("storm-rb-h4-camp-");
    const holdDir = makeTempDir("storm-rb-h4-hold-");
    for (const runId of Object.values(RUNS)) confirmHold(holdDir, runId);
    // B1's runtime missed its hold: every phase depending on B1 is missed.
    missHold(holdDir, RUNS.B1, "runtime hold timeout after 1800000ms");

    const ctx = makeCtx({
      holdDir, clock, campaignDir,
      dispatch: () => ({ ok: true, detail: {} }),
    });
    const state = makeState(derivedPhases(), clock);
    const ops = makeOps();

    await dispatchPhaseSchedule(ctx, state, ops, campaignDir, 0);

    const stopdel = state.rounds.B.phases["B-stopdel"];
    assert.equal(stopdel.status, "missed", "B-stopdel is recorded missed");
    assert.equal(stopdel.waitOutcome.outcome, "hold_missed");
    assert.match(String(stopdel.waitOutcome.reason), new RegExp(RUNS.B1));
    assert.match(String(stopdel.waitOutcome.reason), /1800000ms/);
    const missedOps = ops.ofKind("phase.missed").filter((e: any) => e.id === "B-stopdel");
    assert.equal(missedOps.length, 1);
    assert.equal(missedOps[0].outcome, "hold_missed");
    // B-stopdel's release_targets is B5: releasing it fail-closed means no run
    // is left parked to the runtime timeout.
    assert.ok(fs.existsSync(path.join(holdDir, `${RUNS.B5}.release`)), "a missed phase still releases its targets");
    assert.equal(JSON.parse(fs.readFileSync(path.join(holdDir, `${RUNS.B5}.release`), "utf-8")).reason, "phase_missed");
    // B-bounce depends on B1..B4 and is missed too, releasing B1..B4 fail-closed.
    assert.equal(state.rounds.B.phases["B-bounce"].status, "missed");
    assert.equal(JSON.parse(fs.readFileSync(path.join(holdDir, `${RUNS.B4}.release`), "utf-8")).reason, "phase_missed");
  });

  it("H4b: a not_run derived phase releases its targets with the not_run reason", async () => {
    const clock = makeClock(0);
    const campaignDir = makeTempDir("storm-rb-h4b-camp-");
    const holdDir = makeTempDir("storm-rb-h4b-hold-");
    for (const runId of Object.values(RUNS)) confirmHold(holdDir, runId);

    const ctx = makeCtx({
      holdDir, clock, campaignDir,
      // The dispatch adapter succeeds; B-stopdel is NOT_RUN because its ACTION
      // target (B5) is already terminal — a first-class refusal, never a
      // fabricated fire.
      dispatch: () => ({ ok: true, detail: {} }),
    });
    const state = makeState(derivedPhases(), clock);
    state.rounds.B.runs.B5.status = "terminal";
    const ops = makeOps();

    await dispatchPhaseSchedule(ctx, state, ops, campaignDir, 0);

    assert.equal(state.rounds.B.phases["B-stopdel"].status, "not_run");
    assert.match(String(state.rounds.B.phases["B-stopdel"].notRunReason), /terminal/);
    assert.ok(fs.existsSync(path.join(holdDir, `${RUNS.B5}.release`)), "a not_run phase releases its targets");
    assert.equal(JSON.parse(fs.readFileSync(path.join(holdDir, `${RUNS.B5}.release`), "utf-8")).reason, "phase_not_run");
    // B-bounce still fires (its predicate targets B1..B4) and releases them.
    assert.equal(state.rounds.B.phases["B-bounce"].status, "fired");
    assert.equal(JSON.parse(fs.readFileSync(path.join(holdDir, `${RUNS.B4}.release`), "utf-8")).reason, "phase_fired:B-bounce");
  });

  it("H5: the derived schedule's release map is the last-dependent phase per target", () => {
    const schedule = deriveScriptedHoldSchedule(FAST_SCHEDULE);
    const releaseAt: Record<string, string> = {};
    for (const ph of schedule.round_b.phases) {
      for (const rid of ph.release_targets) releaseAt[rid] = ph.id;
    }
    assert.deepEqual(releaseAt, { B1: "B-bounce", B2: "B-bounce", B3: "B-bounce", B4: "B-bounce", B5: "B-stopdel" });
    // No derived phase releases a target it does not structurally depend on.
    for (const ph of schedule.round_b.phases) {
      assert.ok(ph.release_targets.every((rid: string) => state_depends(ph, rid)), `${ph.id} only releases its dependencies`);
    }
  });
});

// A phase structurally depends on a roster id when the id is in its predicate
// targets OR its action targets.
function state_depends(ph: any, rid: string): boolean {
  const wf = ph.waitFor ?? {};
  const declared = [...(wf.targets ?? [])];
  const action = ph.action ?? {};
  const actionTargets = Array.isArray(action.targets) ? action.targets : (Array.isArray(action.target) ? action.target : (typeof action.target === "string" ? [action.target] : []));
  return declared.includes(rid) || actionTargets.includes(rid);
}
