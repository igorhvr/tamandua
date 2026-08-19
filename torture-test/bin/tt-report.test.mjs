import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { bareVacuityCause, buildCampaignReport, renderCampaignReport, verdictExitCode, writeCampaignReports, zeroRealLaunchesCause } from './tt-report.mjs';

const at = (seconds) => `2026-08-01T00:00:${String(seconds).padStart(2, '0')}.000Z`;

function attempt(id, outcome, started = 1, ended = 3) {
  return {
    id,
    case_id: 'CASE',
    kind: 'local',
    phase: 'terminal',
    started_at: at(started),
    terminal_at: at(ended),
    outcome,
  };
}

function stateWith(cases, discoveredRuns = [], optionsOverrides = {}) {
  const options = { concurrency: 2, stagger_ms: 100, token_poll_interval_ms: 300000, ...optionsOverrides };
  return {
    version: 1,
    campaign_id: 'campaign-report-test',
    phase: 'ready',
    created_at: at(0),
    updated_at: at(9),
    manifest: { path: 'cases/test.jsonl', sha256: 'a'.repeat(64), case_count: cases.length, case_ids: cases.map((item) => item.id) },
    options,
    spend: { tokens_observed: 17, observations: [{ run_id: 'run-root', observed_tokens: 17, observed_at: at(4) }] },
    cases,
    discovered_runs: discoveredRuns,
  };
}

function caseState(id, outcome, overrides = {}) {
  return {
    id,
    wave: overrides.wave ?? 2,
    workflow: overrides.workflow ?? 'local',
    fixture: overrides.fixture ?? 'none',
    harness: overrides.harness ?? 'local',
    class: overrides.class ?? 'verification',
    phase: 'terminal',
    outcome,
    terminal_at: overrides.terminal_at ?? at(5),
    attempts: overrides.attempts ?? [attempt('attempt-1', outcome)],
    findings: overrides.findings ?? [],
    oracle_results: overrides.oracle_results ?? [],
    spend: overrides.spend ?? { tokens_observed: 0, observations: [] },
    ...(overrides.reason === undefined ? {} : { reason: overrides.reason }),
  };
}

test('buildCampaignReport includes every scenario, linked evidence, totals, spend, NOT_RUN reasons, and findings', () => {
  const runId = 'run-11111111-1111-4111-8111-111111111111';
  const product = caseState('B-product', 'PRODUCT_FAIL', {
    wave: 3,
    attempts: [{ ...attempt('attempt-1', 'PROVIDER_FAIL'), run_id: runId }, { ...attempt('attempt-2', 'PRODUCT_FAIL'), retry_of: 'attempt-1' }],
    findings: [{ type: 'O13_TRUTHFULNESS', oracle: 'O13', run_id: runId }],
    oracle_results: [{ oracle_id: 'O2', attempt_id: 'attempt-2', status: 'VALID', response: { result: 'FAIL', findings: [{ id: 'F-2', summary: 'ref did not move' }] } }],
    spend: { tokens_observed: 17, observations: [] },
    reason: { category: 'oracle-failed', oracles: ['O2'] },
  });
  const excluded = caseState('A-predicate', 'NOT_RUN', {
    wave: 0,
    class: 'characterization',
    attempts: [],
    reason: { category: 'predicate', evidence: [{ predicate: 'platform', expected: 'darwin', observed: 'linux' }] },
  });
  const discovered = {
    id: 'discovered-1', case_id: 'B-product', root_case_id: 'B-product', kind: 'discovered-workflow',
    run_id: 'run-22222222-2222-4222-8222-222222222222', parent_run_id: runId,
    phase: 'terminal', started_at: at(2), terminal_at: at(6), terminal_status: 'completed',
    tokens_observed: 5, token_observations: [],
  };

  const report = buildCampaignReport(stateWith([product, excluded], [discovered]));

  assert.deepEqual(report.outcome_totals, { PASS: 0, PRODUCT_FAIL: 1, AGENT_FLAKE: 0, PROVIDER_FAIL: 0, TEST_INFRA_FAIL: 0, INVALID: 0, INCONCLUSIVE: 0, NOT_RUN: 1 });
  assert.deepEqual(report.rows.map((row) => [row.id, row.wave, row.class, row.outcome]), [
    ['B-product', 3, 'verification', 'PRODUCT_FAIL'],
    ['A-predicate', 0, 'characterization', 'NOT_RUN'],
  ]);
  assert.equal(report.rows[0].attempts.length, 2);
  assert.equal(report.rows[0].discovered_runs[0].parent_run_id, runId);
  assert.equal(report.spend.tokens_observed, 17);
  assert.equal(report.spend.wall_ms, 9000);
  assert.equal(report.not_run[0].id, 'A-predicate');
  assert.equal(report.not_run[0].reason.category, 'predicate');
  assert.deepEqual(report.findings.map((finding) => finding.type), ['O13_TRUTHFULNESS', 'ORACLE_FAIL']);
  assert.equal(report.verdict, 'FINDINGS');
  assert.equal(report.exit_code, 1);
});

