#!/usr/bin/env node
// reap-live-pgids.mjs — identity-verified reaping of recorded live pgids
// (E3.C.1 US-005).
//
// The O4 mutation harness (generate-o4-fixtures.mjs -> o4.test.mjs and
// oracles/self-test/run.sh) spawns detached sleeps as "provably alive"
// claim_pgid probes for the green-clean fixture and must reap them once the
// oracle run is done. The pre-fix code recorded ONLY pgids and SIGKILLed each
// entry blindly: if a recorded pgid was stale (the sleep had exited) and the
// pid had been reused by a process in the worker's ancestry, the kill hit the
// wrong process — the US-010 incident, FIX9.1 stale-orphan class.
//
// This module is the ONE reaper every consumer shares (o4.test.mjs's
// finally-reaper, run.sh's live-pgids reaper, and the generator's own
// uncaughtException cleanup). It kills a recorded pgid only when the record's
// process-start identity is verified against the CURRENT /proc state (ABA-safe
// startTime match via tt-process-identity.mjs verifyRecordedTarget — that
// source is the linux-only /proc filesystem; on a /proc-less Darwin host the
// verifier returns null and every record is skipped with the stale-skip
// warning below, never mis-killed: graceful degradation, MACP3 US-003) and
// the pgid is disjoint from the reaper's own process group — so a kill can
// never reach the reaper's own ancestry. Records that fail verification are
// SKIPPED with a stale-skip warning (a leaked sleep is accepted over a
// wrong-process kill).
//
// Exports:
//   reapLivePgids(records) -> { reaped: [{record, method}], skipped: [{record, reason}] }
//     records: array of { pid, pgid, startTime } (the generate-o4-fixtures.mjs
//     live-pgids.json shape).
//   spawnDetachedGroupLeader(command, args) -> { pid, pgid, startTime, child }
//     spawn `command` detached (setsid) so it leads its own process group
//     (pid === pgid, disjoint from the caller's group), wait for group
//     leadership, and return its recorded identity. Throws when the child
//     cannot be confirmed as its own group leader.
//
// CLI (consumed by oracles/self-test/run.sh):
//   node reap-live-pgids.mjs <live-pgids.json>
//     reads the JSON record array, reaps every identity-verified entry,
//     prints a stale-skip warning per skipped entry on stderr, exits 0.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { getProcessGroup, getProcessStartIdentity, verifyRecordedTarget } from '../../bin/tt-process-identity.mjs';

// sleepSync: block the current thread for `ms` milliseconds without touching
// the event loop (fine here — spawn identity reads are synchronous anyway).
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// spawnDetachedGroupLeader: spawn `command` detached (setsid) so it becomes
// its own session/group leader — pid === pgid, disjoint from the caller's
// process group — and return its recorded process identity. The detached
// child calls setsid() before exec, so the group-leader state may take a few
// ms to appear; wait for it rather than recording a transient pgid.
export function spawnDetachedGroupLeader(command, args = []) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
  const pid = child.pid;
  const startTime = getProcessStartIdentity(pid);
  let pgid = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    pgid = getProcessGroup(pid);
    if (pgid === pid) break;
    sleepSync(5);
  }
  if (pgid === null || pgid !== pid || startTime === null) {
    // The child cannot be a safe group-kill target — kill the single pid
    // (best-effort, positive pid only) and refuse to record it.
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    throw new Error(`spawnDetachedGroupLeader: pid ${pid} pgid ${pgid} startTime ${startTime} — expected a detached group leader (pid === pgid)`);
  }
  return { pid, pgid, startTime, child };
}

// reapLivePgids: reap every recorded live pgid whose process-start identity
// still matches the CURRENT /proc state (ABA-safe — linux-only source, guarded
// for the /proc-less Darwin case by the verifier null-degradation in
// tt-process-identity.mjs: records then skip, never mis-kill; MACP3 US-003)
// and whose group is disjoint from the reaper's own process group. Anything
// else is skipped — never signalled. Group kill (kill(-pgid)) is used only
// after verifying pgid == recorded pgid and group disjointness; a positive-
// pid kill with the same identity check is the fallback if the group kill
// fails.
export function reapLivePgids(records) {
  const reaped = [];
  const skipped = [];
  for (const record of records) {
    const verified = verifyRecordedTarget({
      pid: record.pid,
      pgid: record.pgid,
      startTime: record.startTime,
      group: true,
    });
    if (!verified.ok) {
      skipped.push({ record, reason: verified.reason });
      continue;
    }
    // The recorded pgid was verified as the live child's own group, disjoint
    // from the reaper's group — group-kill it.
    try {
      process.kill(-record.pgid, 'SIGKILL');
      reaped.push({ record, method: 'group' });
      continue;
    } catch (groupError) {
      // The group dissolved between verification and the signal (or the
      // leader died). Fall back to a positive-pid kill, re-verifying the
      // pid's identity first — never signal without the check.
      const reVerified = verifyRecordedTarget({
        pid: record.pid,
        pgid: record.pgid,
        startTime: record.startTime,
        group: true,
      });
      if (!reVerified.ok) {
        skipped.push({ record, reason: `group kill failed (${groupError.message}); ${reVerified.reason}` });
        continue;
      }
      try {
        process.kill(record.pid, 'SIGKILL');
        reaped.push({ record, method: 'pid' });
      } catch (pidError) {
        skipped.push({ record, reason: `pid kill failed: ${pidError.message}` });
      }
    }
  }
  return { reaped, skipped };
}

// ── CLI mode ───────────────────────────────────────────────────────

// Gate on import.meta.main (not argv length): the generator and the test
// modules IMPORT this module, and their own argv must not trigger the CLI
// reaper (the generator passes its workspace directory as argv[2]).
if (import.meta.main) {
  const args = process.argv.slice(2);
  const records = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  const { reaped, skipped } = reapLivePgids(records);
  for (const skip of skipped) {
    console.error(`reap-live-pgids: stale-skip pid ${skip.record.pid} pgid ${skip.record.pgid}: ${skip.reason}`);
  }
  console.error(`reap-live-pgids: reaped ${reaped.length} live pgid record(s), skipped ${skipped.length} stale/unverifiable record(s)`);
  process.exit(0);
}
