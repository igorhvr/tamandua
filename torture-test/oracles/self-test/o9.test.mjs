#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const ORACLE = path.resolve(HERE, '..', 'O9');
const GENERATOR = path.join(HERE, 'generate-o9-fixtures.mjs');

function invokeFixture(workspace, name) {
  const expectation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'expectation.json'), 'utf8'));
  const context = JSON.parse(fs.readFileSync(expectation.context, 'utf8'));
  const result = spawnSync(ORACLE, ['--contract-version', '1', '--context', expectation.context], {
    cwd: path.dirname(expectation.context),
    env: {
      ...process.env,
      TT_ORACLE_CONTRACT_VERSION: '1', TT_ORACLE_ID: 'O9', TT_ORACLE_CONTEXT: expectation.context,
      TT_ORACLE_EVIDENCE_DIR: path.dirname(expectation.context), TT_CASE_ID: context.case.id,
      TT_CAMPAIGN_ID: context.campaign.id, TT_RUN_ID: context.run_id,
    },
    encoding: 'utf8', shell: false, timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { expectation, response: JSON.parse(result.stdout.trim()), status: result.status };
}

test('O9 enforces replay, single-flight recovery, special exits, and independent origins', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(generated.status, 0, generated.stderr);
    const names = fs.readdirSync(workspace).filter((name) => name.startsWith('o9-')).sort();
    assert.equal(names.length, 35);
    for (const name of names) {
      const { expectation, response, status } = invokeFixture(workspace, name);
      assert.equal(response.result, expectation.expected, `${name}: ${JSON.stringify(response)}`);
      assert.equal(status, { PASS: 0, FAIL: 1, NOT_EVALUABLE: 3 }[expectation.expected], name);
      if (expectation.finding) assert.ok(response.findings.some((finding) => finding.id === expectation.finding), `${name} omitted ${expectation.finding}`);
      assert.equal(response.evidence.length, 1, `${name} evidence`);
      const observation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'evidence', response.evidence[0].path), 'utf8'));
      assert.equal(observation.schema_version, 1);
      if (expectation.expected === 'NOT_EVALUABLE') {
        assert.equal(response.findings.length, 0, `${name} NOT_EVALUABLE findings`);
        assert.equal(observation.not_evaluable, true);
        assert.equal(typeof observation.reason, 'string');
        assert.ok(observation.reason.length > 0);
        continue;
      }
      assert.equal(observation.ledger_reconciled, true);
      assert.equal(observation.observation_count > 0, true);
      assert.equal(typeof observation.singleflight_observation_count, 'number');
      assert.equal(typeof observation.special_exit_observation_count, 'number');
      assert.equal(typeof observation.origin_identity_count, 'number');
      assert.equal(typeof observation.skipped_foreign_rows, 'number');
      assert.deepEqual(observation.skipped_foreign_row_ids, expectation.skippedRows ? [2] : []);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
