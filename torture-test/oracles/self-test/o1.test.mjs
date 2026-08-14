#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const ORACLE = path.resolve(HERE, '..', 'O1');
const GENERATOR = path.join(HERE, 'generate-o1-fixtures.mjs');

function invokeContext(contextPath) {
  const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  const env = {
    ...process.env,
    TT_ORACLE_CONTRACT_VERSION: '1',
    TT_ORACLE_ID: 'O1',
    TT_ORACLE_CONTEXT: contextPath,
    TT_ORACLE_EVIDENCE_DIR: path.dirname(contextPath),
    TT_CASE_ID: context.case.id,
    TT_CAMPAIGN_ID: context.campaign.id,
    TT_RUN_ID: context.run_id,
  };
  const result = spawnSync(ORACLE, ['--contract-version', '1', '--context', contextPath], {
    cwd: path.dirname(contextPath), env, encoding: 'utf8', shell: false, timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { response: JSON.parse(result.stdout.trim()), status: result.status };
}

function invokeFixture(workspace, name) {
  const expectation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'expectation.json'), 'utf8'));
  return { expectation, ...invokeContext(expectation.context) };
}

test('O1 accepts converged DB/event/workflow evidence and catches every targeted mutation', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(generated.status, 0, generated.stderr);
    const names = fs.readdirSync(workspace).filter((name) => name.startsWith('o1-')).sort();
    assert.equal(names.length, 24);
    for (const name of names) {
      const expectation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'expectation.json'), 'utf8'));
      if (expectation.multiCase) continue; // covered by the dedicated multi-case test
      const { response, status } = invokeContext(expectation.context);
      assert.equal(response.result, expectation.expected, `${name}: ${JSON.stringify(response)}`);
      assert.equal(status, expectation.expected === 'PASS' ? 0 : 1, name);
      if (expectation.finding) {
        assert.ok(response.findings.some((finding) => finding.id === expectation.finding), `${name} omitted ${expectation.finding}`);
      }
      assert.equal(response.evidence.length, 1, `${name} evidence`);
      const observation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'evidence', response.evidence[0].path), 'utf8'));
      assert.deepEqual(observation.runs.map((run) => run.run_id), [
        'run-11111111-1111-4111-8111-111111111111',
        'run-22222222-2222-4222-8222-222222222222',
      ]);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('O1 judges each wave case against its own per-case production floor without cross-case duplicates', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    assert.equal(spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false }).status, 0);
    const { expectation, response, status } = invokeFixture(workspace, 'o1-per-case-floors');
    assert.equal(status, 0);
    assert.equal(response.result, 'PASS');
    assert.equal(response.findings.some((finding) => finding.id.startsWith('O1_DURATION_FLOOR')), false, JSON.stringify(response.findings));
    const observation = JSON.parse(fs.readFileSync(path.join(workspace, expectation.name, 'evidence', response.evidence[0].path), 'utf8'));
    assert.equal(observation.duration_floor_observations.length, 1);
    const floors = new Map(observation.duration_floor_observations[0].case_floors.map((row) => [row.case_id, row]));
    assert.equal(floors.get('o1-per-case-floors').duration_floor_ms, 300000);
    assert.equal(floors.get('wave-peer-1').duration_floor_ms, 180000);
    assert.equal(floors.get('wave-peer-2').duration_floor_ms, 180000);
    assert.equal(observation.duration_floor_observations[0].fast_run_count, 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('O1 suppresses the duration-floor rate finding below four eligible family runs and keeps it at four', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    assert.equal(spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false }).status, 0);
    const tiny = invokeFixture(workspace, 'o1-fast-wave-tiny-sample');
    assert.equal(tiny.status, 0);
    assert.equal(tiny.response.result, 'PASS');
    assert.equal(tiny.response.findings.some((finding) => finding.id === 'O1_DURATION_FLOOR_RATE'), false, JSON.stringify(tiny.response.findings));
    const tinyObservation = JSON.parse(fs.readFileSync(path.join(workspace, 'o1-fast-wave-tiny-sample', 'evidence', tiny.response.evidence[0].path), 'utf8'));
    assert.equal(tinyObservation.duration_floor_observations.length, 1);
    assert.equal(tinyObservation.duration_floor_observations[0].run_count, 3);
    assert.equal(tinyObservation.duration_floor_observations[0].fast_run_count, 3);
    assert.equal(tinyObservation.duration_floor_observations[0].fast_rate, 1);

    const n4 = invokeFixture(workspace, 'o1-fast-wave-n4');
    assert.equal(n4.status, 1);
    assert.equal(n4.response.result, 'FAIL');
    const rate = n4.response.findings.find((finding) => finding.id === 'O1_DURATION_FLOOR_RATE');
    assert.ok(rate, JSON.stringify(n4.response.findings));
    assert.equal(rate.run_count, 4);
    assert.equal(rate.fast_run_count, 4);
    assert.equal(rate.fast_rate, 1);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('O1 reports wave-family floor findings once via the manifest-order reporter and scopes run-citing findings to their owner', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    assert.equal(spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false }).status, 0);
    const campaign = path.join(workspace, 'o1-wave-family-reporter');
    const expectation = JSON.parse(fs.readFileSync(path.join(campaign, 'expectation.json'), 'utf8'));
    const reporter = invokeContext(expectation.contexts.reporter);
    const peer = invokeContext(expectation.contexts.peer);

    // The reporter (first case_id in campaign.manifest.case_ids, deliberately
    // alphabetically LAST) carries the family finding and the duplicate wave
    // row finding for its own run.
    assert.equal(reporter.status, 1);
    assert.equal(reporter.response.result, 'FAIL');
    const rate = reporter.response.findings.find((finding) => finding.id === 'O1_DURATION_FLOOR_RATE');
    assert.ok(rate, JSON.stringify(reporter.response.findings));
    assert.equal(rate.run_count, 5);
    assert.equal(rate.fast_run_count, 2);
    assert.equal(rate.fast_rate, 0.4);
    assert.ok(reporter.response.findings.some((finding) => finding.id === 'O1_WAVE_RUN_DUPLICATE'), JSON.stringify(reporter.response.findings));

    // The peer is not the reporter and does not own the duplicated run, so its
    // result is clean: no family finding, no sibling run-citing finding.
    assert.equal(peer.status, 0);
    assert.equal(peer.response.result, 'PASS');
    assert.equal(peer.response.findings.some((finding) => finding.id.startsWith('O1_DURATION_FLOOR')), false, JSON.stringify(peer.response.findings));
    assert.equal(peer.response.findings.some((finding) => finding.id === 'O1_WAVE_RUN_DUPLICATE'), false, JSON.stringify(peer.response.findings));

    // Duration floor observations stay in the evidence of BOTH cases — only
    // the findings list is deduplicated.
    for (const [label, outcome] of [['reporter', reporter], ['peer', peer]]) {
      const evidenceDir = path.dirname(label === 'reporter' ? expectation.contexts.reporter : expectation.contexts.peer);
      const observation = JSON.parse(fs.readFileSync(path.join(evidenceDir, outcome.response.evidence[0].path), 'utf8'));
      assert.equal(observation.duration_floor_observations.length, 1, label);
      assert.equal(observation.duration_floor_observations[0].run_count, 5, label);
      assert.equal(observation.duration_floor_observations[0].fast_run_count, 2, label);
      assert.equal(observation.duration_floor_observations[0].fast_rate, 0.4, label);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('O1 applies DISP and marks a predeclared mechanically active Hermes straggler inconclusive', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    assert.equal(spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false }).status, 0);
    const { response, status } = invokeFixture(workspace, 'o1-healthy-straggler');
    assert.equal(status, 0);
    assert.equal(response.result, 'PASS');
    assert.deepEqual(response.classification, { ambiguous: { category: 'HEALTHY_STRAGGLER' } });
    const events = JSON.parse(fs.readFileSync(path.join(workspace, 'o1-healthy-straggler', 'snapshots', 'run-events.json'), 'utf8'));
    const tokenEvent = events.rows.find((row) => row.event.event === 'run.tokens.updated').event;
    assert.deepEqual(Object.keys(tokenEvent).sort(), [
      'event', 'runId', 'tokenDelta', 'tokensSpent', 'ts', 'workflowId',
    ]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
