#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateOracleResponse } from '../lib/output.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const RUNNER = path.join(HERE, 'run.sh');
const HARNESS = path.join(HERE, 'harness.mjs');

function run() {
  return spawnSync('bash', [RUNNER], {
    cwd: TT_ROOT,
    encoding: 'utf8',
    shell: false,
    timeout: 300_000,
    env: { ...process.env, TT_SELF_TEST_KEEP_WORKSPACE: '0' },
  });
}

test('self-test harness accepts expected PASS/FAIL and detects both mismatch directions', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const sentinel = path.join(VAR_ROOT, `self-test-sentinel-${process.pid}`);
  fs.writeFileSync(sentinel, 'do not clean\n');
  const before = new Set(fs.readdirSync(VAR_ROOT));
  try {
    const result = run();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /expected PASS.*accepted/i);
    assert.match(result.stdout, /expected FAIL.*accepted/i);
    assert.match(result.stdout, /expected NOT_EVALUABLE.*accepted/i);
    assert.match(result.stdout, /expected PASS accepted for oracle-pass-informational/);
    assert.match(result.stdout, /false positive.*rejected/i);
    assert.match(result.stdout, /missed violation.*rejected/i);
    assert.match(result.stdout, /PASS with a failing finding rejected/);
    assert.match(result.stdout, /informational non-failing findings on PASS PASS/);
    assert.match(result.stdout, /self-test round 1 PASS \([0-9]+ms\)/);
    assert.match(result.stdout, /self-test round 2 PASS \([0-9]+ms\)/);
    assert.equal((result.stdout.match(/calibration o2-phantom-merge caught O2_PHANTOM_MERGE/g) ?? []).length, 2);
    assert.equal((result.stdout.match(/calibration o9-stale-replay caught O9_REPLAY_STALE/g) ?? []).length, 2);
    assert.equal((result.stdout.match(/calibration o11-cross-charge caught O11_CROSS_CHARGE/g) ?? []).length, 2);
    const timings = [...result.stdout.matchAll(/accepted for (O1|O2|O3z|O8|O9|O10|O11) \(([0-9]+)ms\)/g)];
    assert.ok(timings.length > 0, 'standalone oracle timings were not reported');
    assert.ok(timings.every(([, , elapsed]) => Number(elapsed) < 10_000), `oracle exceeded 10 seconds: ${JSON.stringify(timings)}`);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'do not clean\n');
    const leaked = fs.readdirSync(VAR_ROOT).filter((entry) => !before.has(entry) && entry.startsWith('oracle-self-test.'));
    assert.deepEqual(leaked, []);
  } finally {
    fs.rmSync(sentinel, { force: true });
  }
});

function spawnHarness(oraclePath, contextPath, expected) {
  return spawnSync(process.execPath, [HARNESS, '--oracle', oraclePath, '--context', contextPath, '--expected', expected], {
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
  });
}

