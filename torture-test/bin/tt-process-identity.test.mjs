#!/usr/bin/env node
// tt-process-identity.test.mjs — unit tests for the torture-test-local
// process-kill safety primitives (E3.C.1 US-001).
//
// Run: node --test torture-test/bin/tt-process-identity.test.mjs

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  getProcessGroup,
  getProcessStartIdentity,
  getProcessState,
  isAncestorOf,
  ownPid,
  ownProcessGroup,
  verifyRecordedTarget,
} from './tt-process-identity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'tt-process-identity.mjs');

// spawnDetachedChild: a long-lived child in its OWN session + process
// group (setsid via detached:true), so its pgid is disjoint from the test
// runner's ancestry/group — the shape every E3.C kill target is spawned
// under. Returns the ChildProcess; callers MUST kill it in finally.
function spawnDetachedChild() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    detached: true,
    stdio: 'ignore',
  });
}

function killChild(child) {
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
}

function checkCli(pid, expected) {
  return spawnSync(process.execPath, [CLI, '--check', String(pid), String(expected)], {
    encoding: 'utf8',
  });
}

function getCli(pid) {
  return spawnSync(process.execPath, [CLI, '--get', String(pid)], {
    encoding: 'utf8',
  });
}

function verifyCli(pid, expected) {
  const argv = [CLI, '--verify', String(pid)];
  if (expected !== undefined) argv.push(String(expected));
  return spawnSync(process.execPath, argv, {
    encoding: 'utf8',
  });
}

