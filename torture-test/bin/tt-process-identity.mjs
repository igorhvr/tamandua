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
// Darwin (MACP4 US-002): no procfs — the start identity comes from
// `ps -p <pid> -o lstart=` ('darwin:<lstart>', 1-second granularity —
// see getDarwinStartIdentity). The identity-gated daemon stop/escalation
// corridors (daemon-control verify_recorded_identity / --check) therefore
// work on /proc-less hosts too.
//
// MCHA (R4a US-014): the pgid/ppid/ancestry gates that ONLY had a procfs
// source REFUSED fail-closed on Darwin even when the target was legitimate
// (mac campaign #1 W4.09-pi / W4.09-hermes / W4.10-kill-daemon / W4.48a:
// every chaos kill ended chaos-invocation-failed, exit 3 GUARD_MISS
// 'cannot read the process group of daemon pid N'). The pgid/parent and
// cwd/cmdline readers below are therefore PORTABLE: on linux they keep the
// /proc read; on /proc-less hosts they use the mechanical ps/lsof evidence
// (`ps -p <pid> -o pgid=`, `ps -p <pid> -o ppid=`, `ps -p <pid>
// -o command=`, `lsof -a -p <pid> -d cwd -Fn` — BSD and procps both
// support these), with a fail-closed null whenever the portable evidence
// is unavailable. The platform branch is decided by the same
// TT_PROCESS_IDENTITY_PLATFORM seam the identity source uses, so Darwin is
// hermetically simulatable on linux.
//
// CLI mode (bash-callable, consumed by bin/daemon-control and the kill
// sites):
//   tt-process-identity.mjs --check <pid> <expectedStartTime>
//     exit 0 when <pid> is alive and its current start identity equals
//     <expectedStartTime>; exit 1 otherwise, with a one-line reason.
//   tt-process-identity.mjs --get <pid>
//     print the current start identity ('proc:<starttime>' on linux,
//     'darwin:<lstart>' on /proc-less hosts) of <pid> on stdout, exit 0;
//     exit 1 with a one-line reason when unreadable
//     (daemon-control records this at daemon start — US-004).
//   tt-process-identity.mjs --verify <pid> [expectedStartTime]
//     full signal-target verification (US-004 lingering-listener gate):
//     pid alive, startTime match when an expected identity is given,
//     target is NOT an ancestor of the verifier, and the target's pgid is
//     disjoint from the verifier's own pgid. exit 0 when verified, exit 1
//     with a one-line reason otherwise.
//
// Injectable test seams (MACP4 US-002 + MCHA US-014):
//   TT_PROCESS_IDENTITY_PLATFORM = linux|darwin — force the platform
//     branch on any host (hermetic Darwin simulation on linux).
//   TT_PROCESS_IDENTITY_PS = <ps binary path> — shim the ps invocation
//     (deterministic lstart/pgid/ppid/command output, or a failing ps for
//     the null->refusal proof).
//   TT_PROCESS_IDENTITY_LSOF = <lsof binary path> — shim the lsof
//     invocation used by the Darwin cwd reader (default 'lsof').
//
// Exports are safe to import from other torture-test modules; the CLI only
// triggers on an explicit argv.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// ── procfs helpers ─────────────────────────────────────────────────

// readProcStat: parse /proc/<pid>/stat into { state, ppid, pgrp, starttime }.
// /proc/<pid>/stat is linux-only — Darwin has no procfs. Every reader of
// this helper already treats `null` as "cannot introspect" (unavailable),
// so on Darwin the helper simply degrades to null instead of hard-failing;
// getProcessStartIdentity additionally dispatches on platform (linux /proc
// vs the Darwin ps-lstart source — MACP4 US-002).
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

// ── Darwin identity source ────────────────────────────────────────────
//
// Darwin has no procfs, so the linux /proc starttime identity is
// unavailable. MACP4 US-002: use a MECHANICAL source that both BSD ps
// (macOS) and procps (linux) support: `ps -p <pid> -o lstart=` — the full
// process start timestamp (e.g. "Sun Aug 23 18:19:00 2026"). The identity
// string is 'darwin:<lstart>'.
//
// COARSER GRANULARITY (documented): /proc starttime counts clock ticks
// since boot (jiffies) — a pid-reuse within the same jiffy is
// astronomically unlikely; lstart has 1-SECOND resolution, so a pid reused
// within the same second of the recorded lstart would NOT be detected by
// the startTime comparison alone. The kill sites' other fail-closed gates
// (TT-owned cwd/cmdline evidence, pgid/ancestry where readable) are
// therefore MORE load-bearing on Darwin than on linux — they must never be
// relaxed. On the fallback launch path the daemon is a plain nohup child
// recorded in provenance, and stop_cli_auto_daemon re-verifies TT-ownership
// + identity before every signal, so the 1-second window is acceptable.
//
// The darwin branch is the ONLY identity source on /proc-less hosts; every
// existing E3.C.1 fail-closed refusal is preserved: when the pid is
// unverifiable (dead / ps unreadable) this returns null and every caller
// REFUSES to signal — never signals on weak evidence.
//
// Injectable seams (MACP4 US-002, hermetic tests — see
// self-tests/tier1-daemon-control-darwin-identity.test.ts):
//   TT_PROCESS_IDENTITY_PLATFORM   force the platform branch on any host
//                                  ('linux' | 'darwin'); default process.platform
//   TT_PROCESS_IDENTITY_PS         ps binary to invoke (default 'ps'); a PATH
//                                  or binary seam so tests can shim ps (a
//                                  deterministic lstart, or a failing ps to
//                                  prove the null->refusal semantics)

