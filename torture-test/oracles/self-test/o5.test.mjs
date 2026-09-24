#!/usr/bin/env node
// o5.test.mjs — O5 process & port hygiene calibration (STORM-HYGIENE).
//
// One focused calibration suite for the O5 checker, run serially (node --test
// on this file alone). It drives the REAL oracles/O5 executable against the
// generated post-batch sidecars (real exported implementation + wrapper
// parsing/exit codes — never a parallel mock checker) and asserts the
// spec/STORM honesty rules:
//   * positive controls (clean linux census, shared toolchain <=1 at W6,
//     host-admitted shared original repo path, Darwin synthetic weak layers);
//   * negatives: leftover worker/daemon/zombie, foreign-run containment,
//     listener owner mismatch + leftover listener, false scope claims
//     (darwin layer-1 claim + un-reasserted restart), undeclared toolchain,
//     >1 survivor per declared toolchain, duplicated admission ids;
//   * NOT_EVALUABLE (never PASS): absent tool, EPERM-unreadable identity,
//     PID-reuse window, missing sampler span, unavailable layer;
//   * ERROR on malformed sidecars / anchor-less admissions;
//   * read-only proof: sidecar + expectation hashes are unchanged after each
//     wrapper run and the only new file is the oracle's own o5-summary.json.
//
// Capture-hardening regression pins (root capture probe counterexamples,
// o5-o6-root-capture-probe-20260909): hermetic injected-output recorder tests
// (strict port preflight with NO tool call on out-of-scope ports; validated
// lsof -F framing; clean no-match vs exit-1-error/warning/malformed
// distinctions; genuine listener positive; duplicate ports deduped) and real
// wrapper propagation of each recorder failure to NOT_EVALUABLE (never an
// empty-census PASS), of a clean no-match to PASS and of a genuine listening
// row to FAIL.
//
// Recording-only live proof (authorized bounded isolated fixture evidence):
// an EXACT OWNED detached child handle and a bind-to-0 listener are observed
// alive/listening through the real capture module (lib/o5-capture.mjs) and are
// then shut down EXACTLY (identity-verified reap of the child; close of the
// exact listener handle) — the checkers see the alive state as a finding and
// the post-shutdown state as clean. No foreign/old pid is ever signalled and
// no filesystem mutation happens outside the fresh fixture workspace.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateOracleResponse } from '../lib/output.mjs';
import {
  getProcessGroup,
  getProcessStartIdentity,
} from '../../bin/tt-process-identity.mjs';
import {
  parseLsofPortOutput,
  probePresence,
  redactCmdline,
  snapshotOwnedListeners,
  snapshotOwnedProcesses,
} from '../lib/o5-capture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const ORACLE = path.resolve(HERE, '..', 'O5');
const GENERATOR = path.join(HERE, 'generate-o5-fixtures.mjs');

