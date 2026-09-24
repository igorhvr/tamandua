// Tier-2 STORM-REHEARSAL FIX-4 US-001 — SF-6 evidence-truth regression test.
//
// The SF-6 bug: buildStormReport() (~tt-storm-engine.mjs:2248) projected each
// round run record WITHOUT its redBait flag, while report.states.red is built
// from the STATE record's rec.redBait === true. The evidence validator derives
// its green set from the REPORT projection (terminalStatus 'completed' &&
// !redBait) and then asserts nongreen distinctness — so a completed B4
// red-bait run landed in BOTH the green set and report.states.red
// ("nongreen distinctness violated"). This file pins the truthful projection:
//
//   * every projected round run carries a BOOLEAN redBait (rec.redBait ?? false);
//   * a completed red-bait B4 is in report.states.red and EXCLUDED from green;
//   * a completed non-red run is green and in no non-green bucket;
//   * validateRehearsalEvidence (the exported consistency validator) accepts a
//     report built by buildStormReport() with a completed red-bait B4 — i.e.
//     the nongreen distinctness gate holds because the projection is truthful.
//
// In-process only: a synthetic campaign state is fed to the real
// buildStormReport, and the real exported validator is invoked with
// checkFiles:false (no real campaign / daemon / harness / model is touched).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ROUND_B_PHASES } from "../bin/tt-storm-engine.mjs";
import { buildStormReport } from "../bin/tt-storm-engine.mjs";
import { validateRehearsalEvidence } from "./tier2-storm-rehearsal-consistency.test.ts";

const CAMPAIGN_ID = "storm-redbait-projection";
const CAMPAIGN_DIR = `/tmp/${CAMPAIGN_ID}`;

const ROUND_A_IDS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"];
const ROUND_A_ACTIVE_IDS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"];
const ROUND_B_IDS = ["B1", "B2", "B3", "B4", "B5"];

function runIdFor(rid: string): string {
  return `run-${rid.toLowerCase()}`;
}

// Minimal synthetic campaign state accepted by buildStormReport + the
// evidence validator: a fully-terminal Round A (8 active + 2 queued with a
// real 8-concurrent window sample) and a fully-terminal Round B whose B4 is
// the red-bait run and whose B5 carries the identical stop/delete/relaunch
// lineage.
function syntheticState(): any {
  const aRuns: Record<string, any> = {};
  for (const rid of ROUND_A_IDS) {
    const active = ROUND_A_ACTIVE_IDS.includes(rid);
    aRuns[rid] = {
      rosterId: rid,
      run: `${rid}-run`,
      workflow: "wf",
      harness: "pi",
      runId: runIdFor(rid),
      status: active ? "running" : "admitted",
      terminalStatus: "completed",
      admission: { decision: active ? "admit" : "queue", freeSlots: active ? 8 : 0, demandedTimers: active ? 7 : 1 },
      children: [],
      // S7 intentionally omits redBait entirely: the projection must still
      // yield a boolean false (never undefined).
      ...(rid === "S7" ? {} : { redBait: false }),
      ...(active ? {} : { queued: true }),
    };
  }
  const bRuns: Record<string, any> = {};
  for (const rid of ROUND_B_IDS) {
    bRuns[rid] = {
      rosterId: rid,
      run: `${rid}-run`,
      workflow: "wf",
      harness: "pi",
      runId: runIdFor(rid),
      status: "running",
      terminalStatus: "completed",
      admission: { decision: "admit", freeSlots: 8, demandedTimers: 1 },
      children: [],
      redBait: rid === "B4",
    };
  }
  // Identical B5 stop/delete/relaunch lineage (the relaunced run id differs).
  bRuns.B5.relaunchOf = "run-b5";
  bRuns.B5.runId = "run-b5-relaunched";

  const phases: Record<string, any> = {};
  for (const p of ROUND_B_PHASES) {
    phases[p.id] = {
      id: p.id,
      status: "done",
      firedAt: "2026-09-12T00:00:00Z",
      waitOutcome: { outcome: "ok", observed: p.id },
    };
  }
  // US-008: the evidence validator requires the product's own reaction for the
  // two target-moving/dirtying chaos phases. This fixture is about redBait, so
  // it carries minimal recorded product evidence; buildStormReport keeps the
  // recorded value when the (uninjected) fresh product channel is unavailable.
  const bMergeRunIds = ROUND_B_IDS.map((rid) => runIdFor(rid));
  phases["B-rugpull"].productEvidence = {
    phaseId: "B-rugpull", sinceUtc: "2026-09-11T23:00:00Z", runIds: bMergeRunIds,
    ok: true, error: null,
    targetMoved: [{ event: "merge.target_moved", runId: runIdFor("B1"), ts: "2026-09-11T23:01:00Z", detail: "target refs/heads/main moved" }],
    landed: [], parkLanding: [],
  };
  const parkLanded = { event: "merge.landed", runId: runIdFor("B2"), ts: "2026-09-11T23:02:00Z", checkoutRefresh: "parked:main-tamandua-parked-x", parkedBranch: "main-tamandua-parked-x", parkedReason: "local-changes" };
  phases["B-park"].productEvidence = {
    phaseId: "B-park", sinceUtc: "2026-09-11T23:00:00Z", runIds: bMergeRunIds,
    ok: true, error: null,
    targetMoved: [], landed: [parkLanded], parkLanding: [parkLanded],
  };

  const perRun: Record<string, any> = {};
  for (const rid of ROUND_A_ACTIVE_IDS) perRun[runIdFor(rid)] = { claimed: true };
  const windowSample = { round: "A", unknown: 0, configured: 8, perRun };

  return {
    campaign_id: CAMPAIGN_ID,
    source: { commit: "a".repeat(40), tree: "b".repeat(40) },
    qualification: { real_launch_allowed: false },
    cleanup: { ledger: [] },
    sampler: { samples: [windowSample], sample_gaps: [] },
    queue: {
      attempts: [
        { decision: "queue", freeSlots: 0, demandedTimers: 7 },
        { decision: "admit", freeSlots: 8, demandedTimers: 1 },
      ],
    },
    rounds: {
      A: { status: "round_done", runs: aRuns, phases: {} },
      B: { status: "round_done", runs: bRuns, phases },
    },
  };
}

