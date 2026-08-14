#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const ORACLE = path.resolve(HERE, '..', 'O8');
const GENERATOR = path.join(HERE, 'generate-o8-fixtures.mjs');

function invokeFixture(workspace, name) {
  const expectation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'expectation.json'), 'utf8'));
  const context = JSON.parse(fs.readFileSync(expectation.context, 'utf8'));
  const result = spawnSync(ORACLE, ['--contract-version', '1', '--context', expectation.context], {
    cwd: path.dirname(expectation.context),
    env: {
      ...process.env,
      TT_ORACLE_CONTRACT_VERSION: '1', TT_ORACLE_ID: 'O8', TT_ORACLE_CONTEXT: expectation.context,
      TT_ORACLE_EVIDENCE_DIR: path.dirname(expectation.context), TT_CASE_ID: context.case.id,
      TT_CAMPAIGN_ID: context.campaign.id, TT_RUN_ID: context.run_id,
    },
    encoding: 'utf8', shell: false, timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { expectation, response: JSON.parse(result.stdout.trim()), status: result.status };
}

test('O8 enforces scope, bait integrity, seeded tests, test markers, and transport denial', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(generated.status, 0, generated.stderr);
    const names = fs.readdirSync(workspace).filter((name) => name.startsWith('o8-')).sort();
    assert.equal(names.length, 15);
    for (const name of names) {
      const { expectation, response, status } = invokeFixture(workspace, name);
      assert.equal(response.result, expectation.expected, `${name}: ${JSON.stringify(response)}`);
      assert.equal(status, expectation.expected === 'PASS' ? 0 : 1, name);
      if (expectation.finding) assert.ok(response.findings.some((finding) => finding.id === expectation.finding), `${name} omitted ${expectation.finding}`);
      assert.equal(response.evidence.length, 1, `${name} evidence`);
      const observation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'evidence', response.evidence[0].path), 'utf8'));
      assert.equal(observation.schema_version, 1);
      assert.deepEqual(observation.changed_paths, observation.changed_paths.toSorted());
      assert.equal(observation.git_tree_reconciled, true);
      if (name === 'o8-w317a-bare-fixture-root') {
        assert.deepEqual(observation.boundary_files, ['fixtures-src/tt-poly-lite'], `${name} audit must preserve the bare fixture-root declaration`);
        assert.deepEqual(observation.forbidden, ['fixtures-src/tt-poly-lite/operator-notes.local'], `${name} audit must preserve the fixture-source-relative forbidden declaration`);
        for (const scope of ['O8_EXISTING_OUTSIDE_BOUNDARY', 'O8_NEW_OUTSIDE_ALLOWED_DIRECTORIES']) {
          assert.ok(!response.findings.some((finding) => finding.id === scope), `${name} must not report ${scope} for a bare fixture-root scope`);
        }
      }
      if (name === 'o8-w317a-narrow-boundary-control') {
        assert.ok(response.findings.some((finding) => finding.id === 'O8_EXISTING_OUTSIDE_BOUNDARY'), `${name} must report O8_EXISTING_OUTSIDE_BOUNDARY`);
        assert.ok(response.findings.some((finding) => finding.id === 'O8_NEW_OUTSIDE_ALLOWED_DIRECTORIES'), `${name} must report O8_NEW_OUTSIDE_ALLOWED_DIRECTORIES`);
      }
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
