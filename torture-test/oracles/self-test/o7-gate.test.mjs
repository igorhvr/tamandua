#!/usr/bin/env node
// O7 REAL ROTATION-LOSS GATE (torture-test only; STORM-O7).
//
// Drives a small deterministic SCRIPTED run through an ACTUAL private
// daemon + scheduler and the FROZEN scripted harness, using REAL
// claim/complete lifecycle APIs, and causes at least THREE actual
// normal-size native-emitter rotations (20 MiB cap, 3 retained archives)
// of the GLOBAL events stream. The complete known event train — real
// lifecycle records plus declared volume events — must reconstruct from
// the retained segments with correct order/count/identity; the O7 oracle
// then PASSes over the captured evidence.
//
// Close-correction design (all real native code, zero model invocations):
//   - EVERY child is owned by exact handle from the moment it is spawned:
//     ownedSpawn retains the positive stdio-CLOSE observation at spawn time —
//     BEFORE any outcome/readiness logic — and hands out a promise for that
//     SAME real close event. stopChild awaits the retained observation and
//     NEVER infers close from exitCode/signalCode (those prove process EXIT,
//     not stdio CLOSE; an exited child can keep its pipes open through a
//     descendant). An exited process is never re-signaled; spawn failure,
//     readiness failure, timeout, pending pipe closure and never-closing
//     pipes are all bounded, and an unobservable/never-arriving close is an
//     explicit cleanup failure — never a fabricated success.
//   - The main gate after-hook runs closeAllOwned and SURFACES every cleanup
//     failure (including after a primary assertion/readiness failure): a
//     retained cleanup-report.json is written under the fixture root and the
//     primary failure stays the reported failure. All owned resources
//     (children + servers) are registered the instant they are created, and
//     the lifecycle/env negative tests register theirs too, so a failed
//     assertion never strands a child/server.
//   - Receipts are journaled LIVE at operation time: the gate watches the
//     run's own per-run event file while the run is executing and records a
//     host receipt (observed_ts + native event_ts) the moment each
//     run.started / step.running / step.done event appears — never
//     manufactured after the fact from final step rows. Declared expected
//     transitions (per-run linear two-step, single attempt) and the volume
//     plan are written BEFORE capture. Final-state DB observations are
//     recorded separately and labeled.
//   - Listener release is verified on EVERY actually-opened owned endpoint
//     record (control/dashboard/MCP reserved ports observed occupied while
//     the daemon runs), never by probing production ports; exactly-owned
//     process exit, stream close and listener release are distinct evidence.
//   - Focused injected-failure negatives for the lifecycle helpers AND
//     deterministic env allowlist sentinel tests run BEFORE the actual gate.
//   - Child environments are constructed from an EXPLICIT allowlist
//     (public toolchain PATH/LANG/USER + explicit private test-owned values),
//     never a wholesale spread of process.env: provider credentials, host
//     harness homes and live suite/broker/reporting/admin authority never
//     reach test children (sentinel-tested).
//   - fresh mkdtemp-owned root with private HOME / TAMANDUA_STATE_DIR /
//     TAMANDUA_DB_PATH / TMPDIR / TAMANDUA_WORKTREE_ROOT,
//     TAMANDUA_TEST_GUARD=1 and real random ports (never 3334/3338/3339,
//     never the TT fixed ports);
//   - a tiny SYNTHETIC workflow (o7-gate-wf, two linear steps) installed from
//     an owned fixture catalog through the real `workflow install`;
//   - a real private daemon (dist/server/daemon.js) + deterministic motor;
//     harness = torture-test/scripted-runtimes/bin/scripted-pi (the frozen
//     fork), probe ENABLED and answered by the runtime; TAMANDUA_PI_BINARY
//     explicit, fail closed if missing;
//   - four deterministic completed runs (R1..R4), each through real
//     claim/complete APIs; between runs a declared volume hook (fresh private
//     node process importing the real dist events emitter) appends a bounded
//     train of synthetic non-lifecycle `o7.gate.volume` events until the live
//     global file crosses the native 20 MiB cap and rotates — exactly three
//     rotations, then a final live tail;
//   - HUSH probes: two fresh private debug-off / debug-on emitEvent
//     processes in their own private state dirs prove the native filter;
//   - capture everything (event streams incl. archives + .generation, DB
//     snapshot, receipts, plan, probes), write the O7 sidecar, run O7, and
//     require PASS; assert zero tokens and an empty guard-violation ledger;
//   - teardown closes EXACT owned children; the fixture/evidence dirs are
//     RETAINED (never deleted).
//
// Runs standalone: node --test o7-gate.test.mjs  (ONE torture self-test file
// at a time — parity tests mutate the runtimes).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const TT_ROOT = path.join(REPO_ROOT, 'torture-test');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const O7 = path.join(TT_ROOT, 'oracles', 'O7');
const CLI = path.join(REPO_ROOT, 'dist', 'cli', 'cli.js');
const DAEMON_JS = path.join(REPO_ROOT, 'dist', 'server', 'daemon.js');
const EVENTS_JS = path.join(REPO_ROOT, 'dist', 'installer', 'events.js');
const SCRIPTED_PI = path.join(TT_ROOT, 'scripted-runtimes', 'bin', 'scripted-pi');

const CAP = 20 * 1024 * 1024;
const WORKFLOW_ID = 'o7-gate-wf';
const VOLUME_RUN = 'run-o7-gate-volume';
const NODE = process.execPath;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// ── explicit child-env allowlist (Correction E) ─────────────────────────
// Test children NEVER inherit a wholesale process.env. Only public toolchain
// keys (paths/locale/identity — no credentials, no host state) pass through;
// every private value is supplied explicitly by the caller. Run/worker/guard
// authority keys are refused even if an override attempts to smuggle them.
// These helpers are pure, so the deterministic sentinel tests above the gate
// can prove leakage/refusal without launching any fake daemon.
const PUBLIC_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'LANGUAGE', 'USER', 'LOGNAME'];
const DENIED_ENV_KEYS = [
  'TAMANDUA_RUN_ID',
  'TAMANDUA_WORKER_JOB_ID',
  'TAMANDUA_WORKER_PID',
  'TAMANDUA_WORKER_PGID',
  'NODE_TEST_CONTEXT',
];

/** Copy only the explicitly allowlisted public toolchain keys from `ambient`. */
function pickPublicEnv(ambient) {
  const out = {};
  for (const key of PUBLIC_ENV_KEYS) {
    if (ambient[key] !== undefined) out[key] = ambient[key];
  }
  return out;
}

/**
 * Compose an explicit test-owned child env: public toolchain keys from the
 * ambient object + the caller's private owned overrides. Denied authority
 * keys can never appear, even if `owned` tries to smuggle them.
 */
function composeChildEnv(ambient, owned) {
  const env = pickPublicEnv(ambient);
  for (const [key, value] of Object.entries(owned)) {
    if (!DENIED_ENV_KEYS.includes(key)) env[key] = value;
  }
  for (const key of DENIED_ENV_KEYS) delete env[key];
  return env;
}

// ── exact-child lifecycle helpers (shared by negatives + the gate) ─────
//
// Corrected close semantics (STORM-O7-LIFECYCLE): process EXIT (the 'exit'
// event / child.exitCode / child.signalCode) is NOT stdio CLOSE (the 'close'
// event). A child whose process has ended can still hold its pipes open (a
// descendant may have inherited the write end), so the real close can arrive
// much later — or never. Every child is therefore owned from the moment it is
// spawned: ownedSpawn retains the positive close observation at spawn time
// (BEFORE any outcome/readiness logic) and hands out a promise for that SAME
// real close event; stopChild awaits the retained observation, never
// re-signals an exited process, and treats an unobservable/never-arriving
// close as an explicit cleanup failure — never a fabricated success.

/**
 * Spawn a child while retaining spawn-time observations from the very first
 * moment: the spawn error, the process-END ('exit') result, and the positive
 * stdio-CLOSE ('close') result plus a promise for that same close. A failed
 * spawn fires 'error' (and Node may also fire a synthetic 'close'); callers
 * MUST check holder.error before ever trusting a close observation.
 */
function ownedSpawn(command, args, opts = {}) {
  const child = spawn(command, args, opts);
  let resolveClose;
  const closePromise = new Promise((resolve) => { resolveClose = resolve; });
  const holder = {
    error: null, // spawn error, if any
    exit: null, // { code, signal } — process END observation
    close: null, // { code, signal } — stdio CLOSE observation
    closePromise, // resolves at the SAME real 'close' event
  };
  child.__o7Closed = false;
  child.on('error', (err) => { holder.error = err; });
  child.on('exit', (code, signal) => { holder.exit = { code, signal }; });
  child.on('close', (code, signal) => {
    child.__o7Closed = true;
    holder.close = { code, signal };
    resolveClose({ code, signal });
  });
  return { child, holder };
}

