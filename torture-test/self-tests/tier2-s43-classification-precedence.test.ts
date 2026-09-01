// S43c (US-008) — bfmw classification precedence: one authoritative verdict.
//
// Campaign-20260826T225744158Z (W4.dsh-bfmw): state.json classified the
// attempt TEST_INFRA_FAIL (category 'chaos-invocation-failed' — the tt-chaos
// operator timed out: `chaos operator 'tt-chaos' exited null: spawnSync
// /home/igorhvr/idm/tamandua/torture-test/bin/tt-chaos ETIMEDOUT`) while
// report.txt's FINDINGS section rendered `- W4.dsh-bfmw: RUNAWAY - RUNAWAY`
// — the wall_min cap finding filed while the run was in flight (the run ran
// to the 45-minute wall cap because the chaos operator never completed) — so
// the two surfaces appeared to disagree on the cell's outcome. The same
// TIF-vs-RUNAWAY shape appears for W4.dsh-lifecycle (TEST_INFRA_FAIL
// probe-trigger-unreached + RUNAWAY).
//
// THE DOCUMENTED PRECEDENCE (S43c, cases/tier2-traceability.md):
// TEST_INFRA_FAIL infrastructure classifications take precedence over
// RUNAWAY cap findings on the same case. When the authoritative
// classification of a case is TEST_INFRA_FAIL, a RUNAWAY finding filed for
// that case is a DOWNSTREAM ARTIFACT of the infrastructure failure and is
// SUBSUMED: it is never a standalone finding that reads like the cell's
// verdict. Enforcement is in BOTH surfaces:
//   1. state.json classification — the controller's terminal choke-point
//      (markTerminal) marks RUNAWAY findings on a TEST_INFRA_FAIL case
//      `subsumed: true` with `subsumed_by: { outcome, category }`;
//   2. report.txt / report.json — the report layer derives the SAME
//      subsumption from (outcome === 'TEST_INFRA_FAIL' && type === 'RUNAWAY')
//      (so legacy evidence written before the controller-side marking
//      reconciles identically), excludes subsumed findings from the FINDINGS
//      ledger, and renders them in the SUBSUMED FINDINGS section.
//
// This test proves (zero tokens, files ONLY under torture-test/ + temp dirs):
//   * RED-ARM: pins the campaign evidence lines verbatim — state.json
//     classifies TEST_INFRA_FAIL (chaos-invocation-failed) while report.txt
//     FINDINGS renders the standalone `W4.dsh-bfmw: RUNAWAY - RUNAWAY` — and
//     REPRODUCES the pre-fix report behavior history-independently: the
//     pre-fix flatten (every case-level finding into the standalone FINDINGS
//     ledger, no subsumption) renders the RUNAWAY line for the TEST_INFRA_FAIL
//     cell — the two surfaces disagree;
//   * GREEN-ARM: post-fix BOTH surfaces resolve to the documented precedence —
//     the same shape renders the RUNAWAY finding in SUBSUMED FINDINGS (never
//     FINDINGS) with `subsumed_by` metadata in report.json, and the verdict
//     stays INFRA_FAILURE exit 2;
//   * GREEN-ARM (AC3): non-infra cells (W4.dsh-do-now PRODUCT_FAIL + RUNAWAY,
//     W4.37 INCONCLUSIVE + RUNAWAY) keep their standalone RUNAWAY findings
//     unchanged;
//   * GREEN-ARM (controller projection): subsumeRunawayFindings marks
//     state.json findings `subsumed: true` (idempotent, never removes
//     evidence, non-infra untouched);
//   * GREEN-ARM (schema/roster): tt-controller --validate-only stays green
//     and the traceability S43c section documents the precedence.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { buildCampaignReport, renderCampaignReport, verdictExitCode } from "../bin/tt-report.mjs";
import {
  isRunawayFinding,
  runawayFindingSubsumed,
  subsumeRunawayFindings,
} from "../bin/tt-subsumption.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const manifestPath = path.join(ttRoot, "cases", "tier2.jsonl");
const traceabilityPath = path.join(ttRoot, "cases", "tier2-traceability.md");
const controller = path.join(ttRoot, "bin", "tt-controller");