test('renderCampaignReport is deterministic and contains all required sections', () => {
  const state = stateWith([
    caseState('Z-pass', 'PASS', { wave: 9 }),
    caseState('A-skip', 'NOT_RUN', { wave: 1, attempts: [], reason: { category: 'predicate', evidence: [] } }),
  ]);
  const first = renderCampaignReport(buildCampaignReport(state));
  const second = renderCampaignReport(buildCampaignReport(structuredClone(state)));
  assert.equal(first, second);
  assert.match(first, /^TAMANDUA TORTURE-TEST CAMPAIGN REPORT\n/m);
  assert.match(first, /SCENARIO OUTCOMES\nCASE\s+WAVE\s+CLASS\s+OUTCOME/);
  assert.ok(first.indexOf('Z-pass') < first.indexOf('A-skip'), 'manifest row order must be preserved');
  assert.match(first, /SPEND LEDGER\nTokens observed: 17\nWall spend: 0m 9\.000s/);
  assert.match(first, /NOT_RUN\n- A-skip: predicate/);
  assert.match(first, /FINDINGS\n\(none\)/);
  assert.match(first, /VERDICT\nGREEN \(exit 0\)\n$/);
});

test('verdict exit codes distinguish green, findings, and infrastructure failure', () => {
  assert.deepEqual(verdictExitCode(stateWith([caseState('green', 'PASS')])), { verdict: 'GREEN', exitCode: 0 });
  assert.deepEqual(verdictExitCode(stateWith([caseState('predicate', 'NOT_RUN', { attempts: [], reason: { category: 'predicate', evidence: [] } })])), { verdict: 'GREEN', exitCode: 0 });
  assert.deepEqual(verdictExitCode(stateWith([caseState('pending-real', 'NOT_RUN', {
    attempts: [], reason: { category: 'pending-real' },
  })])), { verdict: 'GREEN', exitCode: 0 });
  assert.deepEqual(verdictExitCode(stateWith([caseState('red', 'PRODUCT_FAIL')])), { verdict: 'FINDINGS', exitCode: 1 });
  assert.deepEqual(verdictExitCode(stateWith([caseState('infra', 'TEST_INFRA_FAIL', { reason: { category: 'hook-failed' } })])), { verdict: 'INFRA_FAILURE', exitCode: 2 });
  assert.deepEqual(verdictExitCode(stateWith([caseState('oracle-infra', 'PRODUCT_FAIL', {
    oracle_results: [{ oracle_id: 'O2', status: 'TEST_INFRA' }],
  })])), { verdict: 'INFRA_FAILURE', exitCode: 2 });
});

test('MACP3 US-006: host-profile-missing is infrastructure failure, never a green skip', () => {
  // The controller records profile-unloadable cells as TEST_INFRA_FAIL with
  // category host-profile-missing and the underlying load error in message.
  assert.deepEqual(
    verdictExitCode(stateWith([caseState('req', 'TEST_INFRA_FAIL', {
      attempts: [],
      reason: { category: 'host-profile-missing', message: 'cannot load required host profile ...: ENOENT', evidence: [] },
    })])),
    { verdict: 'INFRA_FAILURE', exitCode: 2 },
    'TEST_INFRA_FAIL(host-profile-missing) must fail closed to RED/INFRA exit 2',
  );
  // Defense-in-depth: even if a legacy/other path persisted the block as
  // NOT_RUN, the host-profile-missing category must NOT be treated as a
  // normal green NOT_RUN (predicate/pending-real are the only green skips).
  assert.deepEqual(
    verdictExitCode(stateWith([caseState('req-legacy', 'NOT_RUN', {
      attempts: [],
      reason: { category: 'host-profile-missing', message: 'cannot load required host profile ...', evidence: [] },
    })])),
    { verdict: 'INFRA_FAILURE', exitCode: 2 },
    'legacy NOT_RUN(host-profile-missing) must still fail closed to exit 2',
  );
});

