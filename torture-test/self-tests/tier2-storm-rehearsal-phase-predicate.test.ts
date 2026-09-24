// Tier-2 STORM-REHEARSAL US-010 — structurally-unsatisfiable Round B phase
// predicates are declared MISSED immediately (SF-5).
//
// Attempt 3 took 153 minutes because NINE Round B phases each waited the full
// 180s phase bound although their predicate could never be satisfied: every run
// they depended on was already terminal (feature-dev / bug-fix runs burned
// through, so `cc1-landed`, `pause-b3-acked`, `B1-B4 pre-finalize`,
// `rugpull-recovered`, etc. could never materialize).
//
// US-010 adds a structural-satisfiability short-circuit to
// waitForPhaseEvidence: after the marker has been probed once and found not
// satisfied, if EVERY run the predicate depends on (declared on
// `waitFor.target`/`waitFor.targets`, else the action's own target) is already
// terminal, the wait returns `{ satisfied:false, outcome:'run_terminal' }`
// immediately with a reason naming the terminal run(s). A satisfied marker
// still wins; a genuinely pending predicate keeps the configured phase bound
// and the 500ms pounding cadence; an UNKNOWN (evidence_error) probe is never
// folded into run_terminal.
//
// This file is hermetic: recording fakes for fs/clock/db + an injected marker
// probe. No daemon, scheduler, harness, model token or production port is
// ever touched.
//
// Coverage (acceptance criteria of US-010):
//   P1 phaseWaitTargetRosterIds prefers the predicate's declared target(s) and
//      falls back to the action target; control-only phases resolve [];
//   P2 all targets terminal + marker not satisfied -> run_terminal immediately
//      (zero phase-wait sleeps, reason names the terminal run id);
//   P3 target runs still pending -> the configured bound is honoured
//      (timed_out after ~timeoutMs), and a late-materializing marker still
//      returns marker_satisfied;
//   P4 an already-satisfied marker is never short-circuited to run_terminal;
//   P5 dispatchPhaseSchedule records the phase 'missed' with outcome
//      run_terminal and a reason naming the terminal run(s);
//   P6 the nine unsatisfiable Round B phases from attempt 3 each resolve in a
//      single poll against the synthetic all-terminal run set (one phase,
//      B-cc1, has a satisfied marker and is exempt).

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { newCampaignState } from "../bin/tt-storm-shared.mjs";
import {
  ROUND_B_PHASES,
  dispatchPhaseSchedule,
  phaseWaitTargetRosterIds,
  resolvePhaseWaitTargetsTerminal,
  waitForPhaseEvidence,
} from "../bin/tt-storm-engine.mjs";

// ─────────────────────────────────────────────────────────────────────
// Recording adapters.
// ─────────────────────────────────────────────────────────────────────

function makeFakeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>();
  for (const [k, v] of Object.entries(initial)) files.set(path.normalize(k), String(v));
  const dirs = new Set<string>(["/", "/var", "/var/results"]);
  const ops: Array<[string, string]> = [];
  const fsx: any = {
    files, dirs, ops,
    existsSync: (p: string) => files.has(path.normalize(String(p))) || dirs.has(path.normalize(String(p))),
    readFileSync: (p: string) => {
      const k = path.normalize(String(p));
      const v = files.get(k);
      if (v === undefined) throw new Error(`FakeFS: no such file ${k}`);
      return v;
    },
    readFile: async (p: string) => fsx.readFileSync(p),
    writeFileSync: (p: string, data: string) => {
      const k = path.normalize(String(p));
      ops.push(["write", k]);
      files.set(k, String(data));
      let d = path.dirname(k);
      while (d !== "/" && d !== "." && !dirs.has(d)) { dirs.add(d); d = path.dirname(d); }
      dirs.add("/");
    },
    appendFileSync: (p: string, data: string) => {
      const k = path.normalize(String(p));
      ops.push(["append", k]);
      files.set(k, (files.get(k) ?? "") + String(data));
      let d = path.dirname(k);
      while (d !== "/" && !dirs.has(d)) { dirs.add(d); d = path.dirname(d); }
      dirs.add("/");
    },
    mkdirSync: (p: string) => {
      const k = path.normalize(String(p));
      ops.push(["mkdir", k]);
      let d = k;
      while (d !== "/") { dirs.add(d); d = path.dirname(d); }
      dirs.add("/");
    },
    renameSync: (a: string, b: string) => {
      const ka = path.normalize(String(a));
      const kb = path.normalize(String(b));
      if (!files.has(ka)) throw new Error(`FakeFS: rename source missing ${ka}`);
      files.set(kb, files.get(ka)!);
      files.delete(ka);
    },
    realpathSync: (p: string) => path.normalize(String(p)),
    statSync: (p: string) => {
      const k = path.normalize(String(p));
      if (!files.has(k) && !dirs.has(k)) throw new Error(`FakeFS: stat missing ${k}`);
      return { isDirectory: () => dirs.has(k), isFile: () => files.has(k), dev: 1, ino: 1 };
    },
    lstatSync: (p: string) => fsx.statSync(p),
    readdirSync: () => [],
    resolve: (p: string) => path.normalize(String(p)),
  };
  return fsx;
}