// ttPlatform: the evidence platform — the TT_PROCESS_IDENTITY_PLATFORM seam
// (hermetic Darwin simulation on linux) or process.platform, read at CALL
// time so tests can shim it mid-flight.
function ttPlatform() {
  return process.env.TT_PROCESS_IDENTITY_PLATFORM ?? process.platform;
}

// runPsField: `ps -p <pid> -o <field>=` — BSD ps (macOS) and procps (linux)
// both support the -o <field>= form, so the SAME invocation is the portable
// evidence source for the pgid/ppid/command/lstart fields on every host.
// Returns the trimmed stdout line, or null when ps is unavailable / exits
// non-zero / prints nothing (fail-closed — every caller refuses on null).
// The TT_PROCESS_IDENTITY_PS seam shims the binary (deterministic output,
// or a failing ps for the null->refusal proofs).
function runPsField(pid, field) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const psBin = process.env.TT_PROCESS_IDENTITY_PS ?? 'ps';
  let res;
  try {
    res = spawnSync(psBin, ['-p', String(pid), '-o', `${field}=`], {
      encoding: 'utf8',
      timeout: 10_000,
    });
  } catch {
    return null;
  }
  if (res.status !== 0) return null;
  const out = String(res.stdout ?? '').trim();
  return out === '' ? null : out;
}