// ── Pinned campaign evidence (campaign-20260826T225744158Z, read-only) ────
// The bfmw run whose surfaces disagreed:
//   * state.json (W4.dsh-bfmw): outcome TEST_INFRA_FAIL, reason category
//     chaos-invocation-failed (the tt-chaos operator timed out), findings
//     [RUNAWAY wall_min 45/46.0079] — the run's cap breach.
//   * report.txt FINDINGS: `- W4.dsh-bfmw: RUNAWAY - RUNAWAY` — the standalone
//     finding that reads like the cell's verdict.
const BFMW_RUN_ID = "run-c8f9df30-b089-401c-94a1-208c894b1a24";
const BFMW_FINDINGS_LINE = "W4.dsh-bfmw: RUNAWAY - RUNAWAY";
const BFMW_INFRA_LINE = "W4.dsh-bfmw: chaos-invocation-failed (chaos operator 'tt-chaos' exited null: spawnSync /home/igorhvr/idm/tamandua/torture-test/bin/tt-chaos ETIMEDOUT)";
const BFMW_INFRA_CATEGORY = "chaos-invocation-failed";
const BFMW_RUNAWAY_FINDING = {
  type: "RUNAWAY", cap: "wall_min", threshold: 45, observed: 46.007933333333334,
  enforcement_latency: 60.476, run_id: BFMW_RUN_ID, detected_at: "2026-08-27T09:14:58.155Z",
};
// The non-infra cells that keep their standalone RUNAWAY findings (AC3).
const DO_NOW_RUNAWAY_FINDING = {
  type: "RUNAWAY", cap: "wall_min", threshold: 5, observed: 5.01335,
  enforcement_latency: 0.801, run_id: "run-ba584b54-fbb3-40b4-a7cc-34f5d6843a2d",
  detected_at: "2026-08-27T08:28:34.282Z",
};
const W437_RUNAWAY_FINDING = {
  type: "RUNAWAY", cap: "wall_min", threshold: 5, observed: 5.0127,
  enforcement_latency: 0.762, run_id: "run-b3ebfd31-7fb8-43f2-9720-8ae01b894fe5",
  detected_at: "2026-08-27T01:10:17.272Z",
};

