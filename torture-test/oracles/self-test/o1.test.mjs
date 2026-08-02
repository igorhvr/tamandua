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

function invokeFixture(workspace, name) {
  const expectation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'expectation.json'), 'utf8'));
  const context = JSON.parse(fs.readFileSync(expectation.context, 'utf8'));
  const env = {
    ...process.env,
    TT_ORACLE_CONTRACT_VERSION: '1',
    TT_ORACLE_ID: 'O1',
    TT_ORACLE_CONTEXT: expectation.context,
    TT_ORACLE_EVIDENCE_DIR: path.dirname(expectation.context),
    TT_CASE_ID: context.case.id,
    TT_CAMPAIGN_ID: context.campaign.id,
    TT_RUN_ID: context.run_id,
  };
  const result = spawnSync(ORACLE, ['--contract-version', '1', '--context', expectation.context], {
    cwd: path.dirname(expectation.context), env, encoding: 'utf8', shell: false, timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  const response = JSON.parse(result.stdout.trim());
  return { expectation, response, status: result.status };
}

test('O1 accepts converged DB/event/workflow evidence and catches every targeted mutation', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(generated.status, 0, generated.stderr);
    const names = fs.readdirSync(workspace).filter((name) => name.startsWith('o1-')).sort();
    assert.equal(names.length, 20);
    for (const name of names) {
      const { expectation, response, status } = invokeFixture(workspace, name);
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