function makeFakeClock(startMs = 0) {
  let ms = startMs;
  const sleeps: Array<{ n: number; reason?: string }> = [];
  const clock: any = {
    sleeps,
    nowMs: () => ms,
    nowUtc: () => new Date(ms).toISOString(),
    sleep: async (n: number, reason?: string) => { sleeps.push({ n, reason }); ms += n; },
    advance: (n: number) => { ms += n; },
  };
  return clock;
}

const RUNS = {
  B1: "run-b1aaaaaa-0000-4000-8000-000000000001",
  B2: "run-b2aaaaaa-0000-4000-8000-000000000002",
  B3: "run-b3aaaaaa-0000-4000-8000-000000000003",
  B4: "run-b4aaaaaa-0000-4000-8000-000000000004",
  B5: "run-b5aaaaaa-0000-4000-8000-000000000005",
};

const CAMPAIGN_DIR = "/var/results/camp-us010-phase-predicate";

// The synthetic terminal-run set: every B run is terminal in the campaign DB.
function makeFakeDb({ clock, terminalAtByRun = {} }: { clock: any; terminalAtByRun?: Record<string, number> }) {
  const ids = Object.values(RUNS);
  return {
    open: () => ({
      ok: true,
      api: {
        getRun: (runId: string) => {
          if (!ids.includes(runId)) return undefined;
          const at = terminalAtByRun[runId] ?? 0; // default: terminal immediately
          const status = clock.nowMs() >= at ? "completed" : "running";
          return { id: runId, status };
        },
        listRuns: () => [],
        activeStepsForRuns: () => [],
        activeTimerCount: () => [],
        close: () => {},
      },
    }),
  };
}

function makeState(clock: any) {
  const state: any = newCampaignState({
    campaignId: "camp-us010-phase-predicate",
    clock,
    source: { repo: "/var/repo", branch: "test", commit: "0".repeat(40), tree: "0".repeat(40) },
    fixture: { name: "tt-poly", basis: "US-010 phase-predicate self-test" },
  });
  state.plan = {
    launches: [],
    fixtureIdentity: {
      originRepo: "/var/fixtures/origin",
      colleagueRepo: "/var/fixtures/colleague",
      parkRepo: "/var/fixtures/park",
      cc1File: "docs/cc1.md",
      cc2File: "client-store.ts",
    },
  };
  state.rounds.B.runs = {
    B1: { rosterId: "B1", run: "storm-b1", workflow: "feature-dev-merge-worktree", runId: RUNS.B1, status: "registered" },
    B2: { rosterId: "B2", run: "storm-b2", workflow: "feature-dev-merge-worktree", runId: RUNS.B2, status: "registered" },
    B3: { rosterId: "B3", run: "storm-b3", workflow: "bug-fix-merge-worktree", runId: RUNS.B3, status: "registered" },
    B4: { rosterId: "B4", run: "storm-b4", workflow: "bug-fix-merge-worktree", runId: RUNS.B4, status: "registered" },
    B5: { rosterId: "B5", run: "storm-b5", workflow: "do-now", runId: RUNS.B5, status: "registered" },
  };
  return state;
}

// A probe whose verdict is controlled per-phase. Default: marker not observed
// yet (a healthy channel, condition absent) — exactly the attempt-3 terminal
// case before US-010 burned the whole bound.
function makeProbe(byPhase: Record<string, any> = {}) {
  return (_ctx: any, _state: any, ph: any) =>
    byPhase[ph.id] ?? { satisfied: false, outcome: "not_yet", marker: ph.waitFor?.marker ?? ph.waitFor?.kind };
}

