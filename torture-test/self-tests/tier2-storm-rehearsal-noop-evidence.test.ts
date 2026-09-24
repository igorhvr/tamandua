// Tier-2 STORM-REHEARSAL FIX9 US-008 (requirement 3) — no-op guard audit.
//
// SF-15 (fix-8) fixed ONE predicate (the B-park landing) that a no-op product
// action could satisfy: the product's `noOpLanding` sets
// `checkoutRefresh:"already-coherent"` WITHOUT inspecting the checkout, so a
// predicate that accepted 'already-coherent'/'refreshed' as a park landing was
// green even though the landing changed nothing (NPF-1).
//
// US-008 generalizes the audit to the REMAINING product-evidence/db
// predicates. For every predicate the EVIDENCE_PREDICATE_AUDIT lists there is
// now an explicit no-op guard:
//   * `realTransition` — the real state transition the predicate requires;
//   * `noopRejected`   — the no-op/fabricated shape it must reject.
//
// The three named high-risk predicates are pinned here with a POSITIVE (real
// evidence passes) and one or more NEGATIVE (no-op/empty/fabricated variants
// fail) case:
//   * rugpull relaunch lineage  — `rugpull-recovered`: a DISTINCT child run
//     row created AFTER B-rugpull fired; an aliased row (reusing the target's
//     own run id) or a pre-action row is rejected.
//   * B-kill/B4 harness reclaim — `B4 post-kill harness reclaim`: a claim row
//     stamped at/after B-kill fired; the pre-kill claim (or a row with no
//     post-kill clock) is rejected.
//   * B5 relaunch lineage       — `B5 relaunch lineage`: deleted B5 + a
//     separate COMPLETED relaunch with a DISTINCT run id; an aliased run id is
//     rejected.
//
// Hermetic: fake dbOpen seam + in-memory state; no daemon, no ports, no
// harness, no git repo, no model.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EVIDENCE_PREDICATE_AUDIT,
  isB5RelaunchLineage,
  isPostKillReclaimRow,
  isRelaunchChildRow,
  probePhaseMarkerReal,
  summarizeEvidencePredicateAudit,
} from "../bin/tt-storm-real.mjs";

const T_FIRED = "2026-09-14T00:00:00.000Z";
const T_AFTER = "2026-09-14T00:05:00.000Z";
const T_BEFORE = "2026-09-13T23:00:00.000Z";

const RUNS = {
  B1: "11111111-1111-4111-8111-111111111111",
  B2: "22222222-2222-4222-8222-222222222222",
  B3: "33333333-3333-4333-8333-333333333333",
  B4: "44444444-4444-4444-8444-444444444444",
  B5: "55555555-5555-4555-8555-555555555555",
  B5R: "66666666-6666-4666-8666-666666666666",
};

const B_TARGETS = ["B1", "B2", "B3", "B4"] as const;

function runRow({ tag, bare, parentBare = null, createdAt = T_BEFORE, status = "failed" }: any) {
  return {
    id: bare,
    run_id_bare: bare,
    run_id_public: `run-${bare}`,
    parent_run_id: parentBare ? `run-${parentBare}` : null,
    parent_run_id_bare: parentBare ?? null,
    status,
    created_at: createdAt,
    updated_at: createdAt,
    tag,
  };
}

function makeState({ phases = {}, runs = {} }: any = {}) {
  const bRuns: any = {};
  for (const rid of B_TARGETS) bRuns[rid] = { rosterId: rid, runId: `run-${RUNS[rid]}` };
  bRuns.B5 = { rosterId: "B5", runId: `run-${RUNS.B5}` };
  return {
    exec_identity: { state_root: "/nonexistent/state" },
    plan: { launches: [], fixtureIdentity: { cc2File: "client-store.ts" } },
    rounds: { B: { runs: { ...bRuns, ...runs }, phases: { ...phases } } },
  };
}