/**
 * Bounded wait for the REAL stdio-close observation that ownedSpawn retained
 * at spawn time. An already-observed close resolves immediately; otherwise the
 * retained closePromise (not a fresh late listener, which could miss an
 * already-emitted close) is awaited. Only meaningful for children created by
 * ownedSpawn.
 */
function awaitRealClose(holder, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    if (holder.close !== null) {
      resolve(holder.close);
      return;
    }
    const timer = setTimeout(() => reject(new Error(`${label}: no real close within ${timeoutMs}ms`)), timeoutMs);
    holder.closePromise.then((close) => {
      clearTimeout(timer);
      resolve(close);
    });
  });
}

/**
 * Destroy OUR ends of the child's owned stdio pipes so that the real 'close'
 * event can fire even when a descendant keeps the far end open. Only invoked
 * after the child's process has already ended — never as a substitute for
 * signalling a live process.
 */
function destroyOwnedStdio(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (stream !== null && stream !== undefined && typeof stream.destroy === 'function' && stream.destroyed !== true) {
      stream.destroy();
    }
  }
}

/**
 * Stop an EXACT child by handle and wait for its REAL close event.
 *   - a child that failed to spawn (holder.error) is a failure;
 *   - a process that already ENDED is never re-signaled — only its pending
 *     stdio close is awaited (bounded); an exited process whose pipes never
 *     close (never-closing pipe) has its OWNED stdio ends destroyed and is
 *     still an explicit cleanup failure if no real close ever arrives;
 *   - a running child gets SIGTERM then, only on the same exact handle,
 *     SIGKILL escalation, with the real close awaited each time.
 * Unknown/unobservable close is never reported as success.
 */
async function stopChild(child, { label = 'child', gracefulMs = 8000, killMs = 4000, spawnError = null } = {}) {
  const holder = spawnError;
  const assertSpawned = () => {
    if (holder !== null && holder.error !== null) {
      throw new Error(`${label}: child failed to run: ${holder.error.message}`);
    }
  };
  assertSpawned();
  if (holder === null || holder.closePromise === undefined) {
    throw new Error(`${label}: stopChild requires an ownedSpawn holder (no spawn-time close observation retained)`);
  }

  // Already positively closed (retained at spawn time, before this call).
  if (holder.close !== null) {
    return { closed: true, code: holder.close.code, signal: holder.close.signal, label, observed: 'spawn-time close' };
  }

  const exited = () =>
    holder.exit !== null ||
    child.exitCode !== null ||
    child.signalCode !== null;

  // Process already ended: only stdio close may still be pending. Never
  // re-signal an exited process — await the SAME retained close (bounded).
  // Pending-pipe closure that never completes is an explicit cleanup failure.
  if (exited()) {
    try {
      const close = await awaitRealClose(holder, gracefulMs, label);
      return { closed: true, code: close.code, signal: close.signal, label, awaitedExit: true };
    } catch (err) {
      destroyOwnedStdio(child);
      try {
        const close = await awaitRealClose(holder, killMs, label);
        return { closed: true, code: close.code, signal: close.signal, label, awaitedExit: true, forcedStdioClose: true };
      } catch (err2) {
        throw new Error(`${label}: exited but stdio never closed (${err.message}; ${err2.message})`);
      }
    }
  }

  // Still running: SIGTERM (skip if a caller already signalled this handle),
  // then wait for the real close event.
  if (!child.killed) {
    child.kill('SIGTERM');
  }
  try {
    const close = await awaitRealClose(holder, gracefulMs, label);
    return { closed: true, code: close.code, signal: close.signal, label };
  } catch (err) {
    assertSpawned();
    // Escalate on the SAME exact handle only — no name/PIDfile/stale kills.
    if (!exited()) {
      child.kill('SIGKILL');
    }
    try {
      const close = await awaitRealClose(holder, killMs, label);
      return { closed: true, code: close.code, signal: close.signal, label, escalated: true };
    } catch (err2) {
      destroyOwnedStdio(child);
      try {
        const close = await awaitRealClose(holder, killMs, label);
        return { closed: true, code: close.code, signal: close.signal, label, escalated: true, forcedStdioClose: true };
      } catch (err3) {
        throw new Error(`${label}: no real close after SIGTERM/SIGKILL (${err2.message}; ${err3.message})`);
      }
    }
  }
}

function isClosed(child) {
  // Positive close observation only — exitCode/signalCode prove EXIT, not CLOSE.
  return child.__o7Closed === true;
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** True when nothing is listening on 127.0.0.1:port right now. */
async function canBind(port) {
  const server = net.createServer();
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

function dbSec(isoTs) {
  return new Date(Date.parse(isoTs)).toISOString().slice(0, 19).replace('T', ' ');
}

function runCli(env, args, opts = {}) {
  const res = spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', shell: false, env, ...opts });
  return res;
}

function isoNow() {
  return new Date().toISOString();
}

// ── injected-failure negatives + env-allowlist sentinels (Correction D)
//    — BEFORE the actual gate. Every test registers its owned child/server
//    IMMEDIATELY (t.after), so a failed assertion never strands a child. ──

/**
 * Register every owned resource of a negative test with the test context so a
 * failed assertion cannot strand its child/server: the after hook closes the
 * exact handles and surfaces any cleanup failure.
 */
function trackOwned(t, ownedChildren, owned, label) {
  ownedChildren.push({ owned, label });
  if (!ownedChildren._registered) {
    ownedChildren._registered = true;
    t.after(async () => {
      const results = [];
      for (const rec of [...ownedChildren].reverse()) {
        const { child, holder } = rec.owned;
        if (holder.error !== null && holder.error !== undefined) {
          // A child that never spawned holds no process/stdio to reap; the
          // spawn failure is the test's own subject and was already asserted
          // in the body — re-reporting it here would be a spurious failure.
          results.push({ label: rec.label, closed: true, note: 'never-spawned; spawn error already surfaced by the test body' });
          continue;
        }
        try {
          results.push(await stopChild(child, { label: rec.label, gracefulMs: 4000, killMs: 3000, spawnError: holder }));
        } catch (error) {
          results.push({ label: rec.label, error: error instanceof Error ? error.message : String(error) });
        }
      }
      const failed = results.filter((r) => r.error !== undefined || r.closed !== true);
      if (failed.length > 0) {
        // Surface cleanup failures. If the body already failed, node:test keeps
        // the primary failure; this still makes the cleanup failure visible in
        // the run output.
        console.error(`owned-resource cleanup failures: ${JSON.stringify(failed)}`);
        throw new Error(`owned-resource cleanup failed: ${JSON.stringify(failed)}`);
      }
    });
  }
}

test('O7 gate lifecycle: stopChild escalates SIGTERM-ignoring child to SIGKILL and waits for real close', async (t) => {
  const ownedChildren = [];
  const { child, holder } = ownedSpawn(NODE, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 200);'], { stdio: 'ignore', env: composeChildEnv(process.env, {}) });
  trackOwned(t, ownedChildren, { child, holder }, 'stubborn');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(!isClosed(child), 'stubborn child closed by itself');
  const started = Date.now();
  const outcome = await stopChild(child, { label: 'stubborn', gracefulMs: 1200, killMs: 5000, spawnError: holder });
  assert.equal(outcome.closed, true, JSON.stringify(outcome));
  assert.equal(outcome.signal, 'SIGKILL', 'expected SIGKILL escalation, got ' + JSON.stringify(outcome));
  assert.equal(outcome.escalated, true);
  assert.ok(Date.now() - started >= 800, 'escalation happened before the grace window elapsed');
  assert.ok(isClosed(child), 'child not actually closed after stopChild');
});

test('O7 gate lifecycle: stopChild propagates a spawn failure instead of a fake closed receipt', async (t) => {
  const ownedChildren = [];
  const { child, holder } = ownedSpawn('/nonexistent/tamandua-o7-gate-binary-xyz', [], { stdio: 'ignore', env: composeChildEnv(process.env, {}) });
  trackOwned(t, ownedChildren, { child, holder }, 'never-spawned');
  await new Promise((resolve) => setTimeout(resolve, 400));
  // A child that never spawned must not report a fabricated closed receipt.
  await assert.rejects(
    () => stopChild(child, { label: 'never-spawned', gracefulMs: 800, killMs: 1500, spawnError: holder }),
    /failed to run/,
    'spawn failure was not propagated',
  );
  assert.ok(holder.error !== null, 'no error event observed from the failed spawn');
});

test('O7 gate lifecycle: readiness failure is rejected and the exact child is still reaped', async (t) => {
  // A child that exits immediately before any readiness line.
  const ownedChildren = [];
  const { child, holder } = ownedSpawn(NODE, ['-e', 'process.exit(3);'], { stdio: ['ignore', 'pipe', 'pipe'], env: composeChildEnv(process.env, {}) });
  trackOwned(t, ownedChildren, { child, holder }, 'early-exit');
  let out = '';
  child.stdout.on('data', (c) => { out += c.toString(); });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('not ready')), 2000);
    const onData = () => {
      if (out.includes('READY_MARKER')) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`child exited early (${code}) before readiness`)); });
  });
  await assert.rejects(() => ready, /exited early/);
  const outcome = await stopChild(child, { label: 'early-exit', gracefulMs: 2000, killMs: 2000, spawnError: holder });
  assert.equal(outcome.closed, true, JSON.stringify(outcome));
  assert.equal(outcome.code, 3, 'child exit code not observed');
});

