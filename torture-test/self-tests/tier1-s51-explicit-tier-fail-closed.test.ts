// S51 (R4a US-009): explicit-tier fail-closed — executed/expected verdict.
//
// Red-arm/green-arm proof for the verdict half of S51 (the launch-gate half —
// host profile RESULT FAIL refusal + --allow-partial — is pinned by the
// fake-tree whole-script tests in bin/tt-run.test.sh, and the host-profile
// writer's profile_result record is pinned by tt-verify-environment.test.sh):
//
// GREEN must require executed == expected-executable under the host profile.
// The mac 2026-09-02 campaigns reported GREEN while only a fraction of the
// cells they were capable of actually executed (1/35, 4/28, 1/70 'greens'):
// an expected-executable cell (its requires satisfied by the loaded profile,
// recorded at campaign start) ended the campaign with zero attempts and a
// tolerated NOT_RUN category, so the old verdict math — which only failed
// closed on INFRA / zero-executed vacuity / real findings — reported GREEN.
//
// RED ARM: the shortfall terminal state below (3 executed PASS cells + 1
// expected-executable cell C-4 skipped with NOT_RUN(predicate) and zero
// attempts) renders GREEN (exit 0) through the PRE-S51 verdictExitCode
// (embedded below, byte-faithful to commit f6b28946 — the pre-change HEAD)
// and INCONCLUSIVE (exit 1) through the post-S51 module, which names C-4 as
// the shortfall cell and prints executed/expected (3/4).
//
// GREEN ARMS: executed == expected stays GREEN with executed/expected
// printed (4/4); a legitimately predicate-blocked cell (the W4.22 darwin-only
// scripted cell analog) is excluded from the recorded scope so a normal
// partial host stays GREEN (3/3); an empty scope (scripted-only run of a
// real-only manifest analog) stays GREEN (0/0); a legacy state without the
// recorded scope keeps the pre-S51 verdict math byte-for-byte (GREEN, no
// executed/expected line); real findings take precedence over INCONCLUSIVE;
// the all-skipped bare vacuity guard still fires before INCONCLUSIVE.
//
// Zero tokens, no daemons, no launches — pure report/state math over
// synthetic terminal campaign states (the same shape the tier1-bare-vacuity
// red-arm uses). Confined to torture-test/.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  bareVacuityCause,
  buildCampaignReport,
  executedExpectedCounts,
  hasInfrastructureFailure,
  renderCampaignReport,
  verdictExitCode,
  zeroRealLaunchesCause,
  // @ts-expect-error -- no ambient declaration for the tt-report.mjs module
} from "../bin/tt-report.mjs";

// ── Pre-S51 verdictExitCode (f6b28946, the commit this story starts from) ──
// Whitespace-normalized exactly as extractBody() compares (MACP5.1): the
// byte-faithfulness pin's self-contained source of truth. Captured at
// authoring time; embedded inline so the RED-ARM's "pre-change it was GREEN"
// claim never depends on git history (unreachable on merged main).
const PRE_S51_VERDICT_EXIT_CODE_BODY =
  " const failClosedCause = zeroRealLaunchesCause(state); if (failClosedCause !== null) return { verdict: 'INFRA_FAILURE', exitCode: 2 }; if (hasInfrastructureFailure(state)) return { verdict: 'INFRA_FAILURE', exitCode: 2 }; // MACP3 US-008: bare-campaign vacuity guard. An all-skipped bare campaign // must be RED (FINDINGS/exit 1) with an explicit vacuous-campaign finding, // never GREEN. INFRA (above) has precedence: a host-profile-missing or // other infrastructure failure is already RED/INFRA (exit 2) and explains // the failure precisely, so it must not be downgraded to a vacuity // FINDINGS. Real-mode behavior is untouched (bareVacuityCause returns null // unless execution_selection='scripted-only'). const vacuityCause = bareVacuityCause(state); if (vacuityCause !== null) return { verdict: 'FINDINGS', exitCode: 1 }; // FIX10 US-005: a hygiene-canary diff (operator-identity file changed // during the campaign) is a campaign-level FINDING — never silent. const hygieneDiffs = state?.hygiene_canary?.diffs; if (Array.isArray(hygieneDiffs) && hygieneDiffs.length > 0) { return { verdict: 'FINDINGS', exitCode: 1 }; } const hasFinding = state.cases.some((item) => !['PASS', 'NOT_RUN'].includes(item.outcome) || (item.findings ?? []).length > 0); return hasFinding ? { verdict: 'FINDINGS', exitCode: 1 } : { verdict: 'GREEN', exitCode: 0 };";