// A fake dbOpen seam over in-memory rows. `listRuns` returns the rows verbatim
// (already decorated with bare identities); `activeStepRows` narrows by run id
// the way the real seam does.
function dbOpenWith({ runs = [] as any[], steps = [] as any[] } = {}) {
  return () => ({
    ok: true,
    api: {
      getRun: (runKey: string) => runs.find(
        (r) => r.id === runKey || r.run_id_bare === runKey || `run-${r.run_id_bare}` === runKey,
      ),
      listRuns: () => runs,
      activeStepRows: (runIds: string[], { stepIds = null }: any = {}) => steps.filter((s) => {
        const matchesRun = runIds.some(
          (id) => id === s.run_id || id === s.run_id_bare || id === `run-${s.run_id_bare}`,
        );
        if (!matchesRun) return false;
        if (stepIds === null) return true;
        return stepIds.includes(s.step_id);
      }),
      close: () => {},
    },
  });
}

function probe({ marker, state, dbOpen }: any) {
  return probePhaseMarkerReal({
    dbOpen: dbOpen ?? dbOpenWith(),
    dbPath: "/nonexistent/campaign.db",
    state,
    ph: { waitFor: { kind: "phase", marker } },
    refs: null,
    stateRoot: "/nonexistent/state",
  } as any);
}

// A complete parent+child rig: every B1..B4 row exists and each has the given
// child shape (or no child at all).
function relaunchRig(childFactory: (rid: string) => any) {
  const runs: any[] = [];
  for (const rid of B_TARGETS) {
    const parent = RUNS[rid as keyof typeof RUNS];
    runs.push(runRow({ tag: rid, bare: parent, status: "failed" }));
    const child = childFactory(rid);
    if (child) runs.push(child);
  }
  return runs;
}

// ─────────────────────────────────────────────────────────────────────
// A1 — every audited predicate carries a no-op guard (AC1).
// ─────────────────────────────────────────────────────────────────────

