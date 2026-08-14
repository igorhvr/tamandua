#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const workspace = path.resolve(process.argv[2] ?? '');
const varRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..', 'var');
if (workspace === varRoot || !workspace.startsWith(`${varRoot}${path.sep}`) || !path.basename(workspace).startsWith('oracle-self-test.')) {
  throw new Error('O11 fixture workspace must be a unique oracle-self-test.* directory beneath torture-test/var');
}

const RUN_A = 'run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_B = 'run-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const START_A = '2026-08-01T12:00:00.000Z';
const START_B = '2026-08-01T12:00:00.500Z';
const FINISH = '2026-08-01T12:01:00.000Z';
const CAPTURED = '2026-08-01T12:02:00.000Z';
const REFERENCE_KEYS = [
  'database_snapshot', 'run_events', 'workflow_status', 'launch_intent', 'git_bundle',
  'refs_before', 'refs_after', 'target_reflog', 'checksum_baseline', 'checksum_terminal',
  'suite_ledger', 'suite_observations', 'token_deltas', 'round_usage',
  'system_tokens_before', 'system_tokens_after', 'submit_rejections',
  'expects_validations', 'dispatch_renderings',
];

const piUsage = {
  id: 'usage-a-1', run_id: RUN_A, step_id: 'step-plan', round_id: 'round-1',
  harness: 'pi', session_id: null, started_at: '2026-08-01T12:00:01.000Z',
  finished_at: '2026-08-01T12:00:02.000Z', candidate_run_ids: [RUN_A],
  formula_inputs: { input: 10, output: 5, cache_read: 2, cache_write: 3, total: null },
};
const hermesUsage = {
  id: 'usage-a-2', run_id: RUN_A, step_id: 'step-implement', round_id: 'round-2',
  harness: 'hermes', session_id: 'session-a', started_at: '2026-08-01T12:00:03.000Z',
  finished_at: '2026-08-01T12:00:04.000Z', candidate_run_ids: [RUN_A],
  formula_inputs: { input: 20, output: 7, cache_read: 1000, cache_write: 4, reasoning: 900 },
};

const CASES = [
  { name: 'o11-green-real', expected: 'PASS' },
  { name: 'o11-output-contract-green', expected: 'PASS' },
  { name: 'o11-invalid-completion', expected: 'FAIL', invalidCompletion: true, finding: 'O11_DONE_WITHOUT_EXPECTS_SUCCESS' },
  { name: 'o11-missing-producer-key', expected: 'FAIL', missingProducerKey: true, finding: 'O11_PRODUCER_ATTRIBUTION_MISSING' },
  { name: 'o11-retry-completion', expected: 'FAIL', retryCompletion: true, finding: 'O11_COMPLETED_FROM_RETRY_VERDICT' },
  { name: 'o11-generic-rejection', expected: 'FAIL', genericRejection: true, finding: 'O11_REJECTION_DIAGNOSTIC_GENERIC' },
  { name: 'o11-dispatch-missing-placeholder', expected: 'FAIL', missingPlaceholder: true, finding: 'O11_DISPATCH_PLACEHOLDER_UNRESOLVED' },
  { name: 'o11-green-scripted', expected: 'PASS', scripted: true },
  { name: 'o11-pi-formula', expected: 'FAIL', piDelta: 19, finding: 'O11_USAGE_FORMULA_MISMATCH' },
  { name: 'o11-hermes-formula', expected: 'FAIL', hermesDelta: 931, finding: 'O11_USAGE_FORMULA_MISMATCH' },
  { name: 'o11-ledger-mismatch', expected: 'FAIL', storedA: 52, finding: 'O11_RUN_LEDGER_MISMATCH' },
  { name: 'o11-completed-real-zero', expected: 'FAIL', zeroReal: true, finding: 'O11_COMPLETED_REAL_ZERO_TOKENS' },
  { name: 'o11-usage-duplicate-charge', expected: 'FAIL', duplicateCharge: true, finding: 'O11_USAGE_CHARGE_COUNT' },
  { name: 'o11-hermes-ambiguous-session', expected: 'FAIL', ambiguous: true, finding: 'O11_HERMES_ATTRIBUTION_AMBIGUOUS' },
  { name: 'o11-usage-outside-owner-window', expected: 'FAIL', outsideWindow: true, finding: 'O11_USAGE_OUTSIDE_RUN_WINDOW' },
  { name: 'o11-calibration-cross-charge', expected: 'FAIL', crossCharge: true, finding: 'O11_CROSS_CHARGE', calibration: true },
  { name: 'o11-scripted-ledger-mismatch', expected: 'FAIL', scripted: true, scriptedExpected: 50, finding: 'O11_SYNTHETIC_LEDGER_MISMATCH' },
  { name: 'o11-loop-multiplicity-green', expected: 'PASS', loop: { doneStories: 3, loopTransitions: 4, verifyTransitions: 3 } },
  { name: 'o11-loop-multiplicity-short', expected: 'FAIL', loop: { doneStories: 3, loopTransitions: 2, verifyTransitions: 3 }, finding: 'O11_DONE_WITHOUT_EXPECTS_SUCCESS' },
  { name: 'o11-nonloop-done-duplicate', expected: 'FAIL', nonLoopDuplicate: true, finding: 'O11_DONE_WITHOUT_EXPECTS_SUCCESS' },
  { name: 'o11-campaign7-w317a-loop-retry', expected: 'PASS', campaign7: { variant: 'w317a' } },
  { name: 'o11-campaign7-w317b-loop-retry-rejection', expected: 'PASS', campaign7: { variant: 'w317b' } },
  { name: 'o11-campaign7-w319-loop-retry-rejection', expected: 'PASS', campaign7: { variant: 'w319' } },
  { name: 'o11-campaign7-nonloop-retry-seal', expected: 'FAIL', campaign7: { variant: 'nonloop' }, finding: 'O11_COMPLETED_FROM_RETRY_VERDICT' },
];