const reportSource = fs.readFileSync(path.join(import.meta.dirname, "..", "bin", "tt-report.mjs"), "utf8");

function extractBody(src: string, fnName: string): string {
  const re = new RegExp(`function\\s+${fnName}\\(state\\) \\{([\\s\\S]*?)\\n\\}`, "m");
  const m = src.match(re);
  assert.ok(m, `function ${fnName}(state) not found in source`);
  return m[1].replace(/\s+/g, " ");
}

// The pre-S51 verdictExitCode, faithfully reconstructed from the embedded
// body using the module's (unchanged by S51) helper functions. GREEN iff no
// infra / vacuity / hygiene / finding — exactly the math that reported the
// mac 1/35, 4/28, 1/70 partial-execution campaigns GREEN.
function legacyVerdictExitCode(state: any): { verdict: string; exitCode: number } {
  const failClosedCause = zeroRealLaunchesCause(state);
  if (failClosedCause !== null) return { verdict: "INFRA_FAILURE", exitCode: 2 };
  if (hasInfrastructureFailure(state)) return { verdict: "INFRA_FAILURE", exitCode: 2 };
  const vacuityCause = bareVacuityCause(state);
  if (vacuityCause !== null) return { verdict: "FINDINGS", exitCode: 1 };
  const hygieneDiffs = state?.hygiene_canary?.diffs;
  if (Array.isArray(hygieneDiffs) && hygieneDiffs.length > 0) {
    return { verdict: "FINDINGS", exitCode: 1 };
  }
  const hasFinding = state.cases.some((item: any) =>
    !["PASS", "NOT_RUN"].includes(item.outcome) || (item.findings ?? []).length > 0);
  return hasFinding ? { verdict: "FINDINGS", exitCode: 1 } : { verdict: "GREEN", exitCode: 0 };
}

const ts = new Date().toISOString();

function caseState(id: string, outcome: string, reason: any, attempts: any[]): any {
  return {
    id, wave: 0, workflow: "local", fixture: "none", harness: "local", class: "verification",
    execution_mode: "scripted", replay_of: null, production_duration_floor_ms: null,
    expected_fast_failure: false, phase: "terminal", outcome, reason: reason ?? null,
    attempts, findings: [], oracle_results: [],
    spend: { tokens_observed: 0, observations: [] },
  };
}

function passAttempt(): any {
  return {
    phase: "terminal", started_at: ts, terminal_at: ts, status: "exited", exit_code: 0,
    command: "true", evidence: { stdout: "", stderr: "" },
  };
}

function makeState(cases: any[], expectedIds: string[], options?: Record<string, unknown>): any {
  return {
    version: 1,
    campaign_id: "campaign-s51-synthetic",
    phase: "ready",
    created_at: ts,
    updated_at: ts,
    options: {
      concurrency: 1, stagger_ms: 0, execution_selection: "all",
      ...(options ?? {}),
    },
    spend: { tokens_observed: 0, observations: [] },
    discovered_runs: [],
    manifest: {
      path: "var/s51-synthetic/manifest.jsonl",
      sha256: "a".repeat(64),
      case_count: cases.length,
      case_ids: cases.map((c) => c.id),
    },
    cases,
    hygiene_canary: null,
    expected_executable: {
      count: expectedIds.length,
      ids: expectedIds,
      basis: "in-scope host-requirement-satisfiable",
      profile: { state: "loaded", result: "PASS" },
    },
  };
}

// The RED-ARM state: 3 executed PASS cells + C-4 recorded expected-executable
// (its requires were satisfiable under the loaded profile at campaign start)
// that ended NOT_RUN(predicate) with zero attempts — the mac drift shape.
function shortfallState(): any {
  return makeState(
    [
      caseState("C-1", "PASS", null, [passAttempt()]),
      caseState("C-2", "PASS", null, [passAttempt()]),
      caseState("C-3", "PASS", null, [passAttempt()]),
      caseState("C-4", "NOT_RUN", {
        category: "predicate",
        evidence: [{ predicate: "capabilities.some-cap", expected: true, observed: false }],
      }, []),
    ],
    ["C-1", "C-2", "C-3", "C-4"],
  );
}