describe("US-008 no-op guard audit", () => {
  it("A1: every EVIDENCE_PREDICATE_AUDIT row names its real transition and the no-op it rejects", () => {
    assert.ok(EVIDENCE_PREDICATE_AUDIT.length >= 12, "the audit still lists the full predicate set");
    for (const entry of EVIDENCE_PREDICATE_AUDIT as any[]) {
      assert.ok(entry.noopGuard, `${entry.marker}: has a noopGuard`);
      assert.equal(typeof entry.noopGuard.realTransition, "string", `${entry.marker}: realTransition is a string`);
      assert.ok(entry.noopGuard.realTransition.trim().length > 0, `${entry.marker}: realTransition names the transition`);
      assert.equal(typeof entry.noopGuard.noopRejected, "string", `${entry.marker}: noopRejected is a string`);
      assert.ok(entry.noopGuard.noopRejected.trim().length > 0, `${entry.marker}: noopRejected names the rejected shape`);
    }
    // The three named high-risk predicates are audited.
    for (const marker of ["rugpull-recovered", "B4 post-kill harness reclaim", "B5 relaunch lineage"]) {
      assert.ok((EVIDENCE_PREDICATE_AUDIT as any[]).some((e) => e.marker === marker), `${marker} must be audited`);
    }
    const summary: any = summarizeEvidencePredicateAudit();
    assert.equal(summary.ok, true, "the audit recomputes ok with every guard present");
    assert.equal(summary.noopGuarded, true);
  });

  it("A2: the pure guards are fail-closed on empty/absent input", () => {
    assert.equal(isRelaunchChildRow(null, { parentBare: RUNS.B1 }), false);
    assert.equal(isRelaunchChildRow({ run_id_bare: RUNS.B1 }, {}), false, "no parent -> reject");
    assert.equal(isPostKillReclaimRow(null, { actionFiredAt: T_FIRED }), false);
    assert.equal(isPostKillReclaimRow({ step_id: "x" }, { actionFiredAt: T_FIRED }), false, "no clock -> reject");
    assert.equal(isB5RelaunchLineage({}), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P* — rugpull relaunch lineage (rugpull-recovered).
// ─────────────────────────────────────────────────────────────────────

describe("US-008 rugpull relaunch lineage (post-action distinct child)", () => {
  it("R1: a distinct child row created AFTER B-rugpull fired is real recovery", async () => {
    const runs = relaunchRig((rid) => runRow({
      tag: `${rid}R`,
      bare: `a${RUNS[rid as keyof typeof RUNS].slice(1)}`,
      parentBare: RUNS[rid as keyof typeof RUNS],
      createdAt: T_AFTER,
      status: "running",
    }));
    const state = makeState({ phases: { "B-rugpull": { id: "B-rugpull", status: "fired", firedAt: T_FIRED } } });
    const v: any = await probe({ marker: "rugpull-recovered", state, dbOpen: dbOpenWith({ runs }) });
    assert.equal(v.satisfied, true, v.evidence);
    assert.equal(v.outcome, "marker_satisfied");
    assert.match(String(v.evidence), /post-action/i);
  });

  it("R2: a child row that ALIASES the target's own run id is a no-op and is rejected", async () => {
    const runs = relaunchRig((rid) => runRow({
      tag: `${rid}R`,
      bare: RUNS[rid as keyof typeof RUNS],
      parentBare: RUNS[rid as keyof typeof RUNS],
      createdAt: T_AFTER,
    }));
    const state = makeState({ phases: { "B-rugpull": { id: "B-rugpull", status: "fired", firedAt: T_FIRED } } });
    const v: any = await probe({ marker: "rugpull-recovered", state, dbOpen: dbOpenWith({ runs }) });
    assert.equal(v.satisfied, false, "an aliased child row must not count as recovery");
    assert.match(String(v.evidence), /no-post-action-child-run/);
  });

  it("R3: a child row created BEFORE B-rugpull fired is a pre-existing run, not recovery", async () => {
    const runs = relaunchRig((rid) => runRow({
      tag: `${rid}R`,
      bare: `${RUNS[rid as keyof typeof RUNS].slice(0, -1)}9`,
      parentBare: RUNS[rid as keyof typeof RUNS],
      createdAt: T_BEFORE,
    }));
    const state = makeState({ phases: { "B-rugpull": { id: "B-rugpull", status: "fired", firedAt: T_FIRED } } });
    const v: any = await probe({ marker: "rugpull-recovered", state, dbOpen: dbOpenWith({ runs }) });
    assert.equal(v.satisfied, false, "a pre-action child row must not count as recovery");
    assert.match(String(v.evidence), /no-post-action-child-run/);
  });

  it("R4: no children at all (the B-rugpull action alone) is rejected", async () => {
    const runs = relaunchRig(() => null);
    const state = makeState({ phases: { "B-rugpull": { id: "B-rugpull", status: "fired", firedAt: T_FIRED } } });
    const v: any = await probe({ marker: "rugpull-recovered", state, dbOpen: dbOpenWith({ runs }) });
    assert.equal(v.satisfied, false);
    assert.equal(v.outcome, "not_yet");
  });
});

// ─────────────────────────────────────────────────────────────────────
// K* — B-kill / B4 harness reclaim.
// ─────────────────────────────────────────────────────────────────────

describe("US-008 B-kill / B4 harness reclaim (post-kill claim only)", () => {
  const killState = () => makeState({ phases: { "B-kill": { id: "B-kill", status: "fired", firedAt: T_FIRED } } });

  it("K1: a claim stamped AFTER B-kill fired is real recovery", async () => {
    const steps = [{ run_id: RUNS.B4, run_id_bare: RUNS.B4, step_id: "investigate", status: "running", updated_at: T_AFTER }];
    const v: any = await probe({ marker: "B4 post-kill harness reclaim", state: killState(), dbOpen: dbOpenWith({ steps }) });
    assert.equal(v.satisfied, true, v.evidence);
    assert.equal(v.outcome, "marker_satisfied");
  });

  it("K2: the PRE-kill claim that triggered B-kill is rejected", async () => {
    const steps = [{ run_id: RUNS.B4, run_id_bare: RUNS.B4, step_id: "investigate", status: "running", updated_at: T_BEFORE }];
    const v: any = await probe({ marker: "B4 post-kill harness reclaim", state: killState(), dbOpen: dbOpenWith({ steps }) });
    assert.equal(v.satisfied, false, "a pre-kill claim must not count as recovery");
    assert.match(String(v.evidence), /no post-kill reclaim/i);
  });

  it("K3: a claim row with no usable post-kill clock fails closed", async () => {
    const steps = [{ run_id: RUNS.B4, run_id_bare: RUNS.B4, step_id: "investigate", status: "running" }];
    const v: any = await probe({ marker: "B4 post-kill harness reclaim", state: killState(), dbOpen: dbOpenWith({ steps }) });
    assert.equal(v.satisfied, false, "unknown claim time is never assumed post-kill");
  });

  it("K4: kill not dispatched yet is not_yet; empty rows are rejected", async () => {
    const empty: any = await probe({
      marker: "B4 post-kill harness reclaim",
      state: makeState(),
      dbOpen: dbOpenWith({ steps: [] }),
    });
    assert.equal(empty.satisfied, false);
    assert.equal(empty.outcome, "not_yet");
    const noRows: any = await probe({ marker: "B4 post-kill harness reclaim", state: killState(), dbOpen: dbOpenWith({ steps: [] }) });
    assert.equal(noRows.satisfied, false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// L* — B5 relaunch lineage.
// ─────────────────────────────────────────────────────────────────────

describe("US-008 B5 relaunch lineage (distinct completed relaunch)", () => {
  const stopdelState = () => makeState({
    phases: { "B-stopdel": { id: "B-stopdel", status: "fired", firedAt: T_FIRED } },
    runs: { B5: { rosterId: "B5", runId: `run-${RUNS.B5}`, terminalStatus: "deleted" } },
  });

  it("L1: a deleted B5 plus a DISTINCT completed B5-relaunch is real lineage", async () => {
    const state = stopdelState();
    state.rounds.B.runs["B5-relaunch"] = {
      rosterId: "B5-relaunch",
      runId: `run-${RUNS.B5R}`,
      relaunchOf: "B5",
      terminalStatus: "completed",
    };
    const v: any = await probe({ marker: "B5 relaunch lineage", state });
    assert.equal(v.satisfied, true, v.evidence);
    assert.equal(v.outcome, "marker_satisfied");
  });

  it("L2: a relaunch reusing the deleted B5's own run id is an alias and is rejected", async () => {
    const state = stopdelState();
    state.rounds.B.runs["B5-relaunch"] = {
      rosterId: "B5-relaunch",
      runId: `run-${RUNS.B5}`,
      relaunchOf: "B5",
      terminalStatus: "completed",
    };
    const v: any = await probe({ marker: "B5 relaunch lineage", state });
    assert.equal(v.satisfied, false, "an aliased relaunch run id must not satisfy the lineage");
    assert.equal(v.outcome, "not_yet");
  });

  it("L3: a fabricated (no run id / not linked / not completed) relaunch is rejected", () => {
    const b5Record = { rosterId: "B5", runId: `run-${RUNS.B5}`, terminalStatus: "deleted" };
    assert.equal(isB5RelaunchLineage({ b5Record, relaunchRecord: { rosterId: "B5-relaunch", relaunchOf: "B5", runId: "", terminalStatus: "completed" } }), false, "no run id");
    assert.equal(isB5RelaunchLineage({ b5Record, relaunchRecord: { rosterId: "B5-relaunch", relaunchOf: "B5", runId: `run-${RUNS.B5R}`, terminalStatus: "running" } }), false, "not completed");
    assert.equal(isB5RelaunchLineage({ b5Record, relaunchRecord: { rosterId: "B5-relaunch", runId: `run-${RUNS.B5R}`, terminalStatus: "completed" } }), false, "unlinked");
    assert.equal(isB5RelaunchLineage({ b5Record: { ...b5Record, terminalStatus: "completed" }, relaunchRecord: { rosterId: "B5-relaunch", relaunchOf: "B5", runId: `run-${RUNS.B5R}`, terminalStatus: "completed" } }), false, "B5 not deleted");
  });

  it("L4: no relaunch record at all is not_yet", async () => {
    const v: any = await probe({ marker: "B5 relaunch lineage", state: stopdelState() });
    assert.equal(v.satisfied, false);
    assert.equal(v.outcome, "not_yet");
  });
});
