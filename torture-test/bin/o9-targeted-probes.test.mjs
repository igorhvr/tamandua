#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runO9TargetedProbes } from './o9-targeted-probes.mjs';

const TT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const SHIM = path.resolve(TT_ROOT, '..', 'bin', 'tamandua-test');

function command(commandName, args, cwd) {
  const result = spawnSync(commandName, args, { cwd, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('controller-authored probes produce real exit-86/87/88 process evidence and untracked junk state', async () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(VAR_ROOT, 'o9-targeted-test.'));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(home, '.tamandua'), { recursive: true });
  command('git', ['init', '-b', 'main'], repo);
  command('git', ['config', 'user.name', 'O9 Probe Test'], repo);
  command('git', ['config', 'user.email', 'o9@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'baseline\n');
  command('git', ['add', 'tracked.txt'], repo);
  command('git', ['commit', '-m', 'fixture'], repo);

  const specialEvents = [];
  const records = [];
  let rowId = 0;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
      let payload = {};
      if (request.url.startsWith('/suite/lookup')) payload = { latest: null, passCount: 0, failCount: 0, flaky: false };
      else if (request.url.startsWith('/suite/duration-history')) payload = { durations: [] };
      else if (request.url === '/suite/claim') payload = { action: 'run' };
      else if (request.url === '/suite/release') payload = { released: true };
      else if (request.url === '/suite/record') {
        records.push(body);
        payload = { id: ++rowId, created_at: new Date().toISOString() };
      } else if (request.url === '/suite/event') {
        if (body.event === 'suite.special_exit_observed') specialEvents.push(body);
      } else {
        response.statusCode = 404;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(payload));
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const result = await runO9TargetedProbes({
      repo,
      runId: 'run-o9-targeted',
      stepPrefix: 'targeted',
      shim: SHIM,
      env: {
        ...process.env,
        HOME: home,
        TAMANDUA_STATE_DIR: path.join(home, '.tamandua'),
        TAMANDUA_CONTROL_PORT: String(address.port),
        TAMANDUA_TEST_GUARD: '0',
      },
    });
    assert.deepEqual(result.exits, [86, 87, 88]);
    assert.equal(result.junk_probe_tracked, false);
    assert.deepEqual(specialEvents.map((event) => event.shim_exit_code), [86, 87, 88]);
    assert.equal(records.length, 1);
    assert.equal(records[0].exit_code, 87);
    assert.equal(specialEvents[0].command_exit_code, 0);
    assert.notEqual(specialEvents[0].pre_tree_hash, specialEvents[0].post_tree_hash);
    assert.equal(specialEvents[1].interrupted, true);
    assert.equal(specialEvents[1].ledger_row_id, 1);
    assert.equal(specialEvents[2].tracked_dirty, true);
    assert.equal(specialEvents[2].command_exit_code, null);
    assert.ok(specialEvents.every((event) => event.junk_probe_tracked === false));
    assert.equal(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8'), 'baseline\n');
    assert.equal(command('git', ['status', '--porcelain', '--untracked-files=no'], repo), '');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
