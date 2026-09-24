// Tier-2 STORM-REHEARSAL FIX-5 US-004 — Round B derived schedule: every chaos
// phase fires against a LIVE held target, and a target is released only after
// its last dependent phase resolves.
//
// US-002 (SF-11) made the derived-hold branch win over the real wrapper's
// injected `probePhaseMarker` (probePhaseMarkerReal has no 'hold-confirmed'
// case), and US-003 (SF-10) made a runtime hold one-shot per run. This suite
// re-checks the SCRIPTED_REHEARSAL Round-B schedule against that now-live
// predicate:
//   * every phase whose action and/or wait predicate names a roster target
//     (kill_harness B4, dirty_tree_park B1-B4 (the shared merge target),
//     mass_rugpull B1-B4, stop_delete_relaunch B5, colleague_commit B1/B3,
//     nudge_storm B1 gated by its B1 hold, pause/resume B3) fires only while
//     each target has a `<runId>.confirmed` hold and is still non-terminal;
//   * no target's `<runId>.release` exists at the instant any dependent phase
//     fires — release is strictly AFTER the last dependent phase resolves;
//   * a phase whose dependencies are absent is recorded `missed` (timed_out /
//     hold_missed), never fabricated satisfied;
//   * `releaseHoldsForRoster(ctx, state, ops, 'B', ['B5'])` releases the B5
//     stop/delete/relaunch lineage run (`relaunchOf: 'B5'`) as well.
//
// In-process only: real temp hold/campaign dirs, an injected advancing fake
// clock and an injected dispatch adapter. No daemon, scheduler, harness, model,
// campaign DB or production port is touched.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { newCampaignState } from "../bin/tt-storm-shared.mjs";
import {
  dispatchPhaseSchedule,
  holdConfirmation,
  holdPredicateVerdict,
  phaseTargetRosterIds,
  phaseWaitTargetRosterIds,
  releaseHoldsForRoster,
  resolveRosterTerminal,
} from "../bin/tt-storm-engine.mjs";
import { HOLD_ID, scriptedRoundBPhases } from "../bin/tt-storm-rehearsal.mjs";

const RUNS: Record<string, string> = {
  B1: "run-b1aaaaaa-0000-4000-8000-000000000001",
  B2: "run-b2aaaaaa-0000-4000-8000-000000000002",
  B3: "run-b3aaaaaa-0000-4000-8000-000000000003",
  B4: "run-b4aaaaaa-0000-4000-8000-000000000004",
  B5: "run-b5aaaaaa-0000-4000-8000-000000000005",
};
const B5_RELAUNCH = "run-b5relaun-0000-4000-8000-000000000006";

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

// The derived SCRIPTED_REHEARSAL schedule: 1s phase steps from the round start
// (the real B-cc1 offset is 900_000ms, so a derived run can never be mistaken
// for the real clock). Must be the exact projection bin/tt-storm consumes.
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
    campaignId: "camp-us004-roundb-live-target",
    clock,
    source: { repo: "/var/repo", branch: "test", commit: "0".repeat(40), tree: "0".repeat(40) },
    fixture: { name: "tt-poly", basis: "US-004 roundb-live-target self-test" },
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
  // actionPlan refuses a not-enabled pounding). poundIfDue is a no-op because
  // no ctx.opts.pounding config / transport adapter is injected.
  state.rounds.B.pounding = {
    active: true, notRunReason: null, cadenceMs: 30_000, latencyBoundMs: 2_000,
    lastPoundMs: null, rounds: 0, probes: 0, assertionFailures: 0, maxLatencyMs: 0,
  };
  return state;
}

// A derived phase's full structural target set: its hold predicate targets
// UNION its action roster targets (this is exactly the schedule's dependency
// set; nudge_storm has no action target but is gated by its B1 hold).
function phaseTargets(ph: any): string[] {
  return [...new Set([...phaseWaitTargetRosterIds(ph), ...phaseTargetRosterIds(ph.action)])];
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

function makeCtx({ holdDir, clock, campaignDir, dispatch, phaseWaitTimeoutMs }: any) {
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
      ...(phaseWaitTimeoutMs ? { phaseWaitTimeoutMs } : {}),
      ...(dispatch ? { dispatchPhaseAction: dispatch } : {}),
    },
  };
}

