#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  OUTCOMES,
  classifyAttempt,
  providerRetryDecision,
} from './tt-classification.mjs';

const oracle = (result, signals = {}) => ({
  status: 'VALID',
  response: { result, classification: signals },
});

const scenarios = [
  ['PASS', { expectation_met: true, oracle_results: [oracle('PASS')] }],
  ['PRODUCT_FAIL', { oracle_results: [oracle('FAIL')] }],
  ['AGENT_FLAKE', { agent_task_succeeded: false, oracle_results: [oracle('PASS')] }],
  ['PROVIDER_FAIL', { provider_failure: { identified: true, injected: false }, oracle_results: [oracle('PASS')] }],
  ['TEST_INFRA_FAIL', { infrastructure_failure: { category: 'fixture-reset' }, oracle_results: [oracle('PASS')] }],
  ['INVALID', { manipulation_checks: [{ id: 'fault', required: true, engaged: false }], oracle_results: [oracle('PASS')] }],
  ['INCONCLUSIVE', { ambiguous: { category: 'terminal-state' }, oracle_results: [oracle('PASS')] }],
  ['NOT_RUN', { not_run: { category: 'predicate' }, oracle_results: [] }],
];

assert.deepEqual([...OUTCOMES], scenarios.map(([outcome]) => outcome));
for (const caseClass of ['verification', 'characterization', 'exploratory']) {
  for (const [expected, evidence] of scenarios) {
    const actual = classifyAttempt({ caseClass, ...evidence });
    assert.equal(actual.outcome, expected, `${caseClass} ${expected}: ${JSON.stringify(actual)}`);
  }
}

for (const competing of [
  { provider_failure: { identified: true, injected: false } },
  { manipulation_checks: [{ id: 'unrelated', required: true, engaged: false }] },
  { infrastructure_failure: { category: 'waiter' } },
]) {
  const actual = classifyAttempt({
    caseClass: 'verification',
    oracle_results: [oracle('FAIL')],
    ...competing,
  });
  assert.equal(actual.outcome, 'PRODUCT_FAIL', `oracle precedence lost: ${JSON.stringify(actual)}`);
}

assert.equal(classifyAttempt({
  caseClass: 'verification',
  expectation_met: false,
  oracle_results: [oracle('PASS')],
}).outcome, 'PRODUCT_FAIL');
assert.equal(classifyAttempt({
  caseClass: 'characterization',
  expectation_met: false,
  oracle_results: [oracle('PASS')],
}).outcome, 'PASS');
assert.equal(classifyAttempt({
  caseClass: 'exploratory',
  agent_task_succeeded: false,
  oracle_results: [oracle('PASS')],
}).outcome, 'AGENT_FLAKE');
assert.equal(classifyAttempt({
  caseClass: 'exploratory',
  ambiguous: { category: 'workflow-terminal' },
  oracle_results: [oracle('PASS', { agent_task_succeeded: false })],
}).outcome, 'AGENT_FLAKE');
assert.equal(classifyAttempt({
  caseClass: 'verification',
  ambiguous: { category: 'workflow-terminal' },
  oracle_results: [oracle('PASS', { expectation_met: false })],
}).outcome, 'PRODUCT_FAIL');
assert.equal(classifyAttempt({
  caseClass: 'verification',
  provider_failure: { identified: true, injected: true },
  ambiguous: { category: 'injected-provider-fault' },
  oracle_results: [oracle('PASS')],
}).outcome, 'INCONCLUSIVE');
assert.equal(classifyAttempt({
  caseClass: 'verification',
  expectation_met: true,
  provider_failure: { identified: false, injected: false },
  oracle_results: [oracle('PASS')],
}).outcome, 'INCONCLUSIVE');

const firstRetry = providerRetryDecision({
  outcome: 'PROVIDER_FAIL',
  attempts: [{ id: 'attempt-1', outcome: 'PROVIDER_FAIL' }],
  backoffMs: 125,
  nowMs: Date.parse('2026-08-01T00:00:00.000Z'),
});
assert.deepEqual(firstRetry, {
  retry: true,
  retry_of: 'attempt-1',
  retry_number: 1,
  retry_not_before: '2026-08-01T00:00:00.125Z',
});
assert.deepEqual(providerRetryDecision({
  outcome: 'PROVIDER_FAIL',
  attempts: [
    { id: 'attempt-1', outcome: 'PROVIDER_FAIL' },
    { id: 'attempt-2', outcome: 'PROVIDER_FAIL', retry_of: 'attempt-1' },
  ],
  backoffMs: 125,
  nowMs: Date.parse('2026-08-01T00:00:01.000Z'),
}), { retry: false });
assert.deepEqual(providerRetryDecision({
  outcome: 'PASS', attempts: [{ id: 'attempt-1', outcome: 'PASS' }], backoffMs: 125,
}), { retry: false });

const source = await import('node:fs').then(({ readFileSync }) =>
  readFileSync(new URL('./tt-classification.mjs', import.meta.url), 'utf8'));
for (const forbidden of ['task_text', 'agent_output', 'progress_report']) {
  assert.equal(source.includes(forbidden), false, `classifier reads forbidden prose field ${forbidden}`);
}

console.log('tt-classification tests passed');
