#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const RUNNER = path.join(HERE, 'run.sh');

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
    assert.match(result.stdout, /false positive.*rejected/i);
    assert.match(result.stdout, /missed violation.*rejected/i);
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
