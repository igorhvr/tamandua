#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const ORACLE = path.resolve(HERE, '..', 'O11');
const GENERATOR = path.join(HERE, 'generate-o11-fixtures.mjs');

function invokeFixture(workspace, name) {
  const expectation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'expectation.json'), 'utf8'));
  const context = JSON.parse(fs.readFileSync(expectation.context, 'utf8'));
  const result = spawnSync(ORACLE, ['--contract-version', '1', '--context', expectation.context], {
    cwd: path.dirname(expectation.context), env: {
      ...process.env, TT_ORACLE_CONTRACT_VERSION: '1', TT_ORACLE_ID: 'O11',
      TT_ORACLE_CONTEXT: expectation.context, TT_ORACLE_EVIDENCE_DIR: path.dirname(expectation.context),
      TT_CASE_ID: context.case.id, TT_CAMPAIGN_ID: context.campaign.id, TT_RUN_ID: context.run_id,
    }, encoding: 'utf8', shell: false, timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { expectation, response: JSON.parse(result.stdout.trim()), status: result.status };
}

test('O11 enforces output contracts, formula, exact ownership, ledger reconciliation, ambiguity, and synthetic ledgers', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(generated.status, 0, generated.stderr);
    const names = fs.readdirSync(workspace).filter((name) => name.startsWith('o11-')).sort();
    assert.equal(names.length, 17);
    for (const name of names) {
      const { expectation, response, status } = invokeFixture(workspace, name);
      assert.equal(response.result, expectation.expected, `${name}: ${JSON.stringify(response)}`);
      assert.equal(status, expectation.expected === 'PASS' ? 0 : 1, name);
      if (expectation.finding) assert.ok(response.findings.some((finding) => finding.id === expectation.finding), `${name} omitted ${expectation.finding}`);
      assert.equal(response.evidence.length, 1, `${name} evidence`);
      const observation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'evidence', response.evidence[0].path), 'utf8'));
      assert.equal(observation.schema_version, 1);
      assert.ok(Array.isArray(observation.runs));
      assert.ok(Array.isArray(observation.usages));
      assert.ok(Array.isArray(observation.output_contract.steps));
      assert.ok(Array.isArray(observation.output_contract.validations));
      assert.ok(Array.isArray(observation.output_contract.rejections));
      assert.ok(Array.isArray(observation.output_contract.renderings));
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
