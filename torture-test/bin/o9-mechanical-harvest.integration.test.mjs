#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  beginOracleEvidenceSnapshot,
  completeOracleEvidenceSnapshot,
} from './oracle-evidence-snapshot.mjs';
import { runO9TargetedProbes } from './o9-targeted-probes.mjs';
import { evaluateO9 } from '../oracles/lib/o9.mjs';

const TT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(TT_ROOT, '..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const SHIM = path.join(REPO_ROOT, 'dist', 'suite', 'shim.js');
const MAIN_RUN_ID = 'run-10101010-1010-4010-8010-101010101010';

function command(name, args, cwd) {
  const result = spawnSync(name, args, { cwd, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, `${name} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function appendRun(db, runId) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO runs
    (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at)
    VALUES (?, 'o9-integration', 'mechanical O9 evidence', 'running', '{}', 1, NULL, ?, ?)`)
    .run(runId, now, now);
}

function post(port, pathname, body) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
}

function eventRows(eventsPath) {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function spawnShim(repo, env, runId, stepId, script) {
  const child = spawn(process.execPath, [SHIM, '--repo', repo, '--run', runId, '--step', stepId, '--', script], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, closed };
}

function killProcessGroup(pidFile) {
  if (!fs.existsSync(pidFile)) return;
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already stopped */ }
}

function makeRecoveryScript(root, repo, name) {
  const marker = path.join(root, `${name}.marker`);
  const pidFile = path.join(root, `${name}.pid`);
  const script = path.join(repo, `${name}.sh`);
  fs.writeFileSync(script, `#!/bin/sh\nif [ ! -e '${marker}' ]; then\n  : > '${marker}'\n  echo $$ > '${pidFile}'\n  echo '${name} OWNER STARTED'\n  while :; do sleep 1; done\nfi\necho '${name} RECOVERY FINISHED'\n`);
  fs.chmodSync(script, 0o755);
  command('git', ['add', path.basename(script)], repo);
  command('git', ['commit', '-m', `add ${name} suite`], repo);
  return { script, pidFile };
}

function snapshotInput({ campaignDir, stateDir, databasePath, repo, runIds }) {
  return {
    ttRoot: TT_ROOT,
    campaignDir,
    stateDir,
    databasePath,
    repositoryPath: repo,
    caseRecord: {
      id: 'O9-MECHANICAL-INTEGRATION', workflow: 'feature-dev-merge-worktree', fixture: 'tt-ts', harness: 'hermes',
      context: { merge_gate: 'green', fail_missing: '1', test_cmd: 'npm test' },
      boundary_files: [], forbidden: [],
    },
    attempt: {
      id: 'attempt-1', run_id: MAIN_RUN_ID, launch_intent_at: new Date().toISOString(),
      execution_mode: 'real', terminal_status: 'completed', tokens_observed: 1,
      steps_snapshot: { source: 'workflow-status-json', captured_at: new Date().toISOString(), steps: [] },
    },
    launchArgv: ['workflow', 'run', 'feature-dev-merge-worktree', '--context', 'merge_gate=green'],
    discoveredRuns: runIds.filter((runId) => runId !== MAIN_RUN_ID)
      .map((runId) => ({ run_id: runId, parent_run_id: MAIN_RUN_ID })),
  };
}

async function runRecovery({ kind, repo, root, env, port, databasePath, eventsPath, runIds }) {
  const ownerRun = `run-${kind}-owner`;
  const waiterRun = `run-${kind}-waiter`;
  const ownerStep = `${kind}-owner-step`;
  const waiterStep = `${kind}-waiter-step`;
  runIds.push(ownerRun, waiterRun);
  const suite = makeRecoveryScript(root, repo, kind);
  const db = new DatabaseSync(databasePath);
  appendRun(db, ownerRun);
  appendRun(db, waiterRun);
  db.close();

  const owner = spawnShim(repo, env, ownerRun, ownerStep, suite.script);
  await waitFor(
    () => eventRows(eventsPath).some((event) => event.event === 'suite.execute_started' && event.runId === ownerRun),
    `${kind} owner did not emit suite.execute_started`,
  );

  if (kind === 'dead-owner') {
    owner.child.kill('SIGKILL');
    await owner.closed;
    const waiter = spawnShim(repo, env, waiterRun, waiterStep, suite.script);
    const waiterResult = await waiter.closed;
    assert.equal(waiterResult.code, 0, waiterResult.stderr);
    assert.ok(eventRows(eventsPath).some((event) => event.event === 'suite.claim_dead_owner_reclaimed'
      && event.ownerRunId === ownerRun && event.reclaimerRunId === waiterRun));
  } else {
    const waiter = spawnShim(repo, env, waiterRun, waiterStep, suite.script);
    await waitFor(
      () => eventRows(eventsPath).some((event) => event.event === 'suite.claim_wait' && event.runId === waiterRun),
      `${kind} waiter did not emit suite.claim_wait`,
    );
    const endpoint = kind === 'stop' ? '/control/pause-run' : '/control/terminate-run';
    const released = await post(port, endpoint, { runId: ownerRun });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    const waiterResult = await waiter.closed;
    assert.equal(waiterResult.code, 0, waiterResult.stderr);
    owner.child.kill('SIGKILL');
    await owner.closed;
    const relevant = eventRows(eventsPath).filter((event) => event.originRepo === fs.realpathSync(repo)
      && event.ownerRunId === ownerRun);
    assert.ok(relevant.some((event) => event.event === 'suite.claim_owner_released'
      && event.releaseReason === (kind === 'stop' ? 'stop' : 'cancel')));
    assert.equal(relevant.some((event) => event.event === 'suite.claim_dead_owner_reclaimed'), false);
  }
  killProcessGroup(suite.pidFile);
  const emitted = eventRows(eventsPath).filter((event) => event.originRepo === fs.realpathSync(repo));
  return {
    kind,
    ownerRun,
    ownerStep,
    waiterRun,
    waiterStep,
    ownerGrant: emitted.find((event) => event.event === 'suite.claim_granted'
      && event.runId === ownerRun && event.ownerRunId === ownerRun),
    ownerStart: emitted.find((event) => event.event === 'suite.execute_started'
      && event.runId === ownerRun && event.stepId === ownerStep),
    waiterGrant: emitted.find((event) => event.event === 'suite.claim_granted'
      && event.runId === waiterRun && event.ownerRunId === waiterRun),
    waiterStart: emitted.find((event) => event.event === 'suite.execute_started'
      && event.runId === waiterRun && event.stepId === waiterStep),
    reclaim: emitted.find((event) => event.event === 'suite.claim_dead_owner_reclaimed'
      && event.ownerRunId === ownerRun),
    release: emitted.find((event) => event.event === 'suite.claim_owner_released'
      && event.ownerRunId === ownerRun),
  };
}

test('real dead-owner, stop/cancel, and controller probes harvest through snapshot to O9 PASS', { timeout: 30_000 }, async () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(VAR_ROOT, 'o9-mechanical-harvest.'));
  const stateDir = path.join(root, 'state');
  const databasePath = path.join(stateDir, 'tamandua.db');
  const eventsPath = path.join(stateDir, 'events', 'all.jsonl');
  const repo = path.join(root, 'repo');
  const campaignDir = path.join(root, 'campaign');
  fs.mkdirSync(path.join(stateDir, 'events'), { recursive: true });
  fs.mkdirSync(repo);
  fs.mkdirSync(campaignDir);
  command('git', ['init', '-b', 'main'], repo);
  command('git', ['config', 'user.name', 'O9 Mechanical Test'], repo);
  command('git', ['config', 'user.email', 'o9-mechanical@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'baseline\n');
  command('git', ['add', 'tracked.txt'], repo);
  command('git', ['commit', '-m', 'fixture'], repo);

  const previousEnv = Object.fromEntries(['HOME', 'TAMANDUA_STATE_DIR', 'TAMANDUA_DB_PATH', 'TAMANDUA_CONTROL_PORT', 'TAMANDUA_TEST_GUARD']
    .map((key) => [key, process.env[key]]));
  process.env.HOME = path.join(root, 'home');
  process.env.TAMANDUA_STATE_DIR = stateDir;
  process.env.TAMANDUA_DB_PATH = databasePath;
  process.env.TAMANDUA_TEST_GUARD = '0';
  const runIds = [MAIN_RUN_ID];
  let server;
  try {
    const { getDb } = await import(`../../dist/db.js?o9-harvest=${Date.now()}`);
    const initialDb = getDb();
    appendRun(initialDb, MAIN_RUN_ID);
    const { createControlServer } = await import(`../../dist/server/control-server.js?o9-harvest=${Date.now()}`);
    server = createControlServer({ listen: false });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    process.env.TAMANDUA_CONTROL_PORT = String(address.port);
    const env = {
      ...process.env,
      HOME: process.env.HOME,
      TAMANDUA_STATE_DIR: stateDir,
      TAMANDUA_DB_PATH: databasePath,
      TAMANDUA_CONTROL_PORT: String(address.port),
      TAMANDUA_TEST_GUARD: '0',
    };
    const request = snapshotInput({ campaignDir, stateDir, databasePath, repo, runIds });
    const baseline = beginOracleEvidenceSnapshot(request);

    const deadOwner = await runRecovery({ kind: 'dead-owner', repo, root, env, port: address.port, databasePath, eventsPath, runIds });
    const stopped = await runRecovery({ kind: 'stop', repo, root, env, port: address.port, databasePath, eventsPath, runIds });
    const cancelled = await runRecovery({ kind: 'cancel', repo, root, env, port: address.port, databasePath, eventsPath, runIds });
    assert.equal(deadOwner.reclaim.ownerRunId, deadOwner.ownerRun);
    assert.equal(deadOwner.reclaim.ownerStepId, deadOwner.ownerStep);
    assert.equal(deadOwner.reclaim.reclaimerRunId, deadOwner.waiterRun);
    assert.equal(deadOwner.reclaim.reclaimerStepId, deadOwner.waiterStep);
    assert.equal(deadOwner.release, undefined, 'SIGKILL recovery must not emit an owner release');
    for (const recovery of [stopped, cancelled]) {
      assert.equal(recovery.release?.releaseReason, recovery.kind);
      assert.equal(recovery.reclaim, undefined, `${recovery.kind} recovery must not emit a dead-owner reclaim`);
    }
    for (const recovery of [deadOwner, stopped, cancelled]) {
      assert.ok(recovery.ownerGrant, `${recovery.kind} owner grant was not mechanically emitted`);
      assert.ok(recovery.ownerStart, `${recovery.kind} owner start was not mechanically emitted`);
      assert.ok(recovery.waiterGrant, `${recovery.kind} waiter grant was not mechanically emitted`);
      assert.ok(recovery.waiterStart, `${recovery.kind} waiter start was not mechanically emitted`);
    }
    const targetedRun = 'run-o9-controller-probes';
    runIds.push(targetedRun);
    await runO9TargetedProbes({ repo, runId: targetedRun, stepPrefix: 'controller-o9', shim: path.join(REPO_ROOT, 'bin', 'tamandua-test'), env });

    const completeRequest = snapshotInput({ campaignDir, stateDir, databasePath, repo, runIds });
    completeRequest.attempt.launch_intent_at = request.attempt.launch_intent_at;
    const completed = completeOracleEvidenceSnapshot(completeRequest, baseline);
    const suiteObservations = JSON.parse(fs.readFileSync(
      path.join(campaignDir, completed.references.suite_observations.path),
      'utf8',
    ));
    assert.ok(suiteObservations.rows.length > 0, 'mechanical suite executions were not projected');
    assert.deepEqual(
      suiteObservations.singleflight_observations.map((observation) => observation.recovery).sort(),
      ['dead_owner', 'stop_cancel', 'stop_cancel'],
    );
    const observationFor = (recovery) => suiteObservations.singleflight_observations.find(
      (observation) => observation.owner_invocation_id === `${recovery.ownerRun}:${recovery.ownerStep}`,
    );
    const deadOwnerObservation = observationFor(deadOwner);
    assert.ok(deadOwnerObservation, 'dead-owner events were not projected into suite observations');
    assert.equal(deadOwnerObservation.recovery, 'dead_owner');
    assert.deepEqual(deadOwnerObservation.waiter_invocation_ids, [`${deadOwner.waiterRun}:${deadOwner.waiterStep}`]);
    assert.ok(deadOwnerObservation.events.some((event) => event.type === 'dead_owner_reclaimed'
      && event.invocation_id === `${deadOwner.waiterRun}:${deadOwner.waiterStep}`));
    for (const recovery of [stopped, cancelled]) {
      const observation = observationFor(recovery);
      assert.ok(observation, `${recovery.kind} events were not projected into suite observations`);
      assert.equal(observation.recovery, 'stop_cancel');
      assert.deepEqual(observation.waiter_invocation_ids, [`${recovery.waiterRun}:${recovery.waiterStep}`]);
      assert.ok(observation.events.some((event) => event.type === 'owner_released'
        && event.invocation_id === `${recovery.ownerRun}:${recovery.ownerStep}`
        && event.reason === recovery.kind));
      assert.equal(observation.events.some((event) => event.type === 'dead_owner_reclaimed'), false);
    }
    assert.deepEqual(suiteObservations.special_exit_observations.map((event) => event.shim_exit_code), [86, 87, 88]);
    assert.ok(suiteObservations.special_exit_observations.every((event) => event.junk_probe_tracked === false));

    const evidenceDir = path.join(campaignDir, 'o9-result');
    fs.mkdirSync(evidenceDir);
    const result = await evaluateO9({
      campaignRoot: campaignDir,
      evidenceDir,
      evidencePaths: Object.fromEntries(Object.entries(completed.references)
        .map(([key, reference]) => [key, path.join(campaignDir, reference.path)])),
    });
    assert.equal(result.result, 'PASS', JSON.stringify(result.findings));
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    for (const name of ['dead-owner', 'stop', 'cancel']) killProcessGroup(path.join(root, `${name}.pid`));
    fs.rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