const EXIT_BY_RESULT = { PASS: 0, FAIL: 1, ERROR: 2, NOT_EVALUABLE: 3 };

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function invokeWrapper(sidecarPath, dir) {
  const result = spawnSync(ORACLE, ['--contract-version', '1', '--sidecar', sidecarPath], {
    cwd: dir,
    env: { ...process.env },
    encoding: 'utf8',
    shell: false,
    timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  let response;
  try {
    response = JSON.parse(result.stdout.trim());
  } catch (error) {
    assert.fail(`O5 emitted invalid JSON: ${result.stdout}\n${result.stderr}`);
  }
  return { response, status: result.status };
}

function freshWorkspace(label) {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(VAR_ROOT, `oracle-self-test.${label}.`));
}

function readSummary(dir, response) {
  const summaryPath = path.join(dir, response.evidence[0].path);
  assert.ok(fs.existsSync(summaryPath), `missing summary evidence ${summaryPath}`);
  return JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
}

test('O5 calibration over generated sidecars (wrapper exit codes, results, findings, read-only)', () => {
  const workspace = freshWorkspace('o5');
  const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
  assert.equal(generated.status, 0, generated.stderr);
  const names = fs.readdirSync(workspace).filter((name) => name.startsWith('o5-')).sort();
  assert.ok(names.length >= 21, `expected >=21 O5 fixtures, got ${names.length}`);
  for (const name of names) {
    const dir = path.join(workspace, name);
    const expectation = JSON.parse(fs.readFileSync(path.join(dir, 'expectation.json'), 'utf8'));
    const sidecarPath = path.join(dir, 'sidecar.json');
    const sidecarHashBefore = sha256File(sidecarPath);
    const expectationHashBefore = sha256File(path.join(dir, 'expectation.json'));
    const { response, status } = invokeWrapper(sidecarPath, dir);
    const errors = validateOracleResponse(response, 'O5', status, dir);
    assert.deepEqual(errors, [], `${name}: ${errors.join('; ')}`);
    assert.equal(response.result, expectation.expected, `${name}: ${JSON.stringify(response)}`);
    assert.equal(status, EXIT_BY_RESULT[expectation.expected], `${name} exit code`);
    if (expectation.finding) {
      assert.ok(response.findings.some((finding) => finding.id === expectation.finding),
        `${name} omitted ${expectation.finding}: ${JSON.stringify(response.findings)}`);
    }
    if (expectation.infoFinding && expectation.expected === 'PASS') {
      assert.ok(response.findings.some((finding) => finding.id === expectation.infoFinding && finding.non_failing === true),
        `${name} omitted informational ${expectation.infoFinding}`);
    }
    if (expectation.expected === 'NOT_EVALUABLE') {
      assert.equal(response.findings.length, 0, `${name}: NOT_EVALUABLE must not carry findings`);
      assert.ok(response.classification?.ambiguous?.category, `${name} must carry an ambiguous classification`);
    }
    // Read-only: the oracle's inputs are byte-identical afterwards; the only
    // new file in the fixture dir is the oracle's own summary evidence.
    assert.equal(sha256File(sidecarPath), sidecarHashBefore, `${name} sidecar mutated`);
    assert.equal(sha256File(path.join(dir, 'expectation.json')), expectationHashBefore, `${name} expectation mutated`);
    const extraFiles = fs.readdirSync(dir).filter((file) => !['sidecar.json', 'expectation.json', 'o5-summary.json'].includes(file));
    assert.deepEqual(extraFiles, [], `${name}: unexpected files created: ${extraFiles.join(', ')}`);
    if (expectation.expected !== 'ERROR') {
      const summary = readSummary(dir, response);
      assert.equal(summary.schema_version, 1);
      assert.equal(summary.oracle_id, 'O5');
      assert.equal(summary.result, expectation.expected);
    }
  }
  process.stdout.write(`O5 calibration PASS (${names.length} fixtures)\n`);
});

test('O5 recording-only live proof: owned child + bind-to-0 listener observed and released exactly', async () => {
  const workspace = freshWorkspace('o5live');
  const runId = 'run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const repoRoot = path.join(workspace, 'scope-root');

  // ── owned child process (exact owned handle) ────────────
  // A DIRECT child of this test process (node reaps it on exit), recorded with
  // its birth identity. Shutdown is EXACT and identity-verified: re-check the
  // start identity, SIGKILL only that pid, await the exit event (reap), then
  // observe the pid as absent.
  const { spawn } = await import('node:child_process');
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  const record = { pid: child.pid, startTime: getProcessStartIdentity(child.pid) };
  const childExit = new Promise((resolve) => child.once('exit', resolve));
  const killOwnedChild = async () => {
    try {
      if (getProcessStartIdentity(record.pid) !== record.startTime) return; // pid reused or gone — never signal
    } catch { return; }
    try { process.kill(record.pid, 'SIGKILL'); } catch { /* already gone */ }
    await Promise.race([childExit, new Promise((resolve) => setTimeout(resolve, 5000))]);
  };
  try {
    // Alive at census -> the checker must report a leftover (FAIL).
    assert.equal(probePresence(record.pid), 'present');
    const processCensus = snapshotOwnedProcesses([record.pid]);
    assert.deepEqual(processCensus.unreadable, []);
    assert.equal(processCensus.rows.length, 1, 'owned child must be observed alive');
    const row = processCensus.rows[0];
    assert.equal(row.pid, record.pid);
    assert.equal(row.start_identity, record.startTime, 'recorded birth identity must corroborate');
    const window = { start_utc: new Date(Date.now() - 60_000).toISOString(), end_utc: new Date().toISOString() };
    const liveSidecar = {
      schema_version: 1,
      sidecar_kind: 'post-batch-hygiene',
      oracle_id: 'O5',
      produced_at: new Date().toISOString(),
      producer: { name: 'o5-live-test', version: '1' },
      campaign: {
        id: 'campaign-o5-live', run_ids: [runId], window,
        host: { platform: process.platform, scope_layer: 'none', scope_pattern: null },
      },
      evidence_files: [], diagnostics: [],
      o5: {
        scope: {
          contained_paths: [repoRoot], host_admitted_paths: [], cgroup_pattern: null,
          daemon_restarts: [],
        },
        admissions: [{
          id: 'live-worker', kind: 'run-worker', run_id: runId, pid: record.pid, pgid: record.pid,
          start_identity: record.startTime, cwd_prefix: repoRoot, cmdline_prefix: null,
          toolchain: null, expect: 'gone',
          required_layers: ['pgid-ancestry', 'path-fd', 'start-window'], listen_specs: null,
        }],
        coverage: {
          scope: { status: 'not_applicable', note: 'host without scope layer; layer 1 not applicable' },
          'pgid-ancestry': { status: 'available', note: null },
          'path-fd': { status: 'available', note: null },
          'start-window': { status: 'available', note: null },
        },
        observations: {
          scope_members: { rows: [], exact_count: 0, capped: false, tool: { name: 'n/a', exit_code: 0 }, spans: [] },
          processes: processCensus,
          listeners: { rows: [], exact_count: 0, capped: false, tool: { name: 'n/a', exit_code: 0 }, spans: [] },
          shared_toolchain: { rows: [], exact_count: 0, capped: false, tool: { name: 'n/a', exit_code: 0 }, spans: [] },
        },
        census: { complete: true, notes: [] },
      },
    };
    const liveDir = path.join(workspace, 'live-alive');
    fs.mkdirSync(liveDir, { recursive: true });
    const liveSidecarPath = path.join(liveDir, 'sidecar.json');
    fs.writeFileSync(liveSidecarPath, `${JSON.stringify(liveSidecar, null, 2)}\n`);
    const liveRun = invokeWrapper(liveSidecarPath, liveDir);
    assert.equal(liveRun.response.result, 'FAIL', `alive child must be a leftover: ${JSON.stringify(liveRun.response)}`);
    assert.ok(liveRun.response.findings.some((finding) => finding.id === 'O5_LEFTOVER_PROCESS'));
  } finally {
    await killOwnedChild();
  }
  // Positive shutdown evidence: after the exact verified kill + reap the
  // recorder observes the pid as ABSENT (not unreadable) and the checker
  // certifies clean.
  {
    let absent = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (probePresence(record.pid) === 'absent') { absent = true; break; }
      sleepSync(10);
    }
    assert.ok(absent, 'owned child must be absent after the exact kill/reap');
    const processCensus = snapshotOwnedProcesses([record.pid]);
    assert.ok(processCensus.unreadable.length === 0 && processCensus.rows.length === 0,
      'post-reap census must be a clean empty observation');
    const window = { start_utc: new Date(Date.now() - 60_000).toISOString(), end_utc: new Date().toISOString() };
    const cleanSidecar = {
      schema_version: 1, sidecar_kind: 'post-batch-hygiene', oracle_id: 'O5',
      produced_at: new Date().toISOString(), producer: { name: 'o5-live-test', version: '1' },
      campaign: { id: 'campaign-o5-live', run_ids: [runId], window, host: { platform: process.platform, scope_layer: 'none', scope_pattern: null } },
      evidence_files: [], diagnostics: [],
      o5: {
        scope: { contained_paths: [repoRoot], host_admitted_paths: [], cgroup_pattern: null, daemon_restarts: [] },
        admissions: [{
          id: 'live-worker', kind: 'run-worker', run_id: runId, pid: record.pid, pgid: record.pid,
          start_identity: record.startTime, cwd_prefix: repoRoot, cmdline_prefix: null, toolchain: null,
          expect: 'gone', required_layers: ['pgid-ancestry', 'path-fd', 'start-window'], listen_specs: null,
        }],
        coverage: {
          scope: { status: 'not_applicable', note: 'host without scope layer; layer 1 not applicable' },
          'pgid-ancestry': { status: 'available', note: null },
          'path-fd': { status: 'available', note: null },
          'start-window': { status: 'available', note: null },
        },
        observations: {
          scope_members: { rows: [], exact_count: 0, capped: false, tool: { name: 'n/a', exit_code: 0 }, spans: [] },
          processes: processCensus,
          listeners: { rows: [], exact_count: 0, capped: false, tool: { name: 'n/a', exit_code: 0 }, spans: [] },
          shared_toolchain: { rows: [], exact_count: 0, capped: false, tool: { name: 'n/a', exit_code: 0 }, spans: [] },
        },
        census: { complete: true, notes: [] },
      },
    };
    const cleanDir = path.join(workspace, 'live-clean');
    fs.mkdirSync(cleanDir, { recursive: true });
    const cleanSidecarPath = path.join(cleanDir, 'sidecar.json');
    fs.writeFileSync(cleanSidecarPath, `${JSON.stringify(cleanSidecar, null, 2)}\n`);
    const cleanRun = invokeWrapper(cleanSidecarPath, cleanDir);
    assert.equal(cleanRun.response.result, 'PASS', `post-reap census must certify clean: ${JSON.stringify(cleanRun.response)}`);
  }

  // ── bind-to-0 listener (exact owned handle) ────────────────────────────
  let server;
  let port;
  try {
    server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
    assert.ok(Number.isInteger(port) && port > 0);
    const selfPid = process.pid;
    const selfIdentity = getProcessStartIdentity(selfPid);
    const selfPgid = getProcessGroup(selfPid);
    const listenerCensus = snapshotOwnedListeners([port]);
    assert.equal(listenerCensus.tool.exit_code, 0, `lsof must be present (${listenerCensus.tool.exit_code})`);
    assert.equal(listenerCensus.rows.length, 1, 'owned listener must be observed listening');
    const listenerRow = listenerCensus.rows.find((row) => row.local_port === port);
    assert.ok(listenerRow, `listener row for port ${port} missing`);
    const window = { start_utc: new Date(Date.now() - 60_000).toISOString(), end_utc: new Date().toISOString() };
    const liveSidecar = {
      schema_version: 1, sidecar_kind: 'post-batch-hygiene', oracle_id: 'O5',
      produced_at: new Date().toISOString(), producer: { name: 'o5-live-test', version: '1' },
      campaign: { id: 'campaign-o5-live-listen', run_ids: [], window, host: { platform: process.platform, scope_layer: 'none', scope_pattern: null } },
      evidence_files: [], diagnostics: [],
      o5: {
        scope: { contained_paths: [repoRoot], host_admitted_paths: [], cgroup_pattern: null, daemon_restarts: [] },
        admissions: [{
          id: 'live-listener', kind: 'listener', run_id: null, pid: selfPid, pgid: selfPgid,
          start_identity: selfIdentity, cwd_prefix: null, cmdline_prefix: null, toolchain: null,
          expect: 'gone', required_layers: ['pgid-ancestry', 'path-fd', 'start-window'],
          listen_specs: [{ protocol: 'tcp', address: '127.0.0.1', port }],
        }],
        coverage: {
          scope: { status: 'not_applicable', note: 'host without scope layer; layer 1 not applicable' },
          'pgid-ancestry': { status: 'available', note: null },
          'path-fd': { status: 'available', note: null },
          'start-window': { status: 'available', note: null },
        },
        observations: {
          scope_members: { rows: [], exact_count: 0, capped: false, tool: { name: 'n/a', exit_code: 0 }, spans: [] },
          processes: { rows: [], exact_count: 0, capped: false, tool: { name: 'n/a', exit_code: 0 }, spans: [] },
          listeners: listenerCensus,
          shared_toolchain: { rows: [], exact_count: 0, capped: false, tool: { name: 'n/a', exit_code: 0 }, spans: [] },
        },
        census: { complete: true, notes: [] },
      },
    };
    const liveDir = path.join(workspace, 'listener-alive');
    fs.mkdirSync(liveDir, { recursive: true });
    const liveSidecarPath = path.join(liveDir, 'sidecar.json');
    fs.writeFileSync(liveSidecarPath, `${JSON.stringify(liveSidecar, null, 2)}\n`);
    const liveRun = invokeWrapper(liveSidecarPath, liveDir);
    assert.equal(liveRun.response.result, 'FAIL', `open listener must be a leftover: ${JSON.stringify(liveRun.response)}`);
    assert.ok(liveRun.response.findings.some((finding) => finding.id === 'O5_LEFTOVER_LISTENER'));
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
  // Positive release evidence: after closing the exact listener handle the
  // recorder observes no listener on the port and the checker certifies clean.
  {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const census = snapshotOwnedListeners([port]);
      if (census.rows.length === 0) break;
      sleepSync(20);
    }
    const released = snapshotOwnedListeners([port]);
    assert.equal(released.tool.exit_code, 0);
    assert.equal(released.rows.length, 0, 'listener must be released after exact close');
    const window = { start_utc: new Date(Date.now() - 60_000).toISOString(), end_utc: new Date().toISOString() };
    const cleanSidecar = {
      schema_version: 1, sidecar_kind: 'post-batch-hygiene', oracle_id: 'O5',
      produced_at: new Date().toISOString(), producer: { name: 'o5-live-test', version: '1' },
      campaign: { id: 'campaign-o5-live-listen', run_ids: [], window, host: { platform: process.platform, scope_layer: 'none', scope_pattern: null } },
      evidence_files: [], diagnostics: [],
      o5: {
        scope: { contained_paths: [repoRoot], host_admitted_paths: [], cgroup_pattern: null, daemon_restarts: [] },
        admissions: [{
          id: 'live-listener', kind: 'listener', run_id: null, pid: process.pid, pgid: null,
          start_identity: null, cwd_prefix: null, cmdline_prefix: null, toolchain: null,
          expect: 'gone', required_layers: ['pgid-ancestry', 'path-fd', 'start-window'],
          listen_specs: [{ protocol: 'tcp', address: '127.0.0.1', port }],
        }],
        coverage: {
          scope: { status: 'not_applicable', note: 'host without scope layer; layer 1 not applicable' },
          'pgid-ancestry': { status: 'available', note: null },
          'path-fd': { status: 'available', note: null },
          'start-window': { status: 'available', note: null },
        },
        observations: {
          scope_members: { rows: [], exact_count: 0, capped: false, tool: { name: 'n/a', exit_code: 0 }, spans: [] },
          processes: { rows: [], exact_count: 0, capped: false, tool: { name: 'n/a', exit_code: 0 }, spans: [] },
          listeners: released,
          shared_toolchain: { rows: [], exact_count: 0, capped: false, tool: { name: 'n/a', exit_code: 0 }, spans: [] },
        },
        census: { complete: true, notes: [] },
      },
    };
    const cleanDir = path.join(workspace, 'listener-clean');
    fs.mkdirSync(cleanDir, { recursive: true });
    const cleanSidecarPath = path.join(cleanDir, 'sidecar.json');
    fs.writeFileSync(cleanSidecarPath, `${JSON.stringify(cleanSidecar, null, 2)}\n`);
    const cleanRun = invokeWrapper(cleanSidecarPath, cleanDir);
    assert.equal(cleanRun.response.result, 'PASS', `released listener must certify clean: ${JSON.stringify(cleanRun.response)}`);
  }
  process.stdout.write('O5 recording-only live proof PASS (owned child + bind-to-0 listener observed and released exactly)\n');
});