describe('tt-process-identity.mjs', () => {
  describe('getProcessStartIdentity', () => {
    it('is stable for a live process and formatted as proc:<n>', () => {
      const first = getProcessStartIdentity(process.pid);
      assert.match(first, /^proc:\d+$/);
      assert.equal(getProcessStartIdentity(process.pid), first);
    });

    it('differs across distinct processes and is null for unreadable pids', () => {
      const child = spawnDetachedChild();
      try {
        const childId = getProcessStartIdentity(child.pid);
        assert.ok(childId, 'child identity readable while alive');
        assert.notEqual(childId, getProcessStartIdentity(process.pid),
          'distinct processes carry distinct start identities');
      } finally {
        killChild(child);
      }
      assert.equal(getProcessStartIdentity(Number.MAX_SAFE_INTEGER), null);
    });
  });

  describe('getProcessGroup / ownProcessGroup', () => {
    it('returns the caller group and numeric pgids', () => {
      const ownPgid = ownProcessGroup();
      assert.equal(typeof ownPgid, 'number');
      assert.ok(ownPgid > 0);
      assert.equal(getProcessGroup(process.pid), ownPgid);
    });

    it('detached children lead their own disjoint group', () => {
      const child = spawnDetachedChild();
      try {
        assert.equal(getProcessGroup(child.pid), child.pid,
          'setsid child is its own group leader');
        assert.notEqual(getProcessGroup(child.pid), ownProcessGroup(),
          'child group is disjoint from the caller group');
      } finally {
        killChild(child);
      }
    });

    it('returns null for unreadable pids', () => {
      assert.equal(getProcessGroup(Number.MAX_SAFE_INTEGER), null);
    });
  });

  describe('getProcessState', () => {
    it('returns a live-state character for a running process and null for an unreadable pid', () => {
      const state = getProcessState(process.pid);
      assert.ok(state !== null, 'own state readable');
      assert.equal(state.length, 1, 'state is a single character');
      assert.ok('RSDTZtX'.includes(state), `unexpected state char ${state}`);
      assert.equal(getProcessState(Number.MAX_SAFE_INTEGER), null);
    });

    it('reports Z for a SIGKILLed child until it is reaped (identity unchanged)', () => {
      // A SIGKILLed child of the CURRENT process lingers in /proc as a zombie
      // with an UNCHANGED startTime until Node reaps it (the 'exit' event).
      // getProcessState must surface that zombie so a kill-site audit can
      // distinguish a signalled member from a live one.
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        stdio: 'ignore',
      });
      const startTime = getProcessStartIdentity(child.pid);
      assert.ok(startTime, 'child identity readable while alive');
      child.kill('SIGKILL');
      // Spin SYNCHRONOUSLY (never yielding to the event loop) so Node cannot
      // run its SIGCHLD reaping callback: the kernel marks the child Z on
      // SIGKILL delivery and it stays visible until waitpid() reaps it.
      let zombieSeen = false;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (getProcessState(child.pid) === 'Z') { zombieSeen = true; break; }
      }
      assert.equal(zombieSeen, true, 'SIGKILLed child must be observable as a zombie (state Z) before reaping');
      assert.equal(getProcessStartIdentity(child.pid), startTime,
        'a zombie keeps its startTime until reaped — state, not identity, reveals the kill');
      return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
      }).then(() => {
        assert.equal(getProcessState(child.pid), null, 'after reaping the pid is gone');
      });
    });
  });

  describe('isAncestorOf', () => {
    it('walks the ppid chain: parent is an ancestor, self is trivially one', () => {
      assert.equal(isAncestorOf(process.ppid, process.pid), true,
        'parent is an ancestor of the child');
      assert.equal(isAncestorOf(process.pid, process.pid), true,
        'self is trivially its own ancestor');
    });

    it('children are not ancestors of their parent, siblings are not ancestors of each other', () => {
      const child = spawnDetachedChild();
      try {
        assert.equal(isAncestorOf(child.pid, process.pid), false,
          'child is not an ancestor of the parent');
      } finally {
        killChild(child);
      }
      const c1 = spawnDetachedChild();
      const c2 = spawnDetachedChild();
      try {
        assert.equal(isAncestorOf(c1.pid, c2.pid), false,
          'sibling 1 is not an ancestor of sibling 2');
        assert.equal(isAncestorOf(c2.pid, c1.pid), false,
          'sibling 2 is not an ancestor of sibling 1');
      } finally {
        killChild(c1);
        killChild(c2);
      }
    });

    it('is false for unreadable or invalid pids', () => {
      assert.equal(isAncestorOf(Number.MAX_SAFE_INTEGER, process.pid), false);
      assert.equal(isAncestorOf(0, process.pid), false);
      assert.equal(isAncestorOf(process.pid, Number.MAX_SAFE_INTEGER), false);
    });
  });

  describe('verifyRecordedTarget', () => {
    it('accepts a live recorded target with matching identity and disjoint group', () => {
      const child = spawnDetachedChild();
      try {
        const startTime = getProcessStartIdentity(child.pid);
        const pgid = getProcessGroup(child.pid);
        const result = verifyRecordedTarget({ pid: child.pid, pgid, startTime, group: true });
        assert.equal(result.ok, true, result.reason);
        assert.ok(result.reason && result.reason.length > 0);
      } finally {
        killChild(child);
      }
    });

    it('accepts a positive-pid record without group semantics', () => {
      const child = spawnDetachedChild();
      try {
        const startTime = getProcessStartIdentity(child.pid);
        const result = verifyRecordedTarget({ pid: child.pid, startTime });
        assert.equal(result.ok, true, result.reason);
      } finally {
        killChild(child);
      }
    });

    it('refuses a stale startTime (ABA / pid reuse)', () => {
      const child = spawnDetachedChild();
      try {
        const pgid = getProcessGroup(child.pid);
        const result = verifyRecordedTarget({ pid: child.pid, pgid, startTime: 'proc:1', group: true });
        assert.equal(result.ok, false);
        assert.match(result.reason, /startTime/i);
      } finally {
        killChild(child);
      }
    });

    it('refuses a dead pid', async () => {
      const child = spawnDetachedChild();
      const startTime = getProcessStartIdentity(child.pid);
      const exited = new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
      });
      killChild(child);
      await exited; // exit fires only after Node reaps the child (zombie gone)
      const result = verifyRecordedTarget({ pid: child.pid, startTime });
      assert.equal(result.ok, false);
      assert.match(result.reason, /not alive/i);
    });

    it('refuses a target that is an ancestor of the caller', () => {
      const parentStart = getProcessStartIdentity(process.ppid);
      assert.ok(parentStart, 'parent identity readable');
      const result = verifyRecordedTarget({ pid: process.ppid, startTime: parentStart });
      assert.equal(result.ok, false);
      assert.match(result.reason, /ancestor/i);
    });

    it('refuses the caller itself (self is trivially an ancestor)', () => {
      const selfStart = getProcessStartIdentity(process.pid);
      const result = verifyRecordedTarget({ pid: process.pid, startTime: selfStart });
      assert.equal(result.ok, false);
      assert.match(result.reason, /ancestor/i);
    });

    it('refuses a group kill whose target pgid equals the caller pgid', () => {
      // A NON-detached child shares the caller's process group while not
      // being an ancestor of the caller — the pgid-disjointness branch is
      // the one that must fire.
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        stdio: 'ignore',
      });
      try {
        assert.equal(getProcessGroup(child.pid), ownProcessGroup(),
          'non-detached child shares the caller process group');
        const result = verifyRecordedTarget({
          pid: child.pid,
          pgid: ownProcessGroup(),
          startTime: getProcessStartIdentity(child.pid),
          group: true,
        });
        assert.equal(result.ok, false);
        assert.match(result.reason, /pgid/i);
      } finally {
        killChild(child);
      }
    });

    it('refuses a recorded pgid that no longer matches the live target', () => {
      const child = spawnDetachedChild();
      try {
        const startTime = getProcessStartIdentity(child.pid);
        const result = verifyRecordedTarget({
          pid: child.pid,
          pgid: child.pid + 1, // deliberately wrong recorded pgid
          startTime,
          group: true,
        });
        assert.equal(result.ok, false);
        assert.match(result.reason, /pgid/i);
      } finally {
        killChild(child);
      }
    });

    it('refuses an invalid pid record', () => {
      const result = verifyRecordedTarget({ pid: -1 });
      assert.equal(result.ok, false);
      assert.match(result.reason, /invalid pid/i);
    });
  });

  describe('CLI --check mode', () => {
    it('exits 0 for a live pid with a matching startTime', () => {
      const selfOk = checkCli(process.pid, getProcessStartIdentity(process.pid));
      assert.equal(selfOk.status, 0, selfOk.stderr);
      assert.match(selfOk.stdout, /ok/);
    });

    it('exits 1 for a live pid with a stale startTime', () => {
      const child = spawnDetachedChild();
      try {
        const stale = checkCli(child.pid, 'proc:1');
        assert.equal(stale.status, 1);
        assert.match(stale.stderr, /mismatch/i);
      } finally {
        killChild(child);
      }
    });

    it('exits 1 for a dead pid', () => {
      const dead = checkCli(Number.MAX_SAFE_INTEGER, 'proc:1');
      assert.equal(dead.status, 1);
      assert.match(dead.stderr, /not alive/i);
    });

    it('exits 2 on malformed usage', () => {
      const bad = checkCli('not-a-pid');
      assert.equal(bad.status, 2);
      assert.match(bad.stderr, /usage/i);
    });
  });

  describe('CLI --get mode', () => {
    it('prints the proc:<n> identity of a live pid and exits 0', () => {
      const got = getCli(process.pid);
      assert.equal(got.status, 0, got.stderr);
      assert.match(got.stdout.trim(), /^proc:\d+$/);
      assert.equal(got.stdout.trim(), getProcessStartIdentity(process.pid));
    });

    it('exits 1 for an unreadable pid', () => {
      const dead = getCli(Number.MAX_SAFE_INTEGER);
      assert.equal(dead.status, 1);
      assert.match(dead.stderr, /not alive|unreadable/i);
    });

    it('exits 2 on malformed usage', () => {
      const bad = getCli('not-a-pid');
      assert.equal(bad.status, 2);
      assert.match(bad.stderr, /usage/i);
    });
  });

  describe('CLI --verify mode', () => {
    it('accepts a live detached target with matching identity', () => {
      const child = spawnDetachedChild();
      try {
        const startTime = getProcessStartIdentity(child.pid);
        const ok = verifyCli(child.pid, startTime);
        assert.equal(ok.status, 0, ok.stderr);
        assert.match(ok.stdout, /ok/);
      } finally {
        killChild(child);
      }
    });

    it('accepts a live detached target with no recorded identity (identity-blind check)', () => {
      const child = spawnDetachedChild();
      try {
        const ok = verifyCli(child.pid);
        assert.equal(ok.status, 0, ok.stderr);
      } finally {
        killChild(child);
      }
    });

    it('refuses a stale startTime (ABA / pid reuse)', () => {
      const child = spawnDetachedChild();
      try {
        const stale = verifyCli(child.pid, 'proc:1');
        assert.equal(stale.status, 1);
        assert.match(stale.stderr, /startTime/i);
      } finally {
        killChild(child);
      }
    });

    it('refuses the caller itself (self is trivially an ancestor)', () => {
      const self = verifyCli(process.pid, getProcessStartIdentity(process.pid));
      assert.equal(self.status, 1);
      assert.match(self.stderr, /ancestor/i);
    });

    it('refuses a group-mate (non-detached child shares the caller pgid)', () => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        stdio: 'ignore',
      });
      try {
        assert.equal(getProcessGroup(child.pid), ownProcessGroup(),
          'non-detached child shares the caller process group');
        const mate = verifyCli(child.pid, getProcessStartIdentity(child.pid));
        assert.equal(mate.status, 1);
        assert.match(mate.stderr, /pgid/i);
      } finally {
        killChild(child);
      }
    });

    it('refuses a dead pid', () => {
      const dead = verifyCli(Number.MAX_SAFE_INTEGER, 'proc:1');
      assert.equal(dead.status, 1);
      assert.match(dead.stderr, /not alive/i);
    });

    it('exits 2 on malformed usage', () => {
      const bad = verifyCli('not-a-pid');
      assert.equal(bad.status, 2);
      assert.match(bad.stderr, /usage/i);
    });
  });
});
