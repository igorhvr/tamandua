#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { isStrictMissing, lifecycleRunning, mergeGateSubset, expectedMergeGateNames, reconcileReroutes, finalizeStepModel, refusalDiagnosis } from '../lib/o10.mjs';
import { legalRerouteTransition, rerouteCorridorByStep } from '../lib/reroute-discipline.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const ORACLE = path.resolve(HERE, '..', 'O10');
const GENERATOR = path.join(HERE, 'generate-o10-fixtures.mjs');

function invokeFixture(workspace, name) {
  const expectation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'expectation.json'), 'utf8'));
  const context = JSON.parse(fs.readFileSync(expectation.context, 'utf8'));
  const result = spawnSync(ORACLE, ['--contract-version', '1', '--context', expectation.context], {
    cwd: path.dirname(expectation.context),
    env: {
      ...process.env,
      TT_ORACLE_CONTRACT_VERSION: '1', TT_ORACLE_ID: 'O10', TT_ORACLE_CONTEXT: expectation.context,
      TT_ORACLE_EVIDENCE_DIR: path.dirname(expectation.context), TT_CASE_ID: context.case.id,
      TT_CAMPAIGN_ID: context.campaign.id, TT_RUN_ID: context.run_id,
    },
    encoding: 'utf8', shell: false, timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { expectation, response: JSON.parse(result.stdout.trim()), status: result.status };
}

test('isStrictMissing accepts only exact unpadded 1/true/on values and off dominates', () => {
  for (const value of ['1', 'true', 'TRUE', 'True', 'on', 'ON']) {
    assert.equal(isStrictMissing('default', value), true, value);
  }
  for (const value of [null, '', '0', 'false', 'off', 'yes', ' true', 'true ', ' on ', 1, true]) {
    assert.equal(isStrictMissing('default', value), false, String(value));
  }
  assert.equal(isStrictMissing('green', ' false '), true);
  assert.equal(isStrictMissing('off', 'true'), false);
});

test('O10 enforces FMIS cells, launch inheritance, scoped already-landed acceptance, and exact-key laundering', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(generated.status, 0, generated.stderr);
    const names = fs.readdirSync(workspace).filter((name) => name.startsWith('o10-')).sort();
    // 29 scripted FMIS probe cells + 5 S27 real-cell fixtures (US-001)
    // + 2 S27 real-cell reroute-reconciliation fixtures (US-002)
    // + 2 S47 attempt-aware finalize fixtures (US-005)
    // + 4 S59 refusal-diagnosis fixtures (US-017).
    assert.equal(names.length, 42);
    assert.equal(names.filter((name) => name.includes('-mutation')).length, 10);
    for (const name of names) {
      const { expectation, response, status } = invokeFixture(workspace, name);
      assert.equal(response.result, expectation.expected, `${name}: ${JSON.stringify(response)}`);
      assert.equal(status, { PASS: 0, FAIL: 1, ERROR: 2, NOT_EVALUABLE: 3 }[expectation.expected], name);
      if (expectation.finding) {
        assert.ok(response.findings.some((finding) => finding.id === expectation.finding), `${name} omitted ${expectation.finding}`);
      }
      if (expectation.expected === 'ERROR') {
        // S26 in-scope mismatch red-arm: fail-closed with the existing message.
        assert.equal(response.evidence.length, 0, `${name} ERROR evidence`);
        assert.equal(response.findings.length, 1, `${name} ERROR findings`);
        assert.equal(response.findings[0].id, 'ORACLE_RUNTIME_ERROR', name);
        assert.match(response.findings[0].summary, /suite_ledger does not reconcile byte-for-field with the read-only database snapshot/, name);
        continue;
      }
      assert.equal(response.evidence.length, 1, `${name} evidence`);
      const observation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'evidence', response.evidence[0].path), 'utf8'));
      assert.equal(observation.schema_version, 1);
      if (expectation.expected === 'NOT_EVALUABLE') {
        assert.equal(response.findings.length, 0, `${name} NOT_EVALUABLE findings`);
        assert.equal(observation.not_evaluable, true);
        assert.equal(typeof observation.reason, 'string');
        assert.ok(observation.reason.length > 0);
        assert.equal(observation.run_count, 0);
        continue;
      }
      assert.equal(observation.run_count, 1);
      assert.equal(observation.runs[0].expected.evidence, expectation.evidence);
      assert.equal(observation.runs[0].expected.mode, expectation.mode);
      if (name === 'o10-scoped-foreign-db-rows') {
        // S26 foreign-origin red-arm: DB rows outside the case's suite-origin
        // scope (stale cross-campaign/intra-campaign) are ignored — PASS with
        // zero findings, never a reconciliation ERROR.
        assert.equal(response.findings.length, 0, `${name} foreign rows must not produce findings`);
      }
      if (name.startsWith('o10-real-')) {
        // S27 real-cell fixtures run through the real-cell regime: the
        // observation records the regime, the merge-gate subset, the
        // lifecycle derivation, and (US-002) the reroute reconciliation.
        assert.equal(observation.runs[0].regime, 'real', `${name} regime`);
        assert.ok(observation.runs[0].merge_gate_subset, `${name} merge-gate subset`);
        assert.ok(Array.isArray(observation.runs[0].merge_gate_subset.expected), `${name} subset expected`);
        assert.ok(Array.isArray(observation.runs[0].merge_gate_subset.observed), `${name} subset observed`);
        assert.ok(Array.isArray(observation.runs[0].lifecycle.anomalies), `${name} lifecycle anomalies`);
        assert.ok(Array.isArray(observation.runs[0].lifecycle.per_step), `${name} lifecycle per_step`);
        assert.ok(observation.runs[0].reroute_reconciliation, `${name} reroute reconciliation`);
        assert.equal(typeof observation.runs[0].reroute_reconciliation.decision_table_reroutes, 'number', `${name} decision-table reroutes`);
        assert.ok(Array.isArray(observation.runs[0].reroute_reconciliation.per_step), `${name} reconciliation per_step`);
        assert.ok(['corroborated', 'fallback'].includes(observation.runs[0].reroute_reconciliation.corridor_evidence), `${name} corridor evidence`);
      } else {
        assert.equal(observation.runs[0].regime, 'scripted', `${name} regime`);
        assert.ok(observation.runs[0].event_set, `${name} exact event set`);
      }
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- S27 US-003: real-cell red-arm fixture pins ----
// The five US-003 fixtures pin the recalibrated two-regime model: the legal
// multi-step and loop streams evaluate PASS (exit 0) while the double-landed,
// missing-terminal, and unknown-step-running streams evaluate FAIL (exit 1)
// with O10_EVENT_SET_MISMATCH present in the findings.

