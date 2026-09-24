// Tier-2 STORM-REAL US-007 — report headline spend/roster and per-tick
// results/spend.json (pure + in-process engine; NO daemon, NO model, NO real
// tokens).
//
// The real storm report must be able to say, from the artifact alone: how many
// tokens each provider spent (local-endpoint pi/hermes counted with cost 0 vs
// the PAID dsh provider), which roster ran (full vs the capacity-scaled lite
// id), and — when the campaign aborted — that the hard cap was crossed and
// under which scope. The observation loop must refresh results/spend.json on
// EVERY tick and record the tick in ops/state.
//
// Coverage:
//   R1  buildSpendHeadline names each provider (local cost 0 vs paid), keeps
//       an UNKNOWN snapshot null (never a fabricated 0);
//   R2  rosterIdentityFromState defaults to the full roster and reads a
//       persisted lite scale/roster id;
//   R3  buildStormReport (JSON) and renderStormReportTxt carry the spend
//       headline + the roster that ran, and an UNKNOWN spend line is honest;
//   R4  an aborted report identifies the cap crossing + scope in JSON and TXT;
//   R5  flushSpendOnTick refreshes results/spend.json every tick, records the
//       tick in ops/state, and is a no-op for SCRIPTED_REHEARSAL;
//   R6  runObservationLoop flushes spend on an observation tick end-to-end.
//
// Everything runs under owned temp fixtures; each test removes only its own
// scratch dir in finally.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { REAL_FS, FULL_ROSTER_ID, rosterIdentityFromState } from "../bin/tt-storm-roster.mjs";
import { REAL, SCRIPTED_REHEARSAL } from "../bin/tt-storm-profile.mjs";
import {
  abortCampaignForSpendCap,
  buildStormReport,
  flushSpendOnTick,
  renderStormReportTxt,
  runObservationLoop,
} from "../bin/tt-storm-engine.mjs";
import {
  SPEND_STATUS_KNOWN,
  SPEND_STATUS_UNKNOWN,
  buildSpendHeadline,
  readSpendSnapshot,
  sumSpendSnapshot,
  unknownSpendSnapshot,
} from "../bin/tt-storm-spend.mjs";

const RUN_PI = "run-11111111-1111-4111-8111-111111111111";
const RUN_DSH = "run-33333333-3333-4333-8333-333333333333";

