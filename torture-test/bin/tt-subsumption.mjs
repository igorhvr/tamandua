// S43c (US-008) — classification precedence: TEST_INFRA_FAIL infrastructure
// classifications take precedence over RUNAWAY cap findings on the same case.
//
// Campaign-20260826T225744158Z (W4.dsh-bfmw): state.json classified the
// attempt TEST_INFRA_FAIL (category 'chaos-invocation-failed' — the tt-chaos
// operator timed out: `chaos operator 'tt-chaos' exited null: spawnSync
// .../tt-chaos ETIMEDOUT`) while report.txt's FINDINGS section rendered
// `- W4.dsh-bfmw: RUNAWAY - RUNAWAY` — the wall_min cap finding filed while
// the run was in flight (the run ran to the 45-minute wall cap because the
// chaos operator never completed) — so the two surfaces appeared to disagree
// on the cell's outcome.
//
// THE DOCUMENTED PRECEDENCE (S43c, cases/tier2-traceability.md):
//
//   TEST_INFRA_FAIL infrastructure classifications take precedence over
//   RUNAWAY cap findings on the same case. When the authoritative
//   classification of a case is TEST_INFRA_FAIL, a RUNAWAY finding filed for
//   that case is a DOWNSTREAM ARTIFACT of the infrastructure failure (the run
//   reached the wall/token cap because the infra failure prevented a clean
//   completion) and is SUBSUMED: it is never a standalone finding that reads
//   like the cell's verdict. The infra classification is the cell's ONE
//   authoritative verdict; the subsumed RUNAWAY evidence remains available in
//   the attempt records (stop_reason / straggler_capture) and in the report's
//   SUBSUMED FINDINGS section.
//
// Enforcement is in BOTH surfaces:
//   1. state.json classification — the controller's terminal choke-point
//      (markTerminal) marks any RUNAWAY finding on a TEST_INFRA_FAIL case
//      `subsumed: true` with `subsumed_by: { outcome, category }`, so the
//      persisted findings never contradict the authoritative classification.
//   2. report.txt / report.json — the report layer derives the same
//      subsumption from (outcome === 'TEST_INFRA_FAIL' && type === 'RUNAWAY')
//      even for legacy evidence written before this module existed, excludes
//      subsumed findings from the FINDINGS ledger, and renders them in the
//      SUBSUMED FINDINGS section with the subsuming classification named.
//
// This module is deliberately dependency-free so both the controller and the
// report layer can share the identical precedence predicate (mirrors the
// tt-chaos-arming.mjs / tt-arming.mjs pattern).

export const RUNAWAY_FINDING_TYPE = 'RUNAWAY';

// A RUNAWAY cap finding is any case-level finding filed by the controller's
// cap-breach monitor (cap: 'wall_min' or 'tokens', with the breach record)
// or a discovered-run stop.
export function isRunawayFinding(finding) {
  return finding !== null && finding !== undefined && finding.type === RUNAWAY_FINDING_TYPE;
}

// The S43c precedence predicate: a RUNAWAY finding is SUBSUMED exactly when
// the case's authoritative outcome is TEST_INFRA_FAIL. Explicitly flagged
// evidence (subsumed === true) is honored, but the derivation from the
// outcome is the source of truth so stored legacy evidence (written before
// the controller-side marking existed) reconciles identically.
export function runawayFindingSubsumed(finding, outcome) {
  return isRunawayFinding(finding) && outcome === 'TEST_INFRA_FAIL';
}

// Controller-side reconciliation (idempotent): mark every RUNAWAY finding on
// a case whose authoritative classification is TEST_INFRA_FAIL as subsumed,
// carrying the subsuming outcome + category for the report layer. Never
// removes evidence — the finding stays in caseState.findings with the
// subsumption metadata; the report layer decides rendering. Returns the
// number of findings marked (0 when nothing was subsumed).
export function subsumeRunawayFindings(caseState, outcome, reason) {
  if (outcome !== 'TEST_INFRA_FAIL') return 0;
  const findings = Array.isArray(caseState?.findings) ? caseState.findings : [];
  let marked = 0;
  for (const finding of findings) {
    if (!isRunawayFinding(finding)) continue;
    if (finding.subsumed === true) continue;
    finding.subsumed = true;
    finding.subsumed_by = {
      outcome: 'TEST_INFRA_FAIL',
      category: reason?.category ?? null,
    };
    marked += 1;
  }
  return marked;
}
