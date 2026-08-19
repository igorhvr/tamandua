#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { getProcessStartIdentity } from '../../bin/tt-process-identity.mjs';
import { reapLivePgids, spawnDetachedGroupLeader } from './reap-live-pgids.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const ORACLE = path.resolve(HERE, '..', 'O4');
const GENERATOR = path.join(HERE, 'generate-o4-fixtures.mjs');

const EXIT_BY_RESULT = { PASS: 0, FAIL: 1, ERROR: 2, NOT_EVALUABLE: 3 };

function invokeFixture(workspace, name) {
  const expectation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'expectation.json'), 'utf8'));
  const context = JSON.parse(fs.readFileSync(expectation.context, 'utf8'));
  const result = spawnSync(ORACLE, ['--contract-version', '1', '--context', expectation.context], {
    cwd: path.dirname(expectation.context), env: {
      ...process.env, TT_ORACLE_CONTRACT_VERSION: '1', TT_ORACLE_ID: 'O4',
      TT_ORACLE_CONTEXT: expectation.context, TT_ORACLE_EVIDENCE_DIR: path.dirname(expectation.context),
      TT_CASE_ID: context.case.id, TT_CAMPAIGN_ID: context.campaign.id, TT_RUN_ID: context.run_id,
    }, encoding: 'utf8', shell: false, timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { expectation, response: JSON.parse(result.stdout.trim()), status: result.status };
}

function readObservation(workspace, name, response) {
  return JSON.parse(fs.readFileSync(path.join(workspace, name, 'evidence', response.evidence[0].path), 'utf8'));
}

test('O4 judges claim & dispatch hygiene: dead pgid, no-work dangling, retry/reroute/abandon budgets, watchdog false positives', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  const livePgidsPath = path.join(workspace, 'live-pgids.json');
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(generated.status, 0, generated.stderr);
    const names = fs.readdirSync(workspace).filter((name) => name.startsWith('o4-')).sort();
    assert.equal(names.length, 11);
    let cleanResponse = null;
    for (const name of names) {
      const { expectation, response, status } = invokeFixture(workspace, name);
      assert.equal(response.result, expectation.expected, `${name}: ${JSON.stringify(response)}`);
      assert.equal(status, EXIT_BY_RESULT[expectation.expected], name);
      if (expectation.finding) {
        assert.ok(response.findings.some((finding) => finding.id === expectation.finding), `${name} omitted ${expectation.finding}: ${JSON.stringify(response.findings)}`);
      }
      assert.equal(response.evidence.length, 1, `${name} evidence`);
      const observation = readObservation(workspace, name, response);
      assert.equal(observation.schema_version, 1);
      assert.ok(Array.isArray(observation.dimensions.dead_claim_pgid), `${name} must carry dead_claim_pgid observations`);
      assert.ok(Array.isArray(observation.dimensions.watchdog.observations), `${name} must carry watchdog observations`);
      assert.ok(Array.isArray(observation.finding_ids), `${name} observation must carry finding_ids`);
      if (expectation.expected === 'FAIL') {
        assert.ok(observation.finding_ids.includes(expectation.finding), `${name} observation omitted ${expectation.finding}`);
      }
      if (expectation.expected === 'PASS') {
        assert.equal(observation.finding_ids.length, 0, `${name} clean fixture must have no findings`);
      }
      if (expectation.expected === 'NOT_EVALUABLE') {
        assert.equal(observation.watchdog_scope, 'watchdog-pid-reuse', `${name} must record the pid-reuse scope`);
      }
      if (name === 'o4-green-clean') cleanResponse = response;
    }
    // The green-clean fixture's running step must have been judged against a
    // LIVE pgid (proving the alive path does not fire the dead-pgid finding).
    const cleanObservation = readObservation(workspace, 'o4-green-clean', cleanResponse);
    const deadCheck = cleanObservation.dimensions.dead_claim_pgid.find((row) => row.step_id === 'implement');
    assert.ok(deadCheck !== undefined && deadCheck.pgid_alive === true, 'clean fixture must probe a live claim_pgid');
  } finally {
    // Reap the live pgids the generator spawned for the alive-claim fixture.
    // The shared reaper is identity-verified (ABA startTime + group
    // disjointness) — a stale/reused pgid record is skipped with a warning,
    // never signalled.
    try {
      const records = JSON.parse(fs.readFileSync(livePgidsPath, 'utf8'));
      const { skipped } = reapLivePgids(records);
      for (const skip of skipped) {
        process.stderr.write(`o4.test: stale-skip live-pgid record pid ${skip.record.pid} pgid ${skip.record.pgid}: ${skip.reason}\n`);
      }
    } catch { /* no live pgids file — nothing to reap */ }
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('O4 live-pgid reaping is identity-verified: stale/reused records are skipped, genuine pgids still reaped', async () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  const livePgidsPath = path.join(workspace, 'live-pgids.json');
  const spawned = [];
  try {
    // A genuine recorded live sleep: the reaper must reap it via its verified
    // process group.
    const genuine = spawnDetachedGroupLeader('sleep', ['300']);
    spawned.push(genuine);
    // A live UNRELATED process recorded with a deliberately WRONG startTime —
    // the ABA / pid-reuse case: a blind reaper (the pre-fix behavior) would
    // SIGKILL it; the identity-verified reaper must skip it.
    const decoy = spawnDetachedGroupLeader('sleep', ['300']);
    spawned.push(decoy);
    const records = [
      { pid: genuine.pid, pgid: genuine.pgid, startTime: genuine.startTime },
      { pid: decoy.pid, pgid: decoy.pgid, startTime: 'proc:1' },
    ];
    fs.writeFileSync(livePgidsPath, `${JSON.stringify(records)}\n`);
    const { reaped, skipped } = reapLivePgids(records);
    // The genuine record was reaped through its verified group...
    const reapedGenuine = reaped.find((entry) => entry.record.pid === genuine.pid);
    assert.ok(reapedGenuine !== undefined, `genuine record must be reaped: ${JSON.stringify(reaped)}`);
    assert.equal(reapedGenuine.method, 'group', 'genuine record must be group-killed');
    // ...and the stale decoy record was skipped (never signalled).
    const skippedDecoy = skipped.find((entry) => entry.record.pid === decoy.pid);
    assert.ok(skippedDecoy !== undefined, `stale decoy record must be skipped: ${JSON.stringify(skipped)}`);
    assert.match(skippedDecoy.reason, /startTime mismatch|pid reuse|ABA/, `skip reason must be the identity mismatch: ${skippedDecoy.reason}`);
    // The genuine sleep is gone (node reaps the SIGKILLed child -> exit event,
    // after which the pid is absent from /proc — linux-only introspection; on
    // a /proc-less Darwin host getProcessStartIdentity returns null for any
    // pid, so this assertion cannot false-pass. MACP3 US-003)
    await Promise.race([
      once(genuine.child, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    assert.equal(getProcessStartIdentity(genuine.pid), null, 'genuine sleep must be dead after reaping');
    // ...while the decoy (its record skipped as stale) is still alive.
    assert.notEqual(getProcessStartIdentity(decoy.pid), null, 'stale decoy process must survive the reaper');
    // The generator's live-pgids.json format carries the recorded identity.
    const written = JSON.parse(fs.readFileSync(livePgidsPath, 'utf8'));
    assert.equal(written.length, 2);
    for (const record of written) {
      assert.equal(typeof record.pid, 'number', 'live-pgids.json records must carry pid');
      assert.equal(typeof record.pgid, 'number', 'live-pgids.json records must carry pgid');
      assert.equal(typeof record.startTime, 'string', 'live-pgids.json records must carry startTime');
    }
  } finally {
    // Reap every still-alive spawn through the verified reaper so no detached
    // sleep leaks (the decoy was skipped above on purpose — its real identity
    // still verifies, so cleanup reaps it).
    reapLivePgids(spawned.map(({ pid, pgid, startTime }) => ({ pid, pgid, startTime })));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