const US003_NAMED = [
  ['o10-real-multistep-legal-reroute', 'PASS', 0, null],
  ['o10-real-loop-multistep', 'PASS', 0, null],
  ['o10-real-double-landed', 'FAIL', 1, 'O10_EVENT_SET_MISMATCH'],
  ['o10-real-missing-terminal', 'FAIL', 1, 'O10_EVENT_SET_MISMATCH'],
  ['o10-real-unknown-step-running', 'FAIL', 1, 'O10_EVENT_SET_MISMATCH'],
];

test('US-003 real-cell fixtures pin the two-regime model with exact exit codes and findings', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(generated.status, 0, generated.stderr);
    for (const [name, expected, exitCode, finding] of US003_NAMED) {
      const { expectation, response, status } = invokeFixture(workspace, name);
      assert.equal(expectation.expected, expected, `${name} expectation`);
      assert.equal(response.result, expected, `${name}: ${JSON.stringify(response)}`);
      assert.equal(status, exitCode, `${name} exit code`);
      if (finding) {
        assert.ok(response.findings.some((entry) => entry.id === finding), `${name} omitted ${finding}`);
      }
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- S47 (US-005): attempt-aware finalize-step model ----
// The two US-005 fixtures pin the attempt model end to end:
//  - o10-real-w4.30-refused-rerouted-finalize reproduces the W4.30 shape the
//    item names (refused finalize, rerouted, >1 finalize attempts, single
//    finalize_merge step): pre-fix O10 threw `run <id> must have exactly one
//    finalize_merge step` (an oracle runtime error on a CORRECT refusal);
//    post-fix the attempt-aware model evaluates PASS with the terminal
//    attempt driving the decision table.
//  - o10-real-launch-refused-no-finalize-step reproduces the launch/setup-time
//    refusal corridor (a run that refused before any step row existed — the
//    detached-HEAD origin refusal): pre-fix the same throw fired (0 != 1);
//    post-fix the run is NOT_EVALUABLE with the reason.

const S47_NAMED = [
  ['o10-real-w4.30-refused-rerouted-finalize', 'PASS', 0, null],
  ['o10-real-launch-refused-no-finalize-step', 'NOT_EVALUABLE', 3, null],
];

test('US-005 S47 fixtures pin the attempt-aware finalize model with exact exit codes and no runtime errors', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(generated.status, 0, generated.stderr);
    for (const [name, expected, exitCode, finding] of S47_NAMED) {
      const { expectation, response, status } = invokeFixture(workspace, name);
      assert.equal(expectation.expected, expected, `${name} expectation`);
      assert.equal(response.result, expected, `${name}: ${JSON.stringify(response)}`);
      assert.equal(status, exitCode, `${name} exit code`);
      assert.equal(response.findings.length, 0, `${name} must carry no findings/runtime errors`);
      if (finding) {
        assert.ok(response.findings.some((entry) => entry.id === finding), `${name} omitted ${finding}`);
      }
    }
    // The multi-attempt refusal fixture must record the attempt model: 2
    // finalize rows, the terminal attempt driving the strict refusal bound
    // (terminal_reroute_count 1 == one step.rerouted event == decision-table
    // bound 1), and the superseded attempt reconciled as an attempt.
    const refusalObs = JSON.parse(fs.readFileSync(
      path.join(workspace, 'o10-real-w4.30-refused-rerouted-finalize', 'evidence', 'o10-fmis-decision-table.json'), 'utf8'));
    assert.equal(refusalObs.run_count, 1);
    assert.equal(refusalObs.runs[0].finalize_step.rows, 2, 'two finalize attempts');
    assert.equal(refusalObs.runs[0].finalize_step.terminal_attempt, 2);
    assert.equal(refusalObs.runs[0].expected.reroutes, 1, 'strict refusal decision-table bound');
    const finalizeRows = refusalObs.runs[0].reroute_reconciliation.per_step.filter((entry) => entry.step_id === 'finalize_merge');
    assert.equal(finalizeRows.length, 2, 'both attempt rows surfaced in the reconciliation');
    const terminal = finalizeRows.find((entry) => entry.attempt_index === undefined);
    const superseded = finalizeRows.find((entry) => entry.attempt_index === 1);
    assert.ok(terminal && superseded, 'terminal + superseded attempt rows present');
    assert.equal(terminal.attempts, 2);
    assert.equal(terminal.superseded_rows, 1);
    assert.equal(terminal.terminal_reroute_count, 1);
    assert.equal(terminal.reroute_events, 1);
    assert.equal(terminal.decision_table_bound, 1, 'strict bound enforced on the terminal attempt');
    assert.equal(superseded.terminal_reroute_count, 0, 'superseded attempt is not counted against the bound');
    assert.equal(superseded.status, 'failed');
    // The launch-refused fixture records NOT_EVALUABLE with the reason.
    const refusedEvidence = JSON.parse(fs.readFileSync(
      path.join(workspace, 'o10-real-launch-refused-no-finalize-step', 'evidence', 'o10-fmis-decision-table.json'), 'utf8'));
    assert.equal(refusedEvidence.not_evaluable, true);
    assert.ok(refusedEvidence.reason.includes('no finalize_merge step row'));
    assert.equal(refusedEvidence.run_count, 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- S59 (US-017): exact refusal self-diagnosis ----
// The four S59 fixtures pin the two-branch refusal-diagnosis model end to
// end:
//  - o10-real-w4.17b-red-refusal-log-tail (PASS): the W4.17-b red-evidence
//    refusal (green gate, exact red row) whose multi-line LOG_TAIL value
//    carries the gate's trailing remediation advice — pre-fix O10 raised
//    O10_REFUSAL_DIAGNOSIS (LOG_TAIL exact compare); post-fix the prefix
//    compare accepts the tail-with-advice reproduction.
//  - o10-real-missing-nearest-refusal-diagnosis (PASS): the missing-evidence
//    refusal that grounded on the NEAREST red row (plain `pytest` runs, exit
//    127 then 1) — pre-fix O10 expected LEDGER_EVIDENCE: missing and the
//    declared command's hash; post-fix every key is compared against the row
//    the gate actually cites (LEDGER_ROW_ID 8).
//  - o10-real-never-executed-canceled (NOT_EVALUABLE): the W4.dsh-fdmw
//    shape — 0 tokens, no step.running, canceled at the wall cap — pre-fix
//    scored PRODUCT_FAIL via O10_EVENT_SET_MISMATCH; post-fix the run is
//    NOT_EVALUABLE with the reason.
//  - o10-real-refusal-prose-output (FAIL O10_REFUSAL_DIAGNOSIS): agent prose
//    where the gate keyline block belongs stays a strict failure.

const S59_NAMED = [
  ['o10-real-w4.17b-red-refusal-log-tail', 'PASS', 0, null],
  ['o10-real-missing-nearest-refusal-diagnosis', 'PASS', 0, null],
  ['o10-real-never-executed-canceled', 'NOT_EVALUABLE', 3, null],
  ['o10-real-refusal-prose-output', 'FAIL', 1, 'O10_REFUSAL_DIAGNOSIS'],
];

test('US-017 S59 fixtures pin the exact refusal-diagnosis model with exact exit codes and findings', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(generated.status, 0, generated.stderr);
    const responses = new Map();
    for (const [name, expected, exitCode, finding] of S59_NAMED) {
      const { expectation, response, status } = invokeFixture(workspace, name);
      responses.set(name, response);
      assert.equal(expectation.expected, expected, `${name} expectation`);
      assert.equal(response.result, expected, `${name}: ${JSON.stringify(response)}`);
      assert.equal(status, exitCode, `${name} exit code`);
      if (finding) {
        assert.ok(response.findings.some((entry) => entry.id === finding), `${name} omitted ${finding}`);
      }
    }
    // The two PASS refusal fixtures must record the exact refusal-diagnosis
    // branch with zero mismatched keys (no spurious O10_REFUSAL_DIAGNOSIS).
    const logTailObs = JSON.parse(fs.readFileSync(
      path.join(workspace, 'o10-real-w4.17b-red-refusal-log-tail', 'evidence', 'o10-fmis-decision-table.json'), 'utf8'));
    assert.equal(logTailObs.run_count, 1);
    assert.equal(logTailObs.runs[0].refusal_diagnosis.branch, 'red-cited-row');
    assert.equal(logTailObs.runs[0].refusal_diagnosis.cited_row_id, '1');
    assert.deepEqual(logTailObs.runs[0].refusal_diagnosis.mismatched_keys, []);
    assert.equal(logTailObs.runs[0].expected.evidence, 'red');
    const nearestObs = JSON.parse(fs.readFileSync(
      path.join(workspace, 'o10-real-missing-nearest-refusal-diagnosis', 'evidence', 'o10-fmis-decision-table.json'), 'utf8'));
    assert.equal(nearestObs.runs[0].refusal_diagnosis.branch, 'red-cited-row');
    assert.equal(nearestObs.runs[0].refusal_diagnosis.cited_row_id, '8');
    assert.deepEqual(nearestObs.runs[0].refusal_diagnosis.mismatched_keys, []);
    assert.equal(nearestObs.runs[0].expected.evidence, 'missing');
    // The never-executed run records NOT_EVALUABLE with the reason.
    const neverExecutedEvidence = JSON.parse(fs.readFileSync(
      path.join(workspace, 'o10-real-never-executed-canceled', 'evidence', 'o10-fmis-decision-table.json'), 'utf8'));
    assert.equal(neverExecutedEvidence.not_evaluable, true);
    assert.ok(neverExecutedEvidence.reason.includes('never reached a claimed step'), neverExecutedEvidence.reason);
    assert.equal(neverExecutedEvidence.run_count, 0);
    // The prose-output refusal fails on the refusal-diagnosis leg (strict):
    // the refusal text must still be gate-generated keylines.
    const proseFindings = responses.get('o10-real-refusal-prose-output').findings;
    assert.ok(proseFindings.some((entry) => entry.id === 'O10_REFUSAL_DIAGNOSIS'));
    assert.ok(proseFindings.some((entry) => entry.id === 'O10_REFUSAL_DIAGNOSIS'
      && Array.isArray(entry.missing_or_mismatched_keys) && entry.missing_or_mismatched_keys.includes('FAILURE_CLASS')));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- S59 (US-017): refusalDiagnosis unit model ----

const S59_KEY = {
  origin_repo: '/torture-test/fixtures/synthetic-o10',
  cmd_hash: createHash('sha256').update('npm test').digest('hex'),
};
const S59_TREE = 'a'.repeat(40);
const S59_ROW = {
  id: 3, origin_repo: S59_KEY.origin_repo, tree_hash: S59_TREE, cmd_hash: S59_KEY.cmd_hash,
  cmd_display: 'npm test', exit_code: 17, duration_ms: 321,
  log_tail: 'tail line 1\ntail line 2', run_id: 'writer-run', step_id: 'test',
  created_at: '2026-08-02T12:04:00.000Z',
};
function s59Block(row, { advice = null, logTail = null, cmdHash = null, testCmd = null, ledgerEvidence = 'red', extra = [] } = {}) {
  const lines = [
    'FAILURE_CLASS: refused_permanent',
    `LEDGER_EVIDENCE: ${ledgerEvidence}`,
    `ORIGIN_REPO: ${row.origin_repo}`,
    `TREE_HASH: ${row.tree_hash}`,
    `CMD_HASH: ${cmdHash ?? row.cmd_hash}`,
    `TEST_CMD: ${testCmd ?? row.cmd_display}`,
  ];
  if (ledgerEvidence === 'red') lines.push(
    `LEDGER_ROW_ID: ${row.id}`,
    `EXIT_CODE: ${row.exit_code}`,
    `TIMESTAMP: ${row.created_at}`,
    `DURATION_MS: ${row.duration_ms}`,
    `LEDGER_RUN_ID: ${row.run_id}`,
    `LEDGER_STEP_ID: ${row.step_id}`,
    `LOG_TAIL: ${logTail ?? row.log_tail}`,
  );
  if (advice !== null) lines.push(advice);
  lines.push(
    'WORKSPACE_STATE: clean',
    'NEAREST_EVIDENCE: nearest evidence line',
    'ACTION: run the suite',
    ...extra,
  );
  return lines.join('\n');
}

test('refusalDiagnosis accepts a multi-line LOG_TAIL carrying the gate trailing advice (S59 sub-cause 1)', () => {
  // The gate appends its remediation sentence after the multi-line LOG_TAIL
  // value, so a full-value parse sees row log_tail + advice. The prefix
  // compare against the cited row's log_tail must not fail.
  const output = s59Block(S59_ROW, { advice: 'Please re-run the exact shim-wrapped test command on the committed tree, then resubmit.' });
  const diagnosis = refusalDiagnosis(output, 'red', S59_KEY, S59_TREE, S59_ROW, [S59_ROW]);
  assert.equal(diagnosis.branch, 'red-cited-row');
  assert.equal(diagnosis.cited_row_id, '3');
  assert.deepEqual(diagnosis.mismatched_keys, []);
});

test('refusalDiagnosis compares every key against the row the gate cites (S59 sub-cause 2)', () => {
  // The worker produced no row for the declared command; the gate refused on
  // the NEAREST red row (plain pytest, a different tree/command) with
  // LEDGER_EVIDENCE: red and THAT row's CMD_HASH/TEST_CMD. The oracle's own
  // decision evidence is missing (no exact row), so every key must be
  // compared against the cited row (id 9), never the declared key.
  const nearest = {
    id: 9, origin_repo: S59_KEY.origin_repo, tree_hash: 'd'.repeat(40),
    cmd_hash: createHash('sha256').update('pytest').digest('hex'), cmd_display: 'pytest',
    exit_code: 1, duration_ms: 900, log_tail: '1 failed, 12 passed in 0.9s',
    run_id: 'writer-run', step_id: 'test', created_at: '2026-08-02T12:08:30.000Z',
  };
  const output = s59Block(nearest);
  const diagnosis = refusalDiagnosis(output, 'missing', S59_KEY, S59_TREE, null, [nearest]);
  assert.equal(diagnosis.branch, 'red-cited-row');
  assert.equal(diagnosis.cited_row_id, '9');
  assert.deepEqual(diagnosis.mismatched_keys, []);
});

test('refusalDiagnosis keeps the missing branch exact against the declared command identity', () => {
  const output = s59Block(S59_ROW, { ledgerEvidence: 'missing', advice: null });
  // A missing-branch block has no LEDGER_ROW_ID: the keys are compared
  // against the DECLARED origin/tree/command.
  const diagnosis = refusalDiagnosis(output, 'missing', S59_KEY, S59_TREE, null, [S59_ROW]);
  assert.equal(diagnosis.branch, 'missing');
  assert.equal(diagnosis.cited_row_id, null);
  assert.deepEqual(diagnosis.mismatched_keys, []);
});

test('refusalDiagnosis stays strict: prose output and wrong-command blocks still mismatch', () => {
  // Agent prose where the gate keyline block belongs -> every gate key is
  // missing from the diagnosis.
  const prose = refusalDiagnosis('STATUS: failed\nThe change is correct, please merge it.', 'red', S59_KEY, S59_TREE, S59_ROW, [S59_ROW]);
  assert.equal(prose.mismatched_keys.includes('FAILURE_CLASS'), true);
  assert.equal(prose.mismatched_keys.includes('LEDGER_EVIDENCE'), true);
  assert.equal(prose.mismatched_keys.includes('WORKSPACE_STATE'), true);
  // A missing-branch block that cites the DECLARED command's hash while the
  // oracle concluded missing is consistent — but a block carrying a
  // TEST_CMD/CMD_HASH that does not hash to the expected command identity
  // (declared on missing, cited row's on red-cited-row) is a mismatch.
  const wrongCmd = refusalDiagnosis(
    s59Block(S59_ROW, { cmdHash: 'f'.repeat(64), testCmd: 'pytest', ledgerEvidence: 'missing' }),
    'missing', S59_KEY, S59_TREE, null, [S59_ROW],
  );
  assert.equal(wrongCmd.mismatched_keys.includes('CMD_HASH'), true);
  assert.equal(wrongCmd.mismatched_keys.includes('TEST_CMD'), true);
});

test('refusalDiagnosis reconciles the cited row with the oracle decision evidence (S59 sub-cause 2 strictness)', () => {
  // Exact red evidence exists (id 3) but the gate cites a DIFFERENT (nearest)
  // row -> the red-branch refusal is not grounded on the exact row the oracle
  // found.
  const nearest = {
    id: 9, origin_repo: S59_KEY.origin_repo, tree_hash: 'd'.repeat(40),
    cmd_hash: createHash('sha256').update('pytest').digest('hex'), cmd_display: 'pytest',
    exit_code: 1, duration_ms: 900, log_tail: '1 failed', run_id: 'writer-run', step_id: 'test',
    created_at: '2026-08-02T12:08:30.000Z',
  };
  const output = s59Block(nearest);
  const diagnosis = refusalDiagnosis(output, 'red', S59_KEY, S59_TREE, S59_ROW, [S59_ROW, nearest]);
  assert.equal(diagnosis.mismatched_keys.includes('LEDGER_ROW_ID'), true);
  // The oracle concluded missing but the gate cites the exact-key row the
  // oracle could not find -> inconsistent diagnosis.
  const exactCitedUnderMissing = refusalDiagnosis(s59Block(S59_ROW), 'missing', S59_KEY, S59_TREE, null, [S59_ROW]);
  assert.equal(exactCitedUnderMissing.mismatched_keys.includes('LEDGER_EVIDENCE'), true);
  // An unknown LEDGER_ROW_ID (no such row in the scoped ledger) fails closed.
  const unknown = refusalDiagnosis(s59Block({ ...S59_ROW, id: 77 }), 'red', S59_KEY, S59_TREE, S59_ROW, [S59_ROW]);
  assert.equal(unknown.mismatched_keys.includes('LEDGER_ROW_ID'), true);
});

test('refusalDiagnosis flags a LOG_TAIL that does not reproduce the cited row log_tail at its head', () => {
  // Truncated tail (the gate cut the row's log_tail short) and a tail whose
  // text diverges are both mismatches — the prefix compare is strict about
  // the row's log_tail being reproduced verbatim at the head of the value.
  const truncated = refusalDiagnosis(s59Block(S59_ROW, { logTail: 'tail line 1' }), 'red', S59_KEY, S59_TREE, S59_ROW, [S59_ROW]);
  assert.equal(truncated.mismatched_keys.includes('LOG_TAIL'), true);
  const diverged = refusalDiagnosis(s59Block(S59_ROW, { logTail: 'other tail' }), 'red', S59_KEY, S59_TREE, S59_ROW, [S59_ROW]);
  assert.equal(diverged.mismatched_keys.includes('LOG_TAIL'), true);
  // A missing LOG_TAIL keyline is a mismatch too (the gate's full row-identity
  // keyline block must be present).
  const missingTail = refusalDiagnosis(
    s59Block(S59_ROW, { logTail: '', extra: [] }).split('\n').filter((line) => !line.startsWith('LOG_TAIL:')).join('\n'),
    'red', S59_KEY, S59_TREE, S59_ROW, [S59_ROW],
  );
  assert.equal(missingTail.mismatched_keys.includes('LOG_TAIL'), true);
});

test('finalizeStepModel orders finalize rows by (updated_at, id) and selects the terminal attempt', () => {
  const late = { id: 'row-b', step_id: 'finalize_merge', updated_at: '2026-08-02T12:10:00.000Z', status: 'failed', terminal_reroute_count: 1 };
  const early = { id: 'row-a', step_id: 'finalize_merge', updated_at: '2026-08-02T12:06:00.000Z', status: 'failed', terminal_reroute_count: 0 };
  const other = { id: 'verify-row', step_id: 'verify', updated_at: '2026-08-02T12:05:00.000Z', status: 'done' };
  const model = finalizeStepModel([other, late, early]);
  assert.equal(model.attempts, 2);
  assert.equal(model.rows[0].id, 'row-a');
  assert.equal(model.rows[1].id, 'row-b');
  assert.equal(model.terminal.id, 'row-b');
  // No finalize rows -> terminal null (never a throw).
  const empty = finalizeStepModel([{ id: 'verify-row', step_id: 'verify', updated_at: '2026-08-02T12:05:00.000Z', status: 'done' }]);
  assert.equal(empty.attempts, 0);
  assert.equal(empty.terminal, null);
});

test('reconcileReroutes reconciles a multi-attempt finalize on a refusal cell without weakening the strict bound', () => {
  // The W4.30 shape: two finalize rows (attempts), one step.rerouted event,
  // terminal row counter 1. The strict refusal bound (exactly one obstructing
  // reroute) applies to the TERMINAL row only; the superseded attempt is an
  // attempt, not a second bound violation.
  const events = [
    { event: 'step.running', stepId: 'verify' },
    { event: 'step.rerouted', stepId: 'finalize_merge' },
    { event: 'step.running', stepId: 'verify' },
    { event: 'run.failed' },
  ];
  const rows = [
    { id: 'finalize-attempt-1-row', step_id: 'finalize_merge', status: 'failed', terminal_reroute_count: 0, updated_at: '2026-08-02T12:06:00.000Z' },
    { id: 'finalize-attempt-2-row', step_id: 'finalize_merge', status: 'failed', terminal_reroute_count: 1, updated_at: '2026-08-02T12:10:00.000Z' },
  ];
  const result = reconcileReroutes(events, rows, { rows: [], byStepId: new Map() }, 1);
  assert.deepEqual(result.anomalies, [], 'the legitimate rerouted multi-attempt finalize must reconcile cleanly');
  const finalizeRows = result.per_step.filter((entry) => entry.step_id === 'finalize_merge');
  assert.equal(finalizeRows.length, 2);
  const terminal = finalizeRows.find((entry) => entry.superseded !== true);
  const superseded = finalizeRows.find((entry) => entry.attempt_index === 1);
  assert.equal(terminal.terminal_reroute_count, 1);
  assert.equal(terminal.decision_table_bound, 1);
  assert.equal(terminal.attempts, 2);
  assert.equal(terminal.superseded_rows, 1);
  assert.equal(superseded.terminal_reroute_count, 0);
});

test('reconcileReroutes flags a multi-attempt finalize whose attempts lack a separating reroute', () => {
  // Two finalize rows with NO step.rerouted event -> the second attempt is not
  // re-dispatched through the corridor -> attempt-without-reroute.
  const events = [{ event: 'step.running', stepId: 'verify' }, { event: 'run.failed' }];
  const rows = [
    { id: 'finalize-attempt-1-row', step_id: 'finalize_merge', status: 'failed', terminal_reroute_count: 0, updated_at: '2026-08-02T12:06:00.000Z' },
    { id: 'finalize-attempt-2-row', step_id: 'finalize_merge', status: 'failed', terminal_reroute_count: 0, updated_at: '2026-08-02T12:10:00.000Z' },
  ];
  const result = reconcileReroutes(events, rows, { rows: [], byStepId: new Map() }, 1);
  const anomaly = result.anomalies.find((entry) => entry.kind === 'attempt-without-reroute');
  assert.ok(anomaly, 'attempt-without-reroute expected');
  assert.equal(anomaly.superseded_rows, 1);
  assert.equal(anomaly.reroute_events, 0);
});

test('reconcileReroutes flags a done finalize attempt superseded by a later finalize row', () => {
  const events = [
    { event: 'step.rerouted', stepId: 'finalize_merge' },
    { event: 'merge.landed' },
    { event: 'run.completed' },
  ];
  const rows = [
    { id: 'finalize-attempt-1-row', step_id: 'finalize_merge', status: 'done', terminal_reroute_count: 0, updated_at: '2026-08-02T12:06:00.000Z' },
    { id: 'finalize-attempt-2-row', step_id: 'finalize_merge', status: 'done', terminal_reroute_count: 1, updated_at: '2026-08-02T12:10:00.000Z' },
  ];
  const result = reconcileReroutes(events, rows, { rows: [], byStepId: new Map() }, null);
  const anomaly = result.anomalies.find((entry) => entry.kind === 'superseded-done-attempt');
  assert.ok(anomaly, 'superseded-done-attempt expected');
  assert.equal(anomaly.attempt_row_id, 'finalize-attempt-1-row');
});

test('US-003 fixture generation is deterministic: two independent generations produce byte-identical trees', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const first = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(first.status, 0, first.stderr);
    const firstHashes = fixtureHashes(workspace);
    // Regenerate into the SAME workspace path (expectation.json embeds the
    // absolute context path, so byte-identity is pinned at a fixed path).
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.mkdirSync(workspace, { recursive: true });
    const second = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(fixtureHashes(workspace), firstHashes, 'two independent generations must be byte-identical');
    assert.ok(firstHashes.size > 0, 'fixture tree must be non-empty');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

function fixtureHashes(root) {
  const hashes = new Map();
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).toSorted((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        hashes.set(
          path.relative(root, file).split(path.sep).join('/'),
          createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        );
      }
    }
  }
  visit(root);
  return hashes;
}

// ---- S27 real-cell event-set model (US-001) ----

function runningEvent(stepId, agentId) {
  return { event: 'step.running', stepId, agentId };
}

test('mergeGateSubset keeps only the merge-gate seal events and sorts them', () => {
  const events = [
    { event: 'step.running' }, { event: 'merge.landed' }, { event: 'step.rerouted' },
    { event: 'pipeline.advanced' }, { event: 'merge.landed_without_suite_evidence' },
    { event: 'run.completed' }, { event: 'run.canceled' }, { event: 'merge.gate_overridden' },
  ];
  assert.deepEqual(mergeGateSubset(events), [
    'merge.gate_overridden', 'merge.landed', 'merge.landed_without_suite_evidence',
    'run.canceled', 'run.completed',
  ]);
  assert.deepEqual(mergeGateSubset([{ event: 'step.running' }, { event: 'step.rerouted' }]), []);
});

test('expectedMergeGateNames is the decision-table multiset minus lifecycle events', () => {
  const concession = { lands: true, reroutes: 1, merger_invocations: 1, annotations: ['merge.landed_without_suite_evidence'] };
  assert.deepEqual(expectedMergeGateNames(concession, 'completed', false), [
    'merge.landed', 'merge.landed_without_suite_evidence', 'run.completed',
  ]);
  const green = { lands: true, reroutes: 0, merger_invocations: 1, annotations: [] };
  assert.deepEqual(expectedMergeGateNames(green, 'completed', false), ['merge.landed', 'run.completed']);
  const refusal = { lands: false, reroutes: 1, merger_invocations: 0, annotations: [] };
  assert.deepEqual(expectedMergeGateNames(refusal, 'failed', false), ['run.failed']);
  const alreadyLanded = { lands: true, reroutes: 0, merger_invocations: 1, annotations: ['merge.accepted_already_landed'] };
  assert.deepEqual(expectedMergeGateNames(alreadyLanded, 'completed', true), [
    'merge.accepted_already_landed', 'run.completed',
  ]);
});

test('lifecycleRunning accepts a legal multi-step stream with a corridor reroute', () => {
  const steps = [
    { step_id: 'triage', agent_id: 'a_triager' },
    { step_id: 'investigate', agent_id: 'a_investigator' },
    { step_id: 'setup', agent_id: 'a_setup' },
    { step_id: 'fix', agent_id: 'a_fixer' },
    { step_id: 'verify', agent_id: 'a_verifier' },
    { step_id: 'finalize_merge', agent_id: 'a_merger' },
  ];
  const events = [
    runningEvent('triage', 'a_triager'),
    runningEvent('investigate', 'a_investigator'),
    runningEvent('setup', 'a_setup'),
    runningEvent('fix', 'a_fixer'),
    runningEvent('verify', 'a_verifier'),
    { event: 'step.rerouted', stepId: 'finalize_merge' },
    runningEvent('verify', 'a_verifier'),
    runningEvent('finalize_merge', 'a_merger'),
    { event: 'merge.landed' },
    { event: 'run.completed' },
  ];
  const result = lifecycleRunning(events, steps);
  assert.deepEqual(result.anomalies, []);
  const verify = result.per_step.find((entry) => entry.step_id === 'verify');
  assert.equal(verify.expected, 2);
  assert.equal(verify.observed, 2);
  assert.equal(verify.reroute_target_executions, 1);
  assert.equal(verify.story_iterations, 0);
});

test('lifecycleRunning flags step.running naming an unknown step', () => {
  const steps = [{ step_id: 'fix', agent_id: 'a_fixer' }, { step_id: 'finalize_merge', agent_id: 'a_merger' }];
  const events = [
    runningEvent('fix', 'a_fixer'),
    runningEvent('ghost', 'a_ghost'),
    runningEvent('finalize_merge', 'a_merger'),
  ];
  const result = lifecycleRunning(events, steps);
  assert.ok(result.anomalies.some((anomaly) => anomaly.kind === 'unknown-step-running' && anomaly.step_id === 'ghost'));
});

test('lifecycleRunning flags step.running with a mismatched agentId', () => {
  const steps = [{ step_id: 'fix', agent_id: 'a_fixer' }, { step_id: 'finalize_merge', agent_id: 'a_merger' }];
  const events = [
    runningEvent('fix', 'WRONG_AGENT'),
    runningEvent('finalize_merge', 'a_merger'),
  ];
  const result = lifecycleRunning(events, steps);
  assert.ok(result.anomalies.some((anomaly) => anomaly.kind === 'unknown-step-running' && anomaly.step_id === 'fix'));
});

test('lifecycleRunning flags a running-count mismatch', () => {
  const steps = [{ step_id: 'fix', agent_id: 'a_fixer' }, { step_id: 'finalize_merge', agent_id: 'a_merger' }];
  const events = [
    runningEvent('fix', 'a_fixer'),
    runningEvent('fix', 'a_fixer'),
    runningEvent('finalize_merge', 'a_merger'),
  ];
  const result = lifecycleRunning(events, steps);
  assert.ok(result.anomalies.some((anomaly) => anomaly.kind === 'running-count-mismatch'
    && anomaly.step_id === 'fix' && anomaly.expected === 1 && anomaly.observed === 2));
});

test('lifecycleRunning derives story-iteration multiplicity for loop and verify_each steps', () => {
  const steps = [
    { step_id: 'plan', agent_id: 'a_planner' },
    { step_id: 'implement', agent_id: 'a_developer', type: 'loop', loop_config: '{"over":"stories"}' },
    { step_id: 'verify', agent_id: 'a_verifier' },
    { step_id: 'finalize_merge', agent_id: 'a_merger' },
  ];
  const events = [
    runningEvent('plan', 'a_planner'),
    { event: 'story.started', stepId: 'implement', storyId: 'US-001' },
    runningEvent('implement', 'a_developer'),
    { event: 'story.done', stepId: 'implement', storyId: 'US-001' },
    { event: 'story.verified', stepId: 'verify', storyId: 'US-001' },
    runningEvent('verify', 'a_verifier'),
    { event: 'story.started', stepId: 'implement', storyId: 'US-002' },
    runningEvent('implement', 'a_developer'),
    { event: 'story.done', stepId: 'implement', storyId: 'US-002' },
    { event: 'story.verified', stepId: 'verify', storyId: 'US-002' },
    runningEvent('verify', 'a_verifier'),
    runningEvent('finalize_merge', 'a_merger'),
  ];
  const result = lifecycleRunning(events, steps);
  assert.deepEqual(result.anomalies, []);
  const implement = result.per_step.find((entry) => entry.step_id === 'implement');
  assert.equal(implement.expected, 2);
  assert.equal(implement.observed, 2);
  assert.equal(implement.story_iterations, 2);
  const verify = result.per_step.find((entry) => entry.step_id === 'verify');
  assert.equal(verify.expected, 2);
  assert.equal(verify.observed, 2);
  assert.equal(verify.story_iterations, 2);
});

test('lifecycleRunning counts honest retry re-dispatches from step.retry events', () => {
  const steps = [
    { step_id: 'plan', agent_id: 'a_planner' },
    { step_id: 'fix', agent_id: 'a_fixer' },
    { step_id: 'finalize_merge', agent_id: 'a_merger' },
  ];
  const events = [
    runningEvent('plan', 'a_planner'),
    { event: 'step.retry', stepId: 'plan' },
    runningEvent('plan', 'a_planner'),
    runningEvent('fix', 'a_fixer'),
    runningEvent('finalize_merge', 'a_merger'),
  ];
  const result = lifecycleRunning(events, steps);
  assert.deepEqual(result.anomalies, []);
  const plan = result.per_step.find((entry) => entry.step_id === 'plan');
  assert.equal(plan.retry_events, 1);
  assert.equal(plan.expected, 2);
  assert.equal(plan.observed, 2);
});

test('lifecycleRunning does not treat DB retry_count as an execution counter', () => {
  // W4.06 class: steps.retry_count is a dispatch-retry counter — plan has
  // retry_count 1 with no step.retry event and exactly one execution.
  const steps = [
    { step_id: 'plan', agent_id: 'a_planner', retry_count: 1 },
    { step_id: 'finalize_merge', agent_id: 'a_merger' },
  ];
  const events = [
    runningEvent('plan', 'a_planner'),
    runningEvent('finalize_merge', 'a_merger'),
  ];
  const result = lifecycleRunning(events, steps);
  assert.deepEqual(result.anomalies, []);
  const plan = result.per_step.find((entry) => entry.step_id === 'plan');
  assert.equal(plan.retry_events, 0);
  assert.equal(plan.expected, 1);
  assert.equal(plan.observed, 1);
});

test('lifecycleRunning tolerates steps rows without type/loop_config (scripted schema)', () => {
  const steps = [{ step_id: 'implement', agent_id: 'a_developer' }, { step_id: 'finalize_merge', agent_id: 'a_merger' }];
  const events = [
    runningEvent('implement', 'a_developer'),
    runningEvent('finalize_merge', 'a_merger'),
  ];
  const result = lifecycleRunning(events, steps);
  assert.deepEqual(result.anomalies, []);
  assert.equal(result.per_step[0].type, null);
  assert.equal(result.per_step[0].expected, 1);
  assert.equal(result.per_step[0].observed, 1);
});

// ---- S27 US-002 real-cell reroute reconciliation ----

const REROUTE_STEPS = [
  { step_id: 'fix', terminal_reroute_count: 0 },
  { step_id: 'verify', terminal_reroute_count: 0 },
  { step_id: 'finalize_merge', terminal_reroute_count: 1 },
];
const REROUTE_EVENTS = [
  { event: 'step.running', stepId: 'fix' },
  { event: 'step.running', stepId: 'verify' },
  { event: 'step.rerouted', stepId: 'finalize_merge' },
  { event: 'step.running', stepId: 'verify' },
  { event: 'step.running', stepId: 'finalize_merge' },
  { event: 'merge.landed' },
  { event: 'run.completed' },
];

test('reconcileReroutes accepts a legal corridor reroute on a landing cell (fallback: artifact absent)', () => {
  const result = reconcileReroutes(REROUTE_EVENTS, REROUTE_STEPS, { rows: [], byStepId: new Map() }, null);
  assert.deepEqual(result.anomalies, []);
  assert.equal(result.corridor_evidence, 'fallback');
  const finalize = result.per_step.find((entry) => entry.step_id === 'finalize_merge');
  assert.equal(finalize.terminal_reroute_count, 1);
  assert.equal(finalize.reroute_events, 1);
  assert.equal(finalize.corridor, 'fallback');
});

test('reconcileReroutes accepts a legal corridor reroute corroborated by dispatch_renderings', () => {
  const corridor = rerouteCorridorByStep([
    { run_id: 'run-x', step_id: 'finalize_merge', step_row_id: 'finalize-row', dispatched: false,
      producer_step_row_id: 'verify-row', transition: { action: 'reroute', target_step_row_id: 'verify-row' } },
  ], 'run-x');
  assert.equal(corridor.rows.length, 1);
  const result = reconcileReroutes(REROUTE_EVENTS, REROUTE_STEPS, corridor, null);
  assert.deepEqual(result.anomalies, []);
  assert.equal(result.corridor_evidence, 'corroborated');
  const finalize = result.per_step.find((entry) => entry.step_id === 'finalize_merge');
  assert.equal(finalize.corridor_rows, 1);
  assert.equal(finalize.corridor, 'corroborated');
});

test('reconcileReroutes flags a step.rerouted event count that differs from the DB terminal_reroute_count', () => {
  const steps = [
    { step_id: 'fix', terminal_reroute_count: 0 },
    { step_id: 'verify', terminal_reroute_count: 0 },
    { step_id: 'finalize_merge', terminal_reroute_count: 0 },
  ];
  const result = reconcileReroutes(REROUTE_EVENTS, steps, { rows: [], byStepId: new Map() }, null);
  const anomaly = result.anomalies.find((entry) => entry.kind === 'count-mismatch' && entry.step_id === 'finalize_merge');
  assert.ok(anomaly, 'finalize_merge count mismatch expected');
  assert.equal(anomaly.expected, 0);
  assert.equal(anomaly.observed, 1);
});

test('reconcileReroutes flags a reroute event without corridor corroboration when the artifact carries corridor rows', () => {
  // The artifact carries a legal corridor row for ANOTHER step; finalize_merge
  // has a step.rerouted event but no corridor row covers it.
  const corridor = rerouteCorridorByStep([
    { run_id: 'run-x', step_id: 'verify', step_row_id: 'verify-row', dispatched: false,
      producer_step_row_id: 'fix-row', transition: { action: 'reroute', target_step_row_id: 'fix-row' } },
  ], 'run-x');
  const result = reconcileReroutes(REROUTE_EVENTS, REROUTE_STEPS, corridor, null);
  const anomaly = result.anomalies.find((entry) => entry.kind === 'corridor-missing' && entry.step_id === 'finalize_merge');
  assert.ok(anomaly, 'finalize_merge corridor-missing expected');
  assert.equal(anomaly.corridor_rows, 0);
  assert.equal(anomaly.reroute_events, 1);
});

test('reconcileReroutes flags a step.rerouted event naming a step absent from the run steps', () => {
  const steps = [
    { step_id: 'fix', terminal_reroute_count: 0 },
    { step_id: 'verify', terminal_reroute_count: 0 },
    { step_id: 'finalize_merge', terminal_reroute_count: 0 },
  ];
  const events = [
    { event: 'step.rerouted', stepId: 'ghost' },
    { event: 'step.running', stepId: 'finalize_merge' },
  ];
  const result = reconcileReroutes(events, steps, { rows: [], byStepId: new Map() }, null);
  const anomaly = result.anomalies.find((entry) => entry.kind === 'unknown-step-rerouted' && entry.step_id === 'ghost');
  assert.ok(anomaly, 'unknown-step-rerouted expected');
  assert.equal(anomaly.reroute_events, 1);
});

test('reconcileReroutes preserves the strict refusal doctrine on refusal cells', () => {
  // Refusal cell (strict missing/green): finalize_merge must reroute exactly
  // once — DB counter AND event count must equal the decision-table bound. A
  // landing-style reconciliation must NOT absorb the mismatch.
  const refusalSteps = [
    { step_id: 'fix', terminal_reroute_count: 0 },
    { step_id: 'verify', terminal_reroute_count: 0 },
    { step_id: 'finalize_merge', terminal_reroute_count: 0 },
  ];
  const refusal = reconcileReroutes(REROUTE_EVENTS, refusalSteps, { rows: [], byStepId: new Map() }, 1);
  const anomaly = refusal.anomalies.find((entry) => entry.kind === 'refusal-count-mismatch' && entry.step_id === 'finalize_merge');
  assert.ok(anomaly, 'refusal-count-mismatch expected');
  assert.equal(anomaly.expected, 1);
  assert.equal(anomaly.database, 0);
  assert.equal(anomaly.observed, 1);
  // The matching refusal shape (counter 1, event 1) passes, and non-finalize
  // steps still reconcile on their own counters.
  const refusalOk = reconcileReroutes(REROUTE_EVENTS, [
    { step_id: 'fix', terminal_reroute_count: 0 },
    { step_id: 'verify', terminal_reroute_count: 0 },
    { step_id: 'finalize_merge', terminal_reroute_count: 1 },
  ], { rows: [], byStepId: new Map() }, 1);
  assert.deepEqual(refusalOk.anomalies, []);
});

test('legalRerouteTransition recognizes only the corridor shape O11 accepts', () => {
  assert.deepEqual(
    legalRerouteTransition({ step_row_id: 'finalize-row', step_id: 'finalize_merge', dispatched: false,
      producer_step_row_id: 'verify-row', transition: { action: 'reroute', target_step_row_id: 'verify-row' } }),
    { target_step_row_id: 'verify-row' },
  );
  // Misrouted: the transition consumes a retry on the consumer, not the producer.
  assert.equal(
    legalRerouteTransition({ step_row_id: 'finalize-row', step_id: 'finalize_merge', dispatched: false,
      producer_step_row_id: 'verify-row', transition: { action: 'reroute', target_step_row_id: 'finalize-row' } }),
    null,
  );
  // Retry (not reroute) is not a reroute corridor.
  assert.equal(
    legalRerouteTransition({ step_row_id: 'finalize-row', step_id: 'finalize_merge', dispatched: false,
      producer_step_row_id: 'verify-row', transition: { action: 'retry', target_step_row_id: 'verify-row' } }),
    null,
  );
  // Missing or self producer is not a corridor.
  assert.equal(
    legalRerouteTransition({ step_row_id: 'finalize-row', step_id: 'finalize_merge', dispatched: false,
      producer_step_row_id: null, transition: { action: 'reroute', target_step_row_id: 'verify-row' } }),
    null,
  );
  assert.equal(
    legalRerouteTransition({ step_row_id: 'finalize-row', step_id: 'finalize_merge', dispatched: false,
      producer_step_row_id: 'finalize-row', transition: { action: 'reroute', target_step_row_id: 'finalize-row' } }),
    null,
  );
  assert.equal(legalRerouteTransition({ step_row_id: 'finalize-row', step_id: 'finalize_merge', dispatched: true }), null);
});

test('rerouteCorridorByStep scopes corridor rows to the run and counts per consumer step', () => {
  const rows = [
    { run_id: 'run-x', step_id: 'finalize_merge', step_row_id: 'f-row', dispatched: false,
      producer_step_row_id: 'v-row', transition: { action: 'reroute', target_step_row_id: 'v-row' } },
    { run_id: 'run-x', step_id: 'finalize_merge', step_row_id: 'f-row', dispatched: false,
      producer_step_row_id: 'v-row', transition: { action: 'reroute', target_step_row_id: 'v-row' } },
    { run_id: 'run-x', step_id: 'verify', step_row_id: 'v-row', dispatched: true, producer_step_row_id: null, transition: null },
    { run_id: 'run-y', step_id: 'finalize_merge', step_row_id: 'f-row', dispatched: false,
      producer_step_row_id: 'v-row', transition: { action: 'reroute', target_step_row_id: 'v-row' } },
  ];
  const result = rerouteCorridorByStep(rows, 'run-x');
  assert.equal(result.rows.length, 2);
  assert.equal(result.byStepId.get('finalize_merge'), 2);
  assert.equal(result.byStepId.get('verify'), undefined);
  // Empty artifact -> empty corridor (the fallback regime).
  const empty = rerouteCorridorByStep(null, 'run-x');
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.byStepId.size, 0);
});