test('MACP3 US-007/US-008: legacy NOT_RUN(predicate) zero-attempt encoding is RED (vacuous); fail-closed encoding is INFRA exit 2', () => {
  // What the controller persisted BEFORE US-006: an unloadable host profile
  // degraded every `requires` predicate to false, so the profile-bound cell
  // was persisted NOT_RUN(predicate) with ZERO attempts. With no other cells
  // that encoding yielded a vacuous GREEN exit 0 — the exact a446deac defect.
  // Under US-006 the fail-closed path converts the same cell to
  // TEST_INFRA_FAIL(host-profile-missing), and under US-008 the bare vacuity
  // guard now catches even a legacy/other path that persists zero-attempt
  // NOT_RUN(predicate): it is FINDINGS (exit 1) with a vacuous-campaign
  // finding, NEVER a bare GREEN. A test demanding GREEN against this encoding
  // must fail — the red leg is now caught by the vacuity guard instead of
  // sliding through as a vacuous GREEN.
  const preFix = caseState('req', 'NOT_RUN', {
    attempts: [],
    reason: { category: 'predicate', evidence: [{ predicate: 'toolchains.node', expected: true, observed: false }] },
  });
  const preFixCause = bareVacuityCause(stateWith([preFix], [], { execution_selection: 'scripted-only' }));
  assert.ok(
    preFixCause !== null && /executed zero scripted cells/.test(preFixCause),
    `the zero-attempt NOT_RUN(predicate) cell must trip the bare vacuity guard, got: ${preFixCause}`,
  );
  assert.deepEqual(
    verdictExitCode(stateWith([preFix], [], { execution_selection: 'scripted-only' })),
    { verdict: 'FINDINGS', exitCode: 1 },
    'pre-fix encoding (NOT_RUN predicate, zero attempts) must NOT be a bare GREEN — US-008 vacuity guard forces FINDINGS exit 1',
  );
  const preFixReport = buildCampaignReport(stateWith([preFix], [], { execution_selection: 'scripted-only' }));
  assert.equal(preFixReport.vacuity.triggered, true, 'vacuity guard must be the operative fail-closed signal');
  assert.match(preFixReport.vacuity.cause, /executed zero scripted cells/);
  assert.ok(
    preFixReport.findings.some((finding) => finding.category === 'vacuous-campaign'),
    'the campaign findings must list a machine-parseable vacuous-campaign finding',
  );
  assert.match(renderCampaignReport(preFixReport), /VACUOUS_CAMPAIGN - bare \(scripted-only\) campaign executed zero scripted cells/);
  assert.match(renderCampaignReport(preFixReport), /VERDICT\nFINDINGS \(exit 1\)\n$/);
  // The fail-closed encoding for the same cell (unloadable profile) is
  // terminal TEST_INFRA_FAIL(host-profile-missing) — never a green skip, and
  // never downgraded to a vacuity FINDINGS: INFRA (exit 2) takes precedence.
  const failClosed = caseState('req', 'TEST_INFRA_FAIL', {
    attempts: [],
    reason: { category: 'host-profile-missing', message: 'cannot load required host profile .../host-profile.json: ENOENT', evidence: [] },
  });
  assert.deepEqual(
    verdictExitCode(stateWith([failClosed], [], { execution_selection: 'scripted-only' })),
    { verdict: 'INFRA_FAILURE', exitCode: 2 },
    'fail-closed encoding must fail the same campaign to INFRA exit 2',
  );
  // The finding must be surfaced in the report, not just the exit code.
  const report = buildCampaignReport(stateWith([failClosed], [], { execution_selection: 'scripted-only' }));
  assert.equal(report.infra_failures.length, 1, 'the TEST_INFRA_FAIL cell must be listed in infra_failures');
  assert.equal(report.infra_failures[0].reason.category, 'host-profile-missing');
  assert.equal(report.vacuity.triggered, false, 'infra precedence: an infra-driven campaign must not be flagged vacuous');
  assert.equal(report.findings.some((finding) => finding.category === 'vacuous-campaign'), false,
    'infra precedence: no vacuous-campaign finding when INFRA explains the RED');
  assert.equal(report.verdict, 'INFRA_FAILURE');
  assert.equal(report.exit_code, 2);
  assert.match(renderCampaignReport(report), /INFRA FAILURES\n- req: host-profile-missing/);
  assert.match(renderCampaignReport(report), /VERDICT\nINFRA_FAILURE \(exit 2\)\n$/);
});

