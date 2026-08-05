import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildCampaignReport, renderCampaignReport, verdictExitCode, writeCampaignReports } from './tt-report.mjs';

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

function stateWith(cases, discoveredRuns = []) {
  return {
    version: 1,
    campaign_id: 'campaign-report-test',
    phase: 'ready',
    created_at: at(0),
    updated_at: at(9),
    manifest: { path: 'cases/test.jsonl', sha256: 'a'.repeat(64), case_count: cases.length, case_ids: cases.map((item) => item.id) },
    options: { concurrency: 2, stagger_ms: 100, token_poll_interval_ms: 300000 },
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
