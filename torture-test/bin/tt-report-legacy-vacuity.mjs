// tt-report-legacy-vacuity.mjs — Preserved PRE-US-008 campaign verdict logic.
//
// MACP3 US-009: red-then-green proof for the bare vacuity guard (US-008).
//
// This module is the permanent, byte-faithful record of what
// bin/tt-report.mjs's verdict graph computed BEFORE the US-008 vacuity guard
// landed. It is extracted VERBATIM (whitespace included) from commit
// dafa40a7 of torture-test/bin/tt-report.mjs — the last commit before US-008
// (ba3fc754 added bareVacuityCause to verdictExitCode/buildCampaignReport) —
// so a red leg can feed a real campaign's state.json through it and PROVE
// that the exact all-skipped configuration that today exits FINDINGS
// (exit 1) with a machine-parseable vacuous-campaign finding was a vacuously
// GREEN (exit 0) before US-008. That is the a446deac defect class this task
// fixes; without this frozen arm the pre-change behavior would only be
// assertable by rewriting old git history.
//
// Faithfulness is pinned by self-tests/tier1-bare-vacuity-red-green.test.ts:
// it diffs this file's legacyVerdictExitCode / zeroRealLaunchesCause /
// hasInfrastructureFailure bodies against `git show
// dafa40a7:torture-test/bin/tt-report.mjs` (whitespace-normalized) and
// asserts they are byte-equal, and that the historical file contains no
// bareVacuityCause. Local git only — hermetic, zero tokens, no network.
//
// Do NOT edit the verdict math here to track future changes in tt-report.mjs:
// this is a frozen historical snapshot by design. This mirrors
// oracles/lib/evidence-procfd-legacy.mjs, which preserves the pre-US-001
// /proc-dependent evidence writer for the same reason (model the regression
// from the actual pre-fix code, not from memory).

const REAL_HARNESSES = new Set(['pi', 'hermes', 'dsh']);

function hasInfrastructureFailure(state) {
  return state.cases.some((item) => item.outcome === 'TEST_INFRA_FAIL'
    // MACP3 US-006: host-profile-missing is infrastructure failure REGARDLESS
    // of how it was persisted — applyHostRequirements records it as
    // TEST_INFRA_FAIL, but a legacy/other-NOT_RUN encoding must not be
    // treated as a normal green skip either. Never a vacuous NOT_RUN.
    || item.reason?.category === 'host-profile-missing'
    || (item.outcome === 'NOT_RUN' && !['predicate', 'pending-real', 'host-profile-missing'].includes(item.reason?.category))
    || (item.oracle_results ?? []).some((result) =>
      result.status === 'TEST_INFRA'
        || (result.status === 'VALID' && result.response?.result === 'ERROR')));
}

function isRealHarness(harness) {
  return REAL_HARNESSES.has(harness);
}

function isRealMode(state) {
  // Real-mode intent is signalled by execution_selection 'all' (the controller
  // maps --include-real / no --scripted-only to 'all'; bare scripted-only runs
  // persist execution_selection 'scripted-only'). Bare mode therefore never
  // trips this check, preserving the pending-real GREEN semantics.
  return (state?.options?.execution_selection ?? 'all') === 'all';
}

// When an include-real campaign was requested, >0 real (pi/hermes/dsh) cases
// exist in the manifest, and yet zero real cases actually launched (every real
// case is terminal without any execution round — predicate-blocked or
// otherwise skipped), return a human-readable cause string. Otherwise return
// null. This is the fail-closed guard against a vacuous GREEN for a real
// campaign that ran nothing.
function zeroRealLaunchesCause(state) {
  if (!isRealMode(state)) return null;
  const realCases = (state?.cases ?? []).filter((item) => isRealHarness(item.harness));
  if (realCases.length === 0) return null;
  const realLaunched = realCases.filter((item) => (item.attempts ?? []).length > 0).length;
  if (realLaunched > 0) return null;
  return `include-real requested but zero real cases launched (${realCases.length} real pi/hermes/dsh cases in manifest, execution_selection=all, but no real launch recorded)`;
}

// legacyVerdictExitCode — the pre-US-008 verdictExitCode. Identical body to
// `export function verdictExitCode(state)` at dafa40a7; ONLY the export name
// differs so both this frozen arm and the live tt-report.mjs function can
// coexist. Notably it contains NO bareVacuityCause: an all-scripted-skipped
// bare campaign (all cells NOT_RUN(predicate), zero attempts) falls through to
// the hasFinding check, every outcome is NOT_RUN, and the verdict is GREEN
// (exit 0) — the vacuous GREEN this task eliminates.
export function legacyVerdictExitCode(state) {
  const failClosedCause = zeroRealLaunchesCause(state);
  if (failClosedCause !== null) return { verdict: 'INFRA_FAILURE', exitCode: 2 };
  if (hasInfrastructureFailure(state)) return { verdict: 'INFRA_FAILURE', exitCode: 2 };
  // FIX10 US-005: a hygiene-canary diff (operator-identity file changed
  // during the campaign) is a campaign-level FINDING — never silent.
  const hygieneDiffs = state?.hygiene_canary?.diffs;
  if (Array.isArray(hygieneDiffs) && hygieneDiffs.length > 0) {
    return { verdict: 'FINDINGS', exitCode: 1 };
  }
  const hasFinding = state.cases.some((item) =>
    !['PASS', 'NOT_RUN'].includes(item.outcome) || (item.findings ?? []).length > 0);
  return hasFinding
    ? { verdict: 'FINDINGS', exitCode: 1 }
    : { verdict: 'GREEN', exitCode: 0 };
}