test('MACP3 US-007: legitimate predicate skip combined with a green PASS stays GREEN exit 0', () => {
  // US-007 Scenario B at unit level: under a VALID loaded host profile a
  // genuinely unsatisfied predicate is a legitimate skip (NOT_RUN, category
  // predicate). Combined with an otherwise green selection the verdict must
  // stay GREEN exit 0 — never INFRA, never a host-profile-missing finding.
  // Asserting GREEN here is what keeps the fail-closed fix from over-blocking.
  const skip = caseState('skip', 'NOT_RUN', {
    attempts: [],
    reason: { category: 'predicate', evidence: [{ predicate: 'platform', expected: 'darwin', observed: 'linux' }] },
  });
  const run = caseState('run', 'PASS');
  assert.deepEqual(
    verdictExitCode(stateWith([run, skip], [], { execution_selection: 'scripted-only' })),
    { verdict: 'GREEN', exitCode: 0 },
    'legit predicate skip + executed PASS must stay GREEN exit 0',
  );
  const report = buildCampaignReport(stateWith([run, skip], [], { execution_selection: 'scripted-only' }));
  assert.equal(report.exit_code, 0);
  assert.equal(report.verdict, 'GREEN');
  assert.equal(report.infra_failures.length, 0, 'legit predicate skip + PASS must surface no infra finding');
  // MACP3 US-008: a legitimate predicate skip is green ONLY when combined
  // with an executed cell; this state has an execution, so the vacuity guard
  // must be silent and the report must carry no vacuous-campaign finding.
  assert.equal(report.vacuity.triggered, false);
  assert.equal(report.findings.some((finding) => finding.category === 'vacuous-campaign'), false);
});