test('harness accepts --expected NOT_EVALUABLE, rejects mismatched expectations, and pins exit code 3', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tamandua-harness-not-evaluable.'));
  try {
    const evidenceDir = path.join(workspace, 'evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const contextPath = path.join(evidenceDir, 'context.json');
    fs.writeFileSync(contextPath, `${JSON.stringify({
      contract_version: 1,
      oracle_id: 'O1',
      campaign: { id: 'campaign-direct' },
      case: { id: 'CASE-DIRECT' },
      run_id: null,
    })}\n`);
    const startedAt = '2026-08-14T00:00:00.000Z';
    const makeOracle = (name, exitCode) => {
      const oraclePath = path.join(workspace, name);
      fs.writeFileSync(oraclePath, `#!/usr/bin/env node\nconst out = ${JSON.stringify({
        contract_version: 1, oracle_id: 'O1', result: 'NOT_EVALUABLE',
        started_at: startedAt, finished_at: startedAt, findings: [], evidence: [],
      })};\nprocess.stdout.write(JSON.stringify(out) + '\\n');\nprocess.exit(${exitCode});\n`, { mode: 0o700 });
      return oraclePath;
    };

    const oraclePath = makeOracle('oracle-not-evaluable', 3);
    const accepted = spawnHarness(oraclePath, contextPath, 'NOT_EVALUABLE');
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
    assert.match(accepted.stdout, /expected NOT_EVALUABLE accepted/);

    for (const wrong of ['PASS', 'FAIL']) {
      const rejected = spawnHarness(oraclePath, contextPath, wrong);
      assert.notEqual(rejected.status, 0, `${rejected.stdout}\n${rejected.stderr}`);
      assert.match(rejected.stderr, /expected .*, observed NOT_EVALUABLE/);
    }

    const wrongExit = makeOracle('oracle-not-evaluable-wrong-exit', 0);
    const rejected = spawnHarness(wrongExit, contextPath, 'NOT_EVALUABLE');
    assert.notEqual(rejected.status, 0, `${rejected.stdout}\n${rejected.stderr}`);
    assert.match(rejected.stderr, /exit code 0 contradicts result NOT_EVALUABLE \(expected 3\)/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('output contract: PASS may carry findings only when every finding is non_failing (informational)', () => {
  // US-001 (adopted S19 policy): the relaxed PASS rule and the unchanged
  // NOT_EVALUABLE/FAIL rules, exercised directly on validateOracleResponse.
  const now = '2026-08-14T00:00:00.000Z';
  const base = { contract_version: 1, oracle_id: 'O1', result: 'PASS', started_at: now, finished_at: now, findings: [], evidence: [] };
  const informational = { id: 'O8_SEEDED_TEST_EXTENDED', summary: 'informational additive extension', non_failing: true, diff: { lines_added: 3, lines_deleted: 0 } };
  const unmarked = { id: 'O8_SEEDED_TEST_CHANGED', summary: 'failing seeded-test change' };

  // PASS with every finding non_failing: true is accepted.
  assert.deepEqual(validateOracleResponse({ ...base, findings: [informational] }, 'O1', 0, '/tmp'), []);
  assert.deepEqual(validateOracleResponse({ ...base, findings: [informational, { ...informational, id: 'SECOND_INFO' }] }, 'O1', 0, '/tmp'), []);

  // PASS with any failing (unmarked) finding is rejected.
  const unmarkedErrors = validateOracleResponse({ ...base, findings: [informational, unmarked] }, 'O1', 0, '/tmp');
  assert.match(unmarkedErrors.join('\n'), /PASS must not contain failing findings/i);
  assert.match(validateOracleResponse({ ...base, findings: [unmarked] }, 'O1', 0, '/tmp').join('\n'), /PASS must not contain failing findings/i);
  // non_failing must be the strict boolean true — a truthy string does not qualify.
  assert.match(validateOracleResponse({ ...base, findings: [{ ...informational, non_failing: 'true' }] }, 'O1', 0, '/tmp').join('\n'), /PASS must not contain failing findings/i);
  assert.match(validateOracleResponse({ ...base, findings: [{ ...informational, non_failing: false }] }, 'O1', 0, '/tmp').join('\n'), /PASS must not contain failing findings/i);

  // NOT_EVALUABLE stays finding-free even for informational findings.
  const notEvaluable = { ...base, result: 'NOT_EVALUABLE' };
  assert.deepEqual(validateOracleResponse(notEvaluable, 'O1', 3, '/tmp'), []);
  assert.match(validateOracleResponse({ ...notEvaluable, findings: [informational] }, 'O1', 3, '/tmp').join('\n'), /NOT_EVALUABLE must not contain findings/i);

  // FAIL still requires at least one finding and may carry informational ones.
  const fail = { ...base, result: 'FAIL' };
  assert.match(validateOracleResponse(fail, 'O1', 1, '/tmp').join('\n'), /FAIL must contain a finding/i);
  assert.deepEqual(validateOracleResponse({ ...fail, findings: [informational, unmarked] }, 'O1', 1, '/tmp'), []);
});
