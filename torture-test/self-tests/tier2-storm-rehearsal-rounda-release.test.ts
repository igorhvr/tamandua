// Tier-2 STORM-REHEARSAL FIX-4 US-007 — Round A hold release after the
// eight-concurrent window (SF-7 / SF-8), fail-closed.
//
// US-006 starts the standalone simultaneity sampler at S1's launch so the whole
// staggered window is observed. US-007 wires that observation to the HOLDS the
// scripted runs park on: the runs stay claimed/alive until the engine samples a
// zero-unknown sample where every active S1..S8 run is claimed, then S1..S8 are
// released. If the window never materializes, the bounded deadline releases
// them with the HONEST observed peak (never the configured 8), so a stuck
// engine can never leave a run held forever (requirements 1a/1b/1d).
//
// In-process only: a real temp-dir fs for the campaign/hold dirs, an injected
// controllable fake clock, a recording ops recorder and synthetic state. No
// daemon, scheduler, harness, model or port is ever touched.
//
// Coverage:
//   A  roundAWindowObserved is true ONLY for a zero-unknown sample where every
//      active S1..S8 run is claimed and at least 8 are sampled (never dropping
//      a roster run that lacks a run id);
//   B  awaitRoundAWindowRelease never releases before the window sample, then
//      releases S1..S8 with outcome 'window_observed';
//   C  the bounded deadline path releases S1..S8 with outcome 'window_timeout'
//      and records the HONEST observed peak without flipping the verdict;
//   D  an admitted queued S9/S10 run's hold is released on admission (reason
//      'queued_admitted_after_window') and the real-storm path is unchanged.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  awaitRoundAWindowRelease,
  observeQueuedAdmission,
  roundAWindowObserved,
  simultaneityVerdict,
} from "../bin/tt-storm-engine.mjs";

const ACTIVE = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"];
const RUN_ID = (rosterId: string) => `run-${rosterId}`;

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

async function flush(n = 30) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