describe("S51 executed/expected verdict (R4a US-009)", () => {
  it("pre-S51 verdictExitCode is pinned (f6b28946) and contains no executed/expected check", () => {
    // The embedded pre-S51 body is the self-contained source of truth for the
    // RED arm's "pre-change it was GREEN" claim (MACP5.1: never resolved via
    // git history — f6b28946 is unreachable on merged main). The pre-S51
    // math must contain none of the S51 machinery, and the CURRENT
    // verdictExitCode must contain it (so the red/green arms measure a real
    // code change, not a restatement).
    assert.ok(!PRE_S51_VERDICT_EXIT_CODE_BODY.includes("executedExpectedCounts"));
    assert.ok(!PRE_S51_VERDICT_EXIT_CODE_BODY.includes("INCONCLUSIVE"));
    assert.ok(
      !PRE_S51_VERDICT_EXIT_CODE_BODY.includes("executed !== execution.expected"),
      "embedded pre-S51 body must predate the executed/expected check",
    );
    const currentBody = extractBody(reportSource, "verdictExitCode");
    assert.ok(
      currentBody.includes("executedExpectedCounts") && currentBody.includes("INCONCLUSIVE"),
      "the current verdictExitCode must carry the S51 executed/expected check",
    );
  });

  it("RED ARM — an expected-executable cell that never executed was GREEN pre-S51 and is INCONCLUSIVE post-S51 (executed/expected printed, cell named)", () => {
    const state = shortfallState();

    // Pre-change behavior (frozen f6b28946 verdict math on the SAME state):
    // 3 PASS + a tolerated NOT_RUN(predicate) => GREEN exit 0. This is the
    // 1/35, 4/28, 1/70 partial-execution 'green' the story fixes.
    assert.deepEqual(
      legacyVerdictExitCode(state),
      { verdict: "GREEN", exitCode: 0 },
      "pre-S51 verdict math must render the shortfall state GREEN (the mac defect)",
    );

    // Post-change behavior: executed (3) < expected-executable (4) =>
    // INCONCLUSIVE (exit 1), naming C-4.
    assert.deepEqual(
      executedExpectedCounts(state),
      { expected: 4, executed: 3, shortfall: ["C-4"] },
    );
    assert.deepEqual(
      verdictExitCode(state),
      { verdict: "INCONCLUSIVE", exitCode: 1 },
      "executed < expected-executable must render INCONCLUSIVE, never GREEN",
    );
    const report = buildCampaignReport(state);
    assert.equal(report.verdict, "INCONCLUSIVE");
    assert.equal(report.exit_code, 1);
    assert.equal(report.executed, 3);
    assert.equal(report.expected_executable, 4);
    assert.deepEqual(report.shortfall_cells, ["C-4"]);
    assert.deepEqual(report.findings, [], "a shortfall is INCONCLUSIVE, not a FINDINGS");
    const text = renderCampaignReport(report);
    assert.match(text, /VERDICT\nINCONCLUSIVE \(exit 1\)/);
    assert.match(text, /executed\/expected: 3\/4/);
    assert.match(text, /shortfall cells \(expected but not executed\): C-4/);
    assert.ok(!/GREEN \(exit 0\)/.test(text), "shortfall must never render GREEN");
  });

  it("GREEN ARM — executed == expected-executable stays GREEN with executed/expected printed (4/4)", () => {
    const state = makeState(
      [
        caseState("C-1", "PASS", null, [passAttempt()]),
        caseState("C-2", "PASS", null, [passAttempt()]),
        caseState("C-3", "PASS", null, [passAttempt()]),
        caseState("C-4", "PASS", null, [passAttempt()]),
      ],
      ["C-1", "C-2", "C-3", "C-4"],
    );
    assert.deepEqual(verdictExitCode(state), { verdict: "GREEN", exitCode: 0 });
    const report = buildCampaignReport(state);
    assert.equal(report.executed, 4);
    assert.equal(report.expected_executable, 4);
    assert.deepEqual(report.shortfall_cells, []);
    const text = renderCampaignReport(report);
    assert.match(text, /VERDICT\nGREEN \(exit 0\)\nexecuted\/expected: 4\/4/);
  });

  it("GREEN ARM — a legitimately predicate-blocked cell (W4.22 darwin-only analog) is excluded from the scope, so a partial host stays GREEN 3/3", () => {
    const blocked = caseState("W4.22-symlink-path-parity", "NOT_RUN", {
      category: "predicate",
      evidence: [{ predicate: "platform", expected: ["darwin"], observed: "linux" }],
    }, []);
    const state = makeState(
      [
        caseState("A-1", "PASS", null, [passAttempt()]),
        caseState("A-2", "PASS", null, [passAttempt()]),
        caseState("A-3", "PASS", null, [passAttempt()]),
        blocked,
      ],
      ["A-1", "A-2", "A-3"],
    );
    assert.deepEqual(verdictExitCode(state), { verdict: "GREEN", exitCode: 0 });
    const report = buildCampaignReport(state);
    assert.equal(report.executed, 3);
    assert.equal(report.expected_executable, 3);
    assert.match(renderCampaignReport(report), /executed\/expected: 3\/3/);
  });

  it("GREEN ARM — an empty expected-executable scope (real-only manifest run bare) stays GREEN 0/0", () => {
    // Real-harness rows are pending-real in a bare (scripted-only) run: no
    // scripted cell exists, so the vacuity guard is silent and the scope is
    // empty — executed 0 == expected 0 stays GREEN.
    const state = makeState(
      [caseState("R-1", "NOT_RUN", { category: "pending-real" }, [])],
      [],
      { execution_selection: "scripted-only" },
    );
    state.cases[0].harness = "pi";
    assert.deepEqual(verdictExitCode(state), { verdict: "GREEN", exitCode: 0 });
    const report = buildCampaignReport(state);
    assert.equal(report.executed, 0);
    assert.equal(report.expected_executable, 0);
    assert.match(renderCampaignReport(report), /executed\/expected: 0\/0/);
  });

  it("regression — a legacy state without the recorded scope keeps the pre-S51 verdict math byte-for-byte (no executed/expected line)", () => {
    const state = shortfallState();
    delete state.expected_executable;
    assert.deepEqual(verdictExitCode(state), { verdict: "GREEN", exitCode: 0 });
    const report = buildCampaignReport(state);
    assert.equal(report.executed, null);
    assert.equal(report.expected_executable, null);
    assert.deepEqual(report.shortfall_cells, []);
    // Legacy render output is byte-identical in shape to pre-S51: the VERDICT
    // block ends at the verdict line (the executed/expected line is absent).
    const text = renderCampaignReport(report);
    assert.match(text, /VERDICT\nGREEN \(exit 0\)\n$/);
    assert.ok(!text.includes("executed/expected"), "legacy render must not add an executed/expected line");
  });

  it("precedence — a real FINDING stays FINDINGS (not downgraded to INCONCLUSIVE); the all-skipped bare vacuity guard fires before INCONCLUSIVE", () => {
    // Finding + shortfall: the proven product defect keeps FINDINGS.
    const findingState = makeState(
      [
        caseState("C-1", "PASS", null, [passAttempt()]),
        caseState("C-2", "FAIL", { category: "product" }, [passAttempt()]),
        caseState("C-3", "NOT_RUN", { category: "predicate", evidence: [] }, []),
      ],
      ["C-1", "C-2", "C-3"],
    );
    assert.deepEqual(verdictExitCode(findingState), { verdict: "FINDINGS", exitCode: 1 });

    // All-skipped bare campaign: vacuity FINDINGS precedes the S51 shortfall.
    const allSkipped = makeState(
      ["S-1", "S-2", "S-3", "S-4"].map((id) =>
        caseState(id, "NOT_RUN", { category: "predicate", evidence: [{ predicate: "platform", expected: "darwin", observed: "linux" }] }, [])),
      ["S-1", "S-2", "S-3", "S-4"],
      { execution_selection: "scripted-only" },
    );
    assert.deepEqual(verdictExitCode(allSkipped), { verdict: "FINDINGS", exitCode: 1 });
    const report = buildCampaignReport(allSkipped);
    assert.equal(report.vacuity.triggered, true, "the vacuous-campaign guard must remain the operative signal");
    assert.ok(report.findings.some((f: any) => f.category === "vacuous-campaign"));
  });

  it("INFRA precedence — infra failures stay INFRA_FAILURE even with an executed/expected shortfall", () => {
    const state = makeState(
      [
        caseState("C-1", "PASS", null, [passAttempt()]),
        caseState("C-2", "TEST_INFRA_FAIL", { category: "host-profile-missing", message: "boom" }, []),
        caseState("C-3", "NOT_RUN", { category: "predicate", evidence: [] }, []),
      ],
      ["C-1", "C-2", "C-3"],
    );
    assert.deepEqual(verdictExitCode(state), { verdict: "INFRA_FAILURE", exitCode: 2 });
  });
});