function makeCtx({ fsx, clock, probe, phaseWaitTimeoutMs }: any) {
  return {
    fs: fsx,
    clock,
    varRoot: "/var",
    campaignDir: CAMPAIGN_DIR,
    db: makeFakeDb({ clock }),
    git: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    proc: {
      launchWorkflow: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      tamandua: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      chaosAction: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      daemonControl: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    },
    opts: {
      launchCwd: "/var/launch-cwd",
      phaseWaitTimeoutMs,
      probePhaseMarker: probe,
    },
  };
}

function phaseWaitSleeps(clock: any, phaseId: string) {
  return clock.sleeps.filter((s: any) => String(s.reason ?? "").startsWith(`phase-wait ${phaseId}`));
}

const EVIDENCE_GATED = ROUND_B_PHASES.filter((ph: any) => ph.waitFor?.kind !== "none");

// ─────────────────────────────────────────────────────────────────────

describe("US-010 structurally-unsatisfiable Round B phases MISSED immediately (SF-5)", () => {
  it("P1: phaseWaitTargetRosterIds prefers declared predicate targets and falls back to the action target", () => {
    // Declared waitFor.targets win (B-nudge depends on B1's cc1 landing).
    assert.deepEqual(phaseWaitTargetRosterIds(ROUND_B_PHASES.find((p: any) => p.id === "B-nudge")), ["B1"]);
    // B-stopdel's marker (other-four-mid-flight) is tied to B1..B4, not B5.
    assert.deepEqual(phaseWaitTargetRosterIds(ROUND_B_PHASES.find((p: any) => p.id === "B-stopdel")), ["B1", "B2", "B3", "B4"]);
    // B-bounce's marker (rugpull-recovered) is tied to the rugpull targets.
    assert.deepEqual(phaseWaitTargetRosterIds(ROUND_B_PHASES.find((p: any) => p.id === "B-bounce")), ["B1", "B2", "B3", "B4"]);
    // Fallback to the action target when the predicate declares none.
    assert.deepEqual(phaseWaitTargetRosterIds(ROUND_B_PHASES.find((p: any) => p.id === "B-pause")), ["B3"]);
    assert.deepEqual(phaseWaitTargetRosterIds(ROUND_B_PHASES.find((p: any) => p.id === "B-park")), ["B1", "B2", "B3", "B4"]);
    // Control-only phases have nothing to short-circuit on.
    assert.deepEqual(phaseWaitTargetRosterIds(ROUND_B_PHASES.find((p: any) => p.id === "B-pounding")), []);
  });

  it("P2: all target runs terminal + marker not satisfied -> run_terminal immediately, zero phase-wait sleeps", async () => {
    const fsx = makeFakeFs();
    const clock = makeFakeClock(0);
    const state = makeState(clock);
    const ph = ROUND_B_PHASES.find((p: any) => p.id === "B-nudge");
    const ctx = makeCtx({ fsx, clock, probe: makeProbe(), phaseWaitTimeoutMs: 180_000 });

    const ev = await waitForPhaseEvidence(ctx, state, ph);

    assert.equal(ev.satisfied, false);
    assert.equal(ev.outcome, "run_terminal", "a terminal dependency set short-circuits the bound");
    assert.match(String(ev.reason), new RegExp(RUNS.B1), "the reason names the terminal target run id");
    assert.match(String(ev.reason), /cc1-landed/, "the reason names the phase predicate");
    assert.equal(phaseWaitSleeps(clock, "B-nudge").length, 0, "no 500ms phase-wait poll was needed");
    assert.equal(clock.nowMs(), 0, "no 180s elapsed on the injected clock");
    assert.equal(ev.targets.find((t: any) => t.rosterId === "B1")?.status, "completed");
  });

  it("P2b: resolvePhaseWaitTargetsTerminal is terminal only when EVERY dependency is terminal", () => {
    const clock = makeFakeClock(0);
    const state = makeState(clock);
    // One live dependency (B2) keeps the wait.
    const liveCtx = makeCtx({
      fsx: makeFakeFs(), clock, probe: makeProbe(), phaseWaitTimeoutMs: 1000,
    });
    liveCtx.db = makeFakeDb({ clock, terminalAtByRun: { [RUNS.B2]: 10 * 60_000 } });
    assert.equal(resolvePhaseWaitTargetsTerminal(liveCtx, state, ROUND_B_PHASES.find((p: any) => p.id === "B-bounce")).terminal, false);
    clock.advance(11 * 60_000);
    assert.equal(resolvePhaseWaitTargetsTerminal(liveCtx, state, ROUND_B_PHASES.find((p: any) => p.id === "B-bounce")).terminal, true);
  });

  it("P3: pending target runs keep the configured bound; a late marker still wins", async () => {
    const fsx = makeFakeFs();
    const clock = makeFakeClock(0);
    const state = makeState(clock);
    const ph = ROUND_B_PHASES.find((p: any) => p.id === "B-nudge");
    // B1 stays live for the whole bound.
    const ctx = makeCtx({ fsx, clock, probe: makeProbe(), phaseWaitTimeoutMs: 2_000 });
    ctx.db = makeFakeDb({ clock, terminalAtByRun: { [RUNS.B1]: 10 * 60_000 } });

    const ev = await waitForPhaseEvidence(ctx, state, ph);
    assert.equal(ev.outcome, "timed_out", "a genuinely pending predicate keeps the bound");
    assert.ok(clock.nowMs() >= 2_000, `the configured bound was honoured (elapsed ${clock.nowMs()}ms)`);
    assert.ok(phaseWaitSleeps(clock, "B-nudge").length > 0, "the 500ms poll cadence still ran");

    // Now a marker that materializes on the second poll returns marker_satisfied.
    const fsx2 = makeFakeFs();
    const clock2 = makeFakeClock(0);
    const ctx2 = makeCtx({ fsx: fsx2, clock: clock2, probe: makeProbe(), phaseWaitTimeoutMs: 180_000 });
    // The dependency stays live, so the terminal short-circuit cannot fire and
    // the wait keeps polling until the marker appears.
    ctx2.db = makeFakeDb({ clock: clock2, terminalAtByRun: { [RUNS.B1]: 10 * 60_000 } });
    let calls = 0;
    ctx2.opts.probePhaseMarker = (_c: any, _s: any, p: any) => {
      calls += 1;
      if (calls < 2) return { satisfied: false, outcome: "not_yet", marker: p.waitFor?.marker };
      return { satisfied: true, outcome: "marker_satisfied", marker: p.waitFor?.marker, evidence: "materialized" };
    };
    const ev2 = await waitForPhaseEvidence(ctx2, makeState(clock2), ph);
    assert.equal(ev2.outcome, "marker_satisfied");
    assert.equal(calls, 2);

    // With no explicit phaseWaitTimeoutMs the engine uses its 180s default.
    const fsx3 = makeFakeFs();
    const clock3 = makeFakeClock(0);
    const ctx3 = makeCtx({ fsx: fsx3, clock: clock3, probe: makeProbe() });
    ctx3.db = makeFakeDb({ clock: clock3, terminalAtByRun: { [RUNS.B1]: 10 * 60_000 } });
    const ev3 = await waitForPhaseEvidence(ctx3, makeState(clock3), ph);
    assert.equal(ev3.outcome, "timed_out");
    assert.equal(clock3.nowMs(), 180_000, "the default 180s bound is honoured for a pending predicate");
  });

  it("P4: an already-satisfied marker is never short-circuited to run_terminal, even with terminal targets", async () => {
    const fsx = makeFakeFs();
    const clock = makeFakeClock(0);
    const state = makeState(clock);
    const ph = ROUND_B_PHASES.find((p: any) => p.id === "B-cc1");
    const ctx = makeCtx({
      fsx, clock, phaseWaitTimeoutMs: 180_000,
      probe: (_c: any, _s: any, p: any) => ({ satisfied: true, outcome: "marker_satisfied", marker: p.waitFor?.marker, evidence: "round B registered 5/5" }),
    });

    const ev = await waitForPhaseEvidence(ctx, state, ph);
    assert.equal(ev.satisfied, true);
    assert.equal(ev.outcome, "marker_satisfied", "a satisfied marker wins over the terminal short-circuit");
    assert.equal(phaseWaitSleeps(clock, "B-cc1").length, 0);
  });

  it("P4b: an UNKNOWN (evidence_error) probe is never folded into run_terminal", async () => {
    const fsx = makeFakeFs();
    const clock = makeFakeClock(0);
    const state = makeState(clock);
    const ph = ROUND_B_PHASES.find((p: any) => p.id === "B-nudge");
    const ctx = makeCtx({ fsx, clock, probe: makeProbe(), phaseWaitTimeoutMs: 1_000 });
    ctx.opts.probePhaseMarker = (_c: any, _s: any, p: any) => ({ satisfied: false, outcome: "evidence_error", marker: p.waitFor?.marker, reason: "ref channel unreadable" });

    const ev = await waitForPhaseEvidence(ctx, state, ph);
    assert.equal(ev.outcome, "evidence_error", "UNKNOWN handling is unchanged — never a fabricated run_terminal");
    assert.match(String(ev.reason), /ref channel unreadable/);
  });

  it("P5: dispatchPhaseSchedule records a terminal-target phase 'missed' with outcome run_terminal", async () => {
    const fsx = makeFakeFs();
    const clock = makeFakeClock(0);
    const state = makeState(clock);
    fsx.writeFileSync(path.join(CAMPAIGN_DIR, "state.json"), JSON.stringify(state));
    // B-cc1's marker is satisfied (the runs registered); every other phase's
    // marker is absent and its dependencies are terminal.
    const ctx = makeCtx({
      fsx, clock, phaseWaitTimeoutMs: 180_000,
      probe: (c: any, s: any, p: any) => makeProbe({
        "B-cc1": { satisfied: true, outcome: "marker_satisfied", marker: p.waitFor?.marker, evidence: "registered 5/5" },
      })(c, s, p),
    });
    const records: any[] = [];
    const ops = { record: (kind: string, detail: any = {}) => { records.push({ kind, ...detail }); return ""; } };

    await dispatchPhaseSchedule(ctx, state, ops, CAMPAIGN_DIR, 0);

    const nudge = state.rounds.B.phases["B-nudge"];
    assert.equal(nudge.status, "missed", "a structurally unsatisfiable phase is recorded missed");
    assert.equal(nudge.waitOutcome.outcome, "run_terminal");
    assert.match(String(nudge.waitOutcome.reason), new RegExp(RUNS.B1));
    const missed = records.find((r) => r.kind === "phase.missed" && r.id === "B-nudge");
    assert.ok(missed, "phase.missed is recorded in ops.jsonl");
    assert.equal(missed.outcome, "run_terminal");
    assert.match(String(missed.reason), new RegExp(RUNS.B1));
    // The satisfied-marker phase was not short-circuited; it was dispatched
    // (and, since B1 is terminal, recorded first-class NOT_RUN by US-009).
    assert.equal(state.rounds.B.phases["B-cc1"].waitOutcome.outcome, "marker_satisfied");
  });

  it("P6: the nine attempt-3-unsatisfiable phases each resolve in one poll (B-cc1's satisfied marker exempt)", async () => {
    const state = makeState(makeFakeClock(0));
    let runTerminal = 0;
    let satisfied = 0;
    for (const ph of EVIDENCE_GATED) {
      const clock = makeFakeClock(0);
      const fsx = makeFakeFs();
      // All B runs terminal in this synthetic set; only B-cc1's marker is
      // already satisfied (the launches registered before the storm).
      const ctx = makeCtx({
        fsx, clock, phaseWaitTimeoutMs: 180_000,
        probe: (c: any, s: any, p: any) => (p.id === "B-cc1"
          ? { satisfied: true, outcome: "marker_satisfied", marker: p.waitFor?.marker }
          : { satisfied: false, outcome: "not_yet", marker: p.waitFor?.marker }),
      });
      const ev = await waitForPhaseEvidence(ctx, state, ph);
      if (ph.id === "B-cc1") {
        assert.equal(ev.outcome, "marker_satisfied");
        satisfied += 1;
      } else {
        assert.equal(ev.outcome, "run_terminal", `${ph.id} must short-circuit against the terminal run set`);
        assert.match(String(ev.reason), /run-/, `${ph.id}'s reason names a terminal run`);
        runTerminal += 1;
      }
      assert.equal(phaseWaitSleeps(clock, ph.id).length, 0, `${ph.id} resolved without a 500ms poll`);
      assert.equal(clock.nowMs(), 0, `${ph.id} resolved without any elapsed bound`);
    }
    assert.equal(satisfied, 1, "exactly one evidence-gated phase had an already-satisfied marker");
    assert.equal(runTerminal, 9, "the nine unsatisfiable Round B phases from attempt 3 resolve in one poll each");
  });
});