function greenKeys(report: any): Set<string> {
  const keys = new Set<string>();
  for (const r of ["A", "B"]) {
    for (const rec of report.rounds?.[r]?.runs ?? []) {
      if (rec.terminalStatus === "completed" && !(rec.redBait ?? false) && rec.rosterId) keys.add(`${r}:${rec.rosterId}`);
    }
  }
  return keys;
}

function nonGreenKeys(report: any): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const bucket of ["red", "missing", "inconclusive", "not_run"]) {
    for (const e of report.states?.[bucket] ?? []) {
      if (!e.round || !e.rosterId) continue;
      const k = `${e.round}:${e.rosterId}`;
      byKey.set(k, [...(byKey.get(k) ?? []), bucket]);
    }
  }
  return byKey;
}

describe("tier2-storm-rehearsal-redbait-projection (SF-6)", () => {
  it("projects a boolean redBait on every Round A and Round B run (never undefined)", () => {
    const report = buildStormReport({ clock: { nowUtc: () => "2026-09-12T00:00:00Z" }, fs: {} }, syntheticState());
    for (const r of ["A", "B"]) {
      const runs = report.rounds[r].runs;
      assert.ok(runs.length > 0, `round ${r} projected runs`);
      for (const rec of runs) {
        assert.equal(typeof rec.redBait, "boolean", `${r}/${rec.rosterId} redBait must be boolean, got ${typeof rec.redBait}`);
      }
    }
    // A missing flag projects to boolean false (S7 omitted it in state).
    assert.equal(report.rounds.A.runs.find((x: any) => x.rosterId === "S7")?.redBait, false);
    // The red-bait run keeps its true flag through the projection.
    assert.equal(report.rounds.B.runs.find((x: any) => x.rosterId === "B4")?.redBait, true);
  });

  it("keeps a completed red-bait B4 in states.red and OUT of the green set", () => {
    const report = buildStormReport({ clock: { nowUtc: () => "2026-09-12T00:00:00Z" }, fs: {} }, syntheticState());
    const b4 = report.rounds.B.runs.find((x: any) => x.rosterId === "B4");
    assert.equal(b4.terminalStatus, "completed", "B4 completed");
    assert.equal(b4.redBait, true, "B4 is red-bait");
    assert.ok(report.states.red.some((x: any) => x.round === "B" && x.rosterId === "B4"), "B4 is reported RED");
    assert.ok(!greenKeys(report).has("B:B4"), "red-bait B4 must NOT be green");
    assert.deepEqual(nonGreenKeys(report).get("B:B4"), ["red"], "B4 is in the red bucket only");
    // The distinctness invariant itself: no green key is also in a non-green bucket.
    const ng = nonGreenKeys(report);
    for (const k of greenKeys(report)) {
      assert.ok(!ng.has(k), `nongreen distinctness violated for ${k} (${JSON.stringify(ng.get(k))})`);
    }
  });

  it("keeps a completed non-red run green and in no non-green bucket", () => {
    const report = buildStormReport({ clock: { nowUtc: () => "2026-09-12T00:00:00Z" }, fs: {} }, syntheticState());
    const green = greenKeys(report);
    for (const k of ["A:S1", "A:S10", "B:B2", "B:B5"]) {
      assert.ok(green.has(k), `${k} must be green`);
      assert.equal(nonGreenKeys(report).has(k), false, `${k} must not be in any non-green bucket`);
    }
  });

  it("validateRehearsalEvidence accepts the built report with a completed red-bait B4 (nongreen distinctness holds)", () => {
    const state = syntheticState();
    const report = buildStormReport({ clock: { nowUtc: () => "2026-09-12T00:00:00Z" }, fs: {} }, state);
    const res = validateRehearsalEvidence({ campaignDir: CAMPAIGN_DIR, state, report, checkFiles: false });
    assert.equal(res.ok, true, `validator refused truthful projection: ${JSON.stringify(res.issues)}`);
    assert.ok(!res.issues.some((i) => i.includes("nongreen distinctness violated")), "no distinctness violation");
  });

  it("the SF-6 regression is observable: dropping redBait from the projection violates distinctness", () => {
    // Reproduce the pre-fix projection shape deliberately: strip redBait from
    // the report runs while keeping states.red populated from state. The
    // validator must flag B4 as both green and red — proving this test would
    // catch the SF-6 bug rather than merely re-asserting current behavior.
    const state = syntheticState();
    const report = buildStormReport({ clock: { nowUtc: () => "2026-09-12T00:00:00Z" }, fs: {} }, state);
    for (const r of ["A", "B"]) {
      for (const rec of report.rounds[r].runs) delete (rec as any).redBait;
    }
    const res = validateRehearsalEvidence({ campaignDir: CAMPAIGN_DIR, state, report, checkFiles: false });
    assert.equal(res.ok, false);
    assert.ok(
      res.issues.some((i) => i.includes("nongreen distinctness violated") && i.includes("B4")),
      `expected a B4 distinctness violation without the projection flag, got: ${JSON.stringify(res.issues)}`,
    );
  });
});
