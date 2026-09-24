// Tier-2 STORM-REHEARSAL US-006 — Round A simultaneity sampler starts at S1 (SF-7).
//
// Attempt 3/4 recorded observedPeak 1 against a configured 8: the single
// observation loop only began sampling AFTER the full staggered launch plus the
// S9/S10 admission (~693s after S1), while a zero-model scripted fixture was
// already terminal, so no sample ever saw the eight-concurrent window.
//
// US-006 extracts a standalone `startSampler` and starts it at S1's launch
// (round start) for the SCRIPTED_REHEARSAL profile, then harvests with
// `runObservationLoop({sample:false})` so the 15s sample cadence is owned by
// the sampler and no duplicate sample is appended. Non-scripted rounds keep the
// original single `runObservationLoop` call (sample defaults to true).
//
// This file is hermetic: pure fakes (in-memory fs, controllable fake clock,
// injected composer, in-memory DB rows). It never spawns a daemon/scheduler/
// harness/model and never touches live ~/.tamandua state.
//
// Coverage:
//   W1  startSampler's first sample lands at S1's launch (round start), before
//       admission, and continues on the 15s cadence;
//   W2  stop() halts sampling promptly (even mid-interval); the round window
//       bounds the loop;
//   W3  runObservationLoop with sample:false appends NO samples but still
//       pounds, pumps queued admission and harvests terminal runs;
//   W4  runObservationLoop's default (sample:true) path still samples on the
//       15s cadence (unchanged);
//   W5  stormRunRoundA wires the scripted profile to start the sampler at S1
//       and harvest with sample:false (source-level contract).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  enablePounding,
  runObservationLoop,
  startSampler,
} from "../bin/tt-storm-engine.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_SOURCE = path.join(HERE, "..", "bin", "tt-storm-engine.mjs");

// Microtask flusher so async loops can settle between fake-clock releases.
async function flush(n = 30) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

