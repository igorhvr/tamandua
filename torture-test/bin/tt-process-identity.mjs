#!/usr/bin/env node
// tt-process-identity.mjs — torture-test-local process-kill safety
// primitives (E3.C.1 US-001).
//
// Every E3.C kill site must verify a target's process-start identity and its
// ancestry/group disjointness from the caller BEFORE signalling. This module
// replicates the C2.2/FIX9.1 process-start-identity pattern
// (src/lib/process-start-identity.ts) locally, inside the torture-test diff
// scope, plus the group/ancestry checks the kill sites need.
//
// Procfs semantics (linux): /proc/<pid>/stat fields —
//   field 4  = ppid      -> afterComm[1]
//   field 5  = pgrp      -> afterComm[2]
//   field 22 = starttime -> afterComm[19]
// after the comm field (which may contain spaces/parens) is stripped by
// slicing at the LAST ')'.
//
// CLI mode (bash-callable, consumed by bin/daemon-control and the kill
// sites):
//   tt-process-identity.mjs --check <pid> <expectedStartTime>
//     exit 0 when <pid> is alive and its current /proc starttime equals
//     <expectedStartTime>; exit 1 otherwise, with a one-line reason.
//   tt-process-identity.mjs --get <pid>
//     print the current start identity ('proc:<starttime>') of <pid> on
//     stdout, exit 0; exit 1 with a one-line reason when unreadable
//     (daemon-control records this at daemon start — US-004).
//   tt-process-identity.mjs --verify <pid> [expectedStartTime]
//     full signal-target verification (US-004 lingering-listener gate):
//     pid alive, startTime match when an expected identity is given,
//     target is NOT an ancestor of the verifier, and the target's pgid is
//     disjoint from the verifier's own pgid. exit 0 when verified, exit 1
//     with a one-line reason otherwise.
//
// Exports are safe to import from other torture-test modules; the CLI only
// triggers on an explicit argv.

import fs from 'node:fs';

// ── procfs helpers ─────────────────────────────────────────────────

// readProcStat: parse /proc/<pid>/stat into { state, ppid, pgrp, starttime }.
// /proc/<pid>/stat is linux-only — Darwin has no procfs. Every reader of
// this helper already treats `null` as "cannot introspect" (unavailable),
// so on Darwin the helper simply degrades to null instead of hard-failing;
// getProcessStartIdentity additionally short-circuits on platform !== linux.
// linux-only /proc usage — guarded for Darwin via null-degradation
// (MACP3 US-003).
// Returns null when the pid is invalid or the entry is unreadable
// (ESRCH / EACCES) or malformed.
function readProcStat(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let stat;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); // linux-only (MACP3 US-003): guarded for Darwin via null-degradation above
  } catch {
    return null;
  }
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const after = stat.slice(close + 2).trim().split(/\s+/);
  // after[0] = state (field 3), after[1] = ppid (field 4),
  // after[2] = pgrp (field 5), ..., after[19] = starttime (field 22)
  if (after.length <= 19) return null;
  const state = after[0];
  const ppid = Number(after[1]);
  const pgrp = Number(after[2]);
  const starttime = after[19];
  if (!Number.isInteger(ppid) || ppid <= 0) return null;
  if (!Number.isInteger(pgrp) || pgrp <= 0) return null;
  if (!/^\d+$/.test(starttime)) return null;
  return { state, ppid, pgrp, starttime };
}

// ── public identity primitives ─────────────────────────────────────

// getProcessStartIdentity: stable process-start identity for ABA reuse
// protection — 'proc:<starttime>' on linux, null when unreadable.
// Mirrors src/lib/process-start-identity.ts semantics.
export function getProcessStartIdentity(pid) {
  if (process.platform !== 'linux') return null;
  const stat = readProcStat(pid);
  return stat === null ? null : `proc:${stat.starttime}`;
}

// getProcessGroup: the process group id (stat field 5) of a pid,
// null when unreadable.
export function getProcessGroup(pid) {
  const stat = readProcStat(pid);
  return stat === null ? null : stat.pgrp;
}

// getProcessState: the current process state character (stat field 3) of a
// pid — 'R'/'S'/'D'/'Z'/'T'/..., null when unreadable. 'Z' (zombie) means the
// process has terminated but not yet been reaped by its parent — a kill-site
// audit can use this to prove a supposed survivor was actually signalled
// (a SIGKILLed member of the caller's own process group lingers as a zombie
// with an UNCHANGED startTime until reaped, so the startTime ABA check alone
// cannot distinguish it from a live process).
export function getProcessState(pid) {
  const stat = readProcStat(pid);
  return stat === null ? null : stat.state;
}

export function ownPid() {
  return process.pid;
}

export function ownProcessGroup() {
  return getProcessGroup(process.pid);
}

