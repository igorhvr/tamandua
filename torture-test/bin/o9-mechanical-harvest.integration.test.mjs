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
    detached: process.platform !== 'win32',
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, exited, closed, output: () => ({ stdout, stderr }) };
}

function bounded(promise, message, timeoutMs = 10_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function stopShim(shim) {
  if (shim.child.exitCode === null && shim.child.signalCode === null) {
    try {
      const target = process.platform === 'win32' ? shim.child.pid : -shim.child.pid;
      process.kill(target, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  shim.child.stdout.destroy();
  shim.child.stderr.destroy();
  await bounded(shim.exited, `shim ${shim.child.pid} did not exit during cleanup`, 2_000);
}

function inspectSuiteProcessGroup(suite) {
  if (!fs.existsSync(suite.pidFile)) return undefined;
  const pid = Number(fs.readFileSync(suite.pidFile, 'utf8').trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `${suite.name} wrote an invalid suite PID`);
  const inspected = spawnSync('ps', ['-o', 'pgid=', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  if (inspected.status !== 0 || inspected.stdout.trim() === '') return undefined;
  const match = inspected.stdout.trim().match(/^(\d+)\s+(.+)$/);
  assert.ok(match, `could not inspect ${suite.name} suite process ${pid}`);
  const pgid = Number(match[1]);
  const args = match[2];
  assert.ok(Number.isSafeInteger(pgid) && pgid > 1, `${suite.name} has an invalid process group`);
  assert.ok(args.includes(suite.script), `${suite.name} PID ${pid} is not owned by this fixture: ${args}`);
  return { pid, pgid };
}

function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function signalOwnedSuiteGroup(suite, ownership, signal) {
  const current = inspectSuiteProcessGroup(suite);
  if (!current) return;
  assert.deepEqual(current, ownership, `${suite.name} suite ownership changed before ${signal}`);
  process.kill(-ownership.pgid, signal);
}

async function stopSuite(suite) {
  await waitFor(
    () => fs.existsSync(suite.pidFile) || fs.existsSync(suite.doneFile),
    `${suite.name} suite never published its process identity`,
    2_000,
  );
  const ownership = inspectSuiteProcessGroup(suite);
  fs.writeFileSync(suite.stopFile, 'stop\n');
  if (!ownership) return;
  try {
    await waitFor(
      () => fs.existsSync(suite.doneFile) && !processGroupExists(ownership.pgid),
      `${suite.name} suite ignored its stop marker`,
      2_000,
    );
    return;
  } catch {
    signalOwnedSuiteGroup(suite, ownership, 'SIGTERM');
  }
  try {
    await waitFor(() => !processGroupExists(ownership.pgid), `${suite.name} suite ignored SIGTERM`, 500);
  } catch {
    signalOwnedSuiteGroup(suite, ownership, 'SIGKILL');
    await waitFor(() => !processGroupExists(ownership.pgid), `${suite.name} suite survived SIGKILL`, 2_000);
  }
}

function removeSuiteMarkers(suite) {
  fs.rmSync(suite.pidFile, { force: true });
  fs.rmSync(suite.stopFile, { force: true });
  fs.rmSync(suite.doneFile, { force: true });
}

function makeRecoveryScript(root, repo, name) {
  const marker = path.join(root, `${name}.marker`);
  const pidFile = path.join(root, `${name}.pid`);
  const stopFile = path.join(root, `${name}.stop`);
  const doneFile = path.join(root, `${name}.done`);
  const script = path.join(repo, `${name}.sh`);
  fs.writeFileSync(script, `#!/bin/sh\nif [ ! -e '${marker}' ]; then\n  : > '${marker}'\n  echo $$ > '${pidFile}'\n  echo '${name} OWNER STARTED'\n  while [ ! -e '${stopFile}' ]; do sleep 0.05; done\n  : > '${doneFile}'\nfi\necho '${name} RECOVERY FINISHED'\n`);
  fs.chmodSync(script, 0o755);
  command('git', ['add', path.basename(script)], repo);
  command('git', ['commit', '-m', `add ${name} suite`], repo);
  return { name, script, pidFile, stopFile, doneFile };
}

test('cleanup force-terminates a wedged invocation-owned suite process group', { timeout: 10_000 }, async () => {
  const root = fs.mkdtempSync(path.join(VAR_ROOT, 'o9-mechanical-cleanup.'));
  const suite = {
    name: 'wedged-cleanup',
    script: path.join(root, 'wedged-cleanup.sh'),
    pidFile: path.join(root, 'wedged-cleanup.pid'),
    stopFile: path.join(root, 'wedged-cleanup.stop'),
    doneFile: path.join(root, 'wedged-cleanup.done'),
  };
  fs.writeFileSync(
    suite.script,
    `#!/bin/sh\ntrap '' TERM\necho $$ > '${suite.pidFile}'\nwhile :; do sleep 0.05; done\n`,
  );
  fs.chmodSync(suite.script, 0o755);
  const child = spawn('/bin/sh', ['-c', suite.script], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  try {
    await waitFor(() => fs.existsSync(suite.pidFile), 'wedged suite did not publish its PID');
    const suitePid = Number(fs.readFileSync(suite.pidFile, 'utf8').trim());
    await stopSuite(suite);
    assert.throws(() => process.kill(suitePid, 0), { code: 'ESRCH' });
  } finally {
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* gone */ }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once('exit', resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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

  const shims = [];
  try {
    const owner = spawnShim(repo, env, ownerRun, ownerStep, suite.script);
    shims.push(owner);
    await waitFor(
      () => eventRows(eventsPath).some((event) => event.event === 'suite.execute_started' && event.runId === ownerRun),
      `${kind} owner did not emit suite.execute_started`,
    );

    if (kind === 'dead-owner') {
      // The control-plane claim records this exact shim PID. Wait for the
      // process to exit, not for stdio to close: an orphaned suite descendant
      // can inherit a descriptor and keep ChildProcess 'close' pending.
      owner.child.kill('SIGKILL');
      await bounded(owner.exited, `${kind} owner did not exit after SIGKILL`);
      const waiter = spawnShim(repo, env, waiterRun, waiterStep, suite.script);
      shims.push(waiter);
      let waiterResult;
      try {
        waiterResult = await bounded(waiter.closed, `${kind} waiter did not reclaim within deadline`);
      } catch (error) {
        const ownerPid = eventRows(eventsPath).find((event) => event.event === 'suite.claim_granted'
          && event.runId === ownerRun)?.ownerPid;
        let ownerProcess = 'absent';
        if (Number.isSafeInteger(ownerPid)) {
          ownerProcess = spawnSync('ps', ['-o', 'pid=', '-o', 'ppid=', '-o', 'stat=', '-o', 'args=', '-p', String(ownerPid)], { encoding: 'utf8' }).stdout.trim() || 'absent';
        }
        throw new Error(`${error.message}; ownerPid=${ownerPid}; ownerProcess=${ownerProcess}; waiterPid=${waiter.child.pid}; waiterOutput=${JSON.stringify(waiter.output())}; events=${JSON.stringify(eventRows(eventsPath).slice(-12))}`);
      }
      assert.equal(waiterResult.code, 0, waiterResult.stderr);
      const reclaims = eventRows(eventsPath).filter((event) => event.event === 'suite.claim_dead_owner_reclaimed'
        && event.ownerRunId === ownerRun);
      assert.equal(reclaims.length, 1, 'dead owner must be reclaimed exactly once by the real waiter');
      assert.equal(reclaims[0].ownerStepId, ownerStep);
      assert.equal(reclaims[0].ownerPid, owner.child.pid);
      assert.equal(reclaims[0].reclaimerRunId, waiterRun);
      assert.equal(reclaims[0].reclaimerStepId, waiterStep);
      assert.equal(reclaims[0].reclaimerPid, waiter.child.pid);
    } else {
      const waiter = spawnShim(repo, env, waiterRun, waiterStep, suite.script);
      shims.push(waiter);
      await waitFor(
        () => eventRows(eventsPath).some((event) => event.event === 'suite.claim_wait' && event.runId === waiterRun),
        `${kind} waiter did not emit suite.claim_wait`,
      );
      const endpoint = kind === 'stop' ? '/control/pause-run' : '/control/terminate-run';
      const released = await post(port, endpoint, { runId: ownerRun });
      assert.equal(released.status, 200, JSON.stringify(released.body));
      const waiterResult = await bounded(waiter.closed, `${kind} waiter did not complete within deadline`);
      assert.equal(waiterResult.code, 0, waiterResult.stderr);
      owner.child.kill('SIGKILL');
      await bounded(owner.exited, `${kind} owner did not exit after cleanup signal`);
      const relevant = eventRows(eventsPath).filter((event) => event.originRepo === fs.realpathSync(repo)
        && event.ownerRunId === ownerRun);
      const releases = relevant.filter((event) => event.event === 'suite.claim_owner_released');
      assert.equal(releases.length, 1, `${kind} must emit exactly one distinct owner release`);
      assert.equal(releases[0].releaseReason, kind === 'stop' ? 'stop' : 'cancel');
      assert.equal(relevant.some((event) => event.event === 'suite.claim_dead_owner_reclaimed'), false);
    }
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
  } finally {
    // Publish the suite's cooperative stop before terminating any shim. If a
    // shim is still between claim and spawn, allowing it to proceed means the
    // late suite sees the marker immediately. The production suite shell has
    // its own detached process group, so killing the shim first would not be a
    // reliable descendant cleanup mechanism.
    let suiteStopError;
    try {
      await stopSuite(suite);
    } catch (error) {
      suiteStopError = error;
    }
    const cleanup = await Promise.allSettled(shims.map((shim) => stopShim(shim)));
    removeSuiteMarkers(suite);
    for (const result of cleanup) assert.equal(result.status, 'fulfilled', String(result.reason));
    if (suiteStopError) throw suiteStopError;
  }
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
  fs.mkdirSync(process.env.HOME);
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
      // US-003: probe_evidence/chaos_log are optional snapshot keys — absent
      // artifacts leave their reference null, so only captured keys map.
      evidencePaths: Object.fromEntries(Object.entries(completed.references)
        .filter(([, reference]) => reference !== null)
        .map(([key, reference]) => [key, path.join(campaignDir, reference.path)])),
    });
    assert.equal(result.result, 'PASS', JSON.stringify(result.findings));
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