test('O7 gate lifecycle: stopChild waits for the REAL close of an already-exited child whose pipe is still open (no exit/close conflation)', async (t) => {
  // A node parent spawns a short-lived grandchild that inherits stdout, then
  // exits at once. The parent's process EXIT is observable immediately, but
  // its stdio CLOSE only arrives when the grandchild releases the pipe. A
  // correct stopChild must not return a fabricated closed receipt at exit
  // time: it must await the retained close observation.
  const ownedChildren = [];
  const parentSrc = `
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 600)'], { stdio: ['ignore', 1, 2] });
    g.unref();
    process.exit(0);
  `;
  const { child, holder } = ownedSpawn(NODE, ['-e', parentSrc], { stdio: ['ignore', 'pipe', 'pipe'], env: composeChildEnv(process.env, {}) });
  trackOwned(t, ownedChildren, { child, holder }, 'exited-pipe-open');
  // Wait for the parent process to EXIT (not close).
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('parent did not exit in time')), 5000);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    child.on('error', reject);
  });
  assert.ok(child.exitCode === 0 || child.signalCode !== null, `parent did not exit cleanly: exitCode=${child.exitCode} signal=${child.signalCode}`);
  const startMs = Date.now();
  const outcome = await stopChild(child, { label: 'exited-pipe-open', gracefulMs: 3000, killMs: 1500, spawnError: holder });
  const elapsed = Date.now() - startMs;
  assert.equal(outcome.closed, true, JSON.stringify(outcome));
  assert.equal(outcome.code, 0, JSON.stringify(outcome));
  // The real close arrived only after the grandchild released the pipe
  // (~600ms); a fabricated exit-based receipt would have returned in <50ms.
  assert.ok(elapsed >= 300, `stopChild resolved before the real close (${elapsed}ms): ${JSON.stringify(outcome)}`);
  assert.ok(isClosed(child), 'child close not observed after stopChild');
});

test('O7 gate lifecycle: never-closing pipe — bounded force-close of OWNED stdio, real close observed (never fabricated)', async (t) => {
  // Parent exits; a grandchild inherits stdout and keeps the pipe open for a
  // long time. stopChild must terminate BOUNDED: it waits the grace window,
  // then force-closes only its OWN ends of the pipes (a real, positive close
  // observation follows — no fabricated success, no hang). The exact
  // grandchild pid (recorded by the parent into an owned pidfile) is reaped
  // at the end so nothing is stranded.
  const ownedChildren = [];
  const pidfile = path.join(fs.mkdtempSync(path.join(VAR_ROOT, 'o7-gate-pidfile.')), 'grandchild.pid');
  const parentSrc = `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: ['ignore', 1, 2] });
    fs.writeFileSync(${JSON.stringify(pidfile)}, String(g.pid));
    g.unref();
    process.exit(0);
  `;
  const { child, holder } = ownedSpawn(NODE, ['-e', parentSrc], { stdio: ['ignore', 'pipe', 'pipe'], env: composeChildEnv(process.env, {}) });
  trackOwned(t, ownedChildren, { child, holder }, 'never-closing-pipe');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('parent did not exit in time')), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.on('error', reject);
  });
  const grandchildPid = Number(fs.readFileSync(pidfile, 'utf8').trim());
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 1, `bad grandchild pid ${grandchildPid}`);
  // Safety net (also runs if the body throws); the deterministic reap below is
  // the primary cleanup.
  t.after(() => {
    try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already gone */ }
  });
  const startMs = Date.now();
  const outcome = await stopChild(child, { label: 'never-closing-pipe', gracefulMs: 300, killMs: 1500, spawnError: holder });
  const elapsed = Date.now() - startMs;
  assert.equal(outcome.closed, true, JSON.stringify(outcome));
  assert.equal(outcome.forcedStdioClose, true, `expected owned-stdio force close, got ${JSON.stringify(outcome)}`);
  assert.ok(isClosed(child), 'child close not observed after forced stdio close');
  assert.ok(elapsed >= 250 && elapsed < 6000, `never-closing pipe not bounded (${elapsed}ms)`);
  // Reap the exact grandchild we created (never a hunt), then verify it is
  // really gone (poll bounded so a slow init reap cannot flake) — the test
  // strands nothing.
  try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already gone */ }
  let alive = true;
  for (let i = 0; i < 20; i += 1) {
    try { process.kill(grandchildPid, 0); } catch { alive = false; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(!alive, `exact grandchild pid ${grandchildPid} still alive after cleanup`);
});

test('O7 gate lifecycle: port release verified on the exact owned port records after close', async (t) => {
  // Occupy an owned random port with a tiny server; verify it is NOT bindable
  // while held and IS bindable again after the exact handle closes. The server
  // is registered for cleanup so a failed assertion never strands it.
  const port = await reservePort();
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  let serverClosed = false;
  t.after(async () => {
    if (!serverClosed) await new Promise((resolve) => server.close(resolve));
  });
  assert.equal(await canBind(port), false, 'owned port bindable while held');
  await new Promise((resolve) => server.close(resolve));
  serverClosed = true;
  assert.equal(await canBind(port), true, 'owned port not released after close');
});

// ── env allowlist / sentinel tests (Correction E) — BEFORE the gate ─────
// Child environments are built from an EXPLICIT allowlist (never by spreading
// process.env): only public toolchain values (PATH/LANG/USER…) pass through;
// every private value is test-owned; run/worker/guard authority and provider
// credentials are refused. Deterministic sentinels run here, before any gate
// operation — no fake daemon is launched to prove the allowlist.

test('O7 gate env: allowlist refuses host authority/credentials (leakage sentinel, pure)', () => {
  const hostileAmbient = {
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    USER: 'somebody',
    HOME: '/host/home',
    TAMANDUA_RUN_ID: 'run-host-sentinel',
    TAMANDUA_WORKER_JOB_ID: 'job-host-sentinel',
    TAMANDUA_WORKER_PID: '999999',
    TAMANDUA_WORKER_PGID: '999999',
    NODE_TEST_CONTEXT: '1',
    TAMANDUA_STATE_DIR: '/host/state',
    TAMANDUA_DB_PATH: '/host/tamandua.db',
    TAMANDUA_CONTROL_PORT: '3339',
    PI_SETTINGS_PATH: '/host/pi/settings.json',
    DSH_HOME: '/host/.dsh',
    HERMES_HOME: '/host/hermes',
    OPENAI_API_KEY: 'sk-sentinel-openai',
    ANTHROPIC_API_KEY: 'sentinel-anthropic',
    HUGGING_FACE_HUB_TOKEN: 'sentinel-hf',
    AWS_ACCESS_KEY_ID: 'sentinel-aws',
    GITHUB_TOKEN: 'sentinel-gh',
  };
  const owned = {
    HOME: '/owned/home',
    TAMANDUA_STATE_DIR: '/owned/state',
    TAMANDUA_DB_PATH: '/owned/db.sqlite',
    TAMANDUA_WORKTREE_ROOT: '/owned/worktrees',
    TAMANDUA_CONTROL_PORT: '45678',
    TAMANDUA_TEST_GUARD: '1',
    TZ: 'UTC',
  };
  const childEnv = composeChildEnv(hostileAmbient, owned);
  // Run/worker/guard authority + provider credentials never appear AT ALL.
  for (const leaked of ['TAMANDUA_RUN_ID', 'TAMANDUA_WORKER_JOB_ID', 'TAMANDUA_WORKER_PID', 'TAMANDUA_WORKER_PGID', 'NODE_TEST_CONTEXT', 'PI_SETTINGS_PATH', 'DSH_HOME', 'HERMES_HOME', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'HUGGING_FACE_HUB_TOKEN', 'AWS_ACCESS_KEY_ID', 'GITHUB_TOKEN']) {
    assert.ok(!(leaked in childEnv), `leaked ambient key into child env: ${leaked}`);
  }
  // Host state values (homes/dirs/ports) must not win over owned values.
  assert.notEqual(childEnv.HOME, '/host/home');
  assert.notEqual(childEnv.TAMANDUA_STATE_DIR, '/host/state');
  assert.notEqual(childEnv.TAMANDUA_DB_PATH, '/host/tamandua.db');
  assert.notEqual(childEnv.TAMANDUA_CONTROL_PORT, '3339');
  // Public toolchain pass-through + owned private values.
  assert.equal(childEnv.PATH, '/usr/bin:/bin');
  assert.equal(childEnv.LANG, 'en_US.UTF-8');
  assert.equal(childEnv.USER, 'somebody');
  assert.equal(childEnv.HOME, '/owned/home');
  assert.equal(childEnv.TAMANDUA_STATE_DIR, '/owned/state');
  assert.equal(childEnv.TAMANDUA_DB_PATH, '/owned/db.sqlite');
  assert.equal(childEnv.TAMANDUA_WORKTREE_ROOT, '/owned/worktrees');
  assert.equal(childEnv.TAMANDUA_CONTROL_PORT, '45678');
  assert.equal(childEnv.TAMANDUA_TEST_GUARD, '1');
  assert.equal(childEnv.TZ, 'UTC');
});