function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-storm-report-spend-${label}-`));
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function deterministicOps(): { records: any[]; record: (kind: string, detail: any) => void } {
  const records: any[] = [];
  return { records, record: (kind, detail) => records.push({ kind, detail }) };
}

// A known spend snapshot: 1000 local pi tokens (cost 0) and 50 paid dsh tokens.
function knownSnapshot(tickAt = "2026-09-23T00:00:00.000Z") {
  return sumSpendSnapshot({
    assignments: [
      { run_id: RUN_PI, harness: "pi" },
      { run_id: RUN_DSH, harness: "dsh" },
    ],
    runRows: [
      { id: RUN_PI.slice(4), tokens_spent: 1000 },
      { id: RUN_DSH.slice(4), tokens_spent: 50 },
    ],
    tickAt,
  });
}

// A REAL campaign state with the round/plan/cleanup structure the report and
// the observation loop read.
function realState(profile: string = REAL, extra: any = {}): any {
  return {
    campaign_id: "storm-report-spend-fixture",
    mode: "run-A",
    source: { active_cap: 52 },
    qualification: { real_launch_allowed: false },
    rounds: {
      A: { status: "running", runs: {}, phases: {}, pounding: null },
      B: { status: "pending", runs: {}, phases: {}, pounding: null },
    },
    plan: { launches: [] },
    sampler: { samples: [] },
    queue: { attempts: [] },
    cleanup: { ledger: [] },
    rehearsal: { profile },
    ...extra,
  };
}

describe("STORM-REAL US-007: report headline spend/roster and per-tick spend.json", () => {
  it("R1: spend headline names each provider (local cost 0 vs paid) and UNKNOWN stays null", () => {
    const headline = buildSpendHeadline(knownSnapshot());
    assert.equal(headline.status, SPEND_STATUS_KNOWN);
    assert.equal(headline.providers.pi.class, "local");
    assert.equal(headline.providers.pi.tokens, 1000);
    assert.equal(headline.providers.pi.billable_tokens, 0, "local-endpoint tokens are not billable");
    assert.equal(headline.providers.pi.cost_zero, true);
    assert.equal(headline.providers.hermes.class, "local");
    assert.equal(headline.providers.hermes.cost_zero, true);
    assert.equal(headline.providers.dsh.class, "paid");
    assert.equal(headline.providers.dsh.tokens, 50);
    assert.equal(headline.providers.dsh.billable_tokens, 50, "dsh is the paid provider");
    assert.equal(headline.providers.dsh.cost_zero, false);
    assert.equal(headline.local_tokens, 1000);
    assert.equal(headline.paid_tokens, 50);
    assert.equal(headline.total_tokens, 1050);
    assert.match(headline.line, /pi local 1000 \(cost 0\)/);
    assert.match(headline.line, /hermes local 0 \(cost 0\)/);
    assert.match(headline.line, /dsh paid 50/);
    assert.match(headline.line, /total 1050/);

    const unknown = buildSpendHeadline(unknownSpendSnapshot({ reason: "campaign DB unreadable" }));
    assert.equal(unknown.status, SPEND_STATUS_UNKNOWN);
    assert.equal(unknown.providers, null);
    assert.equal(unknown.local_tokens, null);
    assert.equal(unknown.paid_tokens, null);
    assert.equal(unknown.total_tokens, null, "UNKNOWN is never a fabricated 0");
    assert.match(unknown.line, /UNKNOWN/);
    assert.match(unknown.line, /campaign DB unreadable/);
  });

  it("R2: roster identity defaults to full and reads a persisted lite scale/roster id", () => {
    const full = rosterIdentityFromState(realState());
    assert.equal(full.id, FULL_ROSTER_ID);
    assert.equal(full.full, true);

    const lite = rosterIdentityFromState(realState(REAL, { rehearsal: { profile: REAL, scale: "lite" } }));
    assert.equal(lite.id, "lite");
    assert.equal(lite.full, false);
    assert.match(lite.label, /lite/);

    // A persisted explicit roster id takes precedence over a bare scale.
    const poly = rosterIdentityFromState(realState(REAL, { rehearsal: { profile: REAL, scale: "lite", roster_id: "tt-poly-lite" } }));
    assert.equal(poly.id, "tt-poly-lite");
    assert.equal(poly.full, false);
  });

  it("R3: report JSON + text headline spend per provider and the roster that ran", () => {
    const state = realState(REAL, {
      rehearsal: { profile: REAL, scale: "lite", roster_id: "tt-poly-lite", spend_cap: { tokens: 100000, scope: "total" } },
      rounds: {
        A: {
          status: "round_done",
          runs: {
            S1: { rosterId: "S1", workflow: "feature-dev-merge-worktree", harness: "pi", runId: RUN_PI, status: "terminal", terminalStatus: "completed" },
            S2: { rosterId: "S2", workflow: "bug-fix-merge-worktree", harness: "dsh", runId: RUN_DSH, status: "terminal", terminalStatus: "completed" },
          },
          phases: {},
          pounding: null,
        },
        B: { status: "pending", runs: {}, phases: {}, pounding: null },
      },
      plan: { launches: [{ round: "A" }, { round: "A" }, { round: "B" }] },
    });
    const report = buildStormReport(
      { clock: { nowUtc: () => "2026-09-23T01:00:00.000Z" }, fs: {}, campaignDir: null },
      state,
      { spend: knownSnapshot() },
    );
    assert.equal(report.spend.status, SPEND_STATUS_KNOWN);
    assert.equal(report.spend.providers.pi.tokens, 1000);
    assert.equal(report.spend.providers.dsh.billable_tokens, 50);
    assert.equal(report.roster.id, "tt-poly-lite");
    assert.equal(report.roster.full, false);
    assert.equal(report.roster.planned_runs, 3);
    assert.equal(report.roster.launched_runs, 2);
    assert.equal(report.roster.terminal_runs, 2);
    assert.ok(report.roster.entries.some((e: any) => e.rosterId === "S2" && e.harness === "dsh"));

    const txt = renderStormReportTxt(report);
    assert.match(txt, /SPEND: .*pi local 1000 \(cost 0\)/);
    assert.match(txt, /dsh paid 50/);
    assert.match(txt, /ROSTER: .*tt-poly-lite/);
    assert.match(txt, /launched 2\/3/);

    // An UNKNOWN spend (a campaign with no observation tick) is stated, never
    // rendered as 0.
    const pending = buildStormReport(
      { clock: { nowUtc: () => "2026-09-23T01:00:00.000Z" }, fs: {}, campaignDir: null },
      state,
    );
    assert.equal(pending.spend.status, SPEND_STATUS_UNKNOWN);
    assert.equal(pending.spend.total_tokens, null);
    assert.match(renderStormReportTxt(pending), /SPEND: UNKNOWN/);
  });

  it("R4: an aborted campaign report identifies the cap crossing and scope in JSON and TXT", async () => {
    const scratch = ownedScratch("aborted");
    try {
      const campaignDir = path.join(scratch, "campaign");
      fs.mkdirSync(campaignDir, { recursive: true });
      const state = realState(REAL, { rehearsal: { profile: REAL, spend_cap: { tokens: 100, scope: "paid" } } });
      const ops = deterministicOps();
      const ctx: any = {
        fs: REAL_FS,
        clock: { nowUtc: () => "2026-09-23T02:00:00.000Z", nowMs: () => 0, sleep: async () => {} },
        campaignDir,
        opts: { runOwnedCleanup: async () => ({ ok: true, ledger: [{ phase: "campaign-owned", ok: true }] }) },
      };
      const snapshot = knownSnapshot("2026-09-23T02:00:00.000Z");
      const res = await abortCampaignForSpendCap(ctx, state, ops, campaignDir, {
        round: "A",
        snapshot,
        verdict: { status: "crossed", scope: "paid", cap: 100, observed: 1050, remaining: -950, reason: "paid spend 1050 crossed the 100-token cap" },
      });
      assert.equal(res.status, "crossed");
      const report = loadJson(path.join(campaignDir, "results", "report.json"));
      assert.equal(report.aborted.cap_crossed, true);
      assert.equal(report.aborted.scope, "paid");
      assert.equal(report.aborted.cap_tokens, 100);
      assert.equal(report.aborted.observed_tokens, 1050);
      assert.equal(report.aborted.cleanup_done, true);
      assert.equal(report.spend.providers.dsh.billable_tokens, 50);
      const txt = fs.readFileSync(path.join(campaignDir, "results", "report.txt"), "utf8");
      assert.match(txt, /ABORTED: spend cap crossed \(scope paid, cap 100, observed 1050\)/);
      assert.match(txt, /cleanup_done=true/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("R5: flushSpendOnTick refreshes results/spend.json every tick, records it, and no-ops for scripted", async () => {
    const scratch = ownedScratch("flush");
    try {
      const campaignDir = path.join(scratch, "campaign");
      fs.mkdirSync(campaignDir, { recursive: true });
      const state = realState(REAL);
      const ops = deterministicOps();
      let tick = "2026-09-23T03:00:00.000Z";
      let observed = knownSnapshot(tick);
      const ctx: any = {
        fs: REAL_FS,
        clock: { nowUtc: () => tick, nowMs: () => 0, sleep: async () => {} },
        campaignDir,
        opts: { collectSpend: async () => observed },
      };

      const spendFile = path.join(campaignDir, "results", "spend.json");
      const first = await flushSpendOnTick(ctx, state, ops, campaignDir, { round: "A" });
      assert.equal(first.status, SPEND_STATUS_KNOWN);
      assert.equal(fs.existsSync(spendFile), true, "the first tick writes results/spend.json");
      assert.equal(loadJson(spendFile).total_tokens, 1050);
      assert.equal(state.spend.last_tick_at, tick);
      assert.equal(state.spend.total_tokens, 1050);
      assert.ok(ops.records.some((r) => r.kind === "spend.tick"), "the flush records a spend.tick op");
      assert.ok(ops.records.some((r) => r.kind === "spend.flush"), "the tick is recorded in ops");

      // The next observation tick refreshes the artifact with the newer figure
      // and the newer tick time — never a stale one.
      tick = "2026-09-23T03:00:15.000Z";
      observed = sumSpendSnapshot({
        assignments: [{ run_id: RUN_DSH, harness: "dsh" }],
        runRows: [{ id: RUN_DSH.slice(4), tokens_spent: 777 }],
        tickAt: tick,
      });
      const second = await flushSpendOnTick(ctx, state, ops, campaignDir, { round: "A" });
      assert.equal(second.total_tokens, 777);
      const onDisk = readSpendSnapshot({ fs: REAL_FS, campaignDir });
      assert.equal(onDisk.tick_at, tick, "the artifact carries the latest tick time");
      assert.equal(onDisk.total_tokens, 777, "the artifact is refreshed, not stale");
      assert.equal(state.spend.total_tokens, 777);
      const tickOps = ops.records.filter((r) => r.kind === "spend.tick");
      assert.equal(tickOps.length, 2, "each tick flushes and records");

      // SCRIPTED_REHEARSAL (no real tokens) is untouched.
      const scripted = realState(SCRIPTED_REHEARSAL, { rehearsal: { profile: SCRIPTED_REHEARSAL } });
      const before = fs.readFileSync(spendFile, "utf8");
      const res = await flushSpendOnTick(ctx, scripted, ops, campaignDir, { round: "A" });
      assert.equal(res, null);
      assert.equal(fs.readFileSync(spendFile, "utf8"), before, "the scripted flush does not touch the artifact");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("R6: runObservationLoop flushes results/spend.json on an observation tick", async () => {
    const scratch = ownedScratch("loop");
    try {
      const campaignDir = path.join(scratch, "campaign");
      fs.mkdirSync(campaignDir, { recursive: true });
      const state = realState(REAL, {
        rehearsal: { profile: REAL, spend_cap: { tokens: 100000, scope: "total" } },
        rounds: {
          A: {
            status: "running",
            runs: { S1: { rosterId: "S1", workflow: "feature-dev-merge-worktree", harness: "pi", runId: RUN_PI, status: "registered" } },
            phases: {},
            pounding: null,
          },
          B: { status: "pending", runs: {}, phases: {}, pounding: null },
        },
        plan: { launches: [] },
      });
      const ops = deterministicOps();
      // Auto-advancing fake clock so the bounded harvest loop completes after
      // its first observation tick (never a real sleep, never an infinite loop).
      let now = 0;
      const ctx: any = {
        fs: REAL_FS,
        clock: {
          nowMs: () => now,
          nowUtc: () => new Date(now).toISOString(),
          sleep: async (ms: number) => { now += ms; },
        },
        db: null,
        campaignDir,
        opts: { collectSpend: async () => knownSnapshot("2026-09-23T04:00:00.000Z"), roundWindowMs: 1 },
      };
      await runObservationLoop(ctx, state, ops, campaignDir, { round: "A", sample: false });
      assert.ok(ops.records.some((r) => r.kind === "spend.tick"), "the observation loop flushed spend on its tick");
      assert.ok(fs.existsSync(path.join(campaignDir, "results", "spend.json")), "results/spend.json was written by the loop");
      assert.equal(loadJson(path.join(campaignDir, "results", "spend.json")).total_tokens, 1050);
      assert.equal(state.spend.status, SPEND_STATUS_KNOWN);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});