test('MACP3 US-008 AC1: bare campaign with all scripted cells predicate-skipped and zero executions is RED (exit 1) with vacuous-campaign finding', () => {
  // Reproduces the a446deac vacuous-GREEN class through the predicate path:
  // every scripted cell legitimate-skipped under a VALID loaded profile
  // (honest requires mismatch), zero cells executed. The campaign produced
  // ZERO evidence, so the bare verdict must be FINDINGS (exit 1) with a
  // machine-parseable vacuous-campaign finding — never GREEN. Note these are
  // LEGIT evaluated skips (US-007 Scenario B weighting): with zero executions
  // even a legitimately evaluated all-skip is vacuous.
  const skipA = caseState('skip-a', 'NOT_RUN', {
    harness: 'local', attempts: [],
    reason: { category: 'predicate', evidence: [{ predicate: 'platform', expected: 'darwin', observed: 'linux' }] },
  });
  const skipB = caseState('skip-b', 'NOT_RUN', {
    harness: 'local', attempts: [],
    reason: { category: 'predicate', evidence: [{ predicate: 'toolchains.python3', expected: true, observed: { present: false } }] },
  });
  const state = stateWith([skipA, skipB], [], { execution_selection: 'scripted-only' });

  const cause = bareVacuityCause(state);
  assert.ok(cause !== null, 'all-skipped bare campaign must trip the vacuity guard');
  assert.match(cause, /executed zero scripted cells \(2 scripted cases in manifest,/)
  assert.deepEqual(verdictExitCode(state), { verdict: 'FINDINGS', exitCode: 1 });

  const report = buildCampaignReport(state);
  assert.equal(report.exit_code, 1);
  assert.equal(report.verdict, 'FINDINGS');
  assert.equal(report.infra_failures.length, 0);
  assert.equal(report.vacuity.triggered, true);
  assert.match(report.vacuity.cause, /executed zero scripted cells/);
  const vic = report.findings.find((finding) => finding.category === 'vacuous-campaign');
  assert.ok(vic, 'report.json findings must contain the vacuous-campaign finding');
  assert.equal(vic.type, 'VACUOUS_CAMPAIGN');
  assert.equal(vic.case_id, null, 'the finding is campaign-level (no owning case)');
  assert.equal(typeof vic.summary, 'string');
  assert.match(vic.summary, /executed zero scripted cells/);
  assert.match(renderCampaignReport(report), /FINDINGS\n- VACUOUS_CAMPAIGN - bare \(scripted-only\) campaign executed zero scripted cells/);
  assert.match(renderCampaignReport(report), /VERDICT\nFINDINGS \(exit 1\)\n$/);
  assert.ok(!renderCampaignReport(report).includes('GREEN (exit 0)'), 'all-skipped bare campaign must not render GREEN');
});

test('MACP3 US-008 AC2: bare campaign with at least one executed scripted cell stays GREEN exit 0', () => {
  // One cell actually EXECUTES (attempts recorded -> PASS), the rest are legit
  // predicate skips under a valid profile. The verdict stays GREEN exit 0 and
  // the vacuity guard is silent — this is the "combined with an otherwise
  // green selection, verdict stays GREEN" bound that keeps the guard from
  // over-blocking honestly-scoped failures.
  const executed = caseState('ran', 'PASS', { harness: 'local' });
  const skip = caseState('skip', 'NOT_RUN', {
    harness: 'local', attempts: [],
    reason: { category: 'predicate', evidence: [{ predicate: 'platform', expected: 'darwin', observed: 'linux' }] },
  });
  const state = stateWith([executed, skip], [], { execution_selection: 'scripted-only' });
  assert.equal(bareVacuityCause(state), null, '>=1 executed scripted cell clears the vacuity guard');
  assert.deepEqual(verdictExitCode(state), { verdict: 'GREEN', exitCode: 0 });
  const report = buildCampaignReport(state);
  assert.equal(report.verdict, 'GREEN');
  assert.equal(report.exit_code, 0);
  assert.equal(report.vacuity.triggered, false);
  assert.equal(report.findings.some((finding) => finding.category === 'vacuous-campaign'), false);
});

test('MACP3 US-008: executed non-PASS outcome still clears the vacuity guard (outcome accounted, not vacuous)', () => {
  // The vacuity guard cares that something EXECUTED, not that it passed. An
  // executed FAIL is a real FINDINGS exit 1 (from the product failure), but it
  // is NOT the vacuous-campaign finding and NOT a vacuous GREEN. This pins
  // the definition boundary: 'executed' = attempts.length > 0 on a scripted
  // cell, exactly mirroring zeroRealLaunchesCause.
  const failed = caseState('ran-fail', 'PRODUCT_FAIL', { harness: 'local' });
  const state = stateWith([failed], [], { execution_selection: 'scripted-only' });
  assert.equal(bareVacuityCause(state), null, 'an executed cell clears the vacuity guard regardless of outcome');
  assert.deepEqual(verdictExitCode(state), { verdict: 'FINDINGS', exitCode: 1 });
  const report = buildCampaignReport(state);
  assert.equal(report.vacuity.triggered, false);
  assert.equal(report.findings.some((finding) => finding.category === 'vacuous-campaign'), false,
    'a genuinely executed failure must not be mislabeled vacuous');
  assert.equal(report.verdict, 'FINDINGS');
  assert.equal(report.exit_code, 1);
});

test('MACP3 US-008 AC3: real-mode zeroRealLaunchesCause behavior is unchanged and vacuity is bare-only', () => {
  // Real mode (execution_selection 'all') is untouched by the vacuity guard:
  // zeroRealLaunchesCause remains the sole combinator there (INFRA exit 2),
  // and bareVacuityCause must stay null for any real-mode state — including
  // the all-predicate-skipped real case that trips zeroRealLaunchesCause.
  const real = caseState('W1.L1-python', 'NOT_RUN', {
    harness: 'pi', attempts: [],
    reason: { category: 'predicate', evidence: [{ predicate: 'toolchains.python3', expected: true, observed: { present: false } }] },
  });
  const realState = stateWith([real], [], { execution_selection: 'all' });
  assert.equal(bareVacuityCause(realState), null, 'vacuity guard must be inert in real mode');
  assert.ok(zeroRealLaunchesCause(realState) !== null, 'zeroRealLaunchesCause still fires in real mode');
  assert.deepEqual(verdictExitCode(realState), { verdict: 'INFRA_FAILURE', exitCode: 2 });
  const realReport = buildCampaignReport(realState);
  assert.equal(realReport.fail_closed.triggered, true);
  assert.equal(realReport.vacuity.triggered, false);
  assert.equal(realReport.findings.some((finding) => finding.category === 'vacuous-campaign'), false);

  // Bare mode with NO scripted cases at all (all pending-real) is a correct
  // bare GREEN — nothing was eligible to execute, so it is not vacuous.
  const pendingReal = caseState('W1.L1-python', 'NOT_RUN', {
    harness: 'pi', attempts: [], reason: { category: 'pending-real' },
  });
  const bare = stateWith([pendingReal], [], { execution_selection: 'scripted-only' });
  assert.equal(bareVacuityCause(bare), null, 'no scripted cases => no vacuity (pending-real is correct for bare)');
  assert.deepEqual(verdictExitCode(bare), { verdict: 'GREEN', exitCode: 0 });
  const bareReport = buildCampaignReport(bare);
  assert.equal(bareReport.vacuity.triggered, false);
  assert.equal(bareReport.exit_code, 0);
});

test('MACP3 US-008: infra precedence — an infra failure masks the vacuity finding (never mislabeled)', () => {
  // A bare campaign where one cell INFRA-failed (hook-failed, zero attempts)
  // and the rest were predicate-skipped: INFRA FAILURES explains the RED
  // precisely; the vacuity guard must not add a contradictory
  // vacuous-campaign finding or downgrade the verdict to a vacuity FINDINGS.
  const infra = caseState('infra', 'TEST_INFRA_FAIL', {
    harness: 'local', attempts: [], reason: { category: 'hook-failed', message: 'hook timed out' },
  });
  const skip = caseState('skip', 'NOT_RUN', {
    harness: 'local', attempts: [],
    reason: { category: 'predicate', evidence: [{ predicate: 'platform', expected: 'darwin', observed: 'linux' }] },
  });
  const state = stateWith([infra, skip], [], { execution_selection: 'scripted-only' });
  assert.ok(bareVacuityCause(state) !== null, 'structurally zero scripted executions still trip the guard');
  assert.deepEqual(verdictExitCode(state), { verdict: 'INFRA_FAILURE', exitCode: 2 },
    'INFRA must take precedence over the vacuity FINDINGS');
  const report = buildCampaignReport(state);
  assert.equal(report.verdict, 'INFRA_FAILURE');
  assert.equal(report.exit_code, 2);
  assert.equal(report.vacuity.triggered, false, 'vacuity must not be the operative signal when infra drives the verdict');
  assert.equal(report.findings.some((finding) => finding.category === 'vacuous-campaign'), false,
    'infra-driven campaign must not carry a vacuous-campaign finding');
  assert.equal(report.infra_failures.length, 1);
  assert.match(renderCampaignReport(report), /INFRA FAILURES\n- infra: hook-failed/);
});

test('buildCampaignReport surfaces infra failures with human-readable reasons', () => {
  const report = buildCampaignReport(stateWith([
    caseState('req', 'TEST_INFRA_FAIL', {
      attempts: [],
      reason: { category: 'host-profile-missing', message: 'cannot load required host profile .../host-profile.json: ENOENT', evidence: [] },
    }),
    caseState('ok', 'PASS'),
  ]));
  assert.equal(report.infra_failures.length, 1, 'the TEST_INFRA_FAIL cell must be listed in infra_failures');
  assert.equal(report.infra_failures[0].id, 'req');
  assert.equal(report.infra_failures[0].reason.category, 'host-profile-missing');
  assert.match(report.infra_failures[0].reason.message, /ENOENT/);
  const text = renderCampaignReport(report);
  assert.match(text, /INFRA FAILURES\n- req: host-profile-missing \(cannot load required host profile \.\.\.\/host-profile\.json: ENOENT\)/);
  assert.match(text, /VERDICT\nINFRA_FAILURE \(exit 2\)/);
});

test('pending real cases are reported distinctly from other NOT_RUN cases', () => {
  const report = buildCampaignReport(stateWith([
    caseState('pending-real', 'NOT_RUN', {
      attempts: [], reason: { category: 'pending-real' },
    }),
    caseState('predicate', 'NOT_RUN', {
      attempts: [], reason: { category: 'predicate', evidence: [] },
    }),
    caseState('executed', 'PASS'),
  ]));

  assert.deepEqual(report.pending_real.map((item) => item.id), ['pending-real']);
  assert.deepEqual(report.not_run.map((item) => item.id), ['predicate']);
  assert.equal(report.verdict, 'GREEN');
  assert.equal(report.exit_code, 0);
  const text = renderCampaignReport(report);
  assert.match(text, /PENDING_REAL\n- pending-real: pending-real/);
  assert.match(text, /NOT_RUN\n- predicate: predicate/);
});

test('fail-closed: include-real with zero real launches returns INFRA_FAILURE exit 2 naming the cause', () => {
  const real = caseState('W1.L1-python', 'NOT_RUN', {
    harness: 'pi',
    attempts: [],
    reason: { category: 'predicate', evidence: [{ predicate: 'toolchains.python3', expected: true, observed: { present: false } }] },
  });
  const state = stateWith([real], [], { execution_selection: 'all' });

  const cause = zeroRealLaunchesCause(state);
  assert.ok(cause !== null, 'fail-closed cause must be present');
  assert.match(cause, /zero real cases launched/);
  assert.deepEqual(verdictExitCode(state), { verdict: 'INFRA_FAILURE', exitCode: 2 });

  const report = buildCampaignReport(state);
  assert.equal(report.exit_code, 2);
  assert.equal(report.verdict, 'INFRA_FAILURE');
  assert.equal(report.fail_closed.triggered, true);
  assert.match(report.fail_closed.cause, /zero real cases launched/);
  const text = renderCampaignReport(report);
  assert.match(text, /VERDICT\nINFRA_FAILURE \(exit 2\)\nCause: include-real requested but zero real cases launched/);
  assert.ok(!text.includes('GREEN (exit 0)'), 'zero real launches must not render a vacuous GREEN');
});

test('fail-closed: real-mode campaign with >=1 real launch stays GREEN', () => {
  const launched = caseState('W1.L1-python', 'PASS', { harness: 'pi' });
  const state = stateWith([launched], [], { execution_selection: 'all' });
  assert.equal(zeroRealLaunchesCause(state), null);
  assert.deepEqual(verdictExitCode(state), { verdict: 'GREEN', exitCode: 0 });
});

test('fail-closed: real-mode with no real cases in manifest stays GREEN', () => {
  const local = caseState('local-only', 'PASS', { harness: 'local' });
  const state = stateWith([local], [], { execution_selection: 'all' });
  assert.equal(zeroRealLaunchesCause(state), null);
  assert.deepEqual(verdictExitCode(state), { verdict: 'GREEN', exitCode: 0 });
});

test('fail-closed: bare scripted-only with pending-real cases stays GREEN exit 0', () => {
  const pendingReal = caseState('W1.L1-python', 'NOT_RUN', {
    harness: 'pi',
    attempts: [],
    reason: { category: 'pending-real' },
  });
  const state = stateWith([pendingReal], [], { execution_selection: 'scripted-only' });
  assert.equal(zeroRealLaunchesCause(state), null);
  assert.deepEqual(verdictExitCode(state), { verdict: 'GREEN', exitCode: 0 });
  const report = buildCampaignReport(state);
  assert.equal(report.exit_code, 0);
  assert.equal(report.fail_closed.triggered, false);
  assert.match(renderCampaignReport(report), /VERDICT\nGREEN \(exit 0\)\n$/);
});

test('fail-closed: a real launch that fails on infra still reports INFRA_FAILURE (not reclassified GREEN)', () => {
  // A real case that attempted a launch and hit infra already fails closed via
  // hasInfrastructureFailure; the zero-real-launch guard must not mask it.
  const infra = caseState('W1.L1-python', 'TEST_INFRA_FAIL', {
    harness: 'pi',
    reason: { category: 'hook-failed' },
  });
  const state = stateWith([infra], [], { execution_selection: 'all' });
  assert.equal(zeroRealLaunchesCause(state), null);
  assert.deepEqual(verdictExitCode(state), { verdict: 'INFRA_FAILURE', exitCode: 2 });
});

test('writeCampaignReports uses only persisted state and atomically replaces deterministic reports', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-report-test-'));
  try {
    const state = stateWith([caseState('green', 'PASS')]);
    const first = writeCampaignReports(directory, state);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8')).campaign.id, state.campaign_id);
    assert.equal(fs.readFileSync(path.join(directory, 'report.txt'), 'utf8'), renderCampaignReport(first));
    const firstText = fs.readFileSync(path.join(directory, 'report.txt'), 'utf8');
    const second = writeCampaignReports(directory, structuredClone(state));
    assert.equal(fs.readFileSync(path.join(directory, 'report.txt'), 'utf8'), firstText);
    assert.deepEqual(second, first);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['report.json', 'report.txt']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