test('O7 gate env: refusal — run/worker/guard authority cannot be smuggled through overrides', () => {
  const childEnv = composeChildEnv(
    { PATH: '/usr/bin:/bin' },
    { TAMANDUA_RUN_ID: 'smuggle-run', TAMANDUA_WORKER_JOB_ID: 'smuggle-job', NODE_TEST_CONTEXT: '1', TAMANDUA_TEST_GUARD: '1', HOME: '/owned' },
  );
  assert.ok(!('TAMANDUA_RUN_ID' in childEnv), 'TAMANDUA_RUN_ID smuggled');
  assert.ok(!('TAMANDUA_WORKER_JOB_ID' in childEnv), 'TAMANDUA_WORKER_JOB_ID smuggled');
  assert.ok(!('NODE_TEST_CONTEXT' in childEnv), 'NODE_TEST_CONTEXT smuggled');
  assert.equal(childEnv.TAMANDUA_TEST_GUARD, '1');
  assert.equal(childEnv.HOME, '/owned');
});

test('O7 gate env: a real spawned child sees only the allowlisted env (refusal sentinel, deterministic)', async () => {
  const hostileAmbient = {
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    USER: 'somebody',
    TAMANDUA_RUN_ID: 'run-host-sentinel',
    OPENAI_API_KEY: 'sk-sentinel-openai',
    HOME: '/host/home',
  };
  const owned = {
    HOME: '/owned/home',
    TAMANDUA_STATE_DIR: '/owned/state',
    TAMANDUA_DB_PATH: '/owned/db.sqlite',
    TAMANDUA_TEST_GUARD: '1',
    TZ: 'UTC',
  };
  const childEnv = composeChildEnv(hostileAmbient, owned);
  const res = spawnSync(NODE, ['-e', 'console.log(JSON.stringify(process.env))'], {
    encoding: 'utf8',
    shell: false,
    env: childEnv,
    timeout: 30_000,
  });
  assert.equal(res.status, 0, `child env probe failed: ${res.stderr}`);
  const seen = JSON.parse(res.stdout.trim());
  assert.equal(seen.PATH, '/usr/bin:/bin');
  assert.equal(seen.HOME, '/owned/home');
  assert.equal(seen.TAMANDUA_STATE_DIR, '/owned/state');
  assert.equal(seen.TAMANDUA_TEST_GUARD, '1');
  assert.ok(!('TAMANDUA_RUN_ID' in seen), 'TAMANDUA_RUN_ID reached a real child');
  assert.ok(!('OPENAI_API_KEY' in seen), 'provider credential reached a real child');
  assert.ok(!('NODE_TEST_CONTEXT' in seen), 'NODE_TEST_CONTEXT reached a real child');
});

// ── the gate ──────────────────────────────────────────────────────────