// Controllable fake clock: sleep() parks until the test releases the next due
// waiter (advancing virtual time), so the poll loop can be interleaved with
// synthetic samples. Mirrors the simultaneity-window self-test.
function makeFakeClock(startMs = 0) {
  let now = startMs;
  const waiters: { at: number; resolve: () => void }[] = [];
  return {
    nowMs: () => now,
    nowUtc: () => new Date(now).toISOString(),
    setNow: (ms: number) => { now = ms; },
    pendingSleeps: () => waiters.length,
    sleep(ms: number, _label = "") {
      return new Promise<void>((resolve) => { waiters.push({ at: now + ms, resolve }); });
    },
    async releaseNext() {
      if (waiters.length === 0) return false;
      waiters.sort((a, b) => a.at - b.at);
      const w = waiters.shift()!;
      now = Math.max(now, w.at);
      w.resolve();
      await flush();
      return true;
    },
    async settle(target: any, maxIterations = 2000) {
      const promise = target?.promise ?? target;
      let settled = false;
      promise.then(() => { settled = true; }, () => { settled = true; });
      for (let i = 0; i < maxIterations && !settled; i += 1) {
        await flush(5);
        if (settled) break;
        if (waiters.length > 0) await this.releaseNext();
      }
      await promise;
      return settled;
    },
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

function sample(activeCount: number, overrides: any = {}) {
  const perRun: Record<string, any> = {};
  ACTIVE.forEach((id, i) => {
    perRun[RUN_ID(id)] = { runId: RUN_ID(id), present: true, claimed: i < activeCount, status: "running" };
  });
  return {
    ts: "2026-01-01T00:00:00.000Z",
    atMs: 0,
    round: "A",
    intervalMs: 15000,
    configured: ACTIVE.length,
    active: activeCount,
    unknown: 0,
    perRun,
    ...overrides,
  };
}

function makeState({ withRunIds = true, samples = [] as any[] } = {}) {
  const runs: Record<string, any> = {};
  for (const id of ACTIVE) {
    runs[id] = {
      rosterId: id,
      status: "registered",
      runId: withRunIds ? RUN_ID(id) : (id === "S8" ? null : RUN_ID(id)),
      queued: false,
    };
  }
  return {
    campaign_id: "storm-rounda-release-test",
    rehearsal: { hold_schedule: { hold_id: "storm-midflight", round_a: { window_deadline_ms: 2_400_000 } } },
    rounds: {
      A: { runs, status: "running", pounding: undefined },
      B: { runs: {}, status: "pending", pounding: undefined },
    },
    sampler: { samples, peak_observed: null },
    plan: { launches: [] },
    queue: { attempts: [], first_capacity_at: null, s10_admitted_at: null },
  } as any;
}

function releasedFor(holdDir: string) {
  return fs.readdirSync(holdDir).filter((f) => f.endsWith(".release")).sort();
}

describe("tier2-storm-rehearsal-rounda-release (US-007, SF-7/SF-8)", () => {
  it("A: roundAWindowObserved requires a zero-unknown sample with every active S1..S8 claimed", () => {
    // No samples at all.
    assert.equal(roundAWindowObserved(makeState()), false);

    // A window sample: 8 sampled, zero unknown, all eight claimed.
    assert.equal(roundAWindowObserved(makeState({ samples: [sample(8)] })), true);

    // UNKNOWN identity in the sample -> never a window.
    assert.equal(roundAWindowObserved(makeState({ samples: [sample(8, { unknown: 1 })] })), false);

    // Fewer than 8 sampled -> never a window.
    assert.equal(roundAWindowObserved(makeState({ samples: [sample(8, { configured: 7 })] })), false);

    // One run not claimed -> never a window (all active runs must be claimed).
    const notAll = sample(8);
    notAll.perRun[RUN_ID("S5")].claimed = false;
    notAll.active = 7;
    assert.equal(roundAWindowObserved(makeState({ samples: [notAll] })), false);

    // A roster run WITHOUT a run id makes the window unobservable: it must not
    // be silently dropped from the id set (the exact verdict honesty rule).
    assert.equal(roundAWindowObserved(makeState({ withRunIds: false, samples: [sample(8)] })), false);

    // A non-A sample is ignored.
    assert.equal(roundAWindowObserved(makeState({ samples: [sample(8, { round: "B" })] })), false);

    // A good sample anywhere in the list wins even after bad ones.
    const bad = sample(8);
    bad.perRun[RUN_ID("S1")].claimed = false;
    assert.equal(roundAWindowObserved(makeState({ samples: [bad, sample(8)] })), true);
  });

  it("B: releases S1..S8 only after a real window sample; never before", async () => {
    const clock = makeFakeClock(1_000_000);
    const campaignDir = makeTempDir("storm-rounda-camp-");
    const holdDir = makeTempDir("storm-rounda-hold-");
    const ctx: any = { fs, clock, opts: { holdDir } };
    const ops = makeOps();
    const state = makeState();

    const run = awaitRoundAWindowRelease(ctx, state, ops, campaignDir, {
      deadlineMs: 1_000_000 + 600_000,
      pollMs: 1000,
    });
    await flush();

    // (a) parked on the poll, NOTHING released yet.
    assert.equal(clock.pendingSleeps(), 1, "poller parked on the 1s cadence");
    assert.deepEqual(releasedFor(holdDir), [], "no release before the window");

    // A non-window sample (unknown identity) still does not release.
    state.sampler.samples.push(sample(8, { unknown: 1 }));
    await clock.releaseNext();
    assert.deepEqual(releasedFor(holdDir), [], "unknown sample never releases");

    // A not-all-claimed sample still does not release.
    const partial = sample(8);
    partial.perRun[RUN_ID("S7")].claimed = false;
    partial.active = 7;
    state.sampler.samples.push(partial);
    await clock.releaseNext();
    assert.deepEqual(releasedFor(holdDir), [], "partial window never releases");

    // (b) the real window sample -> every active S1..S8 hold is released.
    state.sampler.samples.push(sample(8));
    await clock.settle(run);

    const result = await run;
    assert.equal(result.outcome, "window_observed");
    assert.equal(result.observedPeak, 8);
    assert.deepEqual(
      releasedFor(holdDir),
      ACTIVE.map((id) => `${RUN_ID(id)}.release`).sort(),
      "every active S1..S8 hold released after the window",
    );
    const payload = JSON.parse(fs.readFileSync(path.join(holdDir, `${RUN_ID("S1")}.release`), "utf-8"));
    assert.equal(payload.reason, "round_a_window_observed");
    assert.equal(payload.holdId, "storm-midflight");
    assert.equal(state.holds.round_a.outcome, "window_observed");
    assert.equal(state.holds.round_a.observedPeak, 8);

    // The real window sample flips the existing verdict/report honestly.
    assert.equal(simultaneityVerdict(state).eightConcurrentWindowObserved, true);
    const recorded = ops.ofKind("hold.round_a_window");
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].outcome, "window_observed");
  });

  it("C: the bounded deadline releases all and records the HONEST peak (never inflating)", async () => {
    const clock = makeFakeClock(0);
    const campaignDir = makeTempDir("storm-rounda-camp-");
    const holdDir = makeTempDir("storm-rounda-hold-");
    const ctx: any = { fs, clock, opts: { holdDir } };
    const ops = makeOps();
    // A real-but-partial sample: only 3 of the 8 were ever simultaneously
    // claimed, so the honest observed peak is 3.
    const state = makeState({ samples: [sample(3)] });

    const run = awaitRoundAWindowRelease(ctx, state, ops, campaignDir, {
      deadlineMs: 3000,
      pollMs: 1000,
    });
    await clock.settle(run);
    const result = await run;

    assert.equal(result.outcome, "window_timeout");
    assert.equal(result.observedPeak, 3, "honest observed peak, never the configured 8");
    assert.deepEqual(
      releasedFor(holdDir),
      ACTIVE.map((id) => `${RUN_ID(id)}.release`).sort(),
      "deadline fail-closed releases every active S1..S8 hold",
    );
    const payload = JSON.parse(fs.readFileSync(path.join(holdDir, `${RUN_ID("S2")}.release`), "utf-8"));
    assert.equal(payload.reason, "round_a_window_timeout");
    assert.equal(state.holds.round_a.outcome, "window_timeout");
    assert.equal(state.holds.round_a.observedPeak, 3);

    // The verdict is NOT flipped by the timeout release.
    const verdict = simultaneityVerdict(state);
    assert.equal(verdict.eightConcurrentWindowObserved, false);
    assert.equal(verdict.observedPeak, 3);
    const recorded = ops.ofKind("hold.round_a_window");
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].outcome, "window_timeout");
    assert.equal(recorded[0].observedPeak, 3);
  });

  it("D: an admitted queued S9/S10 hold is released on admission (real path unchanged)", async () => {
    const clock = makeFakeClock(0);
    const campaignDir = makeTempDir("storm-rounda-camp-");
    const holdDir = makeTempDir("storm-rounda-hold-");
    const ctx: any = { fs, clock, opts: { holdDir }, db: { open: () => ({ ok: false }) } };
    const ops = makeOps();
    const state = makeState();
    state.rounds.A.runs.S9 = { rosterId: "S9", runId: RUN_ID("S9"), status: "registered", queued: true, admission: [] };
    const runRec = state.rounds.A.runs.S9;
    const launch = { rosterId: "S9", queued: true, demand: 4, timers: 4 };

    await observeQueuedAdmission(ctx, state, ops, launch, runRec, campaignDir, {
      admission: { state: "active", freeSlots: 10, maxActiveTimers: 52 },
    });

    assert.equal(runRec.status, "admitted");
    assert.ok(fs.existsSync(path.join(holdDir, `${RUN_ID("S9")}.release`)), "admitted queued run released");
    const payload = JSON.parse(fs.readFileSync(path.join(holdDir, `${RUN_ID("S9")}.release`), "utf-8"));
    assert.equal(payload.reason, "queued_admitted_after_window");
    assert.ok(
      ops.ofKind("hold.released").some((e: any) => e.runId === RUN_ID("S9") && e.reason === "queued_admitted_after_window"),
      "queued-admission release recorded",
    );

    // Without a scripted hold schedule the real-storm admission path is
    // unchanged: no release is written for the admitted run.
    const state2 = makeState();
    delete state2.rehearsal.hold_schedule;
    state2.rounds.A.runs.S10 = { rosterId: "S10", runId: RUN_ID("S10"), status: "registered", queued: true, admission: [] };
    const runRec2 = state2.rounds.A.runs.S10;
    await observeQueuedAdmission(ctx, state2, ops, { rosterId: "S10", queued: true, demand: 4, timers: 4 }, runRec2, campaignDir, {
      admission: { state: "active", freeSlots: 10, maxActiveTimers: 52 },
    });
    assert.equal(runRec2.status, "admitted");
    assert.ok(!fs.existsSync(path.join(holdDir, `${RUN_ID("S10")}.release`)), "no hold schedule -> no release");
  });
});