// ── Minimal state builders (mirror bin/tt-report.test.mjs) ────────────────
const at = (seconds: number) => `2026-08-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;

function attempt(id: string, outcome: string) {
  return {
    id, case_id: "C", kind: "local", phase: "terminal",
    started_at: at(1), terminal_at: at(3), outcome,
  };
}

function stateWith(cases: any[]) {
  // execution_selection 'all' mirrors the campaign's stored options; the
  // cells are harness 'local' (scripted) so zeroRealLaunchesCause stays null
  // and the infra verdict is driven purely by hasInfrastructureFailure.
  return {
    version: 1,
    campaign_id: "campaign-s43c-precedence-test",
    phase: "ready",
    created_at: at(0),
    updated_at: at(9),
    manifest: { path: "cases/tier2.jsonl", sha256: "a".repeat(64), case_count: cases.length, case_ids: cases.map((item) => item.id) },
    options: { concurrency: 1, stagger_ms: 0, token_poll_interval_ms: 300000, execution_selection: "all" },
    spend: { tokens_observed: 0, observations: [] },
    cases,
    discovered_runs: [],
  };
}

function caseState(id: string, outcome: string, overrides: any = {}) {
  return {
    id,
    wave: overrides.wave ?? 4,
    workflow: overrides.workflow ?? "feature-dev-merge-worktree",
    fixture: overrides.fixture ?? "tt-ts",
    harness: overrides.harness ?? "local",
    class: overrides.class ?? "verification",
    phase: "terminal",
    outcome,
    terminal_at: overrides.terminal_at ?? at(5),
    attempts: overrides.attempts ?? [attempt("attempt-1", outcome)],
    findings: overrides.findings ?? [],
    oracle_results: overrides.oracle_results ?? [],
    spend: overrides.spend ?? { tokens_observed: 0, observations: [] },
    ...(overrides.reason === undefined ? {} : { reason: overrides.reason }),
  };
}

function runController(args: string[]) {
  return spawnSync(controller, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, TAMANDUA_PI_BINARY: "/usr/bin/false", TAMANDUA_HERMES_BINARY: "/usr/bin/false" },
  });
}

function readManifest(): any[] {
  return fs
    .readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// The PRE-FIX (S43c) report flatten, reproduced inline (history-
// independent): every case-level finding lands in the standalone FINDINGS
// ledger regardless of the case's authoritative classification — the pre-fix
// report rendered `W4.dsh-bfmw: RUNAWAY - RUNAWAY` for a TEST_INFRA_FAIL
// cell, disagreeing with state.json.
function preFixReportFindings(cases: any[]): any[] {
  return cases.flatMap((item: any) =>
    (item.findings ?? []).map((finding: any) => ({ case_id: item.id, ...finding })));
}

function bfmwCaseState() {
  return caseState("W4.dsh-bfmw", "TEST_INFRA_FAIL", {
    workflow: "feature-dev-merge-worktree",
    findings: [structuredClone(BFMW_RUNAWAY_FINDING)],
    reason: {
      category: BFMW_INFRA_CATEGORY,
      message: "chaos operator 'tt-chaos' exited null: spawnSync /home/igorhvr/idm/tamandua/torture-test/bin/tt-chaos ETIMEDOUT",
      operator: "tt-chaos", exit_code: null, signal: "SIGTERM", timed_out: true,
    },
  });
}

describe("S43c (US-008) — bfmw classification precedence: one authoritative verdict", () => {
  it("RED-ARM: pins the campaign evidence — state.json classifies TEST_INFRA_FAIL while report.txt FINDINGS renders a standalone RUNAWAY", () => {
    // The report.txt FINDINGS line, verbatim (campaign-20260826T225744158Z).
    assert.equal(
      BFMW_FINDINGS_LINE,
      "W4.dsh-bfmw: RUNAWAY - RUNAWAY",
    );
    // The report.txt INFRA FAILURES line, verbatim — the authoritative
    // classification message.
    assert.equal(
      BFMW_INFRA_LINE,
      "W4.dsh-bfmw: chaos-invocation-failed (chaos operator 'tt-chaos' exited null: spawnSync /home/igorhvr/idm/tamandua/torture-test/bin/tt-chaos ETIMEDOUT)",
    );
    // state.json (W4.dsh-bfmw): the attempt classification.
    assert.equal(BFMW_INFRA_CATEGORY, "chaos-invocation-failed");
    // state.json (W4.dsh-bfmw): the run's RUNAWAY cap finding — the SAME run.
    assert.deepEqual(BFMW_RUNAWAY_FINDING, {
      type: "RUNAWAY", cap: "wall_min", threshold: 45, observed: 46.007933333333334,
      enforcement_latency: 60.476, run_id: BFMW_RUN_ID, detected_at: "2026-08-27T09:14:58.155Z",
    });
    assert.equal(BFMW_RUNAWAY_FINDING.run_id, BFMW_RUN_ID);

    // The DISAGREEMENT: the authoritative classification (state.json) is
    // TEST_INFRA_FAIL chaos-invocation-failed, yet the report's FINDINGS
    // surface renders a standalone RUNAWAY finding that reads like the cell's
    // verdict — a reader of FINDINGS concludes RUNAWAY while state.json says
    // TEST_INFRA_FAIL. The two surfaces disagree on the cell's outcome.
    assert.notEqual(BFMW_INFRA_CATEGORY, "RUNAWAY");
    assert.notEqual(BFMW_INFRA_CATEGORY, "runaway-cap-enforced");

    // The W4.dsh-bfmw cell is the bfmw (bug-fix-merge-worktree) cell in
    // wave 4 — the cell this story reconciles.
    const rows = readManifest();
    const bfmw = rows.find((record) => record.id === "W4.dsh-bfmw");
    assert.ok(bfmw, "W4.dsh-bfmw must be in the tier2 manifest");
    assert.equal(bfmw.workflow, "bug-fix-merge-worktree");
    assert.equal(bfmw.wave, 4);

    // The traceability S43c section exists and documents the precedence.
    const traceability = fs.readFileSync(traceabilityPath, "utf8");
    const section = traceability.match(/## S43c[^\n]*\n([\s\S]*?)(?=\n## |\n---|$)/)?.[1];
    assert.ok(section, "tier2-traceability.md must contain an S43c section");
    assert.match(section, /TEST_INFRA_FAIL infrastructure classifications take precedence over RUNAWAY\s+cap findings/);
    assert.match(section, /W4\.dsh-bfmw/);
    assert.match(section, /chaos-invocation-failed/);
    assert.match(section, /subsumed/i);
  });

  it("RED-ARM: reproduces the pre-fix report behavior — the standalone RUNAWAY finding in FINDINGS for a TEST_INFRA_FAIL cell", () => {
    // The pre-fix flatten (all case-level findings into the standalone
    // FINDINGS ledger, no subsumption) applied to the campaign shape renders
    // the disagreement line for the TEST_INFRA_FAIL cell.
    const preFix = preFixReportFindings([bfmwCaseState()]);
    const runaway = preFix.find((finding) => finding.case_id === "W4.dsh-bfmw" && finding.type === "RUNAWAY");
    assert.ok(runaway, "pre-fix: the TEST_INFRA_FAIL cell's RUNAWAY finding must land in the FINDINGS ledger");
    assert.equal(runaway.cap, "wall_min");
    assert.equal(runaway.run_id, BFMW_RUN_ID);
    // The rendered line (findingSummary shape: `<case_id>: <type> - <type>`
    // for a bare RUNAWAY finding) is exactly the campaign line.
    const label = runaway.oracle_id ?? runaway.oracle ?? runaway.type;
    const summary = runaway.finding?.summary ?? runaway.summary ?? runaway.type;
    assert.equal(`${runaway.case_id}: ${label} - ${summary}`, BFMW_FINDINGS_LINE);
    // The outcome is TEST_INFRA_FAIL — so the pre-fix report disagrees with
    // state.json on the cell's verdict.
    assert.equal(bfmwCaseState().outcome, "TEST_INFRA_FAIL");
  });

  it("GREEN-ARM: post-fix BOTH surfaces agree — the RUNAWAY finding is subsumed by TEST_INFRA_FAIL", () => {
    // The SAME campaign shape (state.json TIF + report.txt RUNAWAY, no
    // subsumed flag — legacy evidence) now reconciles: the report derives the
    // subsumption from outcome + type.
    const bfmw = bfmwCaseState();
    const doNow = caseState("W4.dsh-do-now", "PRODUCT_FAIL", {
      workflow: "do-now",
      findings: [structuredClone(DO_NOW_RUNAWAY_FINDING)],
      reason: { category: "oracle-failed", oracles: ["O1"] },
    });
    const report = buildCampaignReport(stateWith([bfmw, doNow]));

    // The TEST_INFRA_FAIL cell's RUNAWAY finding is NOT a standalone finding.
    assert.equal(
      report.findings.some((finding: any) => finding.case_id === "W4.dsh-bfmw" && finding.type === "RUNAWAY"),
      false,
      `post-fix: the TIF cell's RUNAWAY finding must not appear in FINDINGS: ${JSON.stringify(report.findings)}`,
    );
    // It is preserved in subsumed_findings with the subsuming classification.
    const sub = report.subsumed_findings.find((finding: any) => finding.case_id === "W4.dsh-bfmw");
    assert.ok(sub, "post-fix: the TIF cell's RUNAWAY finding must be preserved in subsumed_findings");
    assert.equal(sub.type, "RUNAWAY");
    assert.equal(sub.run_id, BFMW_RUN_ID);
    assert.equal(sub.subsumed, true);
    assert.deepEqual(sub.subsumed_by, { outcome: "TEST_INFRA_FAIL", category: "chaos-invocation-failed" });

    // report.txt: the FINDINGS section no longer carries the disagreement
    // line (the subsumed entry is rendered in its own section with the
    // subsuming classification named, so the standalone line — exactly
    // `- <case>: RUNAWAY - RUNAWAY` followed by a line break — never appears
    // as a FINDINGS entry).
    const text = renderCampaignReport(report);
    const findingsSection = text.split("\nSUBSUMED FINDINGS\n")[0].split("\nFINDINGS\n")[1] ?? "";
    assert.ok(
      !findingsSection.includes("W4.dsh-bfmw: RUNAWAY - RUNAWAY"),
      `report.txt FINDINGS must not render the standalone RUNAWAY line: ${findingsSection}`,
    );
    assert.match(
      text,
      /SUBSUMED FINDINGS\n- W4\.dsh-bfmw: RUNAWAY - RUNAWAY \(subsumed by TEST_INFRA_FAIL chaos-invocation-failed\)/,
    );
    // The authoritative verdict is unchanged: infra drives exit 2.
    assert.equal(report.verdict, "INFRA_FAILURE");
    assert.equal(report.exit_code, 2);
    assert.match(text, /INFRA FAILURES\n- W4\.dsh-bfmw: chaos-invocation-failed/);

    // AC3: the non-infra PRODUCT_FAIL cell keeps its standalone RUNAWAY
    // finding unchanged (and is absent from subsumed_findings).
    assert.ok(
      report.findings.some((finding: any) => finding.case_id === "W4.dsh-do-now" && finding.type === "RUNAWAY"),
      "AC3: a PRODUCT_FAIL cell's standalone RUNAWAY finding must stay in FINDINGS",
    );
    assert.equal(
      report.subsumed_findings.some((finding: any) => finding.case_id === "W4.dsh-do-now"),
      false,
      "AC3: a PRODUCT_FAIL cell must not be subsumed",
    );
    assert.ok(text.includes("- W4.dsh-do-now: RUNAWAY - RUNAWAY"));
  });

  it("GREEN-ARM: the precedence applies uniformly to every TEST_INFRA_FAIL cell, and non-infra outcomes are untouched (AC3)", () => {
    // W4.dsh-lifecycle (TEST_INFRA_FAIL probe-trigger-unreached + RUNAWAY) —
    // the campaign's second TIF-vs-RUNAWAY cell — reconciles identically.
    const lifecycle = caseState("W4.dsh-lifecycle", "TEST_INFRA_FAIL", {
      workflow: "dsh-lifecycle",
      findings: [{
        type: "RUNAWAY", cap: "wall_min", threshold: 55, observed: 55.06236666666667,
        enforcement_latency: 3.742, run_id: "run-f7aab46f-4925-4234-b710-994d8a4d49c8",
        detected_at: "2026-08-27T12:28:58.013Z",
      }],
      reason: { category: "probe-trigger-unreached", op: "pause_drain", trigger: "step:developer:running", waited_ms: 3299788 },
    });
    // W4.37 (INCONCLUSIVE runaway-cap-enforced + RUNAWAY) — a NON-infra
    // outcome — keeps its standalone RUNAWAY finding.
    const w437 = caseState("W4.37-keyline-spoof-repo-content", "INCONCLUSIVE", {
      workflow: "do-now",
      findings: [structuredClone(W437_RUNAWAY_FINDING)],
      reason: { category: "ambiguous-evidence", cap: { category: "runaway-cap-enforced", cap: "wall_min", terminal_status: "canceled" } },
    });
    const report = buildCampaignReport(stateWith([lifecycle, w437]));

    assert.equal(
      report.findings.some((finding: any) => finding.case_id === "W4.dsh-lifecycle" && finding.type === "RUNAWAY"),
      false,
      "uniform precedence: the TIF (probe-trigger-unreached) cell's RUNAWAY must be subsumed",
    );
    const sub = report.subsumed_findings.find((finding: any) => finding.case_id === "W4.dsh-lifecycle");
    assert.ok(sub);
    assert.deepEqual(sub.subsumed_by, { outcome: "TEST_INFRA_FAIL", category: "probe-trigger-unreached" });

    assert.ok(
      report.findings.some((finding: any) => finding.case_id === "W4.37-keyline-spoof-repo-content" && finding.type === "RUNAWAY"),
      "AC3: an INCONCLUSIVE (runaway-cap-enforced) cell's standalone RUNAWAY finding must stay in FINDINGS",
    );
    assert.equal(
      report.subsumed_findings.some((finding: any) => finding.case_id === "W4.37-keyline-spoof-repo-content"),
      false,
      "AC3: a non-infra cell must not be subsumed",
    );
  });

  it("GREEN-ARM: controller projection — state.json findings carry subsumed: true + subsumed_by for TEST_INFRA_FAIL", () => {
    // The controller's markTerminal reconciliation (subsumeRunawayFindings),
    // unit-armed: a TEST_INFRA_FAIL caseState with in-flight RUNAWAY findings
    // gets them marked subsumed with the subsuming classification.
    const tif = { findings: [
      structuredClone(BFMW_RUNAWAY_FINDING),
      { type: "O1", oracle: "O1" },
    ] };
    const marked = subsumeRunawayFindings(tif, "TEST_INFRA_FAIL", { category: "chaos-invocation-failed" });
    assert.equal(marked, 1);
    assert.equal(tif.findings[0].subsumed, true);
    assert.deepEqual(tif.findings[0].subsumed_by, { outcome: "TEST_INFRA_FAIL", category: "chaos-invocation-failed" });
    assert.equal(tif.findings[1].subsumed, undefined, "non-RUNAWAY findings are never touched");
    // Idempotent: a second pass changes nothing and keeps the first
    // subsumed_by (never overwrites with a later reason).
    assert.equal(subsumeRunawayFindings(tif, "TEST_INFRA_FAIL", { category: "later" }), 0);
    assert.equal(tif.findings[0].subsumed_by.category, "chaos-invocation-failed");
    assert.equal(tif.findings[0].subsumed, true);

    // Non-infra outcomes leave RUNAWAY findings untouched (AC3).
    const pf = { findings: [structuredClone(DO_NOW_RUNAWAY_FINDING)] };
    assert.equal(subsumeRunawayFindings(pf, "PRODUCT_FAIL", { category: "oracle-failed" }), 0);
    assert.equal(pf.findings[0].subsumed, undefined);

    // Predicate arms.
    assert.equal(isRunawayFinding({ type: "RUNAWAY" }), true);
    assert.equal(isRunawayFinding({ type: "O1" }), false);
    assert.equal(isRunawayFinding(null), false);
    assert.equal(runawayFindingSubsumed({ type: "RUNAWAY" }, "TEST_INFRA_FAIL"), true);
    assert.equal(runawayFindingSubsumed({ type: "RUNAWAY" }, "PRODUCT_FAIL"), false);
    assert.equal(runawayFindingSubsumed({ type: "O1" }, "TEST_INFRA_FAIL"), false);
  });

  it("GREEN-ARM: the verdict stays INFRA_FAILURE exit 2, the manifest stays schema-valid, and the report.json carries subsumed_findings", () => {
    // verdictExitCode on the disagreement shape: infra drives exit 2 — the
    // RUNAWAY finding never downgrades the infra verdict (precedence).
    const bfmw = bfmwCaseState();
    const verdict = verdictExitCode(stateWith([bfmw]));
    assert.deepEqual(verdict, { verdict: "INFRA_FAILURE", exitCode: 2 });

    // A PASS-only campaign keeps rendering deterministically with the new
    // SUBSUMED FINDINGS section (empty).
    const green = renderCampaignReport(buildCampaignReport(stateWith([
      caseState("PASS", "PASS", { workflow: "local" }),
    ])));
    assert.match(green, /FINDINGS\n\(none\)\n\nSUBSUMED FINDINGS\n\(none\)/);
    assert.match(green, /VERDICT\nGREEN \(exit 0\)\n$/);

    // report.json exposes subsumed_findings with the subsuming metadata.
    const report = buildCampaignReport(stateWith([bfmw]));
    assert.ok(Array.isArray(report.subsumed_findings));
    assert.equal(report.subsumed_findings.length, 1);
    assert.equal(report.subsumed_findings[0].subsumed_by.category, "chaos-invocation-failed");

    // The real manifest stays schema-valid (70 cases) — the S43c changes
    // touch no manifest surface.
    const res = runController(["--manifest", manifestPath, "--validate-only"]);
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /Validated 70 case\(s\)/);
  });
});