// Controllable fake clock: sleep() parks until the test releases the next due
// waiter, so the test can interleave run registration/admission with samples.
function makeFakeClock() {
  let now = 0;
  const waiters: { at: number; resolve: () => void; ms: number; label: string }[] = [];
  const sleepRequests: { ms: number; label: string }[] = [];
  return {
    sleepRequests,
    nowMs: () => now,
    nowUtc: () => new Date(now).toISOString(),
    setNow: (ms: number) => { now = ms; },
    pendingSleeps: () => waiters.length,
    sleep(ms: number, label = "") {
      sleepRequests.push({ ms, label });
      return new Promise<void>((resolve) => { waiters.push({ at: now + ms, resolve, ms, label }); });
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
    // Drain every pending sleep in due order until the target promise settles.
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

// Auto-advancing fake clock: each sleep advances virtual time immediately and
// yields a microtask, so a bounded loop completes without external driving.
function makeAutoClock() {
  let now = 0;
  const sleepRequests: { ms: number; label: string }[] = [];
  return {
    sleepRequests,
    nowMs: () => now,
    nowUtc: () => new Date(now).toISOString(),
    setNow: (ms: number) => { now = ms; },
    async sleep(ms: number, label = "") {
      sleepRequests.push({ ms, label });
      now += ms;
      await flush(1);
    },
  };
}

// In-memory fs: enough for saveState's write+rename (state persistence).
function makeFakeFs() {
  const files = new Map<string, string>();
  return {
    files,
    writeFileSync: (p: unknown, data: unknown) => { files.set(String(p), String(data)); },
    renameSync: (from: unknown, to: unknown) => {
      files.set(String(to), files.get(String(from)) ?? "");
      files.delete(String(from));
    },
    existsSync: (p: unknown) => files.has(String(p)),
    readFileSync: (p: unknown) => files.get(String(p)) ?? "",
    mkdirSync: () => {},
  };
}

function makeOps() {
  const records: any[] = [];
  return { records, record: (kind: string, payload?: unknown) => { records.push({ kind, payload }); } };
}

function makeState(runIds: string[] = []) {
  const runs: Record<string, any> = {};
  for (const rid of runIds) runs[rid] = { rosterId: rid, status: "registered", runId: `run-${rid}`, queued: false };
  return {
    campaign_id: "storm-simultaneity-window-test",
    source: { active_cap: 52 },
    rounds: {
      A: { runs, status: "running", pounding: undefined },
      B: { runs: {}, status: "pending", pounding: undefined },
    },
    sampler: { interval_ms: 15000, samples: [] as any[], sample_gaps: [] as any[], peak_observed: null },
    plan: { launches: [] as any[] },
    queue: { attempts: [] as any[], first_capacity_at: null, s10_admitted_at: null },
  } as any;
}

// Minimal sound signature of composeStormSample; the seam is what we assert.
function makeCompose(clock: any, calls: any[]) {
  return async (_ctx: any, _state: any, round: string, ids: string[], nowMs: number) => {
    calls.push({ round, ids: [...ids], nowMs });
    return {
      ts: clock.nowUtc(),
      atMs: nowMs,
      round,
      intervalMs: 15000,
      configured: ids.length,
      active: ids.length,
      unknown: 0,
      perRun: Object.fromEntries(ids.map((id) => [id, { runId: id, present: true, claimed: true, status: "running" }])),
    };
  };
}

// In-memory DB returning canned run rows by run id. `activeStepsForRuns`
// reports one ACTIVE claimed step so a sampled run counts as claimed/active.
function makeFakeDb(rows: Record<string, any>) {
  return {
    open: () => ({
      ok: true,
      api: {
        getRun: (rid: string) => rows[rid] ?? null,
        activeStepsForRuns: () => [{ status: "running", n: 1 }],
        close: () => {},
      },
    }),
  };
}

function makeCtx(clock: any, fsx: any, extra: any = {}) {
  return {
    fs: fsx,
    clock,
    campaignDir: "/tmp/campaign",
    db: extra.db ?? { open: () => ({ ok: false }) },
    proc: extra.proc ?? {},
    opts: extra.opts ?? {},
  } as any;
}

describe("tier2-storm-rehearsal-simultaneity-window (US-006, SF-7)", () => {
  it("W1: startSampler's first sample lands at S1's launch (round start), not after admission", async () => {
    const clock = makeFakeClock();
    const fsx = makeFakeFs();
    const ops = makeOps();
    const state = makeState();
    // S1 is mid-launch: no run id recorded yet. Its earliestOffsetMs is 0, so
    // S1's launch time IS the round start.
    state.rounds.A.runs.S1 = { rosterId: "S1", status: "launching", runId: null };
    const ctx = makeCtx(clock, fsx);
    const calls: any[] = [];
    const compose = makeCompose(clock, calls);

    const handle = startSampler(ctx, state, ops, "/tmp/campaign", {
      round: "A",
      startedAt: 0,
      windowMs: 120_000,
      compose,
    });
    await flush();

    // First sample at t=0 — the S1 launch moment — NOT ~693s (post-admission).
    const S1_ADMITTED_AT = 693_000;
    assert.equal(state.sampler.samples.length, 1, "first sample present at S1 launch");
    assert.equal(state.sampler.samples[0].atMs, 0);
    assert.equal(calls[0].nowMs, 0);
    assert.equal(state.sampler.samples[0].configured, 0, "no runId yet -> configured 0, never fabricated");
    assert.ok(state.sampler.samples[0].atMs < S1_ADMITTED_AT, "first sample precedes admission");

    // S1's real registration records its run id; the next sample (15s later)
    // observes it — the sampler is already running through the launch window.
    state.rounds.A.runs.S1.runId = "run-s1";
    state.rounds.A.runs.S1.status = "registered";
    await clock.releaseNext();
    assert.equal(state.sampler.samples.length, 2, "cadence continues");
    assert.equal(state.sampler.samples[1].atMs, 15000);
    assert.equal(state.sampler.samples[1].configured, 1);
    assert.deepEqual(calls[1].ids, ["run-s1"]);

    // Exactly the 15s interval is requested and state is persisted per sample.
    assert.ok(clock.sleepRequests.length >= 1);
    assert.ok(clock.sleepRequests.every((r: any) => r.ms === 15000), "15s sampler cadence");
    assert.ok(fsx.files.size >= 1, "state persisted");

    handle.stop("test_done");
    await handle.promise;
    assert.equal(state.sampler.samples.length, 2, "stop halts sampling");
    assert.ok(ops.records.some((r) => r.kind === "sampler.sample"), "sampler.sample recorded");
  });

  it("W2: stop() halts sampling promptly mid-interval; the round window bounds the loop", async () => {
    // (a) stop() while a 15s sleep is pending resolves the sampler immediately.
    const clock = makeFakeClock();
    const state = makeState(["R1"]);
    const ctx = makeCtx(clock, makeFakeFs());
    const calls: any[] = [];
    const ops = makeOps();
    const handle = startSampler(ctx, state, ops, "/tmp/campaign", {
      round: "A", startedAt: 0, windowMs: 600_000, compose: makeCompose(clock, calls),
    });
    await flush();
    assert.equal(state.sampler.samples.length, 1);
    assert.equal(clock.pendingSleeps(), 1, "sampler parked on the interval");
    handle.stop("release_or_harvest");
    assert.equal(handle.stopped(), true);
    await handle.promise; // resolves without releasing the 15s sleep
    await flush();
    assert.equal(state.sampler.samples.length, 1, "no sample after stop()");
    assert.equal(calls.length, 1);

    // (b) the window bounds the loop: samples at 0/15s/30s, then stop at 45s.
    const clock2 = makeFakeClock();
    const state2 = makeState(["R1"]);
    const ctx2 = makeCtx(clock2, makeFakeFs());
    const calls2: any[] = [];
    const h2 = startSampler(ctx2, state2, makeOps(), "/tmp/campaign", {
      round: "A", startedAt: 0, windowMs: 45_000, compose: makeCompose(clock2, calls2),
    });
    await clock2.settle(h2);
    assert.deepEqual(state2.sampler.samples.map((s: any) => s.atMs), [0, 15000, 30000]);
    assert.equal(state2.sampler.samples.length, 3, "window caps the sample count");
    assert.deepEqual(clock2.sleepRequests.map((r: any) => r.ms), [15000, 15000, 15000]);
  });

  it("W3: runObservationLoop(sample:false) harvests without appending samples (pounding + queue pump + harvest)", async () => {
    const clock = makeAutoClock();
    const fsx = makeFakeFs();
    const ops = makeOps();
    const state = makeState(["R1", "R2"]);
    state.plan.launches = [
      { round: "A", rosterId: "R1", queued: false },
      { round: "A", rosterId: "R2", queued: false },
      { round: "A", rosterId: "S9", queued: true },
    ];
    state.rounds.A.runs.S9 = { rosterId: "S9", status: "queued", runId: "run-S9", queued: true, admission: [] };
    const db = makeFakeDb({
      "run-R1": { id: "run-R1", status: "completed", tokens_spent: 0 },
      "run-R2": { id: "run-R2", status: "running", tokens_spent: 0 },
      "run-S9": { id: "run-S9", status: "running", scheduling_status: "active" },
    });
    const ctx = makeCtx(clock, fsx, {
      db,
      proc: { httpGet: async () => ({ ok: true, statusCode: 200, latencyMs: 1 }), mcpTool: async () => ({ ok: true }) },
      opts: { roundWindowMs: 5_000, pounding: { cadenceMs: 1000, latencyBoundMs: 5000, dashboardUrl: "http://127.0.0.1:1/", mcpToolNames: [] } },
    });
    enablePounding(ctx, state, "A");

    await runObservationLoop(ctx, state, ops, "/tmp/campaign", {
      round: "A",
      startedAt: 0,
      sample: false,
      samplerStartedAt: 0,
    });

    assert.equal(state.sampler.samples.length, 0, "sample:false must not append samples");
    assert.equal(state.rounds.A.runs.R1.status, "terminal", "terminal run harvested");
    assert.equal(state.rounds.A.runs.R1.terminalStatus, "completed");
    assert.equal(state.rounds.A.runs.R2.status, "registered", "active run left open");
    assert.ok(!ops.records.some((r) => r.kind === "sampler.sample"), "no sampler.sample recorded");
    assert.ok(ops.records.some((r) => r.kind === "run.terminal" && r.payload.rosterId === "R1"), "run.terminal recorded");
    assert.ok(ops.records.some((r) => r.kind === "pounding.round"), "pounding polled in the harvest path");
    assert.ok(state.rounds.A.pounding.rounds >= 1, "pounding round counted");
    // Queued admission pump ran (S9 admitted from its active db row).
    assert.ok(ops.records.some((r) => r.kind === "queue.admission_attempt"), "queue pump ran");
    assert.equal(state.queue.attempts.length, 1);
    assert.equal(state.rounds.A.runs.S9.status, "admitted");
  });

  it("W4: runObservationLoop's default (sample:true) path still samples on the 15s cadence", async () => {
    const clock = makeAutoClock();
    const fsx = makeFakeFs();
    const ops = makeOps();
    const state = makeState(["R1"]);
    state.plan.launches = [{ round: "A", rosterId: "R1", queued: false }];
    const db = makeFakeDb({ "run-R1": { id: "run-R1", status: "running", tokens_spent: 0 } });
    const ctx = makeCtx(clock, fsx, { db, opts: { roundWindowMs: 31_000 } });

    await runObservationLoop(ctx, state, ops, "/tmp/campaign", { round: "A", startedAt: 0 });

    assert.deepEqual(state.sampler.samples.map((s: any) => s.atMs), [0, 15000, 30000]);
    assert.equal(state.sampler.samples.length, 3);
    assert.equal(ops.records.filter((r) => r.kind === "sampler.sample").length, 3, "default path records samples");
    assert.ok(state.sampler.peak_observed.peak >= 1);
  });

  it("W5: stormRunRoundA starts the standalone sampler at S1 and harvests with sample:false (source contract)", () => {
    const src = fs.readFileSync(ENGINE_SOURCE, "utf8");
    const start = src.indexOf("export async function stormRunRoundA");
    assert.ok(start > 0, "stormRunRoundA present");
    const nextExport = src.indexOf("\nfunction ensureRunRecord", start);
    assert.ok(nextExport > start);
    const body = src.slice(start, nextExport);

    // The scripted profile is gated on the hold schedule / rehearsalRun opt.
    assert.match(body, /state\.rehearsal\?\.hold_schedule/, "scripted gate reads the hold schedule");
    // The sampler starts at round start BEFORE the launch loop.
    const samplerStart = body.indexOf("startSampler(");
    const launchLoop = body.indexOf("for (const launch of activeLaunches)");
    assert.ok(samplerStart > 0 && launchLoop > samplerStart, "startSampler precedes the launch loop");
    assert.match(body, /startedAt,\s*\n\s*windowMs:/, "sampler startedAt is the round start");
    // Stopped with the release_or_harvest reason, then a sample:false harvest.
    assert.match(body, /roundASampler\.stop\('release_or_harvest'\)/);
    assert.match(body, /sample: !scriptedHoldSchedule/);
    assert.match(body, /samplerStartedAt/);
  });
});