test('redactCmdline bounds and redacts public cmdline fields', () => {
  const raw = 'node runner.js --api-key=sk-0123456789abcdef0123456789abcdef DEEPSEEK_API_KEY=secret-value --port 4334';
  const redacted = redactCmdline(raw);
  assert.ok(!redacted.includes('sk-0123456789abcdef0123456789abcdef'));
  assert.ok(!redacted.includes('secret-value'));
  assert.ok(redacted.length <= 512);
  const long = 'x'.repeat(5000);
  assert.ok(redactCmdline(long).length <= 512);
});

// ── hermetic listener-capture harness (injected lsof outputs) ──────────────
// Recording-only capture tests: TT_O5_LSOF points at a shim that reproduces
// each recorded lsof outcome (root probe scenarios + framing variants) and a
// marker file proves whether the tool was invoked at all. No real census, no
// signals, no network. The injected outputs are explicitly labeled hermetic
// fixtures — never disguised as an actual host census.
function writeLsofShim(dir) {
  const shimPath = path.join(dir, 'lsof-shim.cjs');
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('node:fs');
const cfg = JSON.parse(fs.readFileSync(process.env.TT_LSOF_CFG, 'utf8'));
if (cfg.marker) fs.writeFileSync(cfg.marker, 'invoked');
if (cfg.stderr) process.stderr.write(cfg.stderr);
if (cfg.stdout) process.stdout.write(cfg.stdout);
process.exit(cfg.status ?? 0);
`);
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

function runRecorderCapture(workspace, ports, cfg, label) {
  const dir = path.join(workspace, label);
  fs.mkdirSync(dir, { recursive: true });
  const shim = writeLsofShim(dir);
  const cfgPath = path.join(dir, 'lsof-cfg.json');
  const marker = path.join(dir, 'invoked.marker');
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, marker }));
  process.env.TT_O5_LSOF = shim;
  process.env.TT_LSOF_CFG = cfgPath;
  let result;
  try {
    result = snapshotOwnedListeners(ports);
  } finally {
    delete process.env.TT_O5_LSOF;
    delete process.env.TT_LSOF_CFG;
  }
  return { result, invoked: fs.existsSync(marker) };
}

test('O5 listener capture hardening: strict port preflight + lsof framing validation (hermetic, injected outputs)', () => {
  const workspace = freshWorkspace('o5cap');
  const cases = [
    // root counterexample C + bad-scope variants: strict complete preflight
    // before ANY tool call — no lsof invocation, mechanically non-success.
    { label: 'reject-range-string', ports: ['1-65535'], cfg: {}, expect: { preflight: true, exit: 2, rows: 0, invoked: false } },
    { label: 'reject-negative', ports: [-1], cfg: {}, expect: { preflight: true, exit: 2, rows: 0, invoked: false } },
    { label: 'reject-float', ports: [1.5], cfg: {}, expect: { preflight: true, exit: 2, rows: 0, invoked: false } },
    { label: 'reject-numeric-string', ports: ['45678'], cfg: {}, expect: { preflight: true, exit: 2, rows: 0, invoked: false } },
    { label: 'reject-out-of-range', ports: [65536], cfg: {}, expect: { preflight: true, exit: 2, rows: 0, invoked: false } },
    { label: 'reject-zero', ports: [0], cfg: {}, expect: { preflight: true, exit: 2, rows: 0, invoked: false } },
    { label: 'reject-not-array', ports: '45678', cfg: {}, expect: { preflight: true, exit: 2, rows: 0, invoked: false } },
    // root counterexample A: lsof exit 1 + permission-error stderr is a TOOL
    // FAILURE, never a clean absence.
    { label: 'root-a-exit1-stderr', ports: [45678], cfg: { status: 1, stderr: 'lsof: fixture permission failure' }, expect: { preflight: false, exit: 1, rows: 0, invoked: true } },
    // root counterexample B: lsof exit 0 + non-lsof malformed stdout.
    { label: 'root-b-malformed-success', ports: [45678], cfg: { status: 0, stdout: 'not-lsof-output\n' }, expect: { preflight: false, exit: 1, rows: 0, invoked: true } },
    // root counterexample D: exit 0 + warning on stderr + no rows.
    { label: 'root-d-empty-warning', ports: [45678], cfg: { status: 0, stderr: 'lsof: cannot inspect fixture namespace' }, expect: { preflight: false, exit: 1, rows: 0, invoked: true } },
    // genuine clean no-match: lsof exit 1 with EMPTY stdout+stderr.
    { label: 'clean-no-match', ports: [45678], cfg: { status: 1 }, expect: { preflight: false, exit: 0, rows: 0, invoked: true } },
    // genuine listener positive: exit 0 with a well-formed -F record.
    { label: 'listening-positive', ports: [45678], cfg: { status: 0, stdout: 'p4242\nf21\nPTCP\nn127.0.0.1:45678\n' }, expect: { preflight: false, exit: 0, rows: 1, invoked: true } },
    // rows + warning: rows are evidence but the port is not certified clean.
    { label: 'listening-with-warning', ports: [45678], cfg: { status: 0, stdout: 'p4242\nPTCP\nn127.0.0.1:45678\n', stderr: 'lsof: WARNING: partial namespace' }, expect: { preflight: false, exit: 1, rows: 1, invoked: true } },
    // framing violations.
    { label: 'framing-bad-pid', ports: [45678], cfg: { status: 0, stdout: 'px\nPTCP\nn127.0.0.1:45678\n' }, expect: { preflight: false, exit: 1, rows: 0, invoked: true } },
    { label: 'framing-unframed-line', ports: [45678], cfg: { status: 0, stdout: '9weird\n' }, expect: { preflight: false, exit: 1, rows: 0, invoked: true } },
    { label: 'framing-wrong-port', ports: [45678], cfg: { status: 0, stdout: 'p4242\nPTCP\nn127.0.0.1:9999\n' }, expect: { preflight: false, exit: 1, rows: 0, invoked: true } },
    { label: 'tool-absent-127', ports: [45678], cfg: { status: 127, stderr: 'lsof: not found' }, expect: { preflight: false, exit: 127, rows: 0, invoked: true } },
    // duplicate ports: one well-formed query each, never double-counted rows.
    { label: 'duplicate-ports-deduped', ports: [45678, 45678], cfg: { status: 0, stdout: 'p4242\nPTCP\nn127.0.0.1:45678\n' }, expect: { preflight: false, exit: 0, rows: 1, invoked: true } },
  ];
  for (const fixture of cases) {
    const { result, invoked } = runRecorderCapture(workspace, fixture.ports, fixture.cfg, fixture.label);
    assert.equal(invoked, fixture.expect.invoked, `${fixture.label}: lsof invocation mismatch (expected ${fixture.expect.invoked})`);
    assert.equal(result.tool.exit_code, fixture.expect.exit, `${fixture.label}: tool.exit_code ${JSON.stringify(result)}`);
    assert.equal(result.rows.length, fixture.expect.rows, `${fixture.label}: row count ${JSON.stringify(result)}`);
    assert.equal(result.capped, false, `${fixture.label}: census must never be marked capped`);
    if (fixture.expect.preflight) {
      assert.equal(result.preflight_rejected, true, `${fixture.label}: preflight_rejected must be set`);
      assert.ok(result.diagnostics.length > 0, `${fixture.label}: bounded diagnostics required`);
    }
    if (fixture.expect.exit !== 0) {
      assert.ok(result.diagnostics.length > 0, `${fixture.label}: non-success must carry bounded diagnostics`);
      const row = result.rows[0];
      if (row !== undefined) {
        assert.equal(row.local_port, 45678, `${fixture.label}: parsed row must name the requested port`);
      }
    }
  }
  process.stdout.write('O5 listener capture hardening PASS (strict preflight + framing; no tool call on invalid scope)\n');
});

test('O5 parseLsofPortOutput framing validator rejects malformed -F records', () => {
  const good = parseLsofPortOutput(45678, 'p4242\nf21\nPTCP\nn127.0.0.1:45678\n');
  assert.equal(good.ok, true);
  assert.equal(good.facts.length, 1);
  assert.equal(good.facts[0].pid, 4242);
  assert.equal(good.facts[0].protocol, 'TCP');
  assert.equal(good.facts[0].local_port, 45678);
  assert.equal(parseLsofPortOutput(45678, 'p4242\nPTCP\nn*:45678\n').facts[0].local_address, '*');
  assert.equal(parseLsofPortOutput(45678, 'p4242\nPTCP\nn[::1]:45678\n').facts[0].local_address, '::1');
  const bad = [
    'not-lsof-output\n', // 'n'-prefixed garbage with no parseable name
    '9weird\n', // unframed field line
    'px\nPTCP\nn127.0.0.1:45678\n', // non-numeric pid
    'p0\nPTCP\nn127.0.0.1:45678\n', // non-positive pid
    'n127.0.0.1:45678\n', // name field with no owning pid
    'p4242\nPTCP\nn127.0.0.1:9999\n', // names a different port than requested
    'p4242\nPTCP\nn127.0.0.1:notaport\n', // unparseable name
  ];
  for (const stdout of bad) {
    const parsed = parseLsofPortOutput(45678, stdout);
    assert.equal(parsed.ok, false, `framing must reject: ${JSON.stringify(stdout)} (got ${JSON.stringify(parsed)})`);
  }
  assert.equal(parseLsofPortOutput(45678, '').ok, true); // empty output: caller classifies by exit code
});

test('O5 recorder counterexamples propagate to non-PASS through the real wrapper (never an empty-census success)', () => {
  const workspace = freshWorkspace('o5prop');
  const runId = 'run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const repoRoot = path.join(workspace, 'scope-root');
  const window = { start_utc: new Date(Date.now() - 60_000).toISOString(), end_utc: new Date().toISOString() };

  const buildSidecar = (listenersInventory, diagnostics) => ({
    schema_version: 1,
    sidecar_kind: 'post-batch-hygiene',
    oracle_id: 'O5',
    produced_at: new Date().toISOString(),
    producer: { name: 'o5-propagation-test', version: '1' },
    campaign: {
      id: 'campaign-o5-prop', run_ids: [runId], window,
      host: { platform: 'linux', scope_layer: 'systemd-user-scope', scope_pattern: 'user@1000.service/app.slice/tamandua-run-*.scope' },
    },
    evidence_files: [], diagnostics,
    o5: {
      scope: {
        contained_paths: [repoRoot], host_admitted_paths: [], cgroup_pattern: 'user@1000.service/app.slice/tamandua-run-*.scope',
        daemon_restarts: [{ instance: 'daemon-1', pid: 9001, pgid: 9001, start_identity: 'proc:9001001', started_at: window.start_utc, scope_membership_observed: true }],
      },
      admissions: [{
        id: 'daemon-real', kind: 'daemon', run_id: null, pid: 9001, pgid: 9001,
        start_identity: 'proc:9001001', cwd_prefix: repoRoot, cmdline_prefix: null,
        toolchain: null, expect: 'gone',
        required_layers: ['scope', 'pgid-ancestry', 'path-fd', 'start-window'],
        listen_specs: [{ protocol: 'tcp', address: '127.0.0.1', port: 45678 }],
      }],
      coverage: {
        scope: { status: 'available', note: null }, 'pgid-ancestry': { status: 'available', note: null },
        'path-fd': { status: 'available', note: null }, 'start-window': { status: 'available', note: null },
      },
      observations: {
        scope_members: { rows: [], exact_count: 0, capped: false, tool: { name: 'n/a', exit_code: 0 }, spans: [] },
        // snapshotOwnedProcesses([]) — a real empty observation through the recorder.
        processes: snapshotOwnedProcesses([]),
        listeners: listenersInventory,
        shared_toolchain: { rows: [], exact_count: 0, capped: false, tool: { name: 'n/a', exit_code: 0 }, spans: [] },
      },
      // Producer claims a COMPLETE census and an AVAILABLE path-fd layer: only
      // the recorder's non-zero lsof outcome downgrades the layer (data-driven).
      census: { complete: true, notes: [] },
    },
  });

  // Each root counterexample recorded through the REAL recorder (shim-injected
  // lsof output), then assembled into a sidecar and run through the REAL O5
  // wrapper. A recorder failure must propagate to NOT_EVALUABLE — never a PASS
  // empty census; a genuine clean no-match must certify PASS; a genuine
  // listening row must surface as a FAIL finding.
  const scenarios = [
    { label: 'prop-root-a-exit1-stderr', cfg: { status: 1, stderr: 'lsof: fixture permission failure' }, expected: 'NOT_EVALUABLE', exit: 3 },
    { label: 'prop-root-b-malformed-success', cfg: { status: 0, stdout: 'not-lsof-output\n' }, expected: 'NOT_EVALUABLE', exit: 3 },
    { label: 'prop-root-c-out-of-scope', ports: ['1-65535'], cfg: {}, expected: 'NOT_EVALUABLE', exit: 3 },
    { label: 'prop-root-d-empty-warning', cfg: { status: 0, stderr: 'lsof: cannot inspect fixture namespace' }, expected: 'NOT_EVALUABLE', exit: 3 },
    { label: 'prop-clean-no-match', cfg: { status: 1 }, expected: 'PASS', exit: 0 },
    { label: 'prop-listening-positive', cfg: { status: 0, stdout: 'p4242\nPTCP\nn127.0.0.1:45678\n' }, expected: 'FAIL', exit: 1, finding: 'O5_LISTENER_OWNER_MISMATCH' },
  ];
  for (const scenario of scenarios) {
    const dir = path.join(workspace, scenario.label);
    fs.mkdirSync(dir, { recursive: true });
    const capture = runRecorderCapture(workspace, scenario.ports ?? [45678], scenario.cfg, `${scenario.label}-capture`);
    const sidecar = buildSidecar(capture.result, capture.result.diagnostics ?? []);
    const sidecarPath = path.join(dir, 'sidecar.json');
    fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    const sidecarHash = sha256File(sidecarPath);
    const { response, status } = invokeWrapper(sidecarPath, dir);
    const errors = validateOracleResponse(response, 'O5', status, dir);
    assert.deepEqual(errors, [], `${scenario.label}: ${errors.join('; ')}`);
    assert.equal(response.result, scenario.expected, `${scenario.label}: recorder outcome must propagate (${JSON.stringify(response)})`);
    assert.equal(status, scenario.exit, `${scenario.label} exit code`);
    // REAL assertion of the clean no-match normalization (recorder side): lsof
    // exit 1 with EMPTY stdout+stderr must normalize to aggregate exit_code 0
    // with zero rows AND a per-port clean port_outcome. The wrapper PASS/exit-0
    // assertions above are the O5-side proof; this pins the recorder's own
    // normalized result so the NOT_EVALUABLE branch below is never misread as
    // the place that verifies exit-1 normalization (it only checks that a
    // recorder failure propagated to ambiguous NOT_EVALUABLE with no findings).
    if (scenario.label === 'prop-clean-no-match') {
      assert.equal(capture.result.tool.exit_code, 0, `clean no-match must normalize to recorder exit_code 0 (got ${JSON.stringify(capture.result.tool)})`);
      assert.equal(capture.result.rows.length, 0, 'clean no-match must carry zero rows');
      const cleanOutcome = capture.result.port_outcomes?.find((entry) => entry.port === (scenario.ports ?? [45678])[0]);
      assert.equal(cleanOutcome?.outcome, 'clean', `clean no-match must record a per-port clean port_outcome (got ${JSON.stringify(capture.result.port_outcomes)})`);
    }
    if (scenario.expected === 'NOT_EVALUABLE') {
      assert.equal(response.findings.length, 0, `${scenario.label}: NOT_EVALUABLE carries no findings`);
      assert.ok(response.classification?.ambiguous?.category, `${scenario.label}: ambiguous classification required`);
    }
    if (scenario.finding) {
      assert.ok(response.findings.some((finding) => finding.id === scenario.finding), `${scenario.label}: expected ${scenario.finding}`);
    }
    // read-only: the sidecar is byte-identical after the wrapper run.
    assert.equal(sha256File(sidecarPath), sidecarHash, `${scenario.label}: sidecar mutated`);
  }
  process.stdout.write('O5 recorder counterexample propagation PASS (NOT_EVALUABLE / PASS / FAIL through the real wrapper)\n');
});
