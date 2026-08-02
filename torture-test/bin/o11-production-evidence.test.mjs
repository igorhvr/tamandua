#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  projectDispatchRenderings,
  projectExpectsValidations,
  projectSubmitRejections,
} from './oracle-evidence-snapshot.mjs';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const VAR_ROOT = path.join(REPO_ROOT, 'torture-test', 'var');
const CLI = path.join(REPO_ROOT, 'bin', 'tamandua');

function invoke(args, env, stdin = '') {
  return spawnSync(CLI, args, {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    input: stdin,
    shell: false,
  });
}

function readEvents(stateDir) {
  const file = path.join(stateDir, 'events', 'all.jsonl');
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map((line, index) => ({
    archive: 'all.jsonl',
    line: index + 1,
    event: JSON.parse(line),
  }));
}

test('real claim and completion paths emit mechanically projectable O11 output-contract evidence', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(VAR_ROOT, 'o11-production-evidence.'));
  const home = path.join(root, 'home');
  const stateDir = path.join(root, 'state');
  const dbPath = path.join(stateDir, 'tamandua.db');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    TAMANDUA_STATE_DIR: stateDir,
    TAMANDUA_DB_PATH: dbPath,
    // This integration fixture is intentionally rooted under torture-test/var
    // rather than the system temp directory; all three state paths remain
    // explicit and isolated from production.
    TAMANDUA_TEST_GUARD: '0',
  };

  try {
    const setup = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { getDb } from './dist/db.js';
      const db = getDb();
      const now = new Date().toISOString();
      db.prepare("INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'o11-fixture', 'test', 'running', '{}', ?, ?)").run('o11-real-path', now, now);
      db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'produce', 'producer', 0, 'Reply with:\\nSTATUS: done\\nCHANGES: value\\nTESTS: value\\nARTIFACT: value', 'STATUS: done\\nCHANGES:\\nTESTS:', 'pending', ?, ?)").run('row-producer', 'o11-real-path', now, now);
      db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'consume', 'consumer', 1, 'Consume {{artifact}}', 'STATUS: done', 'waiting', ?, ?)").run('row-consumer', 'o11-real-path', now, now);
    `], { cwd: REPO_ROOT, env, encoding: 'utf8' });
    assert.equal(setup.status, 0, setup.stderr);

    const claim = invoke(['step', 'claim', 'producer', '--run-id', 'run-o11-real-path'], env);
    assert.equal(claim.status, 0, claim.stderr);
    assert.equal(JSON.parse(claim.stdout).stepId, 'step-row-producer');

    const first = invoke(['step', 'complete', 'row-producer'], env, 'STATUS: done\nTESTS: first');
    assert.equal(first.status, 1);
    assert.match(first.stderr, /^REJECTED:/m);
    const second = invoke(['step', 'complete', 'row-producer'], env, 'STATUS: done\nCHANGES: second');
    assert.equal(second.status, 1);
    assert.match(second.stderr, /^REJECTED:/m);
    const accepted = invoke(['step', 'complete', 'row-producer'], env, 'STATUS: done\nCHANGES: final\nTESTS: pass');
    assert.equal(accepted.status, 0, accepted.stderr);
    const blockedConsumer = invoke(['step', 'claim', 'consumer', '--run-id', 'run-o11-real-path'], env);
    assert.equal(blockedConsumer.status, 0, blockedConsumer.stderr);
    assert.equal(blockedConsumer.stdout.trim(), 'NO_WORK');

    const events = readEvents(stateDir);
    const rejections = projectSubmitRejections(events);
    const validations = projectExpectsValidations(events);
    const renderings = projectDispatchRenderings(events);

    assert.equal(rejections.length, 2);
    assert.deepEqual(rejections.map((row) => row.attempt_number), [1, 2]);
    assert.deepEqual(rejections.map((row) => row.missing_keys), [['CHANGES'], ['TESTS']]);
    assert.notEqual(rejections[0].diagnostic_code, rejections[1].diagnostic_code);
    assert.equal(validations.filter((row) => row.outcome === 'rejected').length, 2);
    assert.equal(validations.filter((row) => row.outcome === 'accepted' && row.verdict === 'done').length, 1);
    assert.equal(renderings.length, 2, events.map((row) => row.event.event).join(', '));
    assert.deepEqual(renderings[0].unresolved_keys, []);
    assert.equal(renderings[1].dispatched, false);
    assert.deepEqual(renderings[1].unresolved_keys, ['artifact']);
    assert.equal(renderings[1].producer_step_row_id, 'row-producer');
    assert.deepEqual(renderings[1].transition, { action: 'reroute', target_step_row_id: 'row-producer' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