// isAncestorOf: true when targetPid is an ancestor of selfPid (walks the
// /proc ppid chain from selfPid upward; self is trivially its own
// ancestor; pid 0/1 and ppid cycles terminate the walk as false).
export function isAncestorOf(targetPid, selfPid) {
  if (!Number.isInteger(targetPid) || !Number.isInteger(selfPid)) return false;
  if (targetPid <= 0 || selfPid <= 0) return false;
  let cur = selfPid;
  for (let i = 0; i < 1024; i += 1) {
    if (cur === targetPid) return true;
    const stat = readProcStat(cur);
    if (stat === null) return false;
    if (stat.ppid === cur || stat.ppid <= 0) return false; // cycle / kernel thread / init
    cur = stat.ppid;
  }
  return false;
}

// verifyRecordedTarget: mechanically verify a recorded kill target before
// any signal is fired. record: { pid, startTime?, pgid?, group? }.
//
// Returns { ok, reason }:
//   * pid must be a live, readable process;
//   * when record.startTime is present it must equal the CURRENT /proc
//     starttime (ABA / pid-reuse refusal on mismatch);
//   * the target must NOT be an ancestor of the caller (a kill that can
//     reach the caller's own ancestry is refused);
//   * for group kills (record.group === true, or a pgid is recorded) the
//     target's current pgid must equal the recorded pgid (when recorded)
//     and must be disjoint from the caller's own pgid.
export function verifyRecordedTarget(record = {}) {
  const pid = record.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: `invalid pid ${String(pid)}` };
  }
  const current = getProcessStartIdentity(pid);
  if (current === null) {
    return { ok: false, reason: `target pid ${pid} is not alive (or /proc unreadable)` };
  }
  if (record.startTime !== undefined && record.startTime !== null && record.startTime !== current) {
    return {
      ok: false,
      reason: `startTime mismatch for pid ${pid}: recorded ${record.startTime} != current ${current} (pid reuse / ABA)`,
    };
  }
  if (isAncestorOf(pid, ownPid())) {
    return { ok: false, reason: `target pid ${pid} is an ancestor of the caller — refusing to signal own ancestry` };
  }
  const groupKill = record.group === true || record.pgid !== undefined;
  if (groupKill) {
    const pgid = getProcessGroup(pid);
    if (pgid === null) {
      return { ok: false, reason: `cannot read pgid for pid ${pid}` };
    }
    if (record.pgid !== undefined && record.pgid !== null && pgid !== record.pgid) {
      return { ok: false, reason: `pgid mismatch for pid ${pid}: recorded ${record.pgid} != current ${pgid}` };
    }
    const ownPgid = ownProcessGroup();
    if (pgid === ownPgid) {
      return { ok: false, reason: `target pgid ${pgid} equals the caller's own pgid — group kill would signal the caller` };
    }
  }
  return { ok: true, reason: `ok: pid ${pid} alive with recorded identity` };
}

// ── CLI mode ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args[0] === '--check') {
  const pid = Number(args[1]);
  const expected = args[2];
  if (!Number.isInteger(pid) || pid <= 0 || expected === undefined) {
    console.error('usage: tt-process-identity.mjs --check <pid> <expectedStartTime>');
    process.exit(2);
  }
  const current = getProcessStartIdentity(pid);
  if (current === null) {
    console.error(`tt-process-identity: pid ${pid} not alive or /proc unreadable`);
    process.exit(1);
  }
  if (current !== expected) {
    console.error(`tt-process-identity: startTime mismatch for pid ${pid} (expected ${expected}, got ${current})`);
    process.exit(1);
  }
  console.log(`tt-process-identity: ok pid ${pid} startTime ${current}`);
  process.exit(0);
}

if (args[0] === '--get') {
  const pid = Number(args[1]);
  if (!Number.isInteger(pid) || pid <= 0) {
    console.error('usage: tt-process-identity.mjs --get <pid>');
    process.exit(2);
  }
  const identity = getProcessStartIdentity(pid);
  if (identity === null) {
    console.error(`tt-process-identity: pid ${pid} not alive or /proc unreadable`);
    process.exit(1);
  }
  console.log(identity);
  process.exit(0);
}

if (args[0] === '--verify') {
  const pid = Number(args[1]);
  const expected = args[2];
  if (!Number.isInteger(pid) || pid <= 0) {
    console.error('usage: tt-process-identity.mjs --verify <pid> [expectedStartTime]');
    process.exit(2);
  }
  const record = { pid, group: true };
  if (expected !== undefined && expected !== '' && expected !== 'null') {
    record.startTime = expected;
  }
  const result = verifyRecordedTarget(record);
  if (!result.ok) {
    console.error(`tt-process-identity: ${result.reason}`);
    process.exit(1);
  }
  console.log(`tt-process-identity: ok ${result.reason}`);
  process.exit(0);
}
