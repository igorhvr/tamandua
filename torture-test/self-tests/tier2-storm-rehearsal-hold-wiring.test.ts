// Tier-2 STORM-REHEARSAL-FIX5 US-002 — SF-11 hold-predicate wiring.
//
// Attempt 5 finding SF-11 (high): under the REAL tt-storm wrapper every derived
// Round-B hold phase resolved `evidence_error` -> missed, so no chaos action
// was ever dispatched and the fix-4 predicate was dead code in production.
// Root cause: bin/tt-storm realCtx (line ~374) unconditionally injects
// `opts.probePhaseMarker = probePhaseMarkerReal`; tt-storm-engine.mjs
// probePhaseMarker checked that injected override BEFORE the derived-hold
// branch, and probePhaseMarkerReal has no 'hold-confirmed' case (it falls
// through to `evidence_error`, tt-storm-real.mjs default). The engine now
// evaluates `wf.kind === 'hold'` FIRST, so holdPredicateVerdict (which needs
// ctx.fs/ctx.clock/ctx.opts.holdDir — unreachable from probePhaseMarkerReal)
// really runs under the real wiring.
//
// This file constructs the engine EXACTLY as the CLI does: it imports the
// exported `realCtx` from torture-test/bin/tt-storm (same opts injection path,
// including the real probePhaseMarkerReal override) and drives the real
// `waitForPhaseEvidence` with a real private exec context and a real derived
// B-stopdel hold phase. In-process only: real temp dirs, no daemon, no harness,
// no model, no production port.
//
// Coverage:
//   W1  every target has a confirmed hold file -> marker_satisfied (the derived
//       hold branch won over the injected real probe);
//   W2  no marker -> timed_out once the small bound elapses, NEVER
//       evidence_error (proving holdPredicateVerdict really ran);
//   W2b a runtime `.missed` hold -> hold_missed immediately (with the reason);
//   W3  negative control: probePhaseMarkerReal called directly on the same
//       hold phase (and the real wrapper's injected override, which IS that
//       probe) returns evidence_error — no 'hold-confirmed' predicate exists;
//   W4  the reorder preserves the injected-override seam for every non-hold
//       predicate (the recording gate / real wrapper still win there).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { realCtx } from "../bin/tt-storm";
import { waitForPhaseEvidence } from "../bin/tt-storm-engine.mjs";
import { buildPrivateExecContext, probePhaseMarkerReal } from "../bin/tt-storm-real.mjs";
import { scriptedRoundBPhases } from "../bin/tt-storm-rehearsal.mjs";

const repoRoot = process.cwd();
const TAMANDUA_BIN = path.join(repoRoot, "bin", "tamandua");

const RUNS: Record<string, string> = {
  B1: "run-b1aaaaaa-0000-4000-8000-000000000001",
  B2: "run-b2aaaaaa-0000-4000-8000-000000000002",
  B3: "run-b3aaaaaa-0000-4000-8000-000000000003",
  B4: "run-b4aaaaaa-0000-4000-8000-000000000004",
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

// The real private exec context + the CLI's own realCtx bundle: this is the
// EXACT opts injection path bin/tt-storm uses (opts.probePhaseMarker is
// probePhaseMarkerReal), not a hand-built ctx.
function makeHarness() {
  const scratch = makeTempDir("storm-hold-wiring-");
  const varRoot = path.join(scratch, "var");
  const holdDir = path.join(scratch, "holds");
  const campaignDir = path.join(scratch, "campaign");
  fs.mkdirSync(holdDir, { recursive: true });
  fs.mkdirSync(campaignDir, { recursive: true });
  const execCtx = buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN } });
  const ctx: any = realCtx({ bopts: { holdDir, phaseWaitTimeoutMs: 300 }, execCtx, campaignDir });
  return { scratch, holdDir, campaignDir, execCtx, ctx };
}

function makeState() {
  const run = (id: string) => ({
    rosterId: id,
    run: `storm-${id.toLowerCase()}`,
    workflow: "feature-dev-merge-worktree",
    runId: RUNS[id],
    status: "registered",
  });
  return {
    campaign_id: "camp-hold-wiring",
    rounds: {
      A: { runs: {} },
      B: { runs: { B1: run("B1"), B2: run("B2"), B3: run("B3"), B4: run("B4") }, phases: {} },
    },
  };
}

function confirmHold(holdDir: string, runId: string) {
  fs.writeFileSync(path.join(holdDir, `${runId}.confirmed`), JSON.stringify({ runId, holdId: "storm-midflight", ts: 0 }) + "\n");
}

function missHold(holdDir: string, runId: string, reason: string) {
  fs.writeFileSync(path.join(holdDir, `${runId}.missed`), JSON.stringify({ runId, holdId: "storm-midflight", reason, ts: 0 }) + "\n");
}