function bare(runId) { return runId.slice(4); }
function attempt(runId, executionMode, startedAt, tokens, parentRunId, status = 'completed') {
  const result = {
    id: `attempt-${bare(runId)[0]}`, kind: 'workflow', phase: 'terminal', execution_mode: executionMode,
    run_id: runId, started_at: startedAt, terminal_at: FINISH, terminal_status: status,
    tokens_observed: tokens, command_result: { exit_code: status === 'completed' ? 0 : 1, signal: null }, steps_snapshot: null,
    straggler_capture: null,
  };
  return parentRunId === undefined ? result : { ...result, parent_run_id: parentRunId };
}
function reference(campaign, file, source) {
  return { path: path.relative(campaign, file).split(path.sep).join('/'), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), captured_at: CAPTURED, source };
}
function writeSnapshot(campaign, snapshots, name, value) {
  const file = path.join(snapshots, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  return reference(campaign, file, 'self-test-fixture');
}
function tokenEvent(runId, stepId, roundId, usageId, delta, total, ts) {
  return { archive: 'all.jsonl', line: 1, event: { ts, event: 'run.tokens.updated', runId, stepId, roundId, usageId, tokenDelta: delta, tokensSpent: total } };
}

function outputContractEvidence(fixture) {
  const producerAccepted = {
    id: 'validation-producer-1', observed_at: '2026-08-01T12:00:05.000Z',
    run_id: RUN_A, step_row_id: 'row-producer', step_id: 'producer', claim_id: 'claim-producer-1',
    attempt_number: 1, outcome: 'accepted', verdict: 'done', expects_required: true,
    required_keys: ['STATUS', 'ARTIFACT'], missing_keys: [], invalid_keys: [], key_sources: [],
    diagnostic_code: 'EXPECTS_SATISFIED', transition: { action: 'done', target_step_row_id: 'row-producer' },
  };
  const rejected = [1, 2].map((attemptNumber) => ({
    id: `validation-consumer-${attemptNumber}`, observed_at: `2026-08-01T12:00:0${5 + attemptNumber}.000Z`,
    run_id: RUN_A, step_row_id: 'row-consumer', step_id: 'consumer', claim_id: 'claim-consumer-1',
    attempt_number: attemptNumber, outcome: 'rejected', verdict: null, expects_required: true,
    required_keys: ['STATUS', 'CHANGES', 'TESTS'], missing_keys: [attemptNumber === 1 ? 'CHANGES' : 'TESTS'], invalid_keys: [],
    key_sources: [{ key: attemptNumber === 1 ? 'CHANGES' : 'TESTS', producer_step_row_id: 'row-producer' }],
    diagnostic_code: attemptNumber === 1 ? 'EXPECTS_MISSING_CHANGES' : 'EXPECTS_MISSING_TESTS',
    transition: { action: 'reroute', target_step_row_id: 'row-producer' },
  }));
  const consumerAccepted = {
    id: 'validation-consumer-3', observed_at: '2026-08-01T12:00:08.000Z',
    run_id: RUN_A, step_row_id: 'row-consumer', step_id: 'consumer', claim_id: 'claim-consumer-1',
    attempt_number: 3, outcome: 'accepted', verdict: fixture.retryCompletion ? 'retry' : 'done', expects_required: true,
    required_keys: ['STATUS', 'CHANGES', 'TESTS'], missing_keys: [], invalid_keys: [], key_sources: [],
    diagnostic_code: 'EXPECTS_SATISFIED', transition: {
      action: fixture.retryCompletion ? 'retry' : 'done', target_step_row_id: 'row-consumer',
    },
  };
  if (fixture.missingProducerKey) {
    rejected[0].key_sources = [{ key: 'CHANGES', producer_step_row_id: null }];
    rejected[0].transition = { action: 'retry', target_step_row_id: 'row-consumer' };
  }
  const validations = [producerAccepted, ...rejected, consumerAccepted]
    .filter((row) => !(fixture.invalidCompletion && row.id === 'validation-consumer-3'));
  if (fixture.nonLoopDuplicate) {
    validations.push({
      id: 'validation-producer-2', observed_at: '2026-08-01T12:00:09.000Z',
      run_id: RUN_A, step_row_id: 'row-producer', step_id: 'producer', claim_id: 'claim-producer-2',
      attempt_number: 1, outcome: 'accepted', verdict: 'done', expects_required: true,
      required_keys: ['STATUS', 'ARTIFACT'], missing_keys: [], invalid_keys: [], key_sources: [],
      diagnostic_code: 'EXPECTS_SATISFIED', transition: { action: 'done', target_step_row_id: 'row-producer' },
    });
  }
  const rejections = rejected.map((row) => ({
    id: `rejection-${row.attempt_number}`, observed_at: row.observed_at, run_id: row.run_id,
    step_row_id: row.step_row_id, step_id: row.step_id, claim_id: row.claim_id,
    attempt_number: row.attempt_number, validation_code: 'EXPECTS_REJECTED',
    missing_keys: row.missing_keys, invalid_keys: row.invalid_keys,
    diagnostic_code: fixture.genericRejection && row.attempt_number === 2 ? 'VALIDATION_FAILED' : row.diagnostic_code,
  }));
  const renderings = [
    { id: 'render-producer-1', observed_at: '2026-08-01T12:00:04.000Z', run_id: RUN_A, step_row_id: 'row-producer', step_id: 'producer', claim_id: 'claim-producer-1', required_keys: [], unresolved_placeholder_count: 0, unresolved_keys: [] },
    {
      id: 'render-consumer-1', observed_at: '2026-08-01T12:00:05.500Z', run_id: RUN_A,
      step_row_id: 'row-consumer', step_id: 'consumer', claim_id: 'claim-consumer-1', required_keys: ['ARTIFACT'],
      unresolved_placeholder_count: fixture.missingPlaceholder || fixture.missingProducerKey ? 1 : 0,
      unresolved_keys: fixture.missingPlaceholder || fixture.missingProducerKey ? ['ARTIFACT'] : [],
      dispatched: !fixture.missingProducerKey,
      producer_step_row_id: fixture.missingProducerKey ? null : 'row-producer',
      transition: fixture.missingProducerKey ? { action: 'retry', target_step_row_id: 'row-consumer' } : null,
    },
  ];
  return { validations, rejections, renderings };
}

// Loop-step evidence: one accepted done transition per story iteration for the
// loop step and one per story verification for its verify_each decision step.
function loopContractEvidence(fixture) {
  const validations = [];
  const emitTransitions = (stepRowId, stepId, count, name, secondOffset) => {
    for (let index = 1; index <= count; index += 1) {
      validations.push({
        id: `validation-${name}-${index}`, observed_at: new Date(Date.UTC(2026, 7, 1, 12, 0, secondOffset + index)).toISOString(),
        run_id: RUN_A, step_row_id: stepRowId, step_id: stepId, claim_id: `claim-${name}-${index}`,
        attempt_number: 1, outcome: 'accepted', verdict: 'done', expects_required: true,
        required_keys: ['STATUS', 'CHANGES', 'TESTS'], missing_keys: [], invalid_keys: [], key_sources: [],
        diagnostic_code: 'EXPECTS_SATISFIED', transition: { action: 'done', target_step_row_id: stepRowId },
      });
    }
  };
  emitTransitions('row-loop', 'implement', fixture.loop.loopTransitions, 'loop', 10);
  emitTransitions('row-verify', 'verify', fixture.loop.verifyTransitions, 'verify', 30);
  return { validations, rejections: [], renderings: [] };
}

// Campaign #7-shaped evidence (W3.17a/b marathon-natural/chaos, W3.19
// pause-drain): anonymized replicas of the real expects-validations.json and
// submit-rejections.json row shapes kept under campaign-20260813T123604986Z
// snapshots. implement is a story loop whose verify_each decision step
// verdicts STATUS: retry for a story-reset re-dispatch — the accepted retry
// verdict carries transition.action 'done' targeting the decision step itself,
// which is exactly the by-design shape this oracle leg must exempt.
function campaign7ContractEvidence(fixture) {
  const variant = fixture.campaign7.variant;
  const loopTransitions = variant === 'w319' ? 3 : 4; // W3.19: 3 implement done; W3.17a/b: 4
  const retryAttempt = variant === 'w319' ? 1 : 2; // W3.19 verdicts retry at attempt 1; W3.17a/b at 2
  const validations = [];
  const rejections = [];
  let second = 1;
  const emit = (id, stepRowId, stepId, claimId, attemptNumber, outcome, verdict, missingKeys, diagnostic, action) => {
    second += 1;
    const observedAt = new Date(Date.UTC(2026, 7, 1, 12, 0, second)).toISOString();
    validations.push({
      id, observed_at: observedAt, run_id: RUN_A, step_row_id: stepRowId, step_id: stepId, claim_id: claimId,
      attempt_number: attemptNumber, outcome, verdict, expects_required: true,
      required_keys: outcome === 'rejected' ? ['STATUS'] : [], missing_keys: missingKeys, invalid_keys: [],
      key_sources: outcome === 'rejected' ? [{ key: 'STATUS', producer_step_row_id: null }] : [],
      diagnostic_code: diagnostic, transition: { action, target_step_row_id: stepRowId },
    });
    if (outcome === 'rejected') {
      rejections.push({
        id: `rejection-${claimId}-${attemptNumber}`, observed_at: observedAt, run_id: RUN_A, step_row_id: stepRowId,
        step_id: stepId, claim_id: claimId, attempt_number: attemptNumber, validation_code: 'EXPECTS_REJECTED',
        missing_keys: missingKeys, invalid_keys: [], diagnostic_code: diagnostic,
      });
    }
  };
  const done = (id, stepRowId, stepId, claimId, attemptNumber) => {
    emit(`validation-${id}`, stepRowId, stepId, claimId, attemptNumber, 'accepted', 'done', [], 'EXPECTS_SATISFIED', 'done');
  };
  done('plan-1', 'row-plan', 'plan', 'claim-plan', 1);
  done('setup-1', 'row-setup', 'setup', 'claim-setup', 1);
  for (let attempt = 1; attempt <= loopTransitions; attempt += 1) {
    done(`implement-${attempt}`, 'row-implement', 'implement', 'claim-implement', attempt);
  }
  for (let attempt = 1; attempt <= loopTransitions; attempt += 1) {
    if (attempt === retryAttempt) {
      emit(`validation-verify-${attempt}`, 'row-verify', 'verify', 'claim-verify', attempt, 'accepted', 'retry', [], 'EXPECTS_SATISFIED', 'done');
    } else {
      done(`verify-${attempt}`, 'row-verify', 'verify', 'claim-verify', attempt);
    }
  }
  if (variant === 'w317b' || variant === 'w319') {
    emit('validation-test-1', 'row-test', 'test', 'claim-test', 1, 'rejected', null, ['STATUS'], 'EXPECTS_MISSING_STATUS', 'retry');
    done('test-2', 'row-test', 'test', 'claim-test', 2);
  } else {
    done('test-1', 'row-test', 'test', 'claim-test', 1);
  }
  done('merge-1', 'row-merge', 'finalize_merge', 'claim-merge', 1);
  return { validations, rejections, renderings: [] };
}

for (const fixture of CASES) {
  const campaign = path.join(workspace, fixture.name);
  const snapshots = path.join(campaign, 'snapshots');
  const evidence = path.join(campaign, 'evidence');
  fs.mkdirSync(snapshots, { recursive: true, mode: 0o700 });
  fs.mkdirSync(evidence, { mode: 0o700 });
  fs.writeFileSync(path.join(campaign, 'state.json'), '{}\n', { flag: 'wx' });

  const executionMode = fixture.scripted ? 'scripted' : 'real';
  const usages = fixture.zeroReal ? [] : [{ ...piUsage }, { ...hermesUsage }];
  if (fixture.outsideWindow) usages[0] = {
    ...usages[0],
    started_at: '2026-08-01T11:59:58.000Z',
    finished_at: '2026-08-01T11:59:59.000Z',
  };
  if (fixture.ambiguous) {
    usages[1] = { ...usages[1], run_id: null, step_id: null, round_id: null, candidate_run_ids: [RUN_A, RUN_B] };
  }
  const piDelta = fixture.piDelta ?? 20;
  const hermesDelta = fixture.hermesDelta ?? 31;
  const events = fixture.zeroReal ? [] : [
    tokenEvent(fixture.crossCharge ? RUN_B : RUN_A, 'step-plan', 'round-1', 'usage-a-1', piDelta, piDelta, '2026-08-01T12:00:02.100Z'),
    tokenEvent(RUN_A, 'step-implement', 'round-2', 'usage-a-2', hermesDelta, piDelta + hermesDelta, '2026-08-01T12:00:04.100Z'),
  ];
  if (fixture.duplicateCharge) events.push(tokenEvent(RUN_A, 'step-plan', 'round-1', 'usage-a-1', piDelta, piDelta * 2 + hermesDelta, '2026-08-01T12:00:02.200Z'));
  events.forEach((row, index) => { row.line = index + 1; });

  const sumA = events.filter((row) => row.event.runId === RUN_A).reduce((sum, row) => sum + row.event.tokenDelta, 0);
  const sumB = events.filter((row) => row.event.runId === RUN_B).reduce((sum, row) => sum + row.event.tokenDelta, 0);
  const storedA = fixture.storedA ?? sumA;
  const outputContract = fixture.campaign7 ? campaign7ContractEvidence(fixture) : (fixture.loop ? loopContractEvidence(fixture) : outputContractEvidence(fixture));
  const databasePath = path.join(snapshots, 'database.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, tokens_spent INTEGER NOT NULL);
    CREATE TABLE steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL, status TEXT NOT NULL, expects TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'single', loop_config TEXT);
    CREATE TABLE stories (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE tamandua_stats (id INTEGER PRIMARY KEY, system_tokens_spent INTEGER NOT NULL);`);
  const insertStep = database.prepare('INSERT INTO steps (id, run_id, step_id, status, expects, type, loop_config) VALUES (?, ?, ?, ?, ?, ?, ?)');
  database.prepare('INSERT INTO runs VALUES (?, ?, ?)').run(bare(RUN_A), 'completed', storedA);
  database.prepare('INSERT INTO runs VALUES (?, ?, ?)').run(bare(RUN_B), 'failed', sumB);
  if (fixture.loop) {
    insertStep.run('row-loop', bare(RUN_A), 'implement', 'done', 'STATUS: done\nCHANGES:\nTESTS:', 'loop', JSON.stringify({ over: 'stories', verify_each: true, verify_step: 'verify' }));
    insertStep.run('row-verify', bare(RUN_A), 'verify', 'done', 'STATUS: done\nVERIFIED:', 'single', null);
    const insertStory = database.prepare('INSERT INTO stories (id, run_id, status) VALUES (?, ?, ?)');
    for (let story = 1; story <= fixture.loop.doneStories; story += 1) insertStory.run(`story-${story}`, bare(RUN_A), 'done');
  } else if (fixture.campaign7) {
    // Campaign #7 replicas: the identical step/validation/rejection evidence
    // as W3.17a/b and W3.19 — only the implement step type differs between
    // the loop variants and the nonloop seal fixture (which must keep the
    // strict retry seal and FAIL).
    const isLoop = fixture.campaign7.variant !== 'nonloop';
    insertStep.run('row-plan', bare(RUN_A), 'plan', 'done', 'STATUS: done\nPLAN:', 'single', null);
    insertStep.run('row-setup', bare(RUN_A), 'setup', 'done', 'STATUS: done\nREADY:', 'single', null);
    insertStep.run('row-implement', bare(RUN_A), 'implement', 'done', 'STATUS: done\nCHANGES:\nTESTS:', isLoop ? 'loop' : 'single',
      isLoop ? JSON.stringify({ over: 'stories', completion: 'all_done', fresh_session: true, verify_each: true, verify_step: 'verify' }) : null);
    insertStep.run('row-verify', bare(RUN_A), 'verify', 'done', 'STATUS: done\nVERIFIED:', 'single', null);
    insertStep.run('row-test', bare(RUN_A), 'test', 'done', 'STATUS: done\nTESTED:', 'single', null);
    insertStep.run('row-merge', bare(RUN_A), 'finalize_merge', 'done', 'STATUS: done\nMERGED:', 'single', null);
    const insertStory = database.prepare('INSERT INTO stories (id, run_id, status) VALUES (?, ?, ?)');
    const doneStories = fixture.campaign7.variant === 'w319' ? 2 : 3;
    for (let story = 1; story <= doneStories; story += 1) insertStory.run(`story-${story}`, bare(RUN_A), 'done');
  } else {
    insertStep.run('row-producer', bare(RUN_A), 'producer', 'done', 'STATUS: done\nARTIFACT:', 'single', null);
    insertStep.run('row-consumer', bare(RUN_A), 'consumer', 'done', 'STATUS: done\nCHANGES:\nTESTS:', 'single', null);
  }
  insertStep.run('row-failed', bare(RUN_B), 'consumer', 'failed', 'STATUS: done', 'single', null);
  database.prepare('INSERT INTO tamandua_stats VALUES (1, 0)').run();
  database.close();
  fs.chmodSync(databasePath, 0o400);

  const syntheticLedger = fixture.scripted ? [
    { run_id: RUN_A, expected_tokens: fixture.scriptedExpected ?? storedA },
    { run_id: RUN_B, expected_tokens: sumB },
  ] : [];
  const references = Object.fromEntries(REFERENCE_KEYS.map((key) => [key, null]));
  references.database_snapshot = reference(campaign, databasePath, 'sqlite-self-test');
  references.run_events = writeSnapshot(campaign, snapshots, 'run-events.json', { schema_version: 1, captured_at: CAPTURED, run_ids: [RUN_A, RUN_B], rows: events });
  references.token_deltas = writeSnapshot(campaign, snapshots, 'token-deltas.json', { schema_version: 1, captured_at: CAPTURED, rows: events });
  references.round_usage = writeSnapshot(campaign, snapshots, 'round-usage.json', { schema_version: 1, captured_at: CAPTURED, rows: usages, synthetic_ledger: syntheticLedger });
  for (const key of ['system_tokens_before', 'system_tokens_after']) references[key] = writeSnapshot(campaign, snapshots, `${key.replaceAll('_', '-')}.json`, { schema_version: 1, captured_at: CAPTURED, table_present: true, rows: [{ system_tokens_spent: 0 }], value: 0 });
  references.submit_rejections = writeSnapshot(campaign, snapshots, 'submit-rejections.json', { schema_version: 1, captured_at: CAPTURED, rows: outputContract.rejections });
  references.expects_validations = writeSnapshot(campaign, snapshots, 'expects-validations.json', { schema_version: 1, captured_at: CAPTURED, rows: outputContract.validations });
  references.dispatch_renderings = writeSnapshot(campaign, snapshots, 'dispatch-renderings.json', { schema_version: 1, captured_at: CAPTURED, rows: outputContract.renderings });

  const context = {
    contract_version: 1, oracle_id: 'O11',
    campaign: { id: `campaign-${fixture.name}`, created_at: START_A, manifest: { sha256: '1'.repeat(64), case_count: 1, case_ids: [fixture.name] } },
    case: { id: fixture.name, wave: 4, workflow: 'feature-dev-merge-worktree', fixture: 'synthetic', harness: fixture.scripted ? 'scripted-hermes' : 'hermes', class: 'verification', caps: { tokens: 10000, wall_min: 10 }, boundary_files: [], forbidden: [], chaos: fixture.scripted ? { synthetic_token_ledger: syntheticLedger } : fixture.calibration ? { calibration: 'cross-charge' } : null },
    run_id: RUN_A,
    attempts: [attempt(RUN_A, executionMode, START_A, storedA)],
    discovered_runs: [attempt(RUN_B, executionMode, START_B, sumB, RUN_A, 'failed')],
    o1_wave: { schema_version: 1, wave: 4, duration_floors: [], runs: [] },
    mechanical_evidence: { schema_version: 1, references },
  };
  const contextPath = path.join(evidence, 'context.json');
  fs.writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  fs.writeFileSync(path.join(campaign, 'expectation.json'), `${JSON.stringify({ ...fixture, context: contextPath })}\n`, { flag: 'wx' });
}
