#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { isStrictMissing, lifecycleRunning, mergeGateSubset, expectedMergeGateNames, reconcileReroutes } from '../lib/o10.mjs';
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
    // + 2 S27 real-cell reroute-reconciliation fixtures (US-002).
    assert.equal(names.length, 36);
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
