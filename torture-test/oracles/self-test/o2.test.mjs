#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const ORACLE = path.resolve(HERE, '..', 'O2');
const GENERATOR = path.join(HERE, 'generate-o2-fixtures.mjs');

function invokeFixture(workspace, name) {
  const expectation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'expectation.json'), 'utf8'));
  const context = JSON.parse(fs.readFileSync(expectation.context, 'utf8'));
  const started = Date.now();
  const result = spawnSync(ORACLE, ['--contract-version', '1', '--context', expectation.context], {
    cwd: path.dirname(expectation.context),
    env: {
      ...process.env,
      TT_ORACLE_CONTRACT_VERSION: '1',
      TT_ORACLE_ID: 'O2',
      TT_ORACLE_CONTEXT: expectation.context,
      TT_ORACLE_EVIDENCE_DIR: path.dirname(expectation.context),
      TT_CASE_ID: context.case.id,
      TT_CAMPAIGN_ID: context.campaign.id,
      TT_RUN_ID: context.run_id,
    },
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return {
    elapsed: Date.now() - started,
    expectation,
    response: JSON.parse(result.stdout.trim()),
    status: result.status,
  };
}

test('O2 proves unique ref movement, tested/commit tree identity, ancestry, and patch truth', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(generated.status, 0, generated.stderr);
    const names = fs.readdirSync(workspace).filter((name) => name.startsWith('o2-')).sort();
    assert.deepEqual(names, [
      'o2-alternates-rejected',
      'o2-commit-tree-mismatch',
      'o2-cross-run-duplicate',
      'o2-default-concession',
      'o2-default-concession-laundered-red',
      'o2-default-concession-no-reroute',
      'o2-duplicate-landing',
      'o2-empty-landing',
      'o2-green',
      'o2-green-cross-run-noop',
      'o2-green-noop-recovery',
      'o2-landed-canceled',
      'o2-landed-failed',
      'o2-noop-before-landing',
      'o2-off-mode',
      'o2-off-mode-no-override',
      'o2-off-mode-unbound',
      'o2-ordinary-missing-row',
      'o2-ordinary-wrong-key',
      'o2-patch-missing',
      'o2-phantom-merge',
      'o2-reflog-window-bypass',
      'o2-source-is-target',
      'o2-tested-tree-mismatch',
      'o2-unattributed-transition',
      'o2-unknown-landing-run',
    ]);
    for (const name of names) {
      const { elapsed, expectation, response, status } = invokeFixture(workspace, name);
      assert.ok(elapsed < 10_000, `${name} exceeded 10 seconds`);
      assert.equal(response.result, expectation.expected, `${name}: ${JSON.stringify(response)}`);
      assert.equal(status, { PASS: 0, FAIL: 1, ERROR: 2 }[expectation.expected], name);
      if (expectation.finding) {
        assert.ok(response.findings.some((finding) => finding.id === expectation.finding), `${name} omitted ${expectation.finding}`);
      }
      if (expectation.expected === 'ERROR') {
        assert.equal(response.evidence.length, 0, `${name} error evidence`);
        continue;
      }
      assert.equal(response.evidence.length, expectation.expected === 'FAIL' ? 2 : 1, `${name} evidence`);
      const observation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'evidence', response.evidence[0].path), 'utf8'));
      assert.equal(observation.schema_version, 1);
      assert.equal(observation.target_ref, 'refs/heads/main');
      assert.ok(Array.isArray(observation.landings));
      if (expectation.expected === 'FAIL') {
        const rawReflog = JSON.parse(fs.readFileSync(path.join(workspace, name, 'evidence', response.evidence[1].path), 'utf8'));
        assert.equal(rawReflog.schema_version, 1);
        assert.equal(rawReflog.target_ref, 'refs/heads/main');
        assert.ok(rawReflog.finding_ids.includes(expectation.finding));
        assert.ok(rawReflog.entries.every((entry) => typeof entry.raw === 'string'));
      }
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
