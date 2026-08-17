#!/usr/bin/env node
// reap-live-pgids.test.mjs — unit tests for the identity-verified live-pgid
// reaper (E3.C.1 US-005).
//
// The reaper must kill a recorded pgid ONLY when (a) the current /proc
// startTime matches the recorded startTime (ABA-safe) and (b) the pgid is
// disjoint from the reaper's own process group; anything else is SKIPPED with
// a stale-skip warning. These tests pin the refusal paths (stale ABA record,
// dead pid, pgid mismatch, self/ancestor targets) and the happy path (genuine
// recorded pgid reaped via its verified group), plus the CLI mode run.sh
// consumes.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { getProcessGroup, getProcessStartIdentity, ownPid, ownProcessGroup } from '../../bin/tt-process-identity.mjs';
import { reapLivePgids, spawnDetachedGroupLeader } from './reap-live-pgids.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REAPER = path.join(HERE, 'reap-live-pgids.mjs');

// waitForExit: wait for the SIGKILLed detached child to be reaped by node
// (the 'exit' event fires only after reaping), with a bounded fallback so a
// regression cannot hang the suite.
async function waitForExit(child, label) {
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  assert.equal(getProcessStartIdentity(child.pid), null, `${label}: pid must be absent from /proc after reaping`);
}

test('genuine recorded pgid is reaped via its verified group', async () => {
  const { pid, pgid, startTime, child } = spawnDetachedGroupLeader('sleep', ['300']);
  assert.equal(pgid, pid, 'detached spawn must be its own group leader');
  try {
    const { reaped, skipped } = reapLivePgids([{ pid, pgid, startTime }]);
    assert.deepEqual(skipped, [], `no record may be skipped: ${JSON.stringify(skipped)}`);
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0].record.pid, pid);
    assert.equal(reaped[0].method, 'group', 'genuine record must be group-killed');
    await waitForExit(child, 'genuine sleep');
  } finally {
    reapLivePgids([{ pid, pgid, startTime }]);
  }
});

test('stale/reused startTime record is skipped and the live unrelated process survives', async () => {
  const { pid, pgid, child } = spawnDetachedGroupLeader('sleep', ['300']);
  try {
    // Deliberately WRONG recorded startTime — the ABA / pid-reuse case: a
    // blind reaper would SIGKILL this live process.
    const { reaped, skipped } = reapLivePgids([{ pid, pgid, startTime: 'proc:1' }]);
    assert.deepEqual(reaped, [], 'stale record must not be reaped');
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /startTime mismatch|pid reuse|ABA/);
    assert.notEqual(getProcessStartIdentity(pid), null, 'the unrelated process must survive a stale-record reap');
  } finally {
    reapLivePgids([{ pid, pgid, startTime: getProcessStartIdentity(pid) }]);
  }
});

test('dead-pid record is skipped', () => {
  // 2147483647 > pid_max on any linux host — provably dead.
  const { reaped, skipped } = reapLivePgids([{ pid: 2147483647, pgid: 2147483647, startTime: 'proc:1' }]);
  assert.deepEqual(reaped, []);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /not alive|unreadable/);
});

test('pgid-mismatch record is skipped and the process survives', async () => {
  const { pid, pgid, startTime, child } = spawnDetachedGroupLeader('sleep', ['300']);
  try {
    // Record the correct pid/startTime but a WRONG pgid — the group-kill
    // verification must refuse (current pgid != recorded pgid).
    const wrongPgid = pgid === 999999 ? 999998 : 999999;
    const { reaped, skipped } = reapLivePgids([{ pid, pgid: wrongPgid, startTime }]);
    assert.deepEqual(reaped, [], 'pgid-mismatch record must not be reaped');
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /pgid mismatch/);
    assert.notEqual(getProcessStartIdentity(pid), null, 'the process must survive a pgid-mismatch reap');
  } finally {
    reapLivePgids([{ pid, pgid, startTime }]);
  }
});

test('record naming the reaper itself is refused (own-group / self-ancestor)', async () => {
  const selfPid = ownPid();
  const record = {
    pid: selfPid,
    pgid: ownProcessGroup(),
    startTime: getProcessStartIdentity(selfPid),
  };
  const { reaped, skipped } = reapLivePgids([record]);
  assert.deepEqual(reaped, [], 'self record must not be reaped');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /ancestor|own pgid/);
});

test('record naming an ancestor of the reaper is refused', async () => {
  // process.ppid is an ancestor of the test process (the node --test runner
  // is a child of the launching shell).
  const ancestorPid = process.ppid;
  const record = {
    pid: ancestorPid,
    pgid: getProcessGroup(ancestorPid),
    startTime: getProcessStartIdentity(ancestorPid),
  };
  const { reaped, skipped } = reapLivePgids([record]);
  assert.deepEqual(reaped, [], 'ancestor record must not be reaped');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /ancestor/);
});

test('CLI mode reads live-pgids.json, reaps genuine records, skips stale ones, exits 0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-live-pgids-cli.'));
  const genuine = spawnDetachedGroupLeader('sleep', ['300']);
  const decoy = spawnDetachedGroupLeader('sleep', ['300']);
  try {
    const file = path.join(dir, 'live-pgids.json');
    fs.writeFileSync(file, `${JSON.stringify([
      { pid: genuine.pid, pgid: genuine.pgid, startTime: genuine.startTime },
      { pid: decoy.pid, pgid: decoy.pgid, startTime: 'proc:1' },
    ])}\n`);
    const result = spawnSync(process.execPath, [REAPER, file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /reaped 1 live pgid record\(s\), skipped 1/);
    assert.match(result.stderr, /stale-skip pid/);
    // Genuine record reaped (child reaped -> pid gone), decoy survived.
    await waitForExit(genuine.child, 'CLI genuine sleep');
    assert.notEqual(getProcessStartIdentity(decoy.pid), null, 'CLI decoy must survive the stale-skip');
    // The CLI reaper is the exact entry run.sh invokes.
    assert.match(REAPER, /oracles\/self-test\/reap-live-pgids\.mjs$/);
  } finally {
    // Reap every still-alive spawn through the verified reaper (the decoy was
    // skipped on purpose — its real identity still verifies, so cleanup reaps
    // it) so no detached sleep leaks.
    reapLivePgids([
      { pid: genuine.pid, pgid: genuine.pgid, startTime: genuine.startTime },
      { pid: decoy.pid, pgid: decoy.pgid, startTime: decoy.startTime },
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