describe("tier2-storm-rehearsal-roundb-live-target (US-004)", () => {
  it("T1: every derived chaos phase fires against a confirmed, non-terminal target", async () => {
    const clock = makeClock(0);
    const campaignDir = makeTempDir("storm-rb-live-t1-camp-");
    const holdDir = makeTempDir("storm-rb-live-t1-hold-");
    const phases = derivedPhases();
    // The full roster is genuinely parked on its campaign hold.
    for (const runId of Object.values(RUNS)) confirmHold(holdDir, runId);

    // Snapshot the hold dir INSIDE the dispatch adapter: the instant the phase
    // action fires, before the engine writes any release.
    const snapshots: Record<string, any> = {};
    const ctx = makeCtx({
      holdDir, clock, campaignDir,
      dispatch: (c: any, s: any, _action: any, ph: any) => {
        const verdict = holdPredicateVerdict(c, s, ph);
        const targets: Record<string, any> = {};
        for (const rid of phaseTargets(ph)) {
          const runId = RUNS[rid];
          const term = resolveRosterTerminal(c, s, rid);
          targets[rid] = {
            runId,
            confirmedFile: fs.existsSync(path.join(holdDir, `${runId}.confirmed`)),
            confirmed: holdConfirmation(c, s, runId).confirmed,
            terminalAtFire: term.terminal === true,
            stateStatus: s.rounds.B.runs[rid].status,
          };
        }
        snapshots[ph.id] = { id: ph.id, released: releasedFor(holdDir), targets, verdict };
        return { ok: true, detail: { phase: ph.id } };
      },
    });
    const state = makeState(phases, clock);
    const ops = makeOps();

    await dispatchPhaseSchedule(ctx, state, ops, campaignDir, 0);

    assert.equal(Object.keys(snapshots).length, phases.length, "every derived phase was dispatched");
    for (const ph of phases) {
      const targets = phaseTargets(ph);
      assert.equal(state.rounds.B.phases[ph.id].status, "fired", `${ph.id} fired`);
      assert.equal(state.rounds.B.phases[ph.id].waitOutcome.outcome, "marker_satisfied", `${ph.id} gated by the live hold predicate (never evidence_error)`);
      assert.notEqual(state.rounds.B.phases[ph.id].waitOutcome.outcome, "evidence_error", `${ph.id} never evidence_error`);
      const snap = snapshots[ph.id];
      assert.equal(snap.verdict.outcome, "marker_satisfied", `${ph.id} holdPredicateVerdict satisfied at fire`);
      if (targets.length === 0) {
        assert.deepEqual(snap.targets, {}, `${ph.id} is control-only`);
        continue;
      }
      assert.ok(
        snap.verdict.targets.every((t: any) => t.confirmed === true && t.terminal === false),
        `${ph.id} hold verdict sees only confirmed, non-terminal targets`,
      );
      for (const rid of targets) {
        const t = snap.targets[rid];
        assert.equal(t.confirmedFile, true, `${rid} has a <runId>.confirmed hold at ${ph.id} fire`);
        assert.equal(t.confirmed, true, `${rid} is engine-confirmed at ${ph.id} fire`);
        assert.equal(t.terminalAtFire, false, `${rid} is non-terminal at ${ph.id} fire`);
        assert.equal(t.stateStatus, "registered");
        // (b) release-after-fire only: the release marker must not exist while
        // the phase is firing.
        assert.ok(!snap.released.includes(`${t.runId}.release`), `${rid} not released before ${ph.id} resolves`);
      }
    }
  });

  it("T2: the derived action-target matrix matches the real chaos phases", () => {
    const byId: Record<string, any> = {};
    for (const ph of derivedPhases()) byId[ph.id] = ph;
    // The exact action targets the story enumerates.
    assert.deepEqual(phaseTargetRosterIds(byId["B-cc1"].action), ["B1"]);
    assert.deepEqual(phaseTargetRosterIds(byId["B-cc2"].action), ["B3"]);
    assert.deepEqual(phaseTargetRosterIds(byId["B-pause"].action), ["B3"]);
    assert.deepEqual(phaseTargetRosterIds(byId["B-resume"].action), ["B3"]);
    assert.deepEqual(phaseTargetRosterIds(byId["B-kill"].action), ["B4"]);
    assert.deepEqual(phaseTargetRosterIds(byId["B-park"].action), ["B1", "B2", "B3", "B4"]); // dirty_tree_park -> shared live merge targets
    assert.deepEqual(phaseTargetRosterIds(byId["B-rugpull"].action), ["B1", "B2", "B3", "B4"]);
    assert.deepEqual(phaseTargetRosterIds(byId["B-stopdel"].action), ["B5"]);
    // nudge_storm is control-only; it is gated by its B1 wait target.
    assert.deepEqual(phaseTargetRosterIds(byId["B-nudge"].action), []);
    assert.deepEqual(phaseWaitTargetRosterIds(byId["B-nudge"]), ["B1"]);
    // US-008 (Requirement 4): the two phases that act on the shared live merge
    // target structurally WAIT on B1..B4, so they can only fire while those
    // runs are still held (B1..B4 release at B-bounce, after both).
    assert.deepEqual(phaseWaitTargetRosterIds(byId["B-rugpull"]), ["B1", "B2", "B3", "B4"]);
    assert.deepEqual(phaseWaitTargetRosterIds(byId["B-park"]), ["B1", "B2", "B3", "B4"]);
    assert.deepEqual(byId["B-rugpull"].release_targets, []);
    assert.deepEqual(byId["B-park"].release_targets, []);
    // Every derived phase carries the hold predicate, so the hold branch (not
    // the real injected probe) gates all of them.
    for (const ph of derivedPhases()) {
      assert.equal(ph.waitFor.kind, "hold", `${ph.id} uses the derived hold predicate`);
      assert.equal(ph.waitFor.marker, "hold-confirmed");
    }
  });

  it("T3: no derived phase releases a target before its last dependent phase resolves", async () => {
    const clock = makeClock(0);
    const campaignDir = makeTempDir("storm-rb-live-t3-camp-");
    const holdDir = makeTempDir("storm-rb-live-t3-hold-");
    const phases = derivedPhases();
    for (const runId of Object.values(RUNS)) confirmHold(holdDir, runId);

    const atFire: Record<string, string[]> = {};
    const ctx = makeCtx({
      holdDir, clock, campaignDir,
      dispatch: (_c: any, _s: any, _action: any, ph: any) => { atFire[ph.id] = releasedFor(holdDir); return { ok: true, detail: {} }; },
    });
    const state = makeState(phases, clock);
    const ops = makeOps();

    await dispatchPhaseSchedule(ctx, state, ops, campaignDir, 0);

    const order = phases.map((p: any) => p.id);
    const idxOf = new Map(order.map((id: string, i: number) => [id, i]));
    // The last derived phase that structurally depends on each roster id.
    const lastDep: Record<string, string> = {};
    for (const ph of phases) for (const rid of phaseTargets(ph)) lastDep[rid] = ph.id;
    // The schedule's own release_targets must agree with that last-dependent
    // set (never releases a target an earlier phase still needs).
    for (const ph of phases) {
      const expected = Object.entries(lastDep).filter(([, id]) => id === ph.id).map(([rid]) => rid).sort();
      assert.deepEqual([...ph.release_targets].sort(), expected, `${ph.id} release_targets is the last-dependent set`);
    }

    for (const [rid, lastPhase] of Object.entries(lastDep)) {
      const k = idxOf.get(lastPhase) as number;
      for (let j = 0; j < order.length; j += 1) {
        const has = atFire[order[j]].includes(`${RUNS[rid]}.release`);
        if (j <= k) {
          assert.ok(!has, `${rid} not released at or before its last dependent phase ${lastPhase} (observed at ${order[j]})`);
        } else {
          assert.ok(has, `${rid} released after ${lastPhase} (observed at ${order[j]})`);
        }
      }
    }

    // After the whole schedule every hold is released exactly once.
    assert.deepEqual(
      releasedFor(holdDir),
      Object.values(RUNS).map((r) => `${r}.release`).sort(),
      "every target released after its last dependent phase",
    );
    assert.equal(JSON.parse(fs.readFileSync(path.join(holdDir, `${RUNS.B5}.release`), "utf-8")).reason, "phase_fired:B-stopdel");
    assert.equal(JSON.parse(fs.readFileSync(path.join(holdDir, `${RUNS.B4}.release`), "utf-8")).reason, "phase_fired:B-bounce");
  });

  it("T4: a phase whose targets never confirm is recorded missed, never fired", async () => {
    const clock = makeClock(0);
    const campaignDir = makeTempDir("storm-rb-live-t4-camp-");
    const holdDir = makeTempDir("storm-rb-live-t4-hold-"); // empty: no confirmed holds
    const phases = derivedPhases();
    const fired: string[] = [];
    const ctx = makeCtx({
      holdDir, clock, campaignDir, phaseWaitTimeoutMs: 200,
      dispatch: (_c: any, _s: any, _action: any, ph: any) => { fired.push(ph.id); return { ok: true, detail: {} }; },
    });
    const state = makeState(phases, clock);
    const ops = makeOps();

    await dispatchPhaseSchedule(ctx, state, ops, campaignDir, 0);

    // Only the zero-target B-pounding control phase can fire; the engine never
    // fabricates a satisfied verdict for a target it never observed.
    assert.deepEqual(fired, ["B-pounding"], "only the control-only phase fires when no hold exists");
    for (const ph of phases) {
      if (phaseTargets(ph).length === 0) continue;
      assert.equal(state.rounds.B.phases[ph.id].status, "missed", `${ph.id} recorded missed`);
      assert.equal(state.rounds.B.phases[ph.id].waitOutcome.outcome, "timed_out", `${ph.id} honest timed_out`);
      assert.equal(ops.ofKind("phase.fired").filter((e: any) => e.id === ph.id).length, 0, `${ph.id} never fabricated fired`);
      assert.equal(ops.ofKind("phase.missed").filter((e: any) => e.id === ph.id).length, 1, `${ph.id} recorded missed once`);
    }
    // Direct predicate check: absent holds are not_yet, never satisfied.
    const stopdel = phases.find((p: any) => p.id === "B-stopdel");
    const v = holdPredicateVerdict(ctx, state, stopdel);
    assert.equal(v.satisfied, false);
    assert.equal(v.outcome, "not_yet");
  });

  it("T5: a runtime-missed hold makes the dependent phases hold_missed, never fired", async () => {
    const clock = makeClock(0);
    const campaignDir = makeTempDir("storm-rb-live-t5-camp-");
    const holdDir = makeTempDir("storm-rb-live-t5-hold-");
    const phases = derivedPhases();
    for (const runId of Object.values(RUNS)) confirmHold(holdDir, runId);
    // B2's runtime bounded hold timeout elapsed and it reported a missed hold.
    missHold(holdDir, RUNS.B2, "runtime hold timeout after 1800000ms");

    const fired: string[] = [];
    const ctx = makeCtx({
      holdDir, clock, campaignDir,
      dispatch: (_c: any, _s: any, _action: any, ph: any) => { fired.push(ph.id); return { ok: true, detail: {} }; },
    });
    const state = makeState(phases, clock);
    const ops = makeOps();

    await dispatchPhaseSchedule(ctx, state, ops, campaignDir, 0);

    // B-park now targets the SHARED merge target (B1..B4), so a dead B2 hold
    // also makes it structurally unsatisfiable; the other phases whose
    // predicate/action targets do not include B2 still fire.
    for (const id of ["B-stopdel", "B-rugpull", "B-bounce", "B-park"]) {
      assert.equal(state.rounds.B.phases[id].status, "missed", `${id} missed`);
      assert.equal(state.rounds.B.phases[id].waitOutcome.outcome, "hold_missed", `${id} surfaces the runtime miss immediately`);
      assert.match(String(state.rounds.B.phases[id].waitOutcome.reason), new RegExp(RUNS.B2));
      assert.ok(!fired.includes(id), `${id} never fires on a dead hold`);
    }
    // Phases that do not depend on B2 still fire against their live holds.
    for (const id of ["B-pounding", "B-cc1", "B-nudge", "B-pause", "B-resume", "B-kill", "B-cc2"]) {
      assert.equal(state.rounds.B.phases[id].status, "fired", `${id} fired`);
    }
    assert.ok(ops.ofKind("phase.missed").some((e: any) => e.id === "B-rugpull" && e.outcome === "hold_missed"));
  });

  it("T6: releaseHoldsForRoster('B5') releases the original B5 run AND its relaunch lineage", () => {
    const clock = makeClock(0);
    const campaignDir = makeTempDir("storm-rb-live-t6-camp-");
    const holdDir = makeTempDir("storm-rb-live-t6-hold-");
    const ctx = makeCtx({ holdDir, clock, campaignDir });
    const state = makeState(derivedPhases(), clock);
    // The B5 stop/delete/relaunch lineage: a relaunch record whose relaunchOf
    // names the B5 roster id, with its own fresh run id.
    state.rounds.B.runs["B5-relaunch"] = {
      rosterId: "B5-relaunch", run: "storm-b5-donow", workflow: "do-now",
      runId: B5_RELAUNCH, status: "registered", relaunchOf: "B5",
    };
    confirmHold(holdDir, RUNS.B5);
    confirmHold(holdDir, B5_RELAUNCH);
    confirmHold(holdDir, RUNS.B1); // an unrelated live hold must stay parked
    const ops = makeOps();

    const released = releaseHoldsForRoster(ctx, state, ops, "B", ["B5"]);

    assert.deepEqual([...released].sort(), [RUNS.B5, B5_RELAUNCH].sort(), "original B5 and its relaunch are both released");
    assert.ok(fs.existsSync(path.join(holdDir, `${RUNS.B5}.release`)), "original B5 released");
    assert.ok(fs.existsSync(path.join(holdDir, `${B5_RELAUNCH}.release`)), "relaunch lineage released");
    assert.ok(!fs.existsSync(path.join(holdDir, `${RUNS.B1}.release`)), "unrelated B1 hold untouched");
    assert.deepEqual(releasedFor(holdDir), [`${RUNS.B5}.release`, `${B5_RELAUNCH}.release`].sort());
    const releasedOps = ops.ofKind("hold.released").map((e: any) => e.runId).sort();
    assert.deepEqual(releasedOps, [RUNS.B5, B5_RELAUNCH].sort());
  });
});
