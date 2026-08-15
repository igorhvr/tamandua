#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

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
    try {
      const livePgids = JSON.parse(fs.readFileSync(livePgidsPath, 'utf8'));
      for (const pgid of livePgids) {
        try { process.kill(pgid, 'SIGKILL'); } catch { /* already gone */ }
      }
    } catch { /* no live pgids file — nothing to reap */ }
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