test('O7 rotation-loss gate: >=3 real 20MiB rotations with full train reconstruction (PASS)', { timeout: 1_800_000 }, async (t) => {
  // 0. Environment sanity: dist built; frozen scripted harness present.
  assert.ok(fs.existsSync(CLI), 'dist/cli/cli.js missing — run npm run build first');
  assert.ok(fs.existsSync(DAEMON_JS), 'dist/server/daemon.js missing');
  assert.ok(fs.existsSync(EVENTS_JS), 'dist/installer/events.js missing');
  assert.ok(fs.existsSync(SCRIPTED_PI), 'frozen scripted harness missing');
  // Preflight: dist's runtime dependencies must RESOLVE from the dist tree
  // before the workflow-install step below. The preflight's harmless child
  // gets an explicit public-only env (no inherited run/worker authority).
  {
    const distInstaller = path.join(REPO_ROOT, 'dist', 'installer');
    assert.ok(fs.existsSync(distInstaller), 'dist/installer missing — run npm run build first');
    const preflightEnv = composeChildEnv(process.env, {});
    const depProbe = spawnSync(NODE, ['--input-type=module', '--eval', "await import('yaml')"], {
      cwd: distInstaller,
      encoding: 'utf8',
      shell: false,
      env: preflightEnv,
      timeout: 30_000,
    });
    const depStderr = (depProbe.stderr ?? '').trim().split('\n').filter(Boolean);
    const depErr = depStderr.find((l) => /ERR_MODULE_NOT_FOUND|Cannot find|does not provide an export|'yaml'/i.test(l)) ?? depStderr.at(-1) ?? `exit ${depProbe.status}`;
    assert.equal(depProbe.status, 0,
      `dist dependency 'yaml' does not resolve from ${distInstaller} (${depErr}) — run 'npm run build' at the repo root (it installs node_modules) or make the repo node_modules available (e.g. symlink the main-checkout node_modules) before running the gate`);
  }
  // NOTE: this test process itself may run inside a parent tamandua run
  // (TAMANDUA_RUN_ID etc. present in the ambient env). That authority must
  // NEVER reach the daemon, workers, or probes: every child env is composed
  // from the explicit allowlist (composeChildEnv) below — public toolchain
  // keys only plus the test-owned private values — so inherited
  // run/worker/step authority, provider credentials and host harness homes
  // cannot leak into test children.

  const root = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.o7-gate.'));
  const home = path.join(root, 'home');
  const stateDir = path.join(root, 'state');
  const dbPath = path.join(stateDir, 'tamandua.db');
  const worktreeRoot = path.join(stateDir, 'worktrees');
  const catalog = path.join(root, 'catalog');
  const scriptedState = path.join(root, 'scripted-state');
  const tmpDir = path.join(root, 'tmp');
  const capture = path.join(root, 'capture');
  const evidenceDir = path.join(root, 'oracle-evidence');
  const ledgerPath = path.join(root, 'guard-ledger.jsonl');
  for (const d of [home, stateDir, worktreeRoot, catalog, scriptedState, tmpDir, capture, evidenceDir, path.join(home, '.pi', 'agent')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 'stub', defaultModel: 'stub' }));
  fs.chmodSync(path.join(home, '.pi', 'agent', 'settings.json'), 0o600);

  // Exact owned port records: control + dashboard + MCP ports reserved here
  // and never probed on production ports.
  const controlPort = await reservePort();
  const dashboardPort = await reservePort();
  const mcpPort = await reservePort();
  fs.writeFileSync(path.join(stateDir, 'port'), String(dashboardPort), 'utf8');

  // Explicit test-owned env (Correction E): public toolchain keys
  // (PATH/LANG/USER) pass through composeChildEnv's allowlist; every private
  // value below is set explicitly. Provider credentials, host harness homes
  // and live suite/broker/reporting/admin authority are NEVER inherited —
  // process.env is never spread into a child env.
  const baseEnv = composeChildEnv(process.env, {
    HOME: home,
    TAMANDUA_STATE_DIR: stateDir,
    TAMANDUA_DB_PATH: dbPath,
    TAMANDUA_WORKTREE_ROOT: worktreeRoot,
    TAMANDUA_CONTROL_PORT: String(controlPort),
    TAMANDUA_DASHBOARD_PORT: String(dashboardPort),
    TAMANDUA_MCP_PORT: String(mcpPort),
    TMPDIR: tmpDir,
    TZ: 'UTC',
    TAMANDUA_TEST_GUARD: '1',
    TAMANDUA_TEST_GUARD_LEDGER: ledgerPath,
    TAMANDUA_WORKFLOWS_SRC: catalog,
    TAMANDUA_PI_BINARY: SCRIPTED_PI,
    TAMANDUA_SCRIPTED_BEHAVIORS: path.join(root, 'behaviors.json'),
    TAMANDUA_SCRIPTED_STATE: scriptedState,
    TT_NODE_BIN: NODE,
  });
  // Extra per-call private overrides, still through the same explicit
  // allowlist (denied authority keys can never reappear).
  const cleanEnv = (extra = {}) => composeChildEnv(process.env, { ...baseEnv, ...extra });
  // Deterministic in-run guard: the composed child env must not carry any
  // inherited run/worker/step authority from this test process.
  for (const key of ['TAMANDUA_RUN_ID', 'TAMANDUA_WORKER_JOB_ID', 'TAMANDUA_WORKER_PID', 'TAMANDUA_WORKER_PGID', 'NODE_TEST_CONTEXT']) {
    assert.ok(!(key in baseEnv), `child env leaked parent authority: ${key}`);
  }

  // 0.5 Per-run dedicated harness working directories (never the repo root).
  const runWorkdirs = [];
  for (let i = 1; i <= 8; i += 1) {
    const wd = path.join(root, `wd-${i}`);
    fs.mkdirSync(wd, { recursive: true });
    runWorkdirs.push(wd);
  }
  let nextWorkdir = 0;
  const takeWorkdir = () => runWorkdirs[Math.min(nextWorkdir++, runWorkdirs.length - 1)];

  // Exact-child registry: every child is tracked the instant it is spawned
  // (with its spawn-error holder); teardown closes each by handle and
  // reports any failure.
  const ownedChildren = [];
  const trackChild = (child, holder, label) => {
    const record = { child, holder, label };
    ownedChildren.push(record);
    return record;
  };
  const closeAllOwned = async () => {
    const results = [];
    for (const record of [...ownedChildren].reverse()) {
      const startedAt = Date.now();
      try {
        const outcome = await stopChild(record.child, { label: record.label, spawnError: record.holder, gracefulMs: 8000, killMs: 4000 });
        results.push({ label: record.label, closed: outcome.closed === true, outcome, startedAt, finishedAt: Date.now() });
      } catch (error) {
        results.push({ label: record.label, closed: false, error: error instanceof Error ? error.message : String(error), startedAt, finishedAt: Date.now() });
      }
    }
    return results;
  };
  // The main gate after-hook must NOT discard closeAllOwned's results: every
  // cleanup failure is surfaced (cleanup-report.json retained under the
  // fixture root + console), while a primary body failure stays the reported
  // failure. Children are registered the instant they are spawned, so even a
  // readiness/assertion failure earlier in the body is still fully reaped.
  t.after(async () => {
    const cleanupResults = await closeAllOwned();
    const failures = cleanupResults.filter((r) => r.closed !== true);
    const cleanupReport = {
      hook: 'main-gate-t.after closeAllOwned',
      ran_at: isoNow(),
      total_owned: ownedChildren.length,
      results: cleanupResults,
      failure_count: failures.length,
    };
    if (root !== undefined) {
      fs.writeFileSync(path.join(root, 'cleanup-report.json'), `${JSON.stringify(cleanupReport, null, 2)}\n`);
    }
    if (failures.length > 0) {
      console.error(`O7 gate cleanup failures (after-hook): ${JSON.stringify(failures)}`);
      // Throwing here fails the gate when the body otherwise passed; when the
      // body already failed, node:test reports the PRIMARY failure (verified:
      // after-hook errors are suppressed in favor of the body error), so the
      // cleanup failures above remain surfaced in cleanup-report.json + stderr.
      throw new Error(`O7 gate cleanup failures: ${JSON.stringify(failures)}`);
    }
  });

  // 1. Synthetic workflow in the owned fixture catalog.
  const wfDir = path.join(catalog, WORKFLOW_ID);
  fs.mkdirSync(path.join(wfDir, 'agents', 'w1'), { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'workflow.yml'), `id: ${WORKFLOW_ID}
name: O7 Gate Workflow
version: 1
description: Synthetic two-step linear workflow for the O7 rotation-loss gate (never the real W5 roster).
agents:
  - id: w1
    name: W1
    role: coding
    workspace:
      baseDir: agents/w1
steps:
  - id: step-one
    agent: w1
    input: |
      Execute this deterministic gate step.
      TASK:
      {{task}}
      Reply with:
      STATUS: done
      REPORT: deterministic scripted completion
    expects: "STATUS: done"
    max_retries: 0
  - id: step-two
    agent: w1
    input: |
      Execute this deterministic gate step (second).
      Reply with:
      STATUS: done
      REPORT: deterministic scripted completion
    expects: "STATUS: done"
    max_retries: 0
`);
  fs.writeFileSync(path.join(wfDir, 'agents', 'w1', 'AGENTS.md'), '# W1\nDeterministic scripted gate agent.\n');
  fs.writeFileSync(path.join(root, 'behaviors.json'), JSON.stringify({
    defaultTokens: 0,
    heartbeatTokens: 0,
    agents: { w1: { output: 'STATUS: done\nREPORT: deterministic scripted completion' } },
  }));

  // 2. Install the workflow through the real product API.
  const install = runCli(cleanEnv(), ['workflow', 'install', WORKFLOW_ID]);
  assert.equal(install.status, 0, `workflow install failed: ${install.stderr}`);
  const installedDir = path.join(stateDir, 'workflows', WORKFLOW_ID);
  assert.ok(fs.existsSync(path.join(installedDir, 'workflow.yml')), 'installed workflow missing');

  // 3. Boot the private daemon. Cleanup is registered IMMEDIATELY after the
  //    exact child is created (before readiness), so spawn errors and
  //    readiness failures still reap the exact child.
  const daemonSpawn = ownedSpawn(NODE, ['--disable-warning=ExperimentalWarning', DAEMON_JS], {
    env: cleanEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const daemon = daemonSpawn.child;
  trackChild(daemon, daemonSpawn.holder, 'daemon');
  let daemonOutput = '';
  const awaitDaemonReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`daemon not ready within 30s; output:\n${daemonOutput.slice(-4000)}`)), 30_000);
    daemon.stdout.on('data', (chunk) => {
      daemonOutput += chunk.toString();
      if (daemonOutput.includes('Tamandua control plane listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    daemon.stderr.on('data', (chunk) => {
      daemonOutput += chunk.toString();
    });
    daemon.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited early (${code}); output:\n${daemonOutput.slice(-4000)}`));
    });
    daemon.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`daemon spawn error: ${err.message}`));
    });
  });
  await awaitDaemonReady;
  const daemonPid = daemon.pid;
  assert.ok(daemonPid > 0, 'daemon pid missing');
  // Owned endpoint records: every reserved listener port this gate owns is
  // recorded (control + dashboard + MCP). Which of them the daemon build
  // actually opens is OBSERVED (canBind false while it runs) — never assumed
  // — and each actually-opened one must be RELEASED after the exact child
  // closes (checked in step 8). No production port is ever probed.
  const ownedEndpoints = [
    { name: 'control', port: controlPort },
    { name: 'dashboard', port: dashboardPort },
    { name: 'mcp', port: mcpPort },
  ];
  const openedEndpoints = [];
  for (const endpoint of ownedEndpoints) {
    const held = (await canBind(endpoint.port)) === false;
    if (held) openedEndpoints.push({ name: endpoint.name, port: endpoint.port });
  }
  // The daemon must have actually opened the control plane listener (this
  // daemon build always does); dashboard/MCP may or may not be opened.
  assert.ok(openedEndpoints.some((e) => e.name === 'control'), `control port ${controlPort} not held by the running daemon`);

  const receipts = []; // live-observed operation receipts (append as seen)
  const liveReceiptsPath = path.join(root, 'live-receipts.jsonl');
  const appendReceipt = (receipt) => {
    receipts.push(receipt);
    fs.appendFileSync(liveReceiptsPath, `${JSON.stringify(receipt)}\n`);
  };
  const declaredPath = path.join(root, 'declared-transitions.jsonl');
  const declaredTransitions = [];
  const declareTransitions = (entry) => {
    declaredTransitions.push(entry);
    fs.appendFileSync(declaredPath, `${JSON.stringify(entry)}\n`);
  };
  const observedRuns = [];
  const finalStateRows = []; // final-state DB observations (labeled as such)

  // 4. Launch one deterministic run and drive it to terminal. The run's OWN
  //    per-run event file is watched live while it executes: receipts are
  //    recorded the moment lifecycle events appear (real operation time),
  //    and declared transitions for the deterministic two-step run are
  //    written BEFORE the run completes — never after the fact.
  const runOnce = async (label) => {
    const launchedAt = isoNow();
    const workdir = takeWorkdir();
    const launcherSpawn = ownedSpawn(NODE, [CLI, 'workflow', 'run', WORKFLOW_ID, label, '--working-directory-for-harness', workdir], {
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = launcherSpawn.child;
    trackChild(child, launcherSpawn.holder, `launcher:${label}`);
    let out = '';
    let err = '';
    const prefixPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timeout waiting for Run: prefix; stderr: ${err.slice(0, 1000)}`));
      }, 60_000);
      child.stdout.on('data', (chunk) => {
        out += chunk.toString();
        const m = /^Run:\s+(?:run-)?([0-9a-f]{8,})/im.exec(out);
        if (m) {
          clearTimeout(timer);
          child.kill('SIGTERM');
          resolve(m[1]);
        }
      });
      child.stderr.on('data', (chunk) => { err += chunk.toString(); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const m = /^Run:\s+(?:run-)?([0-9a-f]{8,})/im.exec(out);
        if (m) resolve(m[1]);
        else reject(new Error(`workflow run exited ${code} before Run: line; stdout: ${out.slice(0, 800)} stderr: ${err.slice(0, 800)}`));
      });
    });
    const prefix = await prefixPromise;
    // The launcher printed Run: and was SIGTERM'd; WAIT for its real close
    // (escalating on the exact handle, same retained holder) so it is reaped
    // before we proceed.
    const launcherClose = await stopChild(child, { label: `launcher:${label}`, spawnError: launcherSpawn.holder, gracefulMs: 20_000, killMs: 5000 });
    assert.equal(launcherClose.closed, true, `launcher ${label} did not close: ${JSON.stringify(launcherClose)}`);

    // Resolve the full run id from the product DB (read-only).
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout=5000');
    const row = db.prepare("SELECT id FROM runs WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1").get(`${prefix}%`);
    db.close();
    assert.ok(row, `no DB row for run prefix ${prefix}`);
    const runId = row.id;
    observedRuns.push(runId);

    // Independent DECLARED transitions: the synthetic workflow is a linear
    // two-step single-attempt run, so the host declares exactly one launch,
    // one claim + one completion per step (step-one then step-two) and a
    // completed terminal — written NOW, before the run finishes.
    declareTransitions({
      run_id: runId,
      label,
      launched_at: launchedAt,
      declared_by: 'o7-gate-host',
      expected: { steps: ['step-one', 'step-two'], single_attempt: true, terminal: 'completed' },
    });

    // Live per-run event file watcher.
    const eventsFile = path.join(stateDir, 'events', `${runId}.jsonl`);
    let offset = 0;
    let pending = '';
    const journalEvent = (evt) => {
      if (evt.runId !== runId) return;
      const now = isoNow();
      if (evt.event === 'run.started') {
        appendReceipt({ kind: 'launch', run_id: runId, label, observed_ts: now, event_ts: evt.ts, src: 'live' });
      } else if (evt.event === 'step.running') {
        appendReceipt({ kind: 'claim', run_id: runId, step_id: evt.stepId, agent_id: evt.agentId ?? null, observed_ts: now, event_ts: evt.ts, src: 'live' });
      } else if (evt.event === 'step.done') {
        appendReceipt({ kind: 'complete', run_id: runId, step_id: evt.stepId, observed_ts: now, event_ts: evt.ts, src: 'live' });
      } else if (evt.event === 'step.failed') {
        appendReceipt({ kind: 'fail', run_id: runId, step_id: evt.stepId, observed_ts: now, event_ts: evt.ts, src: 'live' });
      }
    };
    const drain = () => {
      if (!fs.existsSync(eventsFile)) return;
      const stat = fs.statSync(eventsFile);
      if (stat.size < offset) { offset = 0; pending = ''; } // truncation — fail closed below
      if (stat.size === offset) return;
      const fd = fs.openSync(eventsFile, 'r');
      const buf = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = stat.size;
      pending += buf.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? ''; // keep a possible partial tail for the next read
      for (const rawLine of lines) {
        if (rawLine.trim() === '') continue;
        try {
          journalEvent(JSON.parse(rawLine));
        } catch {
          // A partial line raced the writer; retried on the next drain via
          // the pending buffer only when it was the last line — anything
          // else is a real corruption the capture/O7 will surface.
        }
      }
    };

    // Poll + nudge until terminal.
    const deadline = Date.now() + 240_000;
    let terminal = null;
    while (Date.now() < deadline) {
      drain();
      const status = runCli(cleanEnv(), ['workflow', 'status', runId]);
      const statusMatch = /^Status:\s+(\S+)/m.exec(status.stdout ?? '');
      if (statusMatch && ['completed', 'failed', 'canceled'].includes(statusMatch[1].toLowerCase())) {
        terminal = statusMatch[1].toLowerCase();
        break;
      }
      runCli(cleanEnv(), ['nudge']);
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    assert.equal(terminal, 'completed', `run ${runId} did not complete; daemon tail:\n${daemonOutput.slice(-3000)}`);
    // Settle drain: a final step.expects.validated can trail run.completed,
    // and the writer may still flush — drain a few more times.
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      drain();
    }
    // Final-state DB observations (labeled final-state, never receipt time).
    const db2 = new DatabaseSync(dbPath, { readOnly: true });
    db2.exec('PRAGMA busy_timeout=5000');
    const steps = db2.prepare('SELECT step_id, agent_id, claim_job_id, claim_updated_at, status, updated_at FROM steps WHERE run_id = ? ORDER BY step_index').all(runId);
    db2.close();
    for (const step of steps) {
      finalStateRows.push({ src: 'final-state', run_id: runId, step_id: step.step_id, status: step.status, claim_job_id: step.claim_job_id, updated_at: step.updated_at });
    }
    return runId;
  };

  // 5. Volume hook: one fresh private process per burst, importing the real
  //    dist events emitter, emitting a bounded contiguous seq range of
  //    `o7.gate.volume` events until the live global file crosses the native
  //    cap (exactly one rotation per burst).
  const volumePlan = [];
  const volumeBurst = async (burstId, seqStart, targetGeneration) => {
    const script = `
      import fs from 'node:fs';
      const { emitEvent, getGlobalEventsGeneration } = await import(${JSON.stringify('file://' + EVENTS_JS)});
      const eventsDir = ${JSON.stringify(path.join(stateDir, 'events'))};
      const live = ${JSON.stringify(path.join(stateDir, 'events', 'all.jsonl'))};
      const genFile = ${JSON.stringify(path.join(stateDir, 'events', 'all.jsonl.generation'))};
      const burst = ${JSON.stringify(burstId)};
      const seqStart = ${seqStart};
      const volumeRun = ${JSON.stringify(VOLUME_RUN)};
      const wf = ${JSON.stringify(WORKFLOW_ID)};
      const cap = ${CAP};
      fs.mkdirSync(eventsDir, { recursive: true });
      let liveSize = 0;
      try { liveSize = fs.statSync(live).size; } catch { liveSize = 0; }
      let written = liveSize;
      let seq = seqStart;
      const readGen = () => { try { return Number(fs.readFileSync(genFile, 'utf8').trim()); } catch { return 0; } };
      const target = ${targetGeneration};
      const guard = 2_000_000;
      let emitted = 0;
      while (readGen() < target) {
        if (emitted > guard) { console.error('guard exceeded'); process.exit(3); }
        const evt = { ts: new Date().toISOString(), event: 'o7.gate.volume', runId: volumeRun, workflowId: wf, stepId: 'vol', burst, seq };
        emitEvent(evt);
        emitted += 1;
        seq += 1;
        if (written + Buffer.byteLength(JSON.stringify(evt) + '\\n') > cap) {
          written = 0; // rotation emptied the live file
        } else {
          written += Buffer.byteLength(JSON.stringify(evt) + '\\n');
        }
      }
      console.log(JSON.stringify({ burst, emitted, seqEnd: seq }));
    `;
    const res = spawnSync(NODE, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      shell: false,
      env: cleanEnv(),
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(res.status, 0, `volume burst ${burstId} failed: ${res.stderr}\n${daemonOutput.slice(-2000)}`);
    const parsed = JSON.parse((res.stdout ?? '').trim().split('\n').at(-1));
    volumePlan.push({ burst_id: burstId, event: 'o7.gate.volume', run_id: VOLUME_RUN, workflow_id: WORKFLOW_ID, step_id: 'vol', seq_start: seqStart, seq_end: parsed.seqEnd });
    const genNow = Number(fs.readFileSync(path.join(stateDir, 'events', 'all.jsonl.generation'), 'utf8').trim());
    assert.equal(genNow, targetGeneration, `burst ${burstId} did not reach generation ${targetGeneration}`);
    return parsed;
  };

  // 6. The sequence: R1 -> rotation 1 -> R2 -> rotation 2 -> R3 -> rotation 3
  //    -> R4 (final live tail). Real lifecycle events sit inside every
  //    retained archive and the tail, so reconstruction spans the rotations.
  const r1 = await runOnce('gate-run-1');
  const b1 = await volumeBurst('b1', 0, 1);
  const r2 = await runOnce('gate-run-2');
  const b2 = await volumeBurst('b2', b1.seqEnd, 2);
  const r3 = await runOnce('gate-run-3');
  const b3 = await volumeBurst('b3', b2.seqEnd, 3);
  const r4 = await runOnce('gate-run-4');

  // 7. HUSH probes: fresh private debug-off and debug-on emitter processes in
  //    their OWN private state dirs (never the daemon domain).
  const probeRun = async (tag, debugEvents) => {
    const probeState = path.join(root, `probe-${tag}`);
    fs.mkdirSync(path.join(probeState, 'events'), { recursive: true });
    const env = cleanEnv({ TAMANDUA_STATE_DIR: probeState, TAMANDUA_DB_PATH: path.join(probeState, 'tamandua.db') });
    if (debugEvents === null) delete env.TAMANDUA_DEBUG_EVENTS;
    else env.TAMANDUA_DEBUG_EVENTS = debugEvents;
    const script = `
      const { emitEvent } = await import(${JSON.stringify('file://' + EVENTS_JS)});
      const evt = { ts: new Date().toISOString(), event: ${JSON.stringify(tag === 'on' ? 'agent.nudged' : 'run.nudged')}, runId: 'probe-run', workflowId: 'probe' };
      emitEvent(evt);
      emitEvent({ ts: new Date().toISOString(), event: 'run.started', runId: 'probe-run', workflowId: 'probe' });
      process.exit(0);
    `;
    const res = spawnSync(NODE, ['--input-type=module', '-e', script], { encoding: 'utf8', shell: false, env, timeout: 60_000 });
    assert.equal(res.status, 0, `probe ${tag} failed: ${res.stderr}`);
    const bytes = fs.readFileSync(path.join(probeState, 'events', 'all.jsonl'));
    fs.writeFileSync(path.join(capture, `probe-${tag}.jsonl`), bytes);
    return bytes.toString('utf8');
  };
  const offProbe = await probeRun('off', null);
  const onProbe = await probeRun('on', '1');
  assert.ok(!offProbe.includes('run.nudged') && !offProbe.includes('agent.nudged'), 'debug-off probe wrote a HUSH event');
  assert.ok(onProbe.includes('agent.nudged'), 'debug-on probe did not write HUSH events');

  // 8. Stop the daemon (exact child) BEFORE capture so streams are quiescent,
  //    then verify release of EVERY actually-opened owned listener endpoint
  //    (freshly re-probed the instant before the stop — this is the
  //    authoritative opened set for release), not just a convenient one.
  const openedBeforeStop = [];
  for (const endpoint of ownedEndpoints) {
    const held = (await canBind(endpoint.port)) === false;
    if (held) openedBeforeStop.push(endpoint.name);
  }
  assert.ok(openedBeforeStop.includes('control'), `control port ${controlPort} not held by the running daemon before stop`);
  const daemonClose = await stopChild(daemon, { label: 'daemon', spawnError: daemonSpawn.holder, gracefulMs: 20_000, killMs: 8000 });
  assert.equal(daemonClose.closed, true, `daemon did not close: ${JSON.stringify(daemonClose)}`);
  const endpointRelease = [];
  for (const endpoint of ownedEndpoints) {
    const wasOpened = openedBeforeStop.includes(endpoint.name);
    const released = wasOpened ? (await canBind(endpoint.port)) === true : null;
    endpointRelease.push({ name: endpoint.name, port: endpoint.port, was_opened: wasOpened, released_after_close: released });
    if (wasOpened) {
      assert.equal(released, true, `owned endpoint ${endpoint.name} on port ${endpoint.port} not released after daemon close`);
    }
  }

  // 9. Capture evidence: event streams (byte-exact), DB snapshot, live
  //    receipts, declared transitions, volume plan, probes; then write the
  //    O7 sidecar and run O7.
  const eventsDir = path.join(stateDir, 'events');
  const eventsCapture = path.join(capture, 'events');
  fs.mkdirSync(eventsCapture, { recursive: true });
  const streamFiles = fs.readdirSync(eventsDir).sort();
  const members = [];
  const relOf = (name) => `events/${name}`;
  for (const name of streamFiles) {
    const src = path.join(eventsDir, name);
    const details = fs.lstatSync(src);
    assert.ok(details.isFile() && !details.isSymbolicLink(), `unexpected non-file in events dir: ${name}`);
    const bytes = fs.readFileSync(src);
    const dst = path.join(capture, relOf(name));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, bytes);
    fs.chmodSync(dst, 0o444);
    let role = null;
    if (name === 'all.jsonl') role = 'global-live';
    else if (/^all\.jsonl\.[1-3]$/.test(name)) role = `global-archive:${name.split('.').at(-1)}`;
    else if (name === 'all.jsonl.generation') role = 'generation';
    else if (name === '.jsonl') role = 'empty-run';
    else if (name.endsWith('.jsonl')) role = 'per-run';
    else continue; // non-JSONL companion files are annotated, not members
    members.push({ role, path: relOf(name), sha256: sha256(bytes), size: bytes.length });
  }
  // receipts (live-journaled, written BEFORE capture; each receipt carries
  // observed_ts < events_captured_at) + declared transitions + volume plan.
  const receiptsBytes = Buffer.from(receipts.map((r) => `${JSON.stringify(r)}\n`).join(''));
  fs.writeFileSync(path.join(capture, 'receipts.jsonl'), receiptsBytes);
  fs.chmodSync(path.join(capture, 'receipts.jsonl'), 0o444);
  members.push({ role: 'receipts', path: 'receipts.jsonl', sha256: sha256(receiptsBytes), size: receiptsBytes.length });
  const declaredBytes = Buffer.from(declaredTransitions.map((d) => `${JSON.stringify(d)}\n`).join(''));
  fs.writeFileSync(path.join(capture, 'declared-transitions.jsonl'), declaredBytes);
  fs.chmodSync(path.join(capture, 'declared-transitions.jsonl'), 0o444);
  const planBytes = Buffer.from(`${JSON.stringify({ schema_version: 1, bursts: volumePlan }, null, 2)}\n`);
  fs.writeFileSync(path.join(capture, 'volume-plan.json'), planBytes);
  fs.chmodSync(path.join(capture, 'volume-plan.json'), 0o444);
  members.push({ role: 'volume-plan', path: 'volume-plan.json', sha256: sha256(planBytes), size: planBytes.length });
  // probes
  for (const tag of ['off', 'on']) {
    const p = path.join(capture, `probe-${tag}.jsonl`);
    const bytes = fs.readFileSync(p);
    fs.chmodSync(p, 0o444);
    members.push({ role: `probe-debug-${tag}`, path: `probe-${tag}.jsonl`, sha256: sha256(bytes), size: bytes.length });
  }
  // db snapshot: the product DB runs in WAL mode, so a plain file copy would
  // lose every committed row. Produce a consistent read-only snapshot with
  // `VACUUM INTO` through a read-only connection after the daemon is stopped.
  const snapshotDbPath = path.join(capture, 'database.sqlite');
  {
    const src = new DatabaseSync(dbPath, { readOnly: true });
    src.exec('PRAGMA busy_timeout=5000');
    const vac = `VACUUM INTO '${snapshotDbPath.replace(/'/g, "''")}'`;
    src.exec(vac);
    src.close();
  }
  fs.chmodSync(snapshotDbPath, 0o444);
  const dbBytes = fs.readFileSync(snapshotDbPath);
  members.push({ role: 'db-snapshot', path: 'database.sqlite', sha256: sha256(dbBytes), size: dbBytes.length });

  // Product identity (native source/build SHA captured at capture time). The
  // harmless git child queries the checkout only; it still gets an explicit
  // env (public toolchain + private HOME) — never inherited run authority.
  const gitEnv = composeChildEnv(process.env, { HOME: home });
  const gitCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', env: gitEnv }).stdout.trim();
  const gitTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: REPO_ROOT, encoding: 'utf8', env: gitEnv }).stdout.trim();
  const distEventsSha = sha256(fs.readFileSync(EVENTS_JS));
  const capturedAt = isoNow();

  const generationObserved = members.find((m) => m.role === 'generation');
  const genValue = generationObserved ? Number(fs.readFileSync(path.join(capture, generationObserved.path), 'utf8').trim()) : 0;
  assert.ok(genValue >= 3, `expected >=3 rotations, generation=${genValue}`);

  const scopeRuns = observedRuns;
  const deletedRuns = [];
  const manualLedger = [];
  const syntheticStreams = [VOLUME_RUN];

  const sidecar = {
    schema_version: 1,
    oracle_id: 'O7',
    capture: {
      kind: 'rotation-gate',
      producer: 'storm-o7-close-gate-host',
      captured_at: capturedAt,
      events_captured_at: capturedAt,
      db_captured_at: capturedAt,
      state_dir_identity: stateDir,
      generation_at_capture: genValue,
      debug_events_env: null,
      launch_intent: { debug_events: null, declared_by: 'o7-gate-daemon-env' },
    },
    product: { source_commit: gitCommit, source_tree: gitTree, dist_events_sha256: distEventsSha },
    scope_runs: scopeRuns,
    deleted_runs: deletedRuns,
    manual_ledger: manualLedger,
    synthetic_streams: syntheticStreams,
    members,
  };
  const sidecarPath = path.join(capture, 'sidecar.json');
  fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  fs.chmodSync(sidecarPath, 0o444);

  // 10. Run the O7 oracle against the captured evidence. It must PASS. The
  //     oracle is another test child: explicit child env, no inherited
  //     run/worker/step authority.
  const o7 = spawnSync(NODE, [O7, '--sidecar', sidecarPath, '--evidence-dir', evidenceDir], {
    encoding: 'utf8',
    shell: false,
    env: cleanEnv(),
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(o7.error, undefined, o7.error?.message);
  let o7Response = null;
  try {
    o7Response = JSON.parse(o7.stdout.trim());
  } catch {
    assert.fail(`O7 stdout not JSON: ${o7.stdout.slice(0, 1000)}`);
  }
  assert.equal(o7.status, 0, `O7 gate verdict: ${o7Response.result} ${JSON.stringify(o7Response.findings)}`);
  assert.equal(o7Response.result, 'PASS', JSON.stringify(o7Response.findings));

  // Independent raw assertions (belt + suspenders; distinct from O7 logic).
  const all = fs.readFileSync(path.join(capture, 'events', 'all.jsonl'), 'utf8');
  for (let i = 1; i <= 3; i += 1) {
    const archive = path.join(capture, 'events', `all.jsonl.${i}`);
    assert.ok(fs.existsSync(archive), `archive ${i} missing after 3 rotations`);
    const size = fs.statSync(archive).size;
    assert.ok(size > 0 && size <= CAP + 4096, `archive ${i} size ${size} out of expected band`);
  }
  const perRun = fs.readFileSync(path.join(capture, 'events', `${r1}.jsonl`), 'utf8');
  assert.ok(perRun.includes('"event":"run.completed"'), `run ${r1} per-run stream missing terminal event`);
  // Volume events: total emitted must equal the plan's seq span and be
  // reconstructible from the retained train.
  const planTotal = volumePlan.reduce((acc, b) => acc + (b.seq_end - b.seq_start), 0);
  const globalContent = [all];
  for (let i = 1; i <= 3; i += 1) globalContent.push(fs.readFileSync(path.join(capture, 'events', `all.jsonl.${i}`), 'utf8'));
  const volumeCount = globalContent.join('').split('"event":"o7.gate.volume"').length - 1;
  assert.equal(volumeCount, planTotal, `volume events in train (${volumeCount}) != plan total (${planTotal})`);
  const volumePerRun = fs.readFileSync(path.join(capture, 'events', `${VOLUME_RUN}.jsonl`), 'utf8');
  assert.equal(volumePerRun.split('"event":"o7.gate.volume"').length - 1, planTotal, 'volume per-run copy diverged');
  // Declared per-run transitions: every gate run must have its two steps
  // claimed+completed exactly once (from the live journal + the declared
  // expectation), and each live claim receipt must predate the capture.
  for (const decl of declaredTransitions) {
    const runReceipts = receipts.filter((r) => r.run_id === decl.run_id);
    assert.equal(runReceipts.filter((r) => r.kind === 'launch').length, 1, `run ${decl.run_id}: launch receipts`);
    for (const stepId of decl.expected.steps) {
      const claims = runReceipts.filter((r) => r.kind === 'claim' && r.step_id === stepId);
      const completes = runReceipts.filter((r) => r.kind === 'complete' && r.step_id === stepId);
      assert.equal(claims.length, 1, `run ${decl.run_id} step ${stepId}: expected exactly 1 claim, got ${claims.length}`);
      assert.equal(completes.length, 1, `run ${decl.run_id} step ${stepId}: expected exactly 1 completion, got ${completes.length}`);
      assert.ok(claims[0].observed_ts <= capturedAt, 'claim receipt observed_ts after capture');
    }
    const stepOrder = runReceipts.filter((r) => r.kind === 'claim').map((r) => r.step_id);
    assert.deepEqual(stepOrder, decl.expected.steps, `run ${decl.run_id}: claim order ${JSON.stringify(stepOrder)} != declared ${JSON.stringify(decl.expected.steps)}`);
  }
  // Every live receipt line predates capture (operation-time journaling).
  for (const r of receipts) {
    assert.ok(r.observed_ts <= capturedAt, `receipt ${r.kind} ${r.run_id} observed after capture`);
    assert.ok(Date.parse(r.observed_ts) < Date.parse(capturedAt) + 5000, 'receipt observed_ts not before capture');
  }

  // 11. Zero-token + teardown evidence.
  const db = new DatabaseSync(path.join(capture, 'database.sqlite'), { readOnly: true });
  const tokenRows = db.prepare('SELECT run_number, tokens_spent FROM runs').all();
  for (const row of tokenRows) assert.equal(Number(row.tokens_spent), 0, `run ${row.run_number} has non-zero tokens_spent`);
  let systemRows = [];
  try {
    systemRows = db.prepare('SELECT value FROM tamandua_stats').all();
  } catch { systemRows = []; }
  for (const row of systemRows) assert.equal(Number(row.value), 0, `system_tokens_spent non-zero: ${JSON.stringify(row)}`);
  db.close();
  // Guard-violation ledger must be empty.
  const ledger = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8').trim() : '';
  assert.equal(ledger, '', `guard-violation ledger not empty: ${ledger}`);
  // Every exact owned child is closed (registry teardown is re-run idempotently).
  const teardownResults = await closeAllOwned();
  for (const result of teardownResults) {
    assert.equal(result.closed, true, `teardown failure: ${JSON.stringify(result)}`);
  }

  // 12. Retain the fixture; write a gate summary the contract can cite.
  const summary = {
    gate: 'o7-rotation-loss-gate',
    result: o7Response.result,
    source_commit: gitCommit,
    source_tree: gitTree,
    dist_events_sha256: distEventsSha,
    captured_at: capturedAt,
    rotations: { generation: genValue, nominal_cap: CAP, retained_archives: 3 },
    runs: observedRuns.map((id, idx) => ({ ordinal: idx + 1, run_id: id })),
    volume: { bursts: volumePlan, total_events: planTotal, run_id: VOLUME_RUN },
    receipts: { count: receipts.length, journaled_live: true, path: 'live-receipts.jsonl', min_observed_ts: receipts.length ? receipts[0].observed_ts : null, max_observed_ts: receipts.length ? receipts[receipts.length - 1].observed_ts : null },
    declared_transitions: { count: declaredTransitions.length, path: 'declared-transitions.jsonl' },
    final_state_rows: finalStateRows,
    hush_probes: { debug_off_clean: !offProbe.includes('agent.nudged'), debug_on_present: onProbe.includes('agent.nudged') },
    endpoint_release: endpointRelease,
    opened_endpoints_at_ready: openedEndpoints.map((e) => e.name),
    opened_endpoints_before_stop: openedBeforeStop,
    port_release: { control_port: controlPort, released_after_close: endpointRelease.find((e) => e.name === 'control')?.released_after_close },
    child_env: { allowlist: true, sentinel_guards: ['TAMANDUA_RUN_ID', 'TAMANDUA_WORKER_JOB_ID', 'TAMANDUA_WORKER_PID', 'TAMANDUA_WORKER_PGID', 'NODE_TEST_CONTEXT'], public_keys: PUBLIC_ENV_KEYS },
    cleanup_report: path.join(root, 'cleanup-report.json'),
    teardown: teardownResults,
    zero_tokens: true,
    fixture_root: root,
  };
  fs.writeFileSync(path.join(root, 'gate-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`O7 gate PASS — fixture retained at ${root}`);
}, {});