// runLsofCwd: the process cwd via `lsof -a -p <pid> -d cwd -Fn` — lsof
// prints the cwd as an `n<path>` name row (the p<pid> row and the fd-name
// row, if any, are ignored); BSD/linux lsof both emit that shape. Returns
// the path, or null when lsof is unavailable / the pid is dead or foreign
// (fail-closed — a caller that cannot prove the cwd refuses).
function runLsofCwd(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const lsofBin = process.env.TT_PROCESS_IDENTITY_LSOF ?? 'lsof';
  let res;
  try {
    res = spawnSync(lsofBin, ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
  } catch {
    return null;
  }
  if (res.status !== 0) return null;
  const rows = String(res.stdout ?? '').split('\n');
  for (const row of rows) {
    if (row.startsWith('n') && row.length > 1) {
      const cwd = row.slice(1).trim();
      if (cwd !== '') return cwd;
    }
  }
  return null;
}

// ── Darwin identity source ────────────────────────────────────────────

// getDarwinStartIdentity: 'darwin:<lstart>' via `ps -p <pid> -o lstart=`,
// null when the pid is invalid, ps is unavailable, or the pid is not alive
// (ps exits non-zero / prints no lstart row).
export function getDarwinStartIdentity(pid) {
  const lstart = runPsField(pid, 'lstart');
  return lstart === null ? null : `darwin:${lstart}`;
}

// ── public identity primitives ─────────────────────────────────────

// getProcessStartIdentity: stable process-start identity for ABA reuse
// protection — 'proc:<starttime>' on linux (via /proc), 'darwin:<lstart>'
// on /proc-less hosts (via ps -p <pid> -o lstart=, MACP4 US-002), null
// when unreadable. Mirrors src/lib/process-start-identity.ts semantics on
// linux; the Darwin source is the mechanical /proc-free identity the W2
// scripted cells need for daemon stop/escalation identity gates.
// TT_PROCESS_IDENTITY_PLATFORM forces the branch on any host (hermetic
// test seam; linux behavior is identical when unset).
export function getProcessStartIdentity(pid) {
  const platform = ttPlatform();
  if (platform === 'linux') {
    const stat = readProcStat(pid);
    return stat === null ? null : `proc:${stat.starttime}`;
  }
  if (platform === 'darwin') {
    return getDarwinStartIdentity(pid);
  }
  return null;
}

// getProcessGroup: the process group id of a pid — /proc/<pid>/stat field 5
// on linux, `ps -p <pid> -o pgid=` on /proc-less hosts (MCHA US-014), null
// when unreadable. The darwin arm is the SAME mechanical source family as
// the identity arm; a pid whose pgid is unreadable on EITHER branch returns
// null and every caller refuses fail-closed.
export function getProcessGroup(pid) {
  if (ttPlatform() === 'darwin') {
    const out = runPsField(pid, 'pgid');
    if (out === null) return null;
    const pgid = Number(out);
    return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
  }
  const stat = readProcStat(pid);
  return stat === null ? null : stat.pgrp;
}

// getProcessState: the current process state character (stat field 3) of a
// pid — 'R'/'S'/'D'/'Z'/'T'/..., null when unreadable. 'Z' (zombie) means the
// process has terminated but not yet been reaped by its parent — a kill-site
// audit can use this to prove a supposed survivor was actually signalled
// (a SIGKILLed member of the caller's own process group lingers as a zombie
// with an UNCHANGED startTime until reaped, so the startTime ABA check alone
// cannot distinguish it from a live process). /proc-only (linux); on
// /proc-less hosts it degrades to null ("state unprovable") — never a false
// positive.
export function getProcessState(pid) {
  const stat = readProcStat(pid);
  return stat === null ? null : stat.state;
}

// getProcessParent: the ppid of a pid — /proc/<pid>/stat field 4 on linux,
// `ps -p <pid> -o ppid=` on /proc-less hosts (MCHA US-014), null when
// unreadable. The parent-chain walk (S33 US-004 — tt-chaos
// verifyHarnessIdentityChain) uses this to walk a target's ancestry and
// check each ancestor's cwd/cmdline for TT-ownership. A host whose ppid
// evidence is unreadable degrades to null (unprovable), never to a false
// positive.
export function getProcessParent(pid) {
  if (ttPlatform() === 'darwin') {
    const out = runPsField(pid, 'ppid');
    if (out === null) return null;
    const ppid = Number(out);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  }
  const stat = readProcStat(pid);
  return stat === null ? null : stat.ppid;
}

// getProcessCwd: the process working directory — /proc/<pid>/cwd on linux,
// `lsof -a -p <pid> -d cwd -Fn` on /proc-less hosts (MCHA US-014; the same
// portable evidence daemon-control verify_process_tt_owned uses), null when
// unreadable. Never resolves a target — it verifies an ALREADY-RECORDED pid.
export function getProcessCwd(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (ttPlatform() === 'darwin') {
    return runLsofCwd(pid);
  }
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`); // linux-only (MACP3 US-003): darwin arm above
  } catch {
    return null;
  }
}

// getProcessCmdline: the process command line — /proc/<pid>/cmdline on
// linux, `ps -p <pid> -o command=` on /proc-less hosts (MCHA US-014; the
// same portable evidence daemon-control uses), null when unreadable. Never
// resolves a target — it verifies an ALREADY-RECORDED pid.
export function getProcessCmdline(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (ttPlatform() === 'darwin') {
    return runPsField(pid, 'command');
  }
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); // linux-only (MACP3 US-003): darwin arm above
    const joined = cmdline.replace(/\0/g, ' ').trim();
    return joined === '' ? null : joined;
  } catch {
    return null;
  }
}

export function ownPid() {
  return process.pid;
}

export function ownProcessGroup() {
  return getProcessGroup(process.pid);
}

// ── tri-state ancestry (SGRD R4a US-014) ─────────────────────────────
//
// isAncestorOf answers the BOOLEAN question ("true when targetPid is an
// ancestor of selfPid") and, by contract, returns false whenever the ppid
// walk cannot complete (unreadable parent evidence, a cycle, depth
// exhaustion, pid 1/root) — false is NOT a verdict. A KILL GUARD must not
// treat that false as a proven non-ancestor: the signal guard refuses
// unless the ancestry is PROVEN disjoint. classifyAncestry below is the
// tri-state verdict the guards consume; isAncestorOf keeps its observable
// boolean behavior (unknown → false) for the non-guard queries.

// rawParentPidOf: the RAW parent pid of <pid> for the ancestry walk — 0
// when <pid> is a root process (its parent is 0 — pid 1 on a normal host),
// null when the parent evidence is unreadable, >0 otherwise. This
// deliberately bypasses getProcessParent's ppid>0 filter (which maps
// "parent is 0" to null and would conflate a fully-observed root with an
// unreadable read — the SGRD fail-open root cause).
function rawParentPidOf(pid) {
  if (ttPlatform() === 'darwin') {
    const out = runPsField(pid, 'ppid');
    if (out === null) return null;
    const ppid = Number(out);
    return Number.isInteger(ppid) && ppid >= 0 ? ppid : null;
  }
  // linux arm: /proc/<pid>/stat ppid field, parsed WITHOUT the ppid>0
  // filter readProcStat applies (linux-only — the darwin arm above is the
  // /proc-less branch, MACP3 US-003).
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let stat;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const after = stat.slice(close + 2).trim().split(/\s+/);
  const ppid = Number(after[1]);
  return Number.isInteger(ppid) && ppid >= 0 ? ppid : null;
}

// classifyAncestry: tri-state ancestry verdict for the signal guards —
//   'ancestor'  targetPid is an ancestor of selfPid (self included);
//   'disjoint'  a FULLY OBSERVED ppid walk from selfPid to the root (a pid
//               whose parent is 0) never met targetPid — the only verdict
//               a guard may treat as proven non-ancestor;
//   'unknown'   the walk could not be completed — unreadable parent
//               evidence, a ppid cycle, or the 1024-hop depth cap. A guard
//               must REFUSE on 'unknown' (never a weak accept).
export function classifyAncestry(targetPid, selfPid) {
  if (!Number.isInteger(targetPid) || !Number.isInteger(selfPid)) return 'unknown';
  if (targetPid <= 0 || selfPid <= 0) return 'unknown';
  const seen = new Set();
  let cur = selfPid;
  for (let i = 0; i < 1024; i += 1) {
    if (cur === targetPid) return 'ancestor';
    if (seen.has(cur)) return 'unknown'; // ppid cycle — no verdict
    seen.add(cur);
    const parent = rawParentPidOf(cur);
    if (parent === 0) return 'disjoint'; // fully observed walk to the root
    if (parent === null) return 'unknown'; // unreadable parent evidence — no verdict
    cur = parent;
  }
  return 'unknown'; // depth cap — no verdict
}

// isAncestorOf: true when targetPid is an ancestor of selfPid (walks the
// ppid chain from selfPid upward via getProcessParent, so the walk is
// portable — /proc on linux, `ps -o ppid=` on procfs-less hosts (MCHA
// US-014); self is trivially its own ancestor; pid 0/1 and ppid cycles
// terminate the walk as false — the boolean contract: an uncompleted walk
// is NOT a proven ancestor, and a kill guard MUST NOT read this false as
// "proven non-ancestor". The guards use classifyAncestry (above) and
// refuse on 'unknown' instead.
export function isAncestorOf(targetPid, selfPid) {
  if (!Number.isInteger(targetPid) || !Number.isInteger(selfPid)) return false;
  if (targetPid <= 0 || selfPid <= 0) return false;
  let cur = selfPid;
  for (let i = 0; i < 1024; i += 1) {
    if (cur === targetPid) return true;
    const parent = getProcessParent(cur);
    if (parent === null) return false;
    if (parent === cur || parent <= 0) return false; // cycle / kernel thread / init
    cur = parent;
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
//   * the target must NOT be an ancestor of the caller, and the ancestry
//     must be PROVEN disjoint — an uncompleted ppid walk (unreadable parent
//     evidence, a cycle, depth exhaustion) is 'unknown' and REFUSES (SGRD
//     R4a US-014: an incomplete ancestry observation is never a proven
//     non-ancestor);
//   * for group kills (record.group === true, or a pgid is recorded) the
//     target's current pgid must equal the recorded pgid (when recorded)
//     and must be disjoint from the caller's own pgid — a caller whose own
//     pgid is UNREADABLE cannot have its disjointness proven and REFUSES
//     (SGRD R4a US-014: comparing a pgid with null is not disjointness).
export function verifyRecordedTarget(record = {}) {
  const pid = record.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: `invalid pid ${String(pid)}` };
  }
  const current = getProcessStartIdentity(pid);
  if (current === null) {
    return { ok: false, reason: `target pid ${pid} is not alive (or its start identity is unreadable)` };
  }
  if (record.startTime !== undefined && record.startTime !== null && record.startTime !== current) {
    return {
      ok: false,
      reason: `startTime mismatch for pid ${pid}: recorded ${record.startTime} != current ${current} (pid reuse / ABA)`,
    };
  }
  const ancestry = classifyAncestry(pid, ownPid());
  if (ancestry === 'ancestor') {
    return { ok: false, reason: `target pid ${pid} is an ancestor of the caller — refusing to signal own ancestry` };
  }
  if (ancestry === 'unknown') {
    return { ok: false, reason: `cannot establish that target pid ${pid} is not an ancestor of the caller (parent evidence unreadable, cyclic, or depth-exhausted) — refusing to signal` };
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
    if (ownPgid === null) {
      return { ok: false, reason: `cannot read the caller's own process group — group disjointness from the caller cannot be verified, refusing to signal pid ${pid}` };
    }
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
    console.error(`tt-process-identity: pid ${pid} not alive or identity unreadable`);
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
    console.error(`tt-process-identity: pid ${pid} not alive or identity unreadable`);
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
