#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(SCRIPT_DIR, 'run.sh');

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function processStartTime(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return fields[19];
}

function stopOwnedProcess(pid, ownershipMarker) {
  if (!Number.isSafeInteger(pid) || pid < 2) return;
  try {
    const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    if (!commandLine.includes(ownershipMarker)) return;
    process.kill(pid, 'SIGKILL');
  } catch { /* already gone or no longer owned */ }
}

function stopOwnedProcessGroup(child, ownershipMarker) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    const stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const processGroup = Number(fields[2]);
    const commandLine = fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    if (processGroup !== child.pid || !commandLine.includes(ownershipMarker)) return;
    process.kill(-child.pid, 'SIGKILL');
  } catch { /* already gone or no longer owned */ }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('self-test watchdog regression child did not exit')), timeoutMs);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test('whole-suite watchdog kills a wedged detached descendant without touching an unrelated process', { timeout: 12_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watchdog-regression.'));
  const descendantPidFile = path.join(root, 'descendant.pid');

  const unrelated = spawn('/bin/sh', ['-c', 'while :; do sleep 1; done'], { stdio: 'ignore' });
  const child = spawn('/bin/bash', [RUNNER], {
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      TT_SELF_TEST_FAILURE_INJECTION: 'hang',
      TT_SELF_TEST_GRACE_SECONDS: '1',
      TT_SELF_TEST_INJECTION_PID_FILE: descendantPidFile,
      TT_SELF_TEST_INVOCATION_ID: '',
      TT_SELF_TEST_OWNERSHIP_ROOT: '',
      TT_SELF_TEST_SINGLE_ROUND: '1',
      TT_SELF_TEST_SUITE_TIMEOUT_SECONDS: '1',
      TT_SELF_TEST_VAR_ROOT: root,
      TT_SELF_TEST_WATCHDOG_ACTIVE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  let descendantPid;
  try {
    const result = await waitForExit(child, 6_000);
    if (fs.existsSync(descendantPidFile)) descendantPid = Number(fs.readFileSync(descendantPidFile, 'utf8'));
    assert.equal(result.code, 124, `expected watchdog exit 124, got ${JSON.stringify(result)}\n${stdout}\n${stderr}`);
    assert.match(stderr, /whole-suite watchdog expired/);
    assert.ok(Number.isSafeInteger(descendantPid), 'failure fixture did not publish descendant PID');
    assert.equal(processExists(descendantPid), false, `owned descendant ${descendantPid} leaked`);
    assert.equal(processExists(unrelated.pid), true, 'ownership cleanup killed an unrelated process');
    const leakedWorkspaces = fs.readdirSync(root).filter((name) => name.startsWith('oracle-self-test.'));
    assert.deepEqual(leakedWorkspaces, []);
  } finally {
    stopOwnedProcessGroup(child, RUNNER);
    if (!descendantPid && fs.existsSync(descendantPidFile)) {
      descendantPid = Number(fs.readFileSync(descendantPidFile, 'utf8'));
    }
    stopOwnedProcess(descendantPid, descendantPidFile);
    stopOwnedProcess(unrelated.pid, 'while :; do sleep 1; done');
    child.stdout.destroy();
    child.stderr.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inherited active flag without ownership tokens cannot bypass the whole-suite watchdog', { timeout: 12_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watchdog-missing-scope.'));
  const descendantPidFile = path.join(root, 'descendant.pid');
  const child = spawn('/bin/bash', [RUNNER], {
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      TT_SELF_TEST_FAILURE_INJECTION: 'hang',
      TT_SELF_TEST_GRACE_SECONDS: '1',
      TT_SELF_TEST_INJECTION_PID_FILE: descendantPidFile,
      TT_SELF_TEST_INVOCATION_ID: '',
      TT_SELF_TEST_OWNERSHIP_ROOT: '',
      TT_SELF_TEST_SINGLE_ROUND: '1',
      TT_SELF_TEST_SUITE_TIMEOUT_SECONDS: '1',
      TT_SELF_TEST_VAR_ROOT: root,
      TT_SELF_TEST_WATCHDOG_ACTIVE: '1',
      TT_SELF_TEST_WATCHDOG_SCOPE_FILE: '',
      TT_SELF_TEST_WATCHDOG_SCOPE_TOKEN: '',
      TT_SELF_TEST_WATCHDOG_SCOPE_FD: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  let descendantPid;
  try {
    const result = await waitForExit(child, 6_000);
    if (fs.existsSync(descendantPidFile)) descendantPid = Number(fs.readFileSync(descendantPidFile, 'utf8'));
    assert.equal(result.code, 124, `expected watchdog exit 124, got ${JSON.stringify(result)}\n${stdout}\n${stderr}`);
    assert.match(stderr, /whole-suite watchdog expired/);
    assert.ok(Number.isSafeInteger(descendantPid), 'failure fixture did not publish descendant PID');
    assert.equal(processExists(descendantPid), false, `owned descendant ${descendantPid} leaked`);
    const leakedWorkspaces = fs.readdirSync(root).filter((name) => name.startsWith('oracle-self-test.'));
    assert.deepEqual(leakedWorkspaces, []);
  } finally {
    stopOwnedProcessGroup(child, RUNNER);
    if (!descendantPid && fs.existsSync(descendantPidFile)) {
      descendantPid = Number(fs.readFileSync(descendantPidFile, 'utf8'));
    }
    stopOwnedProcess(descendantPid, descendantPidFile);
    child.stdout.destroy();
    child.stderr.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inherited active flag with a forged environment scope cannot bypass the whole-suite watchdog', { timeout: 12_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watchdog-invalid-scope.'));
  const descendantPidFile = path.join(root, 'descendant.pid');
  const forgedScopeFile = path.join(root, 'scope');
  fs.writeFileSync(
    forgedScopeFile,
    `caller-controlled\ncaller-token\n${process.pid}\n${processStartTime(process.pid)}\n`,
    { mode: 0o600 },
  );
  const forgedScopeFd = fs.openSync(forgedScopeFile, 'r');
  const child = spawn('/bin/bash', [RUNNER], {
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      TT_SELF_TEST_FAILURE_INJECTION: 'hang',
      TT_SELF_TEST_GRACE_SECONDS: '1',
      TT_SELF_TEST_INJECTION_PID_FILE: descendantPidFile,
      TT_SELF_TEST_INVOCATION_ID: 'caller-controlled',
      TT_SELF_TEST_OWNERSHIP_ROOT: 'caller-controlled',
      TT_SELF_TEST_SINGLE_ROUND: '1',
      TT_SELF_TEST_SUITE_TIMEOUT_SECONDS: '1',
      TT_SELF_TEST_VAR_ROOT: root,
      TT_SELF_TEST_WATCHDOG_ACTIVE: '1',
      TT_SELF_TEST_WATCHDOG_SCOPE_FILE: forgedScopeFile,
      TT_SELF_TEST_WATCHDOG_SCOPE_TOKEN: 'caller-token',
      TT_SELF_TEST_WATCHDOG_SCOPE_FD: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe', forgedScopeFd],
  });
  fs.closeSync(forgedScopeFd);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  let descendantPid;
  try {
    const result = await waitForExit(child, 6_000);
    if (fs.existsSync(descendantPidFile)) descendantPid = Number(fs.readFileSync(descendantPidFile, 'utf8'));
    assert.equal(result.code, 124, `expected watchdog exit 124, got ${JSON.stringify(result)}\n${stdout}\n${stderr}`);
    assert.match(stderr, /whole-suite watchdog expired/);
    assert.ok(Number.isSafeInteger(descendantPid), 'failure fixture did not publish descendant PID');
    assert.equal(processExists(descendantPid), false, `owned descendant ${descendantPid} leaked`);
    const leakedWorkspaces = fs.readdirSync(root).filter((name) => name.startsWith('oracle-self-test.'));
    assert.deepEqual(leakedWorkspaces, []);
  } finally {
    stopOwnedProcessGroup(child, RUNNER);
    if (!descendantPid && fs.existsSync(descendantPidFile)) {
      descendantPid = Number(fs.readFileSync(descendantPidFile, 'utf8'));
    }
    stopOwnedProcess(descendantPid, descendantPidFile);
    child.stdout.destroy();
    child.stderr.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