// A REAL derived Round-B hold phase (B-stopdel targets B1..B4) exactly as the
// production schedule emits it: waitFor:{kind:'hold',marker:'hold-confirmed'}.
const DERIVED = scriptedRoundBPhases({ startOffsetMs: 0, phaseStepMs: 1_000 });
const STOPDEL = DERIVED.find((p: any) => p.id === "B-stopdel");

describe("tier2-storm-rehearsal-hold-wiring (US-002, SF-11)", () => {
  it("W0: the derived phase is a real hold predicate over B1..B4", () => {
    assert.ok(STOPDEL, "the derived schedule carries B-stopdel");
    assert.equal(STOPDEL!.waitFor.kind, "hold");
    assert.equal(STOPDEL!.waitFor.marker, "hold-confirmed");
    assert.deepEqual(STOPDEL!.waitFor.targets, ["B1", "B2", "B3", "B4"]);
  });

  it("W1: confirmed holds for every target -> marker_satisfied under the real wrapper ctx", async () => {
    const { holdDir, ctx } = makeHarness();
    assert.equal(typeof ctx.opts.probePhaseMarker, "function", "realCtx injected the real probe override");
    const state = makeState();
    for (const rid of ["B1", "B2", "B3", "B4"]) confirmHold(holdDir, RUNS[rid]);

    const ev = await waitForPhaseEvidence(ctx, state, STOPDEL);

    assert.equal(ev.satisfied, true);
    assert.equal(ev.outcome, "marker_satisfied", "the derived hold predicate won over the injected real probe");
    assert.notEqual(ev.outcome, "evidence_error");
  });

  it("W2: no marker -> timed_out after the small bound (holdPredicateVerdict ran), never evidence_error", async () => {
    const { ctx } = makeHarness();
    const state = makeState();

    const ev = await waitForPhaseEvidence(ctx, state, STOPDEL);

    assert.equal(ev.satisfied, false);
    assert.equal(ev.outcome, "timed_out", "the engine-local hold predicate produced plain not-yet -> timed_out");
    assert.notEqual(ev.outcome, "evidence_error", "the injected real probe must not shadow the hold predicate");
    assert.match(String(ev.reason), /hold-confirmed|hold/);
  });

  it("W2b: a runtime `.missed` hold surfaces hold_missed immediately under the real wrapper ctx", async () => {
    const { holdDir, ctx } = makeHarness();
    const state = makeState();
    for (const rid of ["B1", "B2", "B3", "B4"]) confirmHold(holdDir, RUNS[rid]);
    missHold(holdDir, RUNS.B2, "runtime hold timeout after 1800000ms");

    const ev = await waitForPhaseEvidence(ctx, state, STOPDEL);

    assert.equal(ev.outcome, "hold_missed");
    assert.match(String(ev.reason), new RegExp(RUNS.B2));
    assert.match(String(ev.reason), /1800000ms/);
    assert.notEqual(ev.outcome, "evidence_error");
  });

  it("W3: negative control — probePhaseMarkerReal has no hold-confirmed predicate and returns evidence_error", async () => {
    const { holdDir, ctx } = makeHarness();
    const state = makeState();
    // A mechanically-open campaign DB proves the evidence_error is the MISSING
    // PREDICATE (default case), not merely an unreadable DB.
    const api = {
      getRun: () => null,
      listRuns: () => [],
      activeStepRows: () => [],
      activeStepsForRuns: () => [],
      close: () => {},
    };
    const verdict = await probePhaseMarkerReal({
      dbOpen: () => ({ ok: true, api }),
      dbPath: path.join(holdDir, "campaign.db"),
      state,
      ph: STOPDEL,
      refs: null,
    });
    assert.equal(verdict.satisfied, false);
    assert.equal(verdict.outcome, "evidence_error");
    assert.match(String(verdict.reason), /no real phase predicate for marker hold-confirmed/);

    // The real wrapper's injected override IS that probe: on its own it can
    // never satisfy a derived hold (this is exactly the SF-11 defect).
    const injected = await ctx.opts.probePhaseMarker(ctx, state, STOPDEL);
    assert.equal(injected.outcome, "evidence_error");
  });

  it("W4: the reorder preserves the injected-override seam for non-hold predicates", async () => {
    const { ctx } = makeHarness();
    const state = makeState();
    let calls = 0;
    ctx.opts.probePhaseMarker = (_c: any, _s: any, p: any) => {
      calls += 1;
      return { satisfied: true, outcome: "marker_satisfied", marker: p.waitFor?.marker, evidence: "injected seam" };
    };
    const nonHold = {
      id: "B-cc1",
      label: "B-cc1 (non-hold)",
      waitFor: { kind: "ref", marker: "round-b-launches-registered" },
      action: { kind: "colleague_commit" },
    };

    const ev = await waitForPhaseEvidence(ctx, state, nonHold);

    assert.equal(calls, 1, "the injected probe is still consulted for a non-hold predicate");
    assert.equal(ev.outcome, "marker_satisfied");
  });
});